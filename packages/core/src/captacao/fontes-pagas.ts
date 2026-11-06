import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db, decryptCredentials, encryptCredentials, getCurrentTeamId, impressaoDeTexto, tenantData } from "@crmagro/db";
import {
  buscarPessoasCnpja,
  creditosDaPesquisa,
  palavrasDoNome,
  type PaginaDeCandidatos,
} from "@crmagro/captation";
import { can, requireCan } from "../auth/authz";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";

/**
 * FONTES PAGAS de dados (Captação e Enriquecer): a chave do time fica em Integrações, cifrada,
 * e a fonte nasce DESLIGADA (sem chave, nada é consultado). Toda consulta paga:
 *  - mostra o custo estimado ANTES (`estimarBuscaPorNome`) e só roda com a confirmação desse valor;
 *  - respeita o teto de créditos por busca e o teto de créditos por mês do time;
 *  - fica registrada em `ConsultaDocumento` (quem, quando, por quê, quanto custou), sem o nome
 *    ou documento em claro (só a impressão por time e o mascarado);
 *  - é do administrador por padrão (`captacao.fonte_paga`).
 * A chave nunca sai daqui para a tela e nunca vai para o log.
 */

export { FonteSemAcesso, FonteSemCredito, FonteFalhou } from "@crmagro/captation";
export type { PaginaDeCandidatos, CandidatoDePessoa } from "@crmagro/captation";

export type FontePagaId = "cnpja";
export const FONTES_PAGAS: Record<FontePagaId, { nome: string }> = { cnpja: { nome: "CNPJá (API comercial)" } };

export const TETO_CREDITOS_POR_BUSCA_PADRAO = 5;

const configSchema = z.object({
  apiKey: z.string().trim().min(8, "A chave é curta demais.").max(200).regex(/^\S+$/, "A chave não pode ter espaço."),
  /** Preço de um crédito em centavos (a página de preços da fonte não é pública). Vazio = só mostra créditos. */
  precoCreditoCentavos: z.number().int().min(0).max(100_000).nullable().default(null),
  tetoCreditosPorBusca: z.number().int().min(1).max(100).default(TETO_CREDITOS_POR_BUSCA_PADRAO),
  /** Teto de créditos por mês para o time. Vazio = sem teto do CRM Agro (vale o saldo da fonte). */
  tetoCreditosMes: z.number().int().min(1).max(1_000_000).nullable().default(null),
});
export type ConfigFontePaga = z.infer<typeof configSchema>;
export type EntradaDaConfigFontePaga = z.input<typeof configSchema>;

/** O que a tela vê da fonte: nunca a chave. */
export type FontePagaDTO = {
  id: FontePagaId;
  nome: string;
  ligada: boolean;
  chaveMascarada: string | null;
  precoCreditoCentavos: number | null;
  tetoCreditosPorBusca: number;
  tetoCreditosMes: number | null;
  /** Créditos já gastos neste mês pelo time. */
  usoDoMes: number;
};

export class FonteDesligada extends Error {
  constructor() {
    super("Esta fonte paga está desligada. Um administrador liga em Integrações, Fontes de dados.");
    this.name = "FonteDesligada";
  }
}
export class CustoAcimaDoTeto extends Error {
  constructor(public readonly creditos: number, public readonly teto: number) {
    super(`A busca custaria ${creditos} créditos e o teto por busca é ${teto}. Peça menos resultados.`);
    this.name = "CustoAcimaDoTeto";
  }
}
export class CustoNaoConfirmado extends Error {
  constructor(public readonly creditos: number) {
    super(`Confirme o custo de ${creditos} ${creditos === 1 ? "crédito" : "créditos"} antes de buscar.`);
    this.name = "CustoNaoConfirmado";
  }
}
export class CotaDaFonteEsgotada extends Error {
  constructor(public readonly teto: number) {
    super(`O teto de ${teto} créditos deste mês já foi usado. Um administrador pode aumentar em Integrações.`);
    this.name = "CotaDaFonteEsgotada";
  }
}
export class ContadorIndisponivel extends Error {
  constructor() {
    super("Não deu para conferir o teto de créditos agora. Tente de novo em instantes.");
    this.name = "ContadorIndisponivel";
  }
}
export class PedidoDePessoaInvalido extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PedidoDePessoaInvalido";
  }
}

const MES_SP = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" });
/** "AAAA-MM" no fuso de São Paulo. */
export const mesDeSaoPaulo = (d: Date = new Date()): string => MES_SP.format(d).slice(0, 7);

const chaveUso = (teamId: string, id: FontePagaId, mes: string) => `fonte:uso:${teamId}:${id}:${mes}`;

function mascarar(chave: string): string {
  return `••••${chave.slice(-4)}`;
}

/** Config em CLARO (só server-side, para chamar a fonte). Null = desligada. */
async function lerConfig(id: FontePagaId): Promise<ConfigFontePaga | null> {
  const prisma = db();
  const row = await prisma.integration.findFirst({ where: { tipo: id }, select: { credentials: true, status: true } });
  if (!row?.credentials || row.status !== "connected") return null;
  const dec = decryptCredentials(row.credentials) as Partial<ConfigFontePaga> | null;
  const p = configSchema.safeParse(dec ?? {});
  return p.success ? p.data : null;
}

async function usoDoMes(teamId: string, id: FontePagaId): Promise<number> {
  try {
    return Number((await redisEstado().get(chaveUso(teamId, id, mesDeSaoPaulo()))) ?? 0) || 0;
  } catch {
    return 0; // só para mostrar; quem gasta confere de verdade (e nega) em `reservarCreditos`
  }
}

/** Estado das fontes pagas do time para a tela de Integrações (sem a chave). */
export async function listarFontesPagas(): Promise<FontePagaDTO[]> {
  const teamId = getCurrentTeamId();
  const out: FontePagaDTO[] = [];
  for (const id of Object.keys(FONTES_PAGAS) as FontePagaId[]) {
    const cfg = await lerConfig(id);
    out.push({
      id,
      nome: FONTES_PAGAS[id].nome,
      ligada: Boolean(cfg),
      chaveMascarada: cfg ? mascarar(cfg.apiKey) : null,
      precoCreditoCentavos: cfg?.precoCreditoCentavos ?? null,
      tetoCreditosPorBusca: cfg?.tetoCreditosPorBusca ?? TETO_CREDITOS_POR_BUSCA_PADRAO,
      tetoCreditosMes: cfg?.tetoCreditosMes ?? null,
      usoDoMes: teamId && cfg ? await usoDoMes(teamId, id) : 0,
    });
  }
  return out;
}

/** Liga a fonte do time (ou atualiza). A chave vai cifrada; nada é consultado agora (não gasta crédito). */
export async function salvarFontePaga(id: FontePagaId, entrada: EntradaDaConfigFontePaga): Promise<void> {
  requireCan("integrations.manage");
  if (!(id in FONTES_PAGAS)) throw new PedidoDePessoaInvalido("Fonte desconhecida.");
  const prisma = db();
  // Chave em branco numa fonte já ligada = manter a que está (só ajustar preço e tetos).
  const atual = entrada.apiKey?.trim() ? null : await lerConfig(id);
  if (!entrada.apiKey?.trim() && !atual) throw new PedidoDePessoaInvalido("Cole a chave da fonte.");
  const cfg = configSchema.parse({ ...entrada, apiKey: entrada.apiKey?.trim() || atual!.apiKey });
  const credentials = encryptCredentials(cfg) as unknown as Prisma.InputJsonValue;
  const existente = await prisma.integration.findFirst({ where: { tipo: id }, select: { id: true } });
  if (existente) await prisma.integration.update({ where: { id: existente.id }, data: { credentials, status: "connected" } });
  else await prisma.integration.create({ data: tenantData<Prisma.IntegrationUncheckedCreateInput>({ tipo: id, credentials, status: "connected" }) });
}

/** Desliga a fonte e apaga a chave. */
export async function removerFontePaga(id: FontePagaId): Promise<void> {
  requireCan("integrations.manage");
  if (!(id in FONTES_PAGAS)) throw new PedidoDePessoaInvalido("Fonte desconhecida.");
  await db().integration.deleteMany({ where: { tipo: id } });
}

// ---------------------------------------------------------------------------
// Busca de pessoas por NOME (fonte paga) → candidatos
// ---------------------------------------------------------------------------

export const MOTIVOS_DE_BUSCA_DE_PESSOA = ["cliente", "indicacao", "socio_de_empresa", "pediu_contato", "outro"] as const;
export type MotivoDeBuscaDePessoa = (typeof MOTIVOS_DE_BUSCA_DE_PESSOA)[number];
export const ROTULO_DO_MOTIVO: Record<MotivoDeBuscaDePessoa, string> = {
  cliente: "É cliente",
  indicacao: "Foi indicado",
  socio_de_empresa: "É sócio de uma empresa que já prospecto",
  pediu_contato: "Pediu contato",
  outro: "Outro motivo",
};

export type PedidoPorNome = { nome: string; limite?: number };

const LIMITE_PADRAO = 20;

function validarPedido(p: PedidoPorNome): { nome: string; limite: number } {
  const nome = (p.nome ?? "").trim().slice(0, 120);
  if (palavrasDoNome(nome).length < 2) throw new PedidoDePessoaInvalido("Informe nome e sobrenome.");
  const limite = Math.min(Math.max(Math.floor(p.limite ?? LIMITE_PADRAO) || LIMITE_PADRAO, 1), 100);
  return { nome, limite };
}

export type EstimativaDeBusca = {
  fonteLigada: boolean;
  creditos: number;
  /** Null enquanto o preço do crédito não foi informado na configuração. */
  centavos: number | null;
  tetoCreditosPorBusca: number;
  dentroDoTeto: boolean;
  usoDoMes: number;
  tetoCreditosMes: number | null;
};

/** Estimativa de uma consulta de `creditos` créditos, SEM consultar nada. */
export async function estimarCreditos(creditos: number, id: FontePagaId = "cnpja"): Promise<EstimativaDeBusca> {
  requireCan("captacao.fonte_paga");
  const teamId = getCurrentTeamId();
  const cfg = await lerConfig(id);
  const teto = cfg?.tetoCreditosPorBusca ?? TETO_CREDITOS_POR_BUSCA_PADRAO;
  return {
    fonteLigada: Boolean(cfg),
    creditos,
    centavos: cfg?.precoCreditoCentavos != null ? creditos * cfg.precoCreditoCentavos : null,
    tetoCreditosPorBusca: teto,
    dentroDoTeto: creditos <= teto,
    usoDoMes: teamId && cfg ? await usoDoMes(teamId, id) : 0,
    tetoCreditosMes: cfg?.tetoCreditosMes ?? null,
  };
}

/** Quanto a busca por nome custaria, SEM consultar nada. A tela mostra isto antes de pedir a confirmação. */
export async function estimarBuscaPorNome(pedido: PedidoPorNome, id: FontePagaId = "cnpja"): Promise<EstimativaDeBusca> {
  const { limite } = validarPedido(pedido);
  return estimarCreditos(creditosDaPesquisa(limite), id);
}

/** Soma os créditos ao uso do mês ANTES de consultar (nega se passar do teto). Redis fora = nega: sem contar, não gasta. */
async function reservarCreditos(teamId: string, id: FontePagaId, creditos: number, teto: number | null): Promise<void> {
  const chave = chaveUso(teamId, id, mesDeSaoPaulo());
  let total: number;
  try {
    const r = await redisEstado().multi().incrby(chave, creditos).expire(chave, 40 * 86_400).exec();
    total = Number(r?.[0]?.[1]);
    if (!Number.isFinite(total)) throw new Error("resposta inesperada do Redis");
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e), teamId }, "[fonte-paga] contador de créditos indisponível: negando");
    throw new ContadorIndisponivel();
  }
  if (teto !== null && total > teto) {
    await devolverCreditos(teamId, id, creditos);
    throw new CotaDaFonteEsgotada(teto);
  }
}

async function devolverCreditos(teamId: string, id: FontePagaId, creditos: number): Promise<void> {
  try {
    await redisEstado().decrby(chaveUso(teamId, id, mesDeSaoPaulo()), creditos);
  } catch {
    /* sem como devolver: fica a favor da cota (nunca gasta a mais) */
  }
}

/** "Maria S." para o registro (não guarda o nome inteiro). */
export function nomeAbreviado(nome: string): string {
  const [primeiro, ...resto] = nome.trim().split(/\s+/);
  const ult = resto[resto.length - 1];
  return ult ? `${primeiro} ${ult[0]!.toUpperCase()}.` : (primeiro ?? "");
}

export type RegistroDeConsultaPaga = {
  tipo: "nome" | "cpf" | "ie" | "cnpj";
  /** Impressão por time do que foi consultado (nunca o dado em claro). */
  hmac: string;
  mascarado: string | null;
  uf?: string | null;
  motivo: string;
  contactId?: string | null;
};

/**
 * PORTA ÚNICA de toda consulta paga de dado de pessoa: confere o papel (administrador), a fonte ligada, o teto
 * por busca, a confirmação do custo e o teto do mês; chama a fonte com a chave do time; devolve os créditos se
 * a fonte falhar; e registra a consulta em `ConsultaDocumento` (sem o documento em claro). `tolera` marca o
 * erro que NÃO é falha da fonte (ex.: "sem inscrição"): o resultado vem nulo e os créditos ficam gastos.
 */
export async function executarConsultaPaga<T>(
  id: FontePagaId,
  p: {
    creditos: number;
    creditosConfirmados: number;
    consultar: (chave: string) => Promise<T>;
    registro: RegistroDeConsultaPaga;
    tolera?: (e: unknown) => boolean;
  },
): Promise<{ resultado: T | null; creditos: number; custoCentavos: number | null }> {
  const actor = requireCan("captacao.fonte_paga");
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("sem time no contexto");
  const cfg = await lerConfig(id);
  if (!cfg) throw new FonteDesligada();
  if (p.creditos > cfg.tetoCreditosPorBusca) throw new CustoAcimaDoTeto(p.creditos, cfg.tetoCreditosPorBusca);
  if (!(p.creditosConfirmados >= p.creditos)) throw new CustoNaoConfirmado(p.creditos);

  await reservarCreditos(teamId, id, p.creditos, cfg.tetoCreditosMes);
  let resultado: T | null = null;
  try {
    resultado = await p.consultar(cfg.apiKey);
  } catch (e) {
    if (!p.tolera?.(e)) {
      await devolverCreditos(teamId, id, p.creditos); // a fonte falhou: a cota do CRM Agro não fica presa
      logger.warn({ fonte: id, erro: e instanceof Error ? e.name : "erro" }, "[fonte-paga] a consulta falhou");
      throw e;
    }
  }
  const custoCentavos = cfg.precoCreditoCentavos != null ? p.creditos * cfg.precoCreditoCentavos : null;
  await db().consultaDocumento.create({
    data: tenantData<Prisma.ConsultaDocumentoUncheckedCreateInput>({
      userId: actor.userId,
      tipo: p.registro.tipo,
      documentoHmac: p.registro.hmac,
      documentoMascarado: p.registro.mascarado,
      uf: p.registro.uf ?? null,
      motivo: p.registro.motivo,
      fonte: id,
      creditos: p.creditos,
      custoCentavos,
      contactId: p.registro.contactId ?? null,
    }),
  });
  return { resultado, creditos: p.creditos, custoCentavos };
}

/**
 * Busca pessoas por nome na fonte paga. Exige que a pessoa tenha visto e confirmado o custo
 * (`creditosConfirmados` ≥ o custo), o teto por busca e o teto do mês. Devolve candidatos (nome, faixa de
 * idade, CPF mascarado, empresas): nada vira contato; a pessoa escolhe um e a busca de empresas segue
 * pela fonte gratuita.
 */
export async function buscarCandidatosPorNome(
  pedido: PedidoPorNome & { motivo: MotivoDeBuscaDePessoa; creditosConfirmados: number; token?: string | null },
  id: FontePagaId = "cnpja",
): Promise<PaginaDeCandidatos> {
  requireCan("captacao.fonte_paga");
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("sem time no contexto");
  if (!MOTIVOS_DE_BUSCA_DE_PESSOA.includes(pedido.motivo)) throw new PedidoDePessoaInvalido("Diga o motivo da busca.");
  const { nome, limite } = validarPedido(pedido);
  const r = await executarConsultaPaga(id, {
    creditos: creditosDaPesquisa(limite),
    creditosConfirmados: pedido.creditosConfirmados,
    consultar: (chave) => buscarPessoasCnpja({ chave, nome, limite, token: pedido.token ?? null }),
    registro: { tipo: "nome", hmac: impressaoDeTexto(palavrasDoNome(nome).join(" "), teamId, "ConsultaDocumento.nome"), mascarado: nomeAbreviado(nome), motivo: pedido.motivo },
  });
  return r.resultado as PaginaDeCandidatos;
}

/** A pessoa atual pode usar fonte paga? (a tela esconde a opção de quem não pode; o serviço confere de novo.) */
export function podeUsarFontePaga(): boolean {
  return can("captacao.fonte_paga");
}
