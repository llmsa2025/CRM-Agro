import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, getCurrentTeamId, runAsSystem } from "@crmagro/db";
import { env } from "@crmagro/config";
import { normalizarPerfilInstagram } from "@crmagro/captation";
import { requireCan } from "../auth/authz";
import { donoPadrao } from "../tenancy/escopo";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import { resolveSocialAccountId, usernameEsperadoDaConta } from "../social/service";
import { agentesOnlineDaConta, agentesOnlineDoUsuario, enfileirarNaFilaDaConta, touchAgent } from "../relay/hub";
import type { IgFollowersSpec, RelayJob } from "../relay/jobs";
import { insertDrafts, type DraftInput } from "./service";
import {
  adquirirCapturaAtiva,
  CAPTURA_IG_PENDENTE_MS,
  comTravaDoLote,
  LoteOcupado,
  lerRegistroIg,
  liberarCapturaAtiva,
  salvarRegistroIg,
  REGISTRO_TTL_S,
  VISTOS_TTL_S,
  vistosIgKey,
} from "./andamento";
import {
  estadoEmAndamento,
  lerStatusCaptura,
  mensagemDaCaptura,
  novoStatusCaptura,
  salvarStatusCaptura,
  type EstadoCaptura,
  type MotivoCaptura,
  type StatusCaptura,
} from "./status";

/**
 * Captação de seguidores do Instagram PELA EXTENSÃO ("Relay por conta", etapa 3).
 *
 * Por que: o worker lia do IP do VPS (datacenter) e o Instagram devolvia 429, sem a tela
 * dizer o motivo. Agora a leitura sai do Chrome de quem pediu, pelo IP residencial e pela
 * sessão dele. O servidor NÃO usa o cookie guardado nem cai no worker: sem extensão online
 * com a conta, a busca é recusada com um erro que diz o que fazer.
 *
 * Fluxo:
 *  1. `iniciarCapturaInstagramPelaExtensao` (server action): valida, reserva a vaga (uma
 *     busca por pessoa e tipo), grava o status `na_fila` e o registro do lote, e põe a
 *     tarefa `ig_followers` na fila DA CONTA (só a extensão logada nela pega).
 *  2. O `poll` entrega a tarefa e chama `aoEntregarJobAExtensao`: `na_fila` → `rodando`.
 *  3. A extensão lê e manda os perfis em lotes pequenos (`registrarLoteDaExtensao`, rota
 *     `POST /api/relay/captura-lote`), que grava no staging (`insertDrafts`), com dedupe
 *     por @ dentro do lote, e atualiza o MESMO status que a tela lê. O último lote traz
 *     `fim` (terminou, ou parou com um motivo).
 *  4. Ninguém pegou (10 min) ou a extensão sumiu (5 min sem sinal): `statusVivo`
 *     (andamento.ts) fecha como `interrompida` com o motivo `extensao_offline`.
 */

export const LIMITE_SEGUIDORES_MAX = 300;
/** Qual lote é desta tarefa (job do relay): `captacao:ig-job:{teamId}:{jobId}`. */
const jobIgKey = (teamId: string, jobId: string) => `captacao:ig-job:${teamId}:${jobId}`;
const NOME_MAX = 150;
const BIO_MAX = 300;

// --- Erros nomeados ---------------------------------------------------------

/** Já existe uma busca do mesmo tipo andando para esta pessoa. */
export class CapturaEmAndamento extends Error {
  constructor(public readonly status: StatusCaptura) {
    super("Já existe uma busca em andamento.");
    this.name = "CapturaEmAndamento";
  }
}

export class PerfilInstagramInvalido extends Error {
  constructor() {
    super("Confira o @ do perfil: use só letras, números, ponto e sublinhado.");
    this.name = "PerfilInstagramInvalido";
  }
}

/** A pessoa não tem Instagram conectado (ou a conta não tem @ conhecido). */
export class ContaInstagramNaoConectada extends Error {
  constructor(semUsername = false) {
    super(
      semUsername
        ? "Falta o @ da conta de Instagram conectada. Conecte de novo pela extensão (Integrações, Canais)."
        : "Conecte uma conta de Instagram primeiro (Integrações → Canais).",
    );
    this.name = "ContaInstagramNaoConectada";
  }
}

/**
 * Nenhuma extensão pode ler agora. `causa`:
 *  - `offline`: a extensão desta pessoa não está ligada (nenhuma batida recente no poll);
 *  - `conta_ausente`: a extensão está ligada, mas o Chrome não tem esta conta do Instagram
 *    (não leu o @, ou está logado em outra).
 */
export class ExtensaoIndisponivel extends Error {
  constructor(public readonly causa: "offline" | "conta_ausente") {
    super(
      causa === "offline"
        ? "Abra o Chrome com a extensão do CRM Agro ligada e tente de novo."
        : "A extensão está ligada, mas não achou o seu Instagram neste Chrome. Entre no Instagram neste navegador e tente de novo.",
    );
    this.name = "ExtensaoIndisponivel";
  }
}

export class LoteInexistente extends Error {
  readonly codigo = "lote_inexistente";
  constructor() {
    super("lote inexistente");
    this.name = "LoteInexistente";
  }
}
export class LoteDeOutraPessoa extends Error {
  readonly codigo = "lote_de_outra_pessoa";
  constructor() {
    super("este lote é de outra pessoa");
    this.name = "LoteDeOutraPessoa";
  }
}
export class LoteEncerrado extends Error {
  readonly codigo = "lote_encerrado";
  constructor() {
    super("este lote já terminou");
    this.name = "LoteEncerrado";
  }
}

// --- Perfil e mapeamento para o staging -------------------------------------

const limparTexto = (t: unknown, max: number): string =>
  String(t ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** Seguidor lido → rascunho do staging. O worker (legado) e a rota da extensão usam a mesma regra. */
export function draftDoSeguidorInstagram(u: { username: string; nome?: string | null; bio?: string | null; telefone?: string | null; email?: string | null }): DraftInput {
  const bio = limparTexto(u.bio, BIO_MAX);
  return {
    nome: limparTexto(u.nome, NOME_MAX) || u.username,
    telefone: u.telefone ?? null,
    email: u.email ?? null,
    extra: { username: u.username, ...(bio ? { bio } : {}) },
  };
}

// --- 1. Iniciar (server action) ---------------------------------------------

/**
 * Cria o lote e entrega a tarefa à extensão DA PRÓPRIA PESSOA. Roda no contexto dela (time e
 * identidade da sessão). Lança um erro nomeado, com texto pronto para a tela, quando não dá:
 * `PerfilInstagramInvalido`, `ContaInstagramNaoConectada`, `CapturaEmAndamento`,
 * `ExtensaoIndisponivel`. Nunca cai no worker.
 */
export async function iniciarCapturaInstagramPelaExtensao(input: { perfil: string; limite: number }): Promise<{ lote: string }> {
  requireCan("captacao.run");
  const teamId = getCurrentTeamId();
  const ownerId = donoPadrao();
  if (!teamId || !ownerId) throw new Error("sem time ou pessoa no contexto");

  const perfil = normalizarPerfilInstagram(input.perfil);
  if (!perfil) throw new PerfilInstagramInvalido();
  const limite = Math.min(Math.max(Math.floor(Number(input.limite) || 0), 1), LIMITE_SEGUIDORES_MAX);

  const accountId = await resolveSocialAccountId("instagram");
  if (!accountId) throw new ContaInstagramNaoConectada();
  const esperado = await usernameEsperadoDaConta(accountId);
  if (!esperado) throw new ContaInstagramNaoConectada(true);

  // Vaga primeiro: quem já tem busca andando vê "Já existe uma busca em andamento", não
  // "extensão offline" (durante uma leitura longa a extensão não faz poll).
  const lote = randomUUID();
  const ocupada = await adquirirCapturaAtiva(teamId, "instagram", ownerId, lote);
  if (ocupada) throw new CapturaEmAndamento(ocupada);

  try {
    if ((await agentesOnlineDaConta(accountId)) < 1) {
      throw new ExtensaoIndisponivel((await agentesOnlineDoUsuario(teamId, ownerId)) > 0 ? "conta_ausente" : "offline");
    }

    const agora = Date.now();
    const bios = Math.min(env.INSTAGRAM_BIO_MAX, limite);
    const spec: IgFollowersSpec = {
      accountId,
      expectedUsername: esperado,
      perfil,
      limite,
      lote,
      ...(bios > 0 ? { bios: { max: bios } } : {}),
    };
    const job: RelayJob = { id: randomUUID(), teamId, type: "ig_followers", spec, createdAt: agora, expiresAt: agora + CAPTURA_IG_PENDENTE_MS };

    // Status e registro ANTES de a tarefa existir: a extensão pode pegá-la na hora.
    await salvarStatusCaptura(teamId, novoStatusCaptura({ lote, origem: "instagram", estado: "na_fila", total: limite }));
    let payload: string;
    try {
      payload = await enfileirarNaFilaDaConta(job, accountId, CAPTURA_IG_PENDENTE_MS);
    } catch (e) {
      const st = novoStatusCaptura({ lote, origem: "instagram", estado: "interrompida", total: limite });
      st.motivo = "erro";
      st.mensagem = mensagemDaCaptura("erro", "instagram", "não consegui entregar a busca à extensão", "extensao");
      await salvarStatusCaptura(teamId, st);
      throw e;
    }
    await salvarRegistroIg(teamId, { lote, ownerId, accountId, jobId: job.id, payload, perfil, limite, criadoEm: agora, expiraEm: job.expiresAt! });
    logger.info({ lote, limite, teamId }, "[captura] busca do Instagram entregue à extensão");
    return { lote };
  } catch (e) {
    await liberarCapturaAtiva(teamId, "instagram", ownerId, lote);
    throw e;
  }
}

// --- 2. A tarefa saiu da fila para a extensão (rota poll) ----------------------

/**
 * Chamada pela rota `poll` quando entrega uma tarefa `ig_followers`: marca o lote `rodando`.
 * `false` = NÃO entregar à extensão: o lote não existe, é de outra pessoa (a extensão de um
 * admin que casou o Instagram de um colega), já terminou (venceu) ou o papel não permite.
 * Roda no contexto do dono do token.
 */
export async function aoEntregarJobAExtensao(job: RelayJob): Promise<boolean> {
  const teamId = getCurrentTeamId();
  const quem = donoPadrao();
  const spec = job.spec as Partial<IgFollowersSpec>;
  if (!teamId || !quem || typeof spec.lote !== "string") return false;
  try {
    requireCan("captacao.run");
  } catch {
    return false;
  }
  const reg = await lerRegistroIg(teamId, spec.lote);
  if (!reg || reg.jobId !== job.id || reg.ownerId !== quem) {
    logger.warn({ teamId, lote: spec.lote }, "[captura] tarefa de leitura entregue a quem não é o dono: descartada");
    return false;
  }
  try {
    return await comTravaDoLote(teamId, reg.lote, async () => {
      const st = await lerStatusCaptura(teamId, reg.lote);
      if (!st || !estadoEmAndamento(st.estado)) return false;
      if (st.estado === "na_fila") {
        st.estado = "rodando";
        st.iniciadoEm = new Date().toISOString();
        await salvarStatusCaptura(teamId, st);
      }
      // Guarda qual lote é desta tarefa: se a extensão devolver um ERRO no lugar dos lotes (extensão antiga
      // que não conhece o tipo), `aoRecusarJobAExtensao` sabe qual busca fechar.
      await redisEstado().set(jobIgKey(teamId, job.id), reg.lote, "EX", REGISTRO_TTL_S).catch(() => undefined);
      return true;
    });
  } catch (e) {
    // Trava ocupada por 5 s: entrega mesmo assim, o primeiro lote da extensão marca "rodando".
    if (e instanceof LoteOcupado) return true;
    throw e;
  }
}

/**
 * A extensão devolveu a tarefa com ERRO (`POST /api/relay/result` com `ok: false`) em vez de lotes: uma
 * extensão antiga que não conhece `ig_followers` responde `not_implemented`, e uma tarefa recusada por
 * ela (`spec_invalida`, `expirada`) também não manda lote. Fecha a busca com o motivo certo, em vez de
 * deixar a tela em "Buscando..." até o servidor dar a busca por perdida. Só o dono da busca fecha, e
 * só se ela ainda anda (depois de um `fim` normal, o resultado com erro não muda nada). Roda no contexto
 * do dono do token.
 */
export async function aoRecusarJobAExtensao(jobId: string, erro: string): Promise<void> {
  const teamId = getCurrentTeamId();
  const quem = donoPadrao();
  if (!teamId || !quem || !jobId) return;
  const lote = await redisEstado().get(jobIgKey(teamId, jobId));
  if (!lote) return;
  const reg = await lerRegistroIg(teamId, lote);
  if (!reg || reg.ownerId !== quem || reg.jobId !== jobId) return;
  try {
    await comTravaDoLote(teamId, lote, async () => {
      const st = await lerStatusCaptura(teamId, lote);
      if (!st || !estadoEmAndamento(st.estado)) return;
      // O erro do resultado é o motivo que a extensão não conseguiu entregar no `fim` (rede fora na hora), ou o
      // código de uma recusa antes de começar.
      const motivo: MotivoCaptura =
        erro === "not_implemented"
          ? "extensao_desatualizada"
          : erro === "expirada"
            ? "extensao_offline"
            : (MOTIVOS_DA_EXTENSAO as readonly string[]).includes(erro)
              ? (erro as MotivoCaptura)
              : "erro";
      const detalhe = motivo === "erro" ? limparTexto(erro === "spec_invalida" ? "a extensão recusou a tarefa" : erro, 120) : null;
      st.estado = "interrompida";
      st.motivo = motivo;
      st.criados = await rascunhosDoLote(teamId, lote).catch(() => st.criados);
      st.mensagem = mensagemDaCaptura(motivo, "instagram", detalhe, "extensao");
      await salvarStatusCaptura(teamId, st);
      logger.info({ lote, motivo, erro: limparTexto(erro, 40) }, "[captura] a extensão devolveu a tarefa com erro: busca fechada");
    });
  } catch (e) {
    if (!(e instanceof LoteOcupado)) throw e;
  }
}

// --- 3. Lotes da extensão (rota captura-lote) ---------------------------------

/** Motivos que a extensão pode declarar ao parar (o servidor não aceita outros). */
export const MOTIVOS_DA_EXTENSAO = [
  "limite_instagram",
  "sessao_instagram",
  "perfil_nao_encontrado",
  "perfil_privado",
  "extensao_offline",
  "cota_diaria",
  "conta_errada",
  "tempo_esgotado",
  "erro",
] as const satisfies readonly MotivoCaptura[];

const itemSchema = z.object({
  username: z.string().regex(/^[A-Za-z0-9._]{1,30}$/),
  nome: z.string().max(400).nullish(),
  bio: z.string().max(1000).nullish(),
});

export const loteDaExtensaoSchema = z.object({
  lote: z.string().uuid(),
  jobId: z.string().min(1).max(100),
  /** Só para renovar a presença do agente durante a leitura (que dura minutos). */
  agentId: z.string().min(1).max(100).optional(),
  itens: z.array(itemSchema).max(100),
  /** Seguidores lidos até agora (progresso "N de M"). */
  lidos: z.number().int().min(0).max(100_000).optional(),
  /** Presente só no último lote: terminou (motivo null) ou parou por um motivo. */
  fim: z
    .object({
      motivo: z.enum(MOTIVOS_DA_EXTENSAO).nullable(),
      detalhe: z.string().max(400).nullish(),
      /** Epoch ms: antes disto não adianta tentar (espera guardada na extensão). */
      tentarDepoisDe: z.number().int().positive().max(8.64e15).optional(),
    })
    .optional(),
});
export type LoteDaExtensao = z.infer<typeof loteDaExtensaoSchema>;

export type ResultadoDoLote = { estado: EstadoCaptura; criados: number; encerrada: boolean };

/** Quantos rascunhos o lote tem DE FATO no banco, no time do contexto. */
async function rascunhosDoLote(teamId: string, lote: string): Promise<number> {
  return runAsSystem(teamId, () => db().prospectDraft.count({ where: { lote } }));
}

/**
 * Recebe um lote de perfis da extensão. Roda no contexto do DONO DO TOKEN (time, pessoa e
 * papel do token: `requireCan("captacao.run")`). O que barra abuso:
 *  - o lote é procurado no time do TOKEN: token de outro time não acha nada (`LoteInexistente`);
 *  - só a pessoa que pediu a busca manda lotes (`LoteDeOutraPessoa`), e só com o `jobId` da tarefa;
 *  - lote que já terminou recusa mais perfis (`LoteEncerrado`);
 *  - nunca grava mais que o `limite` pedido, nem o mesmo @ duas vezes no lote;
 *  - o texto de cada perfil é limpo e cortado.
 * Reenviar o mesmo lote (a resposta se perdeu) não duplica nada.
 */
export async function registrarLoteDaExtensao(entrada: unknown): Promise<ResultadoDoLote> {
  requireCan("captacao.run");
  const body = loteDaExtensaoSchema.parse(entrada);
  const teamId = getCurrentTeamId();
  const quem = donoPadrao();
  if (!teamId || !quem) throw new LoteInexistente();

  const reg = await lerRegistroIg(teamId, body.lote);
  if (!reg) throw new LoteInexistente();
  if (reg.ownerId !== quem) throw new LoteDeOutraPessoa();
  if (reg.jobId !== body.jobId) throw new LoteInexistente();

  if (body.agentId) void touchAgent(body.agentId, teamId, quem);

  return comTravaDoLote(teamId, body.lote, async () => {
    const st = await lerStatusCaptura(teamId, body.lote);
    if (!st) throw new LoteInexistente();
    if (!estadoEmAndamento(st.estado)) {
      // O fim repetido (a resposta do primeiro se perdeu) só confirma; qualquer outra coisa não entra.
      if (body.fim) return { estado: st.estado, criados: st.criados, encerrada: true };
      throw new LoteEncerrado();
    }

    // Perfis novos: um @ nunca entra duas vezes no lote, e nunca passa do limite pedido.
    const jaNoLote = await rascunhosDoLote(teamId, body.lote);
    const cabem = Math.max(0, reg.limite - jaNoLote);
    const unicos = [...new Map(body.itens.map((i) => [i.username.toLowerCase(), { ...i, username: i.username.toLowerCase() }])).values()];
    let inseridos: string[] = [];
    if (unicos.length && cabem > 0) {
      const r = redisEstado();
      const chave = vistosIgKey(teamId, body.lote);
      const pipe = r.pipeline();
      for (const u of unicos) pipe.sadd(chave, u.username);
      pipe.expire(chave, VISTOS_TTL_S);
      const res = (await pipe.exec()) ?? [];
      const novos = unicos.filter((_, i) => res[i]?.[1] === 1).slice(0, cabem);
      try {
        await insertDrafts("instagram", body.lote, novos.map(draftDoSeguidorInstagram), reg.ownerId);
        inseridos = novos.map((n) => n.username);
      } catch (e) {
        // Não gravou: devolve os @ ao "não visto" para a extensão poder reenviar o lote.
        if (novos.length) await r.srem(chave, ...novos.map((n) => n.username)).catch(() => undefined);
        throw e;
      }
    }

    const criados = await rascunhosDoLote(teamId, body.lote).catch(() => st.criados + inseridos.length);
    st.criados = criados;
    if (typeof body.lidos === "number") st.processados = Math.max(st.processados, Math.min(body.lidos, reg.limite));
    st.estado = "rodando";
    st.iniciadoEm ??= new Date().toISOString();

    if (body.fim) {
      const { motivo } = body.fim;
      if (motivo === null) {
        st.estado = criados > 0 ? "concluida" : "vazia";
        st.motivo = criados > 0 ? null : "sem_resultados";
        st.mensagem = criados > 0 ? null : mensagemDaCaptura("sem_resultados", "instagram", null, "extensao");
      } else {
        st.estado = "interrompida";
        st.motivo = motivo;
        const detalhe = motivo === "erro" ? limparTexto(body.fim.detalhe, 120) : "";
        st.mensagem = mensagemDaCaptura(motivo, "instagram", detalhe || null, "extensao");
        // A espera vem do cliente: só vale no futuro, e nunca além de 48 h.
        const depois = body.fim.tentarDepoisDe;
        if (depois && depois > Date.now() && (motivo === "limite_instagram" || motivo === "sessao_instagram")) {
          st.tentarDepoisDe = new Date(Math.min(depois, Date.now() + 48 * 3_600_000)).toISOString();
        }
      }
    }
    await salvarStatusCaptura(teamId, st);
    if (body.fim) {
      logger.info({ lote: body.lote, estado: st.estado, motivo: st.motivo, criados: st.criados, lidos: st.processados }, "[captura] busca do Instagram pela extensão: fim");
    }
    return { estado: st.estado, criados: st.criados, encerrada: !estadoEmAndamento(st.estado) };
  });
}
