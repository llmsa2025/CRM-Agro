import { env } from "@crmagro/config";
import { db } from "@crmagro/db";
import {
  ChannelSendFailed,
  classificarErroDeRede,
  hasWhatsAppHistory,
  isChannelSendFailed,
  normalizarDestinoSocial,
} from "@crmagro/channels";
import { sendMessage, sendTyping, startConversationWithContact, getWhatsAppNumber } from "../conversations/service";
import { escolhaDaCondicao, escolhaDoSorteio, type EscolhaDoPasso } from "./escolha";
import { hasInboundActivitySince, hasInboundOnChannelSince } from "../contacts/service";
import { valorDe } from "../contacts/identificadores-cifra";
import { ensureDeal, moveDealInFunnel } from "../funnels/service";
import { adicionarTagPorNome, chaveDaTag, contatoTemATag } from "../tags/por-nome";
import {
  consumeSendQuota,
  devolverCotaDeEnvio,
  esgotarCotaDoDia,
  reservarEspacoDeEmail,
} from "../channels-limit/service";
import { zonedParts } from "../motor-do-dia/tz";
import { logger } from "../logger/index";
import { safeFetch } from "../http/safe-fetch";
import { marcarFaseDoPasso } from "./fase-envio";
import { adiamentoForaDaJanela } from "../motor-do-dia/send-window";
import type { JanelaEnvio } from "./janela";
import { devolverEnvioAoContato, reservarEnvioAoContato, MAX_ENVIOS_CONTATO_24H, MOTIVO_OPT_OUT } from "./limites";
import type { GanchosDeEnvio } from "../conversations/service";
import type { AiAgentConfig, ConditionDef, SnapshotNode } from "./schema";
import { limparNomeDoWhatsApp } from "./nome-whatsapp";
import { NOS_QUE_FALAM_COM_O_CONTATO } from "./tipos";
import { classificarResposta, respostaTemTexto } from "./classificar-resposta";
import { conferirTemWhatsApp, conferirWhatsAppLigado } from "./conferir-whatsapp";
import {
  AGENTE_MAX_RESPOSTAS_PADRAO,
  AGENTE_SILENCIO_HORAS_PADRAO,
  ESPERA_APOS_FALHA_DA_IA_MS,
  RECHECK_DO_AGENTE_MS,
  MAX_FALHAS_DA_IA,
  avaliarEspera,
  fimPedeUmaPessoa,
  lerEstadoDoAgente,
  motivoLegivelDaFalha,
  pausaAntesDeResponderMs,
  textoDoFim,
  type EstadoDoAgente,
  type FimDaConversa,
} from "./agente-conversa";

/**
 * Executor — executa UM nó de um enrollment e devolve qual é o próximo.
 *
 * Roda DENTRO de `runWithTeam(teamId)` (o handler do worker garante o contexto).
 * Assim pode chamar `db()` e os serviços de domínio diretamente — eles leem o
 * ALS. Regra de ouro (§6): o motor nunca envia direto — chama `sendMessage` →
 * `Channel.send`. Nenhum provider é instanciado aqui.
 *
 * `NodeResult.sideEffects` carrega efeitos que o handler aplica no Enrollment
 * (ex.: `lastOutboundAt` após um send_message bem-sucedido), mantendo uma
 * única atualização da row no handler.
 */

export type NodeResult = {
  nextNodeId: string | null;
  // Saída com VÁRIOS destinos (condição): todos, ao mesmo tempo. `nextNodeId` é o primeiro (segue nesta inscrição);
  // o motor cria um RAMO (inscrição filha, `paiId`) para cada um dos outros (`concluirPasso`).
  nextNodeIds?: string[];
  delayMs?: number;
  skipped?: boolean;
  // Passo ADIADO (não executado ainda): o send bateu o teto/pausa da conta e
  // será retentado na próxima janela. Distinto de `skipped` (que é definitivo) —
  // sem isto, o adiamento seria contado como "mensagem enviada" nas métricas.
  deferred?: boolean;
  // Passo TRAVADO à espera de ação humana (revenda com histórico segurada p/
  // revisão; ligação manual pendente). O handler põe o enrollment em `waiting`
  // SEM reagendar (nextRunAt=null) — só uma ação manual o devolve ao fluxo.
  hold?: boolean;
  // Condição "respondeu?" com janela aberta e sem resposta (item 1.1): a
  // inscrição fica `waiting` com waitingFor="reply" até `ate` (fim da janela).
  // A mensagem recebida a acorda na hora; o job agendado é só o timeout.
  aguardandoResposta?: { ate: Date };
  // Estado do agente de conversa (`ai_agent` em modo "conversa"): o turno seguinte lê do resultado do passo
  // anterior (ver `agente-conversa.ts`).
  agente?: EstadoDoAgente;
  // Por que o passo foi pulado/segurado/adiado (aparece no log do fluxo).
  motivo?: string;
  // Qual saída um passo de decisão seguiu (condição, teste A/B). Aparece no balão do passo no log do fluxo.
  escolha?: EscolhaDoPasso;
  // Envio SOCIAL (Instagram/LinkedIn): o executor (core) NÃO pode tocar o
  // Playwright (quebra o bundle do web). Ele resolve conta/destinatário/texto e
  // devolve esta diretiva; o HANDLER do worker faz o envio via BrowserProvider.
  social?: { accountId: string; network: "instagram" | "linkedin"; to: string; text: string };
  sideEffects?: {
    lastOutboundAt?: Date;
  };
};

/** Resultado de uma saída com um ou vários destinos (o 1º segue nesta inscrição; cada outro vira um ramo paralelo). */
function destinosDaSaida(principal: string | null | undefined, mais: readonly string[] | undefined): NodeResult {
  const todos = [...new Set([principal, ...(mais ?? [])].filter((x): x is string => !!x))];
  if (todos.length === 0) return { nextNodeId: null };
  return todos.length === 1 ? { nextNodeId: todos[0]! } : { nextNodeId: todos[0]!, nextNodeIds: todos };
}


/** Forma do enrollment que o executor precisa (carregada pelo handler). */
/** Campos do contato disponíveis como variáveis nas mensagens de fluxo. */
export type ContactVars = {
  id: string;
  nome: string;
  /** Opt-out (N12): `opt_out` para de receber mensagem automática. */
  relacionamentoStatus?: string | null;
  tags: string[];
  ownerId: string | null;
  sobrenome?: string | null;
  empresa?: string | null;
  cargo?: string | null;
  cidade?: string | null;
  estado?: string | null;
  cpf?: string | null;
  cnpj?: string | null;
  site?: string | null;
  email?: string | null;
  telefone?: string | null;
  instagram?: string | null;
  linkedin?: string | null;
  // Empresa PRINCIPAL (para {empresa_*} nas mensagens). `empresa` (nome) já existe acima.
  empresaCnpj?: string | null;
  empresaIe?: string | null;
  empresaCidade?: string | null;
  empresaEstado?: string | null;
  empresaSite?: string | null;
  empresaTelefone?: string | null;
  empresaEmail?: string | null;
};

export type EnrollmentContext = {
  id: string;
  teamId: string;
  contactId: string;
  lastOutboundAt: Date | null;
  contact: ContactVars;
  /** Round do passo em execução (o worker passa) — alvo das marcas de envio. */
  round?: number;
  /** Profundidade de gatilho da inscrição (item 1.4) — cascatas herdam +1. */
  profundidade?: number;
  /** Horário de envio do FLUXO (o worker lê do `triggerConfig`). Ausente = segue a empresa. */
  janelaEnvio?: JanelaEnvio;
};

/**
 * Fora do horário de envio do FLUXO (item 1.3, MF-05): adia o PRÓPRIO passo até
 * a abertura da janela + jitter. Vale para todo nó que fala com uma pessoa. O
 * horário é o do fluxo (`enr.janelaEnvio`): segue a empresa, é livre ou próprio.
 */
async function adiarSeForaDaJanela(node: { id: string }, enr: Pick<EnrollmentContext, "janelaEnvio">): Promise<NodeResult | null> {
  const delayMs = await adiamentoForaDaJanela(new Date(), enr.janelaEnvio);
  if (delayMs === null) return null;
  return { nextNodeId: node.id, delayMs, deferred: true, motivo: "fora do horário de envio" };
}

/**
 * Resposta SMTP de "limite do provedor" (item 1.7): 452 (limite/armazenamento)
 * ou 5.4.5 / "quota exceeded" (limite diário do Gmail/Workspace).
 */
function limiteDoProvedorDeEmail(e: { status?: number; message: string }): boolean {
  return e.status === 452 || /5\.4\.5|quota|daily (sending )?limit|sending limit/i.test(e.message);
}

/** Histórico da Evolution indisponível: quanto adiar o passo (item 1.2). */
const ADIA_SEM_HISTORICO_MS = 15 * 60_000;

/**
 * Envia com as marcas de fase e a cota em ordem (item 1.2, MF-03):
 * - `antesDeEnviar` grava "enviando" no passo; `depoisDeEnviar`, "enviado";
 * - cota devolvida se o envio certamente NÃO saiu (erro antes da marca
 *   "enviando" ou `ChannelSendFailed` not_sent). Resultado incerto não devolve.
 */
async function enviarComMarcas<T>(
  enr: EnrollmentContext,
  nodeId: string,
  contaDaCota: string | null,
  envio: (ganchos: GanchosDeEnvio) => Promise<T>,
  /** `semReservaDoContato`: o envio não reservou o limite por contato (resposta de agente), então não há o que devolver. */
  opcoes: { semReservaDoContato?: boolean } = {},
): Promise<T> {
  const alvo = { enrollmentId: enr.id, nodeId, round: enr.round };
  let chamouCanal = false;
  const ganchos: GanchosDeEnvio = {
    antesDeEnviar: async () => {
      await marcarFaseDoPasso(alvo, { fase: "enviando" });
      chamouCanal = true;
    },
    depoisDeEnviar: async (providerMessageId) => {
      await marcarFaseDoPasso(alvo, { fase: "enviado", enviado: true, providerMessageId });
    },
  };
  try {
    return await envio(ganchos);
  } catch (e) {
    const naoSaiu = !chamouCanal || (isChannelSendFailed(e) && e.outcome === "not_sent");
    if (naoSaiu) {
      if (contaDaCota) await devolverCotaDeEnvio(contaDaCota).catch(() => {});
      if (!opcoes.semReservaDoContato) await devolverEnvioAoContato(enr.contactId);
    }
    throw e;
  }
}

/**
 * Limite de envios automáticos por CONTATO (item 1.4, MF-08): 3 em 24 h,
 * somando todos os fluxos. Excedeu → adia o passo até a janela zerar.
 */
async function adiarSePassouDoLimiteDoContato(enr: EnrollmentContext, node: { id: string }): Promise<NodeResult | null> {
  const reserva = await reservarEnvioAoContato(enr.contactId);
  if (reserva.ok) return null;
  return {
    nextNodeId: node.id,
    delayMs: reserva.esperaMs + Math.round(Math.random() * 30 * 60_000),
    deferred: true,
    motivo: `limite de ${MAX_ENVIOS_CONTATO_24H} envios automáticos por contato em 24 h`,
  };
}

/**
 * Um nome é REAL quando não é vazio nem um placeholder (o próprio número ou "só
 * dígitos"). Contatos criados sem nome costumam nascer com o telefone no lugar.
 */
export function hasRealName(nome: string | null | undefined): boolean {
  const n = (nome ?? "").trim();
  if (n.length < 2) return false;
  // só dígitos/pontuação de telefone (+55 66 99999-0000) → não é nome
  if (/^[+\d][\d\s().-]*$/.test(n)) return false;
  return true;
}

/**
 * Um `externalName` (pushName exposto pelo contato) NÃO é um nome utilizável
 * quando parece um handle/URL/e-mail (ex.: "@fulano", "site.com", "x@y.com").
 * Complementa `hasRealName` (que barra número puro) para o sync_name não gravar
 * lixo no cadastro.
 */
export function isLikelyHandle(nome: string | null | undefined): boolean {
  const s = (nome ?? "").trim();
  if (!s) return false;
  if (s.startsWith("@")) return true;
  if (/https?:\/\//i.test(s)) return true;
  if (/\S+@\S+\.\S+/.test(s)) return true; // e-mail
  return false;
}

/** Adiciona uma tag ao contato só se ainda não a tiver (idempotente). */
async function pushTagOnce(contactId: string, tag: string): Promise<void> {
  const prisma = db();
  const c = await prisma.contact.findUnique({ where: { id: contactId }, select: { tags: true } });
  if (c && !c.tags.includes(tag)) {
    await prisma.contact.update({ where: { id: contactId }, data: { tags: { push: tag } } });
  }
}

/**
 * Monta o CONTEXTO textual do contato para a IA (só fatos reais do cadastro).
 * Nome só entra se for um nome real — para a IA não "chamar pelo número".
 */
function buildContactContext(c: ContactVars): string {
  return [
    hasRealName(c.nome) && `Nome: ${c.nome}`,
    c.empresa && `Empresa: ${c.empresa}`,
    c.cargo && `Atividade/cargo: ${c.cargo}`,
    (c.cidade || c.estado) && `Local: ${[c.cidade, c.estado].filter(Boolean).join("/")}`,
    c.site && `Site: ${c.site}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * Template de SEGURANÇA do nó ai_agent (fail-open): usado quando a IA está
 * desligada, sem chave ou falha. Neutro e sem placeholder que possa vazar — a
 * saudação some/limpa sozinha pelo renderTemplate quando não há dado.
 */
const AI_AGENT_FALLBACK_PADRAO =
  "{saudacao}! Posso te mandar uma informação rápida por aqui?";

/** Tamanho-alvo padrão (caracteres) da mensagem gerada pela IA. */
const AI_AGENT_MAX_CHARS_PADRAO = 480;

/** Saudação conforme a hora local (America/Sao_Paulo): bom dia/tarde/noite. */
export function saudacaoPorHora(now: Date = new Date()): string {
  const h = zonedParts(now).hour;
  if (h >= 5 && h < 12) return "bom dia";
  if (h >= 12 && h < 18) return "boa tarde";
  return "boa noite";
}

/**
 * Renderiza variáveis num texto de mensagem. Suporta `{var}` e `{var|fallback}`.
 * Variáveis: {saudacao}, {nome}, {primeiro_nome}, {sobrenome}, {empresa},
 * {cargo} (= {profissao}), {cidade}, {estado}, {cpf}, {cnpj}, {site}, {email},
 * {telefone}, {instagram}, {linkedin}. Variável sem valor (e sem fallback) some
 * do texto — e a pontuação/vírgula órfã é limpa.
 */
export function renderTemplate(
  text: string,
  ctx: Partial<ContactVars> & { now?: Date },
): string {
  const nomeReal = hasRealName(ctx.nome) ? ctx.nome!.trim() : "";
  const primeiro = nomeReal.split(/\s+/)[0] ?? "";
  const val = (v: string | null | undefined) => (v ?? "").trim();
  const vars: Record<string, string> = {
    saudacao: saudacaoPorHora(ctx.now),
    nome: nomeReal,
    primeiro_nome: primeiro,
    sobrenome: val(ctx.sobrenome),
    empresa: val(ctx.empresa),
    cargo: val(ctx.cargo),
    profissao: val(ctx.cargo),
    cidade: val(ctx.cidade),
    estado: val(ctx.estado),
    cpf: val(ctx.cpf),
    cnpj: val(ctx.cnpj),
    site: val(ctx.site),
    email: val(ctx.email),
    telefone: val(ctx.telefone),
    instagram: val(ctx.instagram),
    linkedin: val(ctx.linkedin),
    // Empresa principal
    empresa_cnpj: val(ctx.empresaCnpj),
    empresa_cidade: val(ctx.empresaCidade),
    empresa_estado: val(ctx.empresaEstado),
    empresa_site: val(ctx.empresaSite),
    empresa_telefone: val(ctx.empresaTelefone),
    empresa_email: val(ctx.empresaEmail),
    ie: val(ctx.empresaIe),
  };
  // Índice do 1º caractere não-branco: se a saudação ABRE a mensagem, ela é
  // capitalizada ("boa tarde" → "Boa tarde"); no meio da frase fica minúscula.
  const firstNonSpace = text.search(/\S/);
  return text
    .replace(/\{(\w+)(?:\|([^}]*))?\}/g, (_m, key: string, fallback?: string, offset?: number) => {
      const v = vars[key];
      if (v === undefined) return _m; // variável desconhecida: deixa como está
      const out = v !== "" ? v : (fallback ?? "");
      // Capitaliza a saudação apenas quando é o começo da mensagem.
      if (key === "saudacao" && out && offset === firstNonSpace) {
        return out.charAt(0).toUpperCase() + out.slice(1);
      }
      return out;
    })
    // Limpa o que sobra quando um nome vazio some do texto: espaço duplo, espaço
    // antes de pontuação, e vírgula/;/- órfãos grudados na pontuação final
    // ("boa noite,!" → "boa noite!").
    // Só espaço e tab: as quebras de linha são do autor (parágrafos, listas) e ficam como ele montou.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]+([,.!?;])/g, "$1")
    .replace(/[,;-][ \t]*([.!?])/g, "$1")
    .trim();
}

/** Resolve a ChannelAccount de WhatsApp do time (do config ou fallback conectada). */
async function resolveWhatsAppAccount(
  channelAccountId: string | undefined,
  opts: { aceitarDesconectada?: boolean } = {},
): Promise<{ id: string; instance: string | null } | null> {
  const prisma = db();
  let account = channelAccountId
    ? await prisma.channelAccount.findUnique({ where: { id: channelAccountId } })
    : await prisma.channelAccount.findFirst({
        where: { canal: "whatsapp", status: "connected" },
        orderBy: { createdAt: "asc" },
      });
  // Passo que só LÊ (histórico): sem conta conectada, usa a mais antiga que exista.
  if (!account && opts.aceitarDesconectada) {
    account = await prisma.channelAccount.findFirst({ where: { canal: "whatsapp" }, orderBy: { createdAt: "asc" } });
  }
  if (!account) return null;
  const instance = (account.credentials as { instance?: string } | null)?.instance ?? null;
  return { id: account.id, instance };
}

/**
 * Contas de WhatsApp que um passo que só LÊ (histórico) consulta. Com número escolhido no passo, só ele. No
 * automático, TODOS os números do time que têm instância, conectados primeiro: a conversa do contato pode estar em
 * qualquer um, e ler só o primeiro deixava a do outro de fora. Desconectado serve (a Evolution guarda as mensagens
 * do mesmo jeito); número do WhatsApp oficial (sem instância da Evolution) não entra.
 */
async function resolveContasWhatsAppParaLeitura(channelAccountId: string | undefined): Promise<Array<{ id: string; instance: string }>> {
  if (channelAccountId) {
    const conta = await resolveWhatsAppAccount(channelAccountId, { aceitarDesconectada: true });
    return conta?.instance ? [{ id: conta.id, instance: conta.instance }] : [];
  }
  const contas = await db().channelAccount.findMany({ where: { canal: "whatsapp" }, orderBy: { createdAt: "asc" } });
  return contas
    .map((c) => ({ id: c.id, instance: (c.credentials as { instance?: string } | null)?.instance ?? null, conectada: c.status === "connected" }))
    .filter((c): c is { id: string; instance: string; conectada: boolean } => !!c.instance)
    .sort((a, b) => Number(b.conectada) - Number(a.conectada))
    .map(({ id, instance }) => ({ id, instance }));
}

/**
 * Resolve UMA conta conectada de QUALQUER canal (para o indicador "digitando",
 * que é agnóstico). Usa a conta configurada no nó, senão a primeira conectada.
 */
async function resolveAnyAccount(
  channelAccountId: string | undefined,
): Promise<{ id: string } | null> {
  const prisma = db();
  const account = channelAccountId
    ? await prisma.channelAccount.findUnique({ where: { id: channelAccountId } })
    : await prisma.channelAccount.findFirst({
        where: { status: "connected" },
        orderBy: { createdAt: "asc" },
      });
  return account ? { id: account.id } : null;
}

export async function executeNode(enr: EnrollmentContext, node: SnapshotNode): Promise<NodeResult> {
  // Opt-out (N12), defesa na hora de ENVIAR: a inscrição que já rodava quando o
  // contato disse "pare" termina aqui em vez de mandar a próxima mensagem.
  if (NOS_QUE_FALAM_COM_O_CONTATO.has(node.tipo) && enr.contact.relacionamentoStatus === "opt_out") {
    return { nextNodeId: null, skipped: true, motivo: MOTIVO_OPT_OUT };
  }
  switch (node.tipo) {
    // -----------------------------------------------------------------------
    case "send_message": {
      const cfg = node.config;
      const foraDaJanela = await adiarSeForaDaJanela(node, enr);
      if (foraDaJanela) return foraDaJanela;
      const account = await resolveWhatsAppAccount(cfg.channelAccountId);
      if (!account) {
        // Sem conta WhatsApp conectada: NÃO pula e NÃO falha o fluxo (não mata o
        // enrollment). Em vez disso, SEGURA (hold) o contato no passo e marca um
        // alerta "Sem Canal" no contato — para o vendedor ver e conectar antes de
        // retomar. O handler põe o enrollment em `waiting` (nextRunAt=null).
        await pushTagOnce(enr.contactId, "Sem Canal");
        return { nextNodeId: node.id, hold: true, skipped: true, motivo: "sem conta de WhatsApp conectada" };
      }

      // Pré-envio determinístico (item 1.2): contato sem WhatsApp → pula, SEM
      // gastar cota (antes a cota era consumida e o envio lançava depois).
      const number = await getWhatsAppNumber(enr.contactId);
      if (!number) return { nextNodeId: node.nextNodeId, skipped: true, motivo: "contato sem WhatsApp" };

      // Toggle "não enviar se já houver conversa fora da plataforma".
      if (cfg.skipIfHistory && account.instance) {
        const hasHistory = await hasWhatsAppHistory({
          apiUrl: env.EVOLUTION_API_URL,
          apiKey: env.EVOLUTION_API_KEY,
          instance: account.instance,
          number,
        });
        if (hasHistory === null) {
          // Evolution não respondeu: NÃO dá para saber se já é cliente. Antes
          // isto virava "não conversou" e o fluxo escrevia para quem já era
          // cliente (INT-15). Modo "hold" segura; "skip" adia 15 min.
          if (cfg.onHistory === "hold") {
            return { nextNodeId: node.id, hold: true, skipped: true, motivo: "histórico do WhatsApp indisponível" };
          }
          return { nextNodeId: node.id, delayMs: ADIA_SEM_HISTORICO_MS, deferred: true, motivo: "histórico do WhatsApp indisponível" };
        }
        if (hasHistory) {
          // Revenda: modo "hold" → não envia, marca "Tem Histórico" e SEGURA o
          // contato para revisão manual (o vendedor decide retomar). Modo padrão
          // "skip" → não envia e segue o fluxo silenciosamente.
          if (cfg.onHistory === "hold") {
            await pushTagOnce(enr.contactId, "Tem Histórico");
            return { nextNodeId: node.id, hold: true, skipped: true, motivo: "já tem conversa no WhatsApp" };
          }
          // Não envia — o fluxo segue sem disparar. Não seta lastOutboundAt.
          return { nextNodeId: node.nextNodeId, skipped: true, motivo: "já tem conversa no WhatsApp" };
        }
      }

      // Conversa ANTES da cota (item 1.2): falha aqui não gasta envio do dia.
      const { conversationId } = await startConversationWithContact(account.id, enr.contactId);

      // Controle de ritmo por conta (Fase B): só envia se houver cota HOJE. Sem cota (ou
      // conta pausada pelo monitor de saúde), ADIA o próprio passo para a próxima
      // janela (dia seguinte) em vez de forçar e arriscar o ban do número.
      // Limite por contato (item 1.4) antes da cota do número.
      const limiteContato = await adiarSePassouDoLimiteDoContato(enr, node);
      if (limiteContato) return limiteContato;
      const quota = await consumeSendQuota(account.id);
      if (!quota.allowed) {
        await devolverEnvioAoContato(enr.contactId);
        return { nextNodeId: node.id, delayMs: quota.retryAfterMs, deferred: true };
      }

      // Resolve variáveis ({saudacao}, {nome}, {empresa}, {cidade}, …) no envio.
      const texto = renderTemplate(cfg.text, enr.contact);
      await enviarComMarcas(enr, node.id, account.id, (ganchos) => sendMessage(conversationId, texto, ganchos));

      return {
        nextNodeId: node.nextNodeId,
        sideEffects: { lastOutboundAt: new Date() },
      };
    }

    // -----------------------------------------------------------------------
    case "send_email": {
      const cfg = node.config;
      const foraDaJanela = await adiarSeForaDaJanela(node, enr);
      if (foraDaJanela) return foraDaJanela;
      // Sem e-mail no contato: pula (segue o fluxo) — nunca falha por isso.
      if (!enr.contact.email) {
        return { nextNodeId: node.nextNodeId, skipped: true, motivo: "contato sem e-mail" };
      }
      const { sendEmail, resolverContaDeEmail, emailDeEnvioDoContato } = await import("../email/service");
      // Endereço marcado inválido por bounce (item 3.4): pula ANTES do espaçamento,
      // do limite do contato e da cota — não gasta nada e não insiste num
      // endereço morto (reputação). Outro e-mail válido do contato ainda serve.
      const destino = await emailDeEnvioDoContato(enr.contactId);
      if (destino.email === null) return { nextNodeId: node.nextNodeId, skipped: true, motivo: destino.motivo };
      // Conta de e-mail ANTES de tudo (item 1.7): a cota, o aquecimento e o
      // espaçamento são dela. Sem conta → pula, sem gastar nada.
      const contaEmail = await resolverContaDeEmail(cfg.channelAccountId);
      if (!contaEmail) return { nextNodeId: node.nextNodeId, skipped: true, motivo: "nenhuma conta de e-mail conectada" };

      // Espaçamento de 30–90 s entre e-mails da MESMA conta (anti-bloqueio).
      const espaco = await reservarEspacoDeEmail(contaEmail);
      if (!espaco.ok) {
        return { nextNodeId: node.id, delayMs: espaco.esperaMs, deferred: true, motivo: "espaçamento entre e-mails da conta" };
      }
      const limiteContato = await adiarSePassouDoLimiteDoContato(enr, node);
      if (limiteContato) return limiteContato;
      // Teto diário com aquecimento próprio de e-mail (30 → 300/dia).
      const quota = await consumeSendQuota(contaEmail);
      if (!quota.allowed) {
        await devolverEnvioAoContato(enr.contactId);
        return { nextNodeId: node.id, delayMs: quota.retryAfterMs, deferred: true, motivo: "cota diária de e-mail da conta" };
      }

      const subject = renderTemplate(cfg.subject, enr.contact);
      const body = renderTemplate(cfg.body, enr.contact);
      try {
        await enviarComMarcas(enr, node.id, contaEmail, (ganchos) =>
          sendEmail(
            enr.contactId,
            {
              subject,
              body,
              channelAccountId: contaEmail,
              ...(cfg.signatureId ? { signatureId: cfg.signatureId } : {}),
            },
            ganchos,
          ),
        );
      } catch (e) {
        // O PROVEDOR disse que o limite diário dele acabou (452 / 5.4.5): esgota
        // a cota de hoje da conta e adia para amanhã — os próximos e-mails do
        // dia também esperam, em vez de martelar e queimar a reputação.
        if (isChannelSendFailed(e) && e.outcome === "not_sent" && limiteDoProvedorDeEmail(e)) {
          await esgotarCotaDoDia(contaEmail);
          const { adiamentoParaProximoDia } = await import("../motor-do-dia/send-window");
          return {
            nextNodeId: node.id,
            delayMs: await adiamentoParaProximoDia(),
            deferred: true,
            motivo: "limite diário do provedor de e-mail",
          };
        }
        throw e;
      }
      return { nextNodeId: node.nextNodeId, sideEffects: { lastOutboundAt: new Date() } };
    }

    case "switch_flow": {
      const cfg = node.config;
      // Inscreve o contato no fluxo de destino e ENCERRA o atual (ele migrou).
      try {
        const { enroll } = await import("./service");
        await enroll(enr.contactId, cfg.flowId, { profundidade: (enr.profundidade ?? 0) + 1 });
      } catch {
        // já inscrito / fluxo inválido/inativo: não trava o motor — só encerra este.
      }
      return { nextNodeId: null };
    }

    case "send_social": {
      const cfg = node.config;
      const foraDaJanela = await adiarSeForaDaJanela(node, enr);
      if (foraDaJanela) return foraDaJanela;
      // @/URL do contato no canal (instagram/linkedin). Sem isso: pula o passo.
      const handle = cfg.canal === "instagram" ? enr.contact.instagram : enr.contact.linkedin;
      if (!handle) {
        // "hold": segura o contato no passo (não avança) até ação manual.
        // "skip" (default): pula e segue o fluxo.
        if (cfg.onNoHandle === "hold") return { nextNodeId: node.id, hold: true, skipped: true };
        return { nextNodeId: node.nextNodeId, skipped: true };
      }
      // Destino que não é um perfil (@ inválido, URL de empresa/post): pula
      // antes de gastar cota (item 1.8, INT-09).
      if (!normalizarDestinoSocial(cfg.canal, handle)) {
        return { nextNodeId: node.nextNodeId, skipped: true, motivo: `${cfg.canal} do contato não é um perfil válido` };
      }

      const { resolveSocialAccountId } = await import("../social/service");
      const accountId = await resolveSocialAccountId(cfg.canal, cfg.channelAccountId);
      if (!accountId) throw new Error(`nenhuma conta ${cfg.canal} conectada`);

      // Limite por contato (item 1.4) também vale para DM — antes, só WhatsApp
      // e e-mail contavam.
      const limiteContato = await adiarSePassouDoLimiteDoContato(enr, node);
      if (limiteContato) return limiteContato;
      // Controle de ritmo: só envia se houver cota HOJE (mesma rampa/warmup do WhatsApp).
      // Sem cota → ADIA o passo (não força e arrisca o ban).
      const quota = await consumeSendQuota(accountId);
      if (!quota.allowed) {
        await devolverEnvioAoContato(enr.contactId);
        return { nextNodeId: node.id, delayMs: quota.retryAfterMs, deferred: true };
      }

      let text = renderTemplate(cfg.template, enr.contact);
      // ANTI-BAN por IA: reescreve o texto (já com as variáveis resolvidas) numa
      // versão variada por contato. Fail-open: sem IA/erro → mantém o original.
      if (cfg.aiPersonalize) {
        const { personalizeMessage } = await import("../ai/personalize");
        const contexto = [
          enr.contact.nome && `Nome: ${enr.contact.nome}`,
          enr.contact.empresa && `Empresa: ${enr.contact.empresa}`,
          enr.contact.cargo && `Atividade: ${enr.contact.cargo}`,
          (enr.contact.cidade || enr.contact.estado) &&
            `Local: ${[enr.contact.cidade, enr.contact.estado].filter(Boolean).join("/")}`,
        ]
          .filter(Boolean)
          .join("; ");
        text = await personalizeMessage(text, { instrucao: cfg.aiInstrucao, contexto });
      }
      // O envio real (extensão/Playwright) sai pela fila `social` (item 1.8):
      // o handler entrega a diretiva e a inscrição espera o resultado.
      return {
        nextNodeId: node.nextNodeId,
        social: { accountId, network: cfg.canal, to: handle, text },
        sideEffects: { lastOutboundAt: new Date() },
      };
    }

    // -----------------------------------------------------------------------
    case "wait": {
      const cfg = node.config;
      const factor = unitFactor(cfg.unit);
      // Modo intercalar: sorteia entre duration e durationMax (inclusive), na
      // mesma unidade. Sem durationMax, espera fixa.
      const base =
        cfg.durationMax != null && cfg.durationMax > cfg.duration
          ? cfg.duration + Math.floor(Math.random() * (cfg.durationMax - cfg.duration + 1))
          : cfg.duration;
      return { nextNodeId: node.nextNodeId, delayMs: base * factor };
    }

    // -----------------------------------------------------------------------
    case "typing": {
      const cfg = node.config;
      // Duração humana: fixa, ou aleatória em [duration, durationMax] (controle de ritmo).
      const base =
        cfg.durationMax != null && cfg.durationMax > cfg.duration
          ? cfg.duration + Math.floor(Math.random() * (cfg.durationMax - cfg.duration + 1))
          : cfg.duration;
      const durationMs = base * unitFactor(cfg.unit);

      // Indicador "digitando" NÃO-BLOQUEANTE. Antes `sendTyping` dormia a duração
      // inteira no worker — com concorrência baixa, um typing de 30s congelava
      // TODOS os fluxos. Agora dispara a presença em BACKGROUND (best-effort,
      // agnóstico de canal: `sendTyping` só age se o canal tiver `sendPresence`)
      // e devolve `delayMs` — o atraso vira um job agendado, então a pausa é só
      // DESTE fluxo, não de todos. Estruturado para qualquer canal (WhatsApp
      // agora; Instagram/LinkedIn quando o provider trouxer presença).
      const account = await resolveAnyAccount(cfg.channelAccountId);
      if (account) {
        const { conversationId } = await startConversationWithContact(account.id, enr.contactId);
        void sendTyping(conversationId, durationMs).catch(() => {});
      }
      return { nextNodeId: node.nextNodeId, delayMs: durationMs };
    }

    // -----------------------------------------------------------------------
    case "condition": {
      const branches = node.branches;
      for (const [i, b] of branches.branches.entries()) {
        const casou = await evalCondition(enr, b.condition, node.id);
        // Ainda não dá para saber (conferir o número no WhatsApp: fora do horário, ritmo, teto, conta caída): ADIA o
        // próprio passo, como os envios. Round novo, sem gastar tentativa, e nenhum ramo é escolhido no escuro.
        if (typeof casou === "object") {
          // Sem conta de WhatsApp no CRM Agro: segura para a pessoa conectar um número (igual ao passo "Enviar mensagem").
          if ("segurar" in casou) return { nextNodeId: node.id, hold: true, skipped: true, motivo: casou.segurar.motivo };
          return { nextNodeId: node.id, delayMs: casou.adiar.delayMs, deferred: true, motivo: casou.adiar.motivo };
        }
        if (casou) {
          return { ...destinosDaSaida(b.nextNodeId, b.maisDestinos), escolha: escolhaDaCondicao(branches.branches, i) };
        }
      }
      // Nenhum ramo casou. Antes de cair no "senão", checa se algum ramo
      // "respondeu?" ainda tem JANELA aberta — nesse caso o fluxo não desistiu,
      // só ainda não houve resposta. Reagenda a PRÓPRIA condição (o handler
      // incrementa o round, então a idempotência não bloqueia a re-checagem).
      const espera = janelaRestanteMs(enr, branches.branches);
      if (espera > 0) {
        // Item 1.1 (MF-02): espera ORIENTADA A EVENTO. Um job de timeout no fim
        // da janela (ou a cada REPLY_RECHECK_MS em janelas longas, como rede de
        // segurança); a resposta acorda a inscrição na hora (acordarQuemEspera
        // Resposta). Antes: um job a cada 30 s durante toda a janela.
        return {
          nextNodeId: node.id,
          delayMs: Math.min(REPLY_RECHECK_MS, espera),
          aguardandoResposta: { ate: new Date(Date.now() + espera) },
        };
      }
      return { ...destinosDaSaida(branches.default, branches.defaultMais), escolha: escolhaDaCondicao(branches.branches, null) };
    }

    // -----------------------------------------------------------------------
    // Teste A/B: sorteia uma variante por PESO, mas o sorteio é DETERMINÍSTICO por
    // (enrollmentId, nodeId) — assim retry/re-execução caem sempre na MESMA
    // variante (senão quebraria a idempotência do motor). Peso total 0 → termina.
    case "ab_split": {
      const variants = node.branches.variants;
      const total = variants.reduce((s, v) => s + Math.max(0, v.weight), 0);
      if (total <= 0) return { nextNodeId: null };
      const bucket = hashString(`${enr.id}:${node.id}`) % total;
      let acc = 0;
      for (const [i, v] of variants.entries()) {
        acc += Math.max(0, v.weight);
        if (bucket < acc) return { nextNodeId: v.nextNodeId || null, escolha: escolhaDoSorteio(v.label, i) };
      }
      const ultima = variants.length - 1;
      return { nextNodeId: variants[ultima]?.nextNodeId || null, escolha: escolhaDoSorteio(variants[ultima]?.label ?? "", ultima) };
    }

    // -----------------------------------------------------------------------
    // "Mover etapa": SÓ move o negócio aberto do contato NAQUELE funil. Não cria
    // (isso é papel do "criar card"). Sem negócio no funil → passo pulado.
    case "update_stage": {
      const cfg = node.config;
      // Cascata do motor (item 1.4): o stage_changed disparado aqui herda +1.
      const { moved } = await moveDealInFunnel(enr.contactId, cfg.funnelId, cfg.stageId, {
        profundidade: (enr.profundidade ?? 0) + 1,
      });
      return { nextNodeId: node.nextNodeId, skipped: !moved };
    }

    // -----------------------------------------------------------------------
    // "Criar card": garante 1 negócio aberto do contato no funil (dedup). Se já
    // existe, não cria outro.
    case "create_deal": {
      const cfg = node.config;
      // Só cria se o contato ainda não tem card ABERTO neste funil (`ensureDeal`): passar de novo não duplica.
      const { created } = await ensureDeal(cfg.funnelId, cfg.stageId, enr.contactId);
      return { nextNodeId: node.nextNodeId, motivo: created ? "Card criado no funil" : "Já tinha card aberto neste funil, não criou outro" };
    }

    // -----------------------------------------------------------------------
    // "Adicionar tag": a tag passa a existir no catálogo do time (a barra e o filtro de Contatos leem o catálogo) e o
    // contato é vinculado a ela. Sem duplicar por caixa nem acento, sem tirar as outras tags do contato, e repetir o
    // passo não duplica nada. `Contact.tags` (campo legado) continua gravado para o que ainda lê dele.
    case "add_tag": {
      const prisma = db();
      const r = await adicionarTagPorNome(enr.contactId, node.config.tag, { profundidade: (enr.profundidade ?? 0) + 1 });
      const atual = await prisma.contact.findUnique({
        where: { id: enr.contactId },
        select: { tags: true },
      });
      if (!(atual?.tags ?? []).some((t) => chaveDaTag(t) === chaveDaTag(r.nome))) {
        await prisma.contact.update({
          where: { id: enr.contactId },
          data: { tags: { push: r.nome } },
        });
      }
      return {
        nextNodeId: node.nextNodeId,
        motivo: r.tagCriada ? `Tag "${r.nome}" criada no catálogo e adicionada ao contato` : r.vinculada ? `Tag "${r.nome}" adicionada ao contato` : `O contato já tinha a tag "${r.nome}"`,
      };
    }

    // -----------------------------------------------------------------------
    case "notify_user": {
      const cfg = node.config;
      const prisma = db();
      await prisma.activity.create({
        data: {
          contactId: enr.contactId,
          tipo: "note",
          direcao: "out",
          conteudo: cfg.message,
          meta: { notifyUserId: cfg.userId ?? enr.contact.ownerId ?? null, kind: "flow_notify" },
        } as never,
      });
      return { nextNodeId: node.nextNodeId };
    }

    // -----------------------------------------------------------------------
    case "http_request": {
      const cfg = node.config;
      // S6: URL do usuário só sai por safeFetch (https, sem IP interno, IP
      // fixado, redirect revalidado, 1 MB, timeout). O erro gravado no histórico
      // é GENÉRICO: o status do alvo servia de oráculo para varrer portas.
      // Item 1.2: o erro é CLASSIFICADO — bloqueado antes de conectar = pula;
      // conexão recusada = tenta de novo; timeout/erro do destino = incerto (o
      // destino pode ter processado) → segura para revisão. Mensagens genéricas
      // de propósito (S6); o detalhe vai só para o log.
      const alvo = { enrollmentId: enr.id, nodeId: node.id, round: enr.round };
      await marcarFaseDoPasso(alvo, { fase: "enviando" });
      let ok = false;
      try {
        const res = await safeFetch(cfg.url, {
          method: cfg.method,
          headers: cfg.headers,
          body: cfg.body,
          timeoutMs: cfg.timeoutMs ?? 10_000,
        });
        ok = res.ok;
      } catch (e) {
        logger.warn(
          { enrollmentId: enr.id, nodeId: node.id, err: e instanceof Error ? e.message : String(e) },
          "[flow] http_request falhou",
        );
        const bloqueio = e as { name?: string; fase?: string };
        if (bloqueio?.name === "SafeFetchBlocked") {
          throw bloqueio.fase === "validacao"
            ? new ChannelSendFailed("http_request falhou (destino não permitido)", "not_sent", false)
            : new ChannelSendFailed("http_request falhou (sem resposta a tempo)", "unknown", false);
        }
        const c = classificarErroDeRede(e, "http_request");
        throw new ChannelSendFailed("http_request falhou", c.outcome, c.retryable);
      }
      if (!ok) throw new ChannelSendFailed("http_request falhou", "unknown", false);
      await marcarFaseDoPasso(alvo, { fase: "enviado", enviado: true });
      return { nextNodeId: node.nextNodeId };
    }

    // -----------------------------------------------------------------------
    // Ligação manual: TRAVA o passo. Registra uma ligação PENDENTE no histórico
    // e segura o enrollment (hold) até o vendedor marcar "feito". Idempotente:
    // não recria a pendência se já houver uma aberta para este nó.
    case "manual_call": {
      const prisma = db();
      const roteiro = node.config?.roteiro?.trim();
      const jaPendente = await prisma.activity.findFirst({
        where: {
          contactId: enr.contactId,
          tipo: "call",
          meta: { path: ["enrollmentId"], equals: enr.id },
        },
      });
      const aberta =
        jaPendente && (jaPendente.meta as { status?: string } | null)?.status === "pending";
      if (!aberta) {
        await prisma.activity.create({
          data: {
            contactId: enr.contactId,
            tipo: "call",
            direcao: "out",
            conteudo: roteiro ? `Ligação pendente: ${roteiro}` : "Ligação pendente",
            meta: {
              kind: "manual_call",
              status: "pending",
              enrollmentId: enr.id,
              nodeId: node.id,
              roteiro: roteiro ?? null,
            },
          } as never,
        });
      }
      return { nextNodeId: node.id, hold: true };
    }

    // -----------------------------------------------------------------------
    // "Atualizar nome pelo WhatsApp": lê o pushName exposto quando o contato
    // respondeu (guardado em Conversation.externalName) e preenche o nome do
    // cadastro se ele ainda não for um nome real (ou sempre, se overwrite).
    case "sync_name": {
      const prisma = db();
      const overwrite = node.config?.overwrite ?? false;
      // Idempotente: sem overwrite, se já há nome real não faz nada.
      if (!overwrite && hasRealName(enr.contact.nome)) {
        return { nextNodeId: node.nextNodeId, skipped: true }; // já tem nome real
      }

      // Prioriza o WhatsApp, na ordem do nome da conversa (pedido do dono, 28/09): o nome que o dono SALVOU NA AGENDA do
      // celular e, na falta, o pushName (só é exposto DEPOIS de o contato interagir e só é gravado de mensagem RECEBIDA).
      let melhorNome = await nomeDoWhatsApp(enr.contactId);
      const pickName = escolherNome;

      // Multicanal: se a resposta/nome veio por OUTRO canal, usa o melhor de lá.
      if (!melhorNome) {
        const outrosRows = await prisma.conversation.findMany({
          where: {
            contactId: enr.contactId,
            canal: { not: "whatsapp" },
            externalName: { not: null },
          },
          orderBy: { updatedAt: "desc" },
          select: { externalName: true },
        });
        melhorNome = pickName(outrosRows.map((r) => r.externalName));
      }

      if (melhorNome && melhorNome !== enr.contact.nome) {
        await prisma.contact.update({ where: { id: enr.contactId }, data: { nome: melhorNome } });
        logger.info({ contactId: enr.contactId, nome: melhorNome }, "[sync_name] nome atualizado pelo canal");
        return { nextNodeId: node.nextNodeId };
      }
      if (melhorNome) {
        // Já era exatamente esse nome — nada a gravar (idempotente).
        return { nextNodeId: node.nextNodeId, skipped: true };
      }
      logger.info({ contactId: enr.contactId }, "[sync_name] sem nome utilizável nos canais — passo pulado");
      return { nextNodeId: node.nextNodeId, skipped: true }; // sem nome utilizável
    }

    // -----------------------------------------------------------------------
    // "Registrar conversa no histórico": traz a conversa inteira do contato no WhatsApp (respondida ou não) e
    // registra no histórico dele. Só com número de WhatsApp cadastrado; sem ele o passo fica SEGURADO ("sem
    // cadastro"), aparece no histórico do fluxo e volta a rodar quando a pessoa cadastrar e retomar.
    case "save_history": {
      const numero = await getWhatsAppNumber(enr.contactId);
      if (!numero) {
        return { nextNodeId: node.id, hold: true, skipped: true, motivo: "Sem cadastro: o contato não tem número de WhatsApp. Cadastre o número e retome o passo." };
      }
      // Só lê: serve conta de WhatsApp que esteja desconectada agora (a Evolution guarda as mensagens do mesmo jeito).
      const contas = await resolveContasWhatsAppParaLeitura(node.config?.channelAccountId);
      if (!contas.length) return { nextNodeId: node.id, hold: true, skipped: true, motivo: "Sem conta de WhatsApp no CRM Agro. Conecte um número e retome o passo." };
      const { registrarConversaNoHistorico } = await import("./registrar-historico");
      let mensagens = 0;
      let novas = 0;
      const falhas: unknown[] = [];
      for (const conta of contas) {
        try {
          const r = await registrarConversaNoHistorico({ teamId: enr.teamId, accountId: conta.id, instance: conta.instance, contactId: enr.contactId, numero });
          mensagens += r.mensagens;
          novas += r.novasNoHistorico;
        } catch (e) {
          falhas.push(e);
        }
      }
      // Nunca "sem conversa" por engano: se a Evolution falhou em todos os números, ou falhou em algum e nenhum outro
      // achou mensagem, o erro sobe e o motor trata (tenta de novo ou segura). Falhou só em um e outro achou: segue e avisa.
      if (falhas.length === contas.length || (falhas.length > 0 && mensagens === 0)) throw falhas[0];
      const aviso = falhas.length > 0 ? ` (${falhas.length} de ${contas.length} números não responderam)` : "";
      if (mensagens === 0) {
        const onde = contas.length === 1 ? "no número de WhatsApp do CRM Agro" : `nos ${contas.length} números de WhatsApp do CRM Agro`;
        return {
          nextNodeId: node.nextNodeId,
          skipped: true,
          motivo: `Sem conversa encontrada para este número ${onde}. Conversa antiga que o WhatsApp guarda só com código anônimo (@lid) não dá para ligar ao telefone.`,
        };
      }
      logger.info({ contactId: enr.contactId, mensagens, novas, contas: contas.length }, "[save_history] conversa registrada no histórico");
      return { nextNodeId: node.nextNodeId, motivo: `${novas} mensagem(ns) nova(s) no histórico, de ${mensagens} na conversa${aviso}` };
    }

    case "enrich_data": {
      const { enriquecerContatoDoFluxo } = await import("./enriquecer-dados");
      const r = await enriquecerContatoDoFluxo(enr.contactId);
      return { nextNodeId: node.nextNodeId, ...(r.skipped ? { skipped: true } : {}), motivo: r.motivo };
    }

    // "Enriquecer empresa" e "Enriquecer pessoa" substituem o "Enriquecer dados" (que segue funcionando).
    case "enrich_company": {
      const { enriquecerEmpresaDoFluxo } = await import("./enriquecer-dados");
      const r = await enriquecerEmpresaDoFluxo(enr.contactId);
      return { nextNodeId: node.nextNodeId, ...(r.skipped ? { skipped: true } : {}), motivo: r.motivo };
    }

    case "enrich_person": {
      const { enriquecerPessoaDoFluxo } = await import("./enriquecer-dados");
      const r = await enriquecerPessoaDoFluxo(enr.contactId, { incluirConfiancaMedia: node.config?.incluirConfiancaMedia === true });
      return { nextNodeId: node.nextNodeId, ...(r.skipped ? { skipped: true } : {}), motivo: r.motivo };
    }

    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // "Agente de IA": gera uma mensagem PERSONALIZADA a partir do contexto do
    // contato + histórico da conversa e a ENVIA pelo canal. Segue a regra de
    // ouro (o core chama `sendMessage` → Channel; nenhum provider aqui) e o
    // mesmo controle de ritmo do send_message (cota por conta, hold sem canal). A IA tem
    // guardrails (ver ai/flow-message.ts) e é FAIL-OPEN: se falhar/desligada,
    // cai num template seguro — nunca trava o fluxo, nunca manda lixo.
    // Modo "mensagem" (padrão): UMA mensagem. Modo "conversa": ver `executarAgenteDeConversa`.
    case "ai_agent": {
      const cfg: Partial<AiAgentConfig> = node.config ?? {};
      // Modo "conversa": o agente fala, espera a resposta, lê o histórico e responde (laço sobre o próprio nó).
      if (cfg.modo === "conversa") return executarAgenteDeConversa(enr, node, cfg);
      const foraDaJanela = await adiarSeForaDaJanela(node, enr);
      if (foraDaJanela) return foraDaJanela;
      const account = await resolveWhatsAppAccount(cfg.channelAccountId);
      if (!account) {
        // Sem conta WhatsApp: mesma proteção do send_message — SEGURA (hold) o
        // contato e marca "Sem Canal" para o vendedor conectar antes de retomar.
        await pushTagOnce(enr.contactId, "Sem Canal");
        return { nextNodeId: node.id, hold: true, skipped: true, motivo: "sem conta de WhatsApp conectada" };
      }

      // Pré-envio determinístico (item 1.2): sem WhatsApp → pula sem gastar cota.
      const number = await getWhatsAppNumber(enr.contactId);
      if (!number) return { nextNodeId: node.nextNodeId, skipped: true, motivo: "contato sem WhatsApp" };

      // "Não escrever se já houver conversa fora da plataforma" (revendas).
      if (cfg.skipIfHistory && account.instance) {
        const hasHistory = await hasWhatsAppHistory({
          apiUrl: env.EVOLUTION_API_URL,
          apiKey: env.EVOLUTION_API_KEY,
          instance: account.instance,
          number,
        });
        if (hasHistory === null) {
          // Não dá para saber (Evolution fora/lenta): hold segura; skip adia.
          if (cfg.onHistory === "hold") {
            return { nextNodeId: node.id, hold: true, skipped: true, motivo: "histórico do WhatsApp indisponível" };
          }
          return { nextNodeId: node.id, delayMs: ADIA_SEM_HISTORICO_MS, deferred: true, motivo: "histórico do WhatsApp indisponível" };
        }
        if (hasHistory) {
          if (cfg.onHistory === "hold") {
            await pushTagOnce(enr.contactId, "Tem Histórico");
            return { nextNodeId: node.id, hold: true, skipped: true, motivo: "já tem conversa no WhatsApp" };
          }
          return { nextNodeId: node.nextNodeId, skipped: true, motivo: "já tem conversa no WhatsApp" };
        }
      }

      // Conversa ANTES da cota (item 1.2).
      const { conversationId } = await startConversationWithContact(account.id, enr.contactId);

      // Controle de ritmo: só envia se houver cota HOJE; sem cota → adia o passo.
      // Limite por contato (item 1.4) antes da cota do número.
      const limiteContato = await adiarSePassouDoLimiteDoContato(enr, node);
      if (limiteContato) return limiteContato;
      const quota = await consumeSendQuota(account.id);
      if (!quota.allowed) {
        await devolverEnvioAoContato(enr.contactId);
        return { nextNodeId: node.id, delayMs: quota.retryAfterMs, deferred: true };
      }

      // Fallback seguro (fail-open) já com as variáveis do contato resolvidas.
      const fallbackRaw = cfg.fallbackText?.trim() || AI_AGENT_FALLBACK_PADRAO;
      const fallback = renderTemplate(fallbackRaw, enr.contact);

      // Geração + envio dentro das marcas: se nada sair (IA vazia, erro antes do
      // canal, not_sent), a cota volta.
      const enviado = await enviarComMarcas(enr, node.id, account.id, async (ganchos) => {
        const { generateFlowMessage } = await import("../ai/flow-message");
        const { text, source } = await generateFlowMessage({
          contactId: enr.contactId,
          contexto: buildContactContext(enr.contact),
          objetivo: cfg.objetivo,
          tom: cfg.tom,
          maxChars: cfg.maxChars ?? AI_AGENT_MAX_CHARS_PADRAO,
          temNomeReal: hasRealName(enr.contact.nome),
          fallback,
          metodologiaId: cfg.metodologiaId,
          provider: cfg.provider,
          model: cfg.model,
          temperature: cfg.temperature,
        });
        const texto = (text ?? "").trim();
        // Guarda extra: se nem a IA nem o fallback produziram texto, não envia
        // (nada de mensagem vazia). Segue o fluxo silenciosamente.
        if (!texto) {
          await devolverCotaDeEnvio(account.id).catch(() => {});
          await devolverEnvioAoContato(enr.contactId);
          logger.warn({ contactId: enr.contactId }, "[ai_agent] sem texto (IA e fallback vazios) — passo pulado");
          return false;
        }
        await sendMessage(conversationId, texto, ganchos);
        logger.info({ contactId: enr.contactId, source, chars: texto.length }, "[ai_agent] mensagem enviada");
        return true;
      });
      if (!enviado) return { nextNodeId: node.nextNodeId, skipped: true, motivo: "IA sem texto" };

      return { nextNodeId: node.nextNodeId, sideEffects: { lastOutboundAt: new Date() } };
    }

    // -----------------------------------------------------------------------
    // Nó terminal explícito: encerra a inscrição (o handler marca `done` quando
    // nextNodeId é null). Deixa o "fim" visível no editor em vez de implícito.
    case "end": {
      return { nextNodeId: null };
    }
  }
}

/** Hash determinístico (FNV-1a 32-bit) → inteiro não-negativo. Base do sorteio
 * estável do A/B: mesma string → mesmo número, sempre. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Rede de segurança da espera por resposta: se nenhum evento acordar a
 * inscrição, ela re-checa a cada REPLY_RECHECK_MS (padrão 60 min) até o fim da
 * janela. Janela de até 60 min = um job só. (Era 30 s: 120 jobs por hora por
 * inscrição.)
 */
const REPLY_RECHECK_MS = Number(process.env.FLOW_REPLY_RECHECK_MIN ?? 60) * 60_000;

/**
 * Janela padrão quando o ramo `responded` não define `janelaMin`.
 *
 * "Respondeu?" medido no instante em que o fluxo chega na condição é sempre
 * falso logo após um envio — ninguém responde em 1 segundo. Fluxos criados
 * antes do campo existir ficariam quebrados para sempre; assumir um padrão é
 * mais correto que honrar um zero que nunca foi uma escolha do usuário.
 */
const JANELA_PADRAO_MIN = 60;

/**
 * Quanto ainda resta (ms) da janela de espera por resposta.
 *
 * Só ramos `responded` com `janelaMin` contam. A janela é medida a partir do
 * último envio do enrollment (`lastOutboundAt`) — é dali que faz sentido contar
 * "respondeu em X minutos?". Sem envio anterior, não há janela.
 * Retorna 0 quando não há janela ou ela já expirou.
 */
function janelaRestanteMs(
  enr: EnrollmentContext,
  branches: Array<{ condition: ConditionDef }>,
): number {
  if (!enr.lastOutboundAt) return 0;
  let maior = 0;
  for (const b of branches) {
    if (b.condition.type !== "responded") continue;
    const janelaMin = b.condition.janelaMin ?? JANELA_PADRAO_MIN;
    const fim = enr.lastOutboundAt.getTime() + janelaMin * 60_000;
    maior = Math.max(maior, fim - Date.now());
  }
  return Math.max(0, maior);
}

/** ms por unidade de tempo dos nós wait/typing. */
function unitFactor(unit: "sec" | "min" | "hour" | "day"): number {
  switch (unit) {
    case "sec":
      return 1_000;
    case "min":
      return 60_000;
    case "hour":
      return 3_600_000;
    case "day":
      return 86_400_000;
  }
}

// ---------------------------------------------------------------------------
// Agente de CONVERSA (`ai_agent`, modo "conversa")
// ---------------------------------------------------------------------------

/** Marca do contato que o agente passou para uma pessoa (o vendedor filtra por ela). */
const TAG_AGENTE_PEDIU_PESSOA = "IA: precisa de uma pessoa";

/** Mensagens do contato na conversa depois de `desde` (a IA ainda não leu). */
async function contarNovasDoContato(conversationId: string, desde: Date): Promise<number> {
  return db().message.count({ where: { conversationId, direcao: "in", createdAt: { gt: desde } } });
}

/**
 * Mensagens que SAÍRAM na conversa depois da última do agente e não são dele: uma pessoa respondeu à mão
 * (pela tela de Conversas ou direto no celular). Quando isso acontece o agente se cala.
 */
async function contarMensagensDeOutros(conversationId: string, estado: Pick<EstadoDoAgente, "enviadoEm" | "mensagemId">): Promise<number> {
  if (!estado.enviadoEm) return 0;
  return db().message.count({
    where: {
      conversationId,
      direcao: "out",
      createdAt: { gt: new Date(estado.enviadoEm) },
      ...(estado.mensagemId ? { id: { not: estado.mensagemId } } : {}),
    },
  });
}

/** Aviso ao dono do contato (mesma forma do nó `notify_user`: uma anotação com `notifyUserId`). */
async function avisarSobreOAgente(enr: EnrollmentContext, texto: string): Promise<void> {
  await db().activity.create({
    data: {
      contactId: enr.contactId,
      tipo: "note",
      direcao: "out",
      conteudo: texto,
      meta: { notifyUserId: enr.contact.ownerId ?? null, kind: "flow_notify", origem: "agente_ia" },
    } as never,
  });
}

/**
 * Executa UM turno do agente de conversa. As fases estão em `agente-conversa.ts`. Regras de segurança:
 * - fora do horário de envio do fluxo o agente não FALA (adia); avaliar a espera não envia nada, então roda;
 * - a abertura segue o limite por contato (3 em 24 h, todos os fluxos) e o "já tem conversa fora da plataforma";
 *   as respostas, não (a conversa já existe): quem limita é `maxRespostas`;
 * - todo envio pela cota do número (aquecimento) e com as marcas de fase (retry seguro);
 * - se a IA falha, tenta de novo (5 min) até `MAX_FALHAS_DA_IA` e então passa para uma pessoa;
 * - uma pessoa respondeu na conversa, o contato pediu para sair (opt-out, no topo do `executeNode`) ou o
 *   contato parou de responder: o agente para e o fluxo segue.
 */
async function executarAgenteDeConversa(
  enr: EnrollmentContext,
  node: { id: string; nextNodeId: string | null },
  cfg: Partial<AiAgentConfig>,
): Promise<NodeResult> {
  const maxRespostas = cfg.maxRespostas ?? AGENTE_MAX_RESPOSTAS_PADRAO;
  const silencioMs = (cfg.silencioHoras ?? AGENTE_SILENCIO_HORAS_PADRAO) * 3_600_000;
  const orientacao = (cfg.orientacao ?? "").trim();
  if (!orientacao) return { nextNodeId: node.nextNodeId, skipped: true, motivo: "agente sem orientação" };

  const anteriores = await db().flowStepExecution.findMany({
    where: { enrollmentId: enr.id, nodeId: node.id, ...(enr.round ? { round: { lt: enr.round } } : {}) },
    orderBy: { round: "desc" },
    take: 30,
    select: { result: true },
  });
  const estado = lerEstadoDoAgente(anteriores.map((a) => a.result));

  /** Fecha o laço: o fluxo segue para o próximo passo. */
  const encerrar = async (
    fim: FimDaConversa,
    base: Pick<EstadoDoAgente, "conversationId" | "enviadas" | "vistoAte" | "enviadoEm" | "mensagemId">,
    motivo?: string,
    extra: { lastOutboundAt?: Date } = {},
  ): Promise<NodeResult> => {
    const texto = textoDoFim(fim, motivo);
    if (fimPedeUmaPessoa(fim)) {
      await pushTagOnce(enr.contactId, TAG_AGENTE_PEDIU_PESSOA);
      if (cfg.avisarVendedor !== false) await avisarSobreOAgente(enr, texto);
    }
    return {
      nextNodeId: node.nextNodeId,
      motivo: texto,
      agente: { ...base, acao: "encerrou", falhas: 0, fim },
      ...(extra.lastOutboundAt ? { sideEffects: { lastOutboundAt: extra.lastOutboundAt } } : {}),
    };
  };

  // 1) Esperando a resposta: acordou pela mensagem do contato ou pelo fim do prazo. Só AVALIA.
  if (estado?.acao === "esperando") {
    const agora = new Date();
    const [novasDoContato, mensagensDeOutros] = await Promise.all([
      contarNovasDoContato(estado.conversationId, new Date(estado.vistoAte)),
      contarMensagensDeOutros(estado.conversationId, estado),
    ]);
    const av = avaliarEspera({ estado, agora, silencioMs, maxRespostas, novasDoContato, mensagensDeOutros });
    switch (av.tipo) {
      case "pessoa_respondeu":
        return encerrar("pessoa_respondeu", estado);
      case "silencio":
        return encerrar("silencio", estado);
      case "limite":
        return encerrar("limite", estado);
      case "continuar_esperando":
        return {
          nextNodeId: node.id,
          delayMs: Math.min(Math.max(REPLY_RECHECK_MS, RECHECK_DO_AGENTE_MS), av.restanteMs),
          aguardandoResposta: { ate: new Date(agora.getTime() + av.restanteMs) },
          agente: estado,
        };
      case "preparar": {
        const pausaMs = pausaAntesDeResponderMs();
        // "Digitando…" durante a pausa (best-effort, nunca derruba o passo), como o nó `typing`.
        if (pausaMs > 0) void sendTyping(estado.conversationId, pausaMs).catch(() => {});
        return { nextNodeId: node.id, delayMs: pausaMs || undefined, agente: { ...estado, acao: "preparando" } };
      }
    }
  }

  // 2) Vai FALAR: a abertura (sem estado) ou a resposta (preparando / tentando de novo).
  const abertura = !estado || estado.enviadas === 0;
  const foraDaJanela = await adiarSeForaDaJanela(node, enr);
  if (foraDaJanela) return foraDaJanela;
  const account = await resolveWhatsAppAccount(cfg.channelAccountId);
  if (!account) {
    await pushTagOnce(enr.contactId, "Sem Canal");
    return { nextNodeId: node.id, hold: true, skipped: true, motivo: "sem conta de WhatsApp conectada" };
  }
  const number = await getWhatsAppNumber(enr.contactId);
  if (!number) return { nextNodeId: node.nextNodeId, skipped: true, motivo: "contato sem WhatsApp" };

  // "Não escrever se já houver conversa fora da plataforma": vale só para ABRIR (depois da 1ª mensagem do
  // agente o histórico do WhatsApp sempre tem conversa).
  if (abertura && cfg.skipIfHistory && account.instance) {
    const hasHistory = await hasWhatsAppHistory({ apiUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY, instance: account.instance, number });
    if (hasHistory === null) {
      if (cfg.onHistory === "hold") return { nextNodeId: node.id, hold: true, skipped: true, motivo: "histórico do WhatsApp indisponível" };
      return { nextNodeId: node.id, delayMs: ADIA_SEM_HISTORICO_MS, deferred: true, motivo: "histórico do WhatsApp indisponível" };
    }
    if (hasHistory) {
      if (cfg.onHistory === "hold") {
        await pushTagOnce(enr.contactId, "Tem Histórico");
        return { nextNodeId: node.id, hold: true, skipped: true, motivo: "já tem conversa no WhatsApp" };
      }
      return { nextNodeId: node.nextNodeId, skipped: true, motivo: "já tem conversa no WhatsApp" };
    }
  }

  // A conversa do estado é a que vale (histórico, "novas mensagens" e "pessoa respondeu" saem dela), mesmo que o
  // número padrão tenha mudado no meio. A cota é do número DESSA conversa.
  let conversationId = "";
  let contaDaCota = account.id;
  if (estado?.conversationId) {
    const conv = await db().conversation.findUnique({ where: { id: estado.conversationId }, select: { id: true, channelAccountId: true } });
    if (conv) {
      conversationId = conv.id;
      if (conv.channelAccountId) contaDaCota = conv.channelAccountId;
    }
  }
  if (!conversationId) ({ conversationId } = await startConversationWithContact(account.id, enr.contactId));
  const base = {
    conversationId,
    enviadas: estado?.enviadas ?? 0,
    vistoAte: estado?.vistoAte ?? new Date().toISOString(),
    enviadoEm: estado?.enviadoEm,
    mensagemId: estado?.mensagemId,
  };

  // Uma pessoa respondeu à mão enquanto o agente preparava a resposta: o agente se cala.
  if (estado && (await contarMensagensDeOutros(conversationId, estado)) > 0) return encerrar("pessoa_respondeu", base);

  // Abertura: limite por contato (3 em 24 h, todos os fluxos) antes da cota do número. Resposta: sem limite
  // por contato, quem limita é `maxRespostas`.
  if (abertura) {
    const limiteContato = await adiarSePassouDoLimiteDoContato(enr, node);
    if (limiteContato) return limiteContato;
  }
  const quota = await consumeSendQuota(contaDaCota);
  if (!quota.allowed) {
    if (abertura) await devolverEnvioAoContato(enr.contactId);
    return { nextNodeId: node.id, delayMs: quota.retryAfterMs, deferred: true };
  }

  const falas = await enviarComMarcas(
    enr,
    node.id,
    contaDaCota,
    async (ganchos) => {
      const { gerarTurnoDaConversa } = await import("../ai/flow-conversa");
      const turno = await gerarTurnoDaConversa({
        contactId: enr.contactId,
        conversationId,
        contexto: buildContactContext(enr.contact),
        orientacao,
        tom: cfg.tom,
        maxChars: cfg.maxChars ?? AI_AGENT_MAX_CHARS_PADRAO,
        temNomeReal: hasRealName(enr.contact.nome),
        abertura,
        enviadas: base.enviadas,
        maxRespostas,
        metodologiaId: cfg.metodologiaId,
        provider: cfg.provider,
        model: cfg.model,
        temperature: cfg.temperature,
      });
      const d = turno.decisao;
      const texto = d.acao === "falhou" ? undefined : d.texto?.trim();
      if (!texto) {
        // Nada sai (a IA falhou, ou decidiu passar/encerrar sem frase): a cota volta.
        await devolverCotaDeEnvio(contaDaCota).catch(() => {});
        if (abertura) await devolverEnvioAoContato(enr.contactId);
        return { turno, enviado: null };
      }
      const msg = await sendMessage(conversationId, texto, ganchos);
      logger.info({ contactId: enr.contactId, acao: d.acao, chars: texto.length, abertura }, "[ai_agent] conversa: mensagem enviada");
      return { turno, enviado: { id: msg.id, em: new Date(msg.createdAt) } };
    },
    { semReservaDoContato: !abertura },
  );

  const { turno, enviado } = falas;
  const d = turno.decisao;

  // A IA falhou: tenta de novo mais tarde. Esgotadas as tentativas, uma pessoa assume. ("responder" que não
  // saiu não deveria acontecer: o texto vem conferido. Se acontecer, conta como falha em vez de calar.)
  if (d.acao === "falhou" || (d.acao === "responder" && !enviado)) {
    const falhas = (estado?.falhas ?? 0) + 1;
    const porque = motivoLegivelDaFalha(d.acao === "falhou" ? d.motivo : "resposta_invalida");
    if (falhas >= MAX_FALHAS_DA_IA) return encerrar("passou_para_pessoa", base, `${porque} (${falhas} tentativas)`);
    return {
      nextNodeId: node.id,
      delayMs: ESPERA_APOS_FALHA_DA_IA_MS,
      deferred: true,
      motivo: `${porque}, tenta de novo em 5 min (${falhas}/${MAX_FALHAS_DA_IA})`,
      agente: { ...base, acao: "tentando_de_novo", falhas },
    };
  }

  const depois = {
    conversationId,
    enviadas: base.enviadas + (enviado ? 1 : 0),
    // O que a IA leu: o contato só "falou de novo" se escrever depois disto.
    vistoAte: (turno.ultimoInboundEm ?? turno.lidoEm).toISOString(),
    enviadoEm: enviado ? enviado.em.toISOString() : base.enviadoEm,
    mensagemId: enviado ? enviado.id : base.mensagemId,
  };
  const lastOutboundAt = enviado ? enviado.em : undefined;

  if (d.acao === "passar_para_humano") return encerrar("passou_para_pessoa", depois, d.motivo, { lastOutboundAt });
  if (d.acao === "encerrar") return encerrar("encerrado_pela_ia", depois, d.motivo, { lastOutboundAt });

  // Respondeu: espera o contato. Se ele escreveu enquanto a IA pensava, não há evento para acordar (a
  // mensagem chegou antes da espera existir): reavalia daqui a pouco, sem esperar.
  const chegouMais = await contarNovasDoContato(conversationId, new Date(depois.vistoAte));
  const saiuEm = enviado ? enviado.em : new Date();
  const resultado: NodeResult = {
    nextNodeId: node.id,
    agente: { ...depois, acao: "esperando", falhas: 0 },
    sideEffects: { lastOutboundAt: saiuEm },
  };
  if (chegouMais > 0) return { ...resultado, delayMs: 5_000 };
  const ate = new Date(saiuEm.getTime() + silencioMs);
  return { ...resultado, delayMs: Math.min(Math.max(REPLY_RECHECK_MS, RECHECK_DO_AGENTE_MS), silencioMs), aguardandoResposta: { ate } };
}

/** Avalia uma condição de ramificação. */
/** Primeiro nome utilizável de uma lista: nome de verdade (sem emoji, símbolo ou caractere solto) e que não é @handle, URL ou e-mail. */
function escolherNome(nomes: ReadonlyArray<string | null | undefined>): string | null {
  for (const bruto of nomes) {
    if (bruto && isLikelyHandle(bruto.trim())) continue;
    const n = limparNomeDoWhatsApp(bruto);
    if (n && hasRealName(n)) return n;
  }
  return null;
}

/**
 * O melhor nome do contato no WhatsApp: o que o dono salvou na agenda do aparelho e, na falta, o nome do perfil
 * (que só aparece depois de o contato interagir). Base do passo "Atualizar nome" e da condição "tem nome no WhatsApp".
 */
async function nomeDoWhatsApp(contactId: string): Promise<string | null> {
  const rows = await db().conversation.findMany({
    where: { contactId, canal: "whatsapp", OR: [{ nomeAgenda: { not: null } }, { externalName: { not: null } }] },
    orderBy: { updatedAt: "desc" },
    select: { externalName: true, nomeAgenda: true },
  });
  return escolherNome(rows.map((r) => r.nomeAgenda)) ?? escolherNome(rows.map((r) => r.externalName));
}

/**
 * O contato tem um número de WhatsApp que dá para usar: existe no cadastro e não foi marcado como errado (numa
 * ligação ou num envio). Só lê o cadastro, não consulta a Evolution. Mesma regra da lista "falta WhatsApp" de Contatos.
 */
async function temWhatsApp(contactId: string): Promise<boolean> {
  const linhas = await db().channelIdentifier.findMany({
    where: { contactId, canal: "whatsapp", invalido: false },
    select: { valor: true, valorCifrado: true },
  });
  return linhas.some((l) => valorDe(l) !== null);
}

/**
 * O contato tem um e-mail para onde o passo "Enviar e-mail" mandaria: existe e não está marcado inválido por
 * bounce. É a MESMA função do envio, então a condição e o passo nunca discordam.
 */
async function temEmail(contactId: string): Promise<boolean> {
  const { emailDeEnvioDoContato } = await import("../email/service");
  return (await emailDeEnvioDoContato(contactId)).email !== null;
}

/**
 * O que o contato respondeu: as mensagens que ele mandou DEPOIS do último envio deste fluxo (até 5, da mais antiga
 * à mais nova). Sem envio no fluxo, as 5 últimas que ele mandou. Só texto (mídia sem legenda fica de fora).
 */
async function respostasDoContato(enr: EnrollmentContext): Promise<string[]> {
  const linhas = await db().activity.findMany({
    where: { contactId: enr.contactId, direcao: "in", ...(enr.lastOutboundAt ? { createdAt: { gt: enr.lastOutboundAt } } : {}) },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { conteudo: true },
  });
  return linhas
    .reverse()
    .map((l) => (l.conteudo ?? "").trim())
    .filter((t) => t && !/^\[(audio|image|video|document|sticker|doc)\]$/i.test(t));
}

/** Resposta de uma condição: sim ou não, ou "ainda não dá para saber": o passo adia (`NodeResult.deferred`) ou segura (`hold`). */
type ResultadoDaCondicao = boolean | { adiar: { delayMs: number; motivo: string } } | { segurar: { motivo: string } };

async function evalCondition(enr: EnrollmentContext, cond: ConditionDef, nodeId: string): Promise<ResultadoDaCondicao> {
  switch (cond.type) {
    case "responded": {
      // Sem último envio neste enrollment → não há janela; não casa (cai no default).
      if (!enr.lastOutboundAt) return false;
      // Canal escolhido no nó ("respondeu no WhatsApp?") — antes era ignorado e
      // qualquer resposta, em qualquer canal, contava.
      return cond.canal
        ? hasInboundOnChannelSince(enr.contactId, enr.lastOutboundAt, cond.canal)
        : hasInboundActivitySince(enr.contactId, enr.lastOutboundAt);
    }
    case "tag_present":
      // O catálogo (o que a tela de Contatos mostra) e o campo antigo; caixa e acento não contam.
      return enr.contact.tags.some((t) => chaveDaTag(t) === chaveDaTag(cond.tag)) || (await contatoTemATag(enr.contactId, cond.tag));
    case "stage_is": {
      const prisma = db();
      const deal = await prisma.deal.findFirst({
        where: { contactId: enr.contactId, stageId: cond.stageId, status: "open" },
      });
      return !!deal;
    }
    case "has_name":
      return hasRealName(enr.contact.nome);
    case "whatsapp_name":
      return (await nomeDoWhatsApp(enr.contactId)) !== null;
    case "has_whatsapp": {
      // Sem `modo` (fluxo de antes) ou "cadastro": só o cadastro, grátis e na hora. "verificar" pergunta ao WhatsApp.
      // `FLOW_CONFERIR_WHATSAPP=off` volta tudo para o cadastro sem mexer nos fluxos.
      if (cond.modo !== "verificar" || !conferirWhatsAppLigado()) return temWhatsApp(enr.contactId);
      const r = await conferirTemWhatsApp({ contactId: enr.contactId, enrollmentId: enr.id, nodeId, janelaEnvio: enr.janelaEnvio });
      return "resposta" in r ? r.resposta : r;
    }
    case "has_email":
      return temEmail(enr.contactId);
    case "channel_history": {
      const prisma = db();
      if (cond.canal === "whatsapp") {
        const account = await resolveWhatsAppAccount(undefined);
        const number = await getWhatsAppNumber(enr.contactId);
        if (account?.instance && number) {
          const historico = await hasWhatsAppHistory({
            apiUrl: env.EVOLUTION_API_URL,
            apiKey: env.EVOLUTION_API_KEY,
            instance: account.instance,
            number,
          });
          // Não sei (Evolution fora/lenta): NÃO escolher ramo no escuro — o ramo
          // errado pode mandar "primeiro contato" para quem já é cliente. Tenta
          // de novo com o backoff do motor (item 1.2).
          if (historico === null) {
            throw new ChannelSendFailed("histórico do WhatsApp indisponível", "not_sent", true);
          }
          return historico;
        }
        return false;
      }
      if (cond.canal === "email") {
        return (await prisma.activity.count({ where: { contactId: enr.contactId, tipo: "email" } })) > 0;
      }
      // instagram
      return !!(await prisma.conversation.findFirst({
        where: { contactId: enr.contactId, canal: "instagram" },
        select: { id: true },
      }));
    }
    case "has_reply": {
      // Qualquer resposta recebida do contato (Activity de entrada), sempre.
      return (await db().activity.count({ where: { contactId: enr.contactId, direcao: "in" } })) > 0;
    }
    case "reply_class": {
      const respostas = await respostasDoContato(enr);
      if (respostas.length === 0) return false;
      return classificarResposta(respostas.join(" ")) === cond.classe;
    }
    case "reply_text":
      return respostaTemTexto(await respostasDoContato(enr), cond.texto, cond.modo);
  }
}
