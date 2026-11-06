import { basePrisma, db, getCurrentTeamId } from "@crmagro/db";
import { env } from "@crmagro/config";
import {
  descobrirLidDoTelefone,
  descobrirTelefoneDoLid,
  ehJidLid,
  normalizePhone,
  phoneVariants,
  type ParLid,
} from "@crmagro/channels";
import { requireCan } from "../auth/authz";
import { assertOwned } from "../tenancy/assert-owned";
import { escopoDoContato } from "../contacts/escopo";
import { ondeConversaPorNumero, ondeIdentificadorExato, valorDe } from "../contacts/identificadores-cifra";
import { isUniqueViolation } from "../contacts/errors";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import { escopoConversa } from "./escopo";
import { ehLid, nomeDePessoaValido } from "./nome";
import { invalidarNaoLidas } from "./ultima-mensagem";
import { gravarParesLid, lerParesLid, lidResumido, type OrigemParLid } from "./lid-mapa";

/**
 * Unificação de conversas do WhatsApp que são da MESMA pessoa: a "sem número"
 * (`…@lid`, código anônimo) e a que tem o telefone. Causa, desenho e riscos em
 * a documentação interna.
 *
 * Regras que valem para tudo aqui:
 * - só junta dentro da MESMA conta (número) e do MESMO time (índice único parcial
 *   conta+contato / conta+número; o time vem do contexto, nunca de parâmetro);
 * - mensagem nunca some: são MOVIDAS (o índice único `teamId + providerMessageId`
 *   garante que a mesma mensagem do WhatsApp não existe duas vezes) e a conversa
 *   de origem só é apagada quando ficou sem nenhuma;
 * - idempotente: repetir não muda nada (a origem já não existe, ou já não é @lid);
 * - transação + trava (advisory + linha da conversa de origem): duas unificações
 *   ao mesmo tempo, ou uma mensagem chegando na conversa que está sendo juntada,
 *   esperam a vez em vez de se atropelar.
 */

// ─── Erros (mensagens escritas para a pessoa ler; ver apps/web/lib/erros.ts) ────

export class ConversaJaTemNumero extends Error {
  constructor() {
    super("Esta conversa já tem número. Não há o que unificar.");
    this.name = "ConversaJaTemNumero";
  }
}

export class ContatoSemWhatsApp extends Error {
  constructor() {
    super("Este contato não tem número de WhatsApp cadastrado. Cadastre o número no contato e tente de novo.");
    this.name = "ContatoSemWhatsApp";
  }
}

export class NumeroDoLidNaoEncontrado extends Error {
  constructor() {
    super("O CRM Agro não conseguiu descobrir o número desta conversa. Escolha o contato na lista.");
    this.name = "NumeroDoLidNaoEncontrado";
  }
}

export class LidComOutroNumero extends Error {
  constructor(telefone: string) {
    super(
      `O WhatsApp indica que esta conversa é de um número que termina em ${telefone.replace(/\D/g, "").slice(-4)}, e esse contato tem outro número. Por segurança, o CRM Agro não juntou as conversas.`,
    );
    this.name = "LidComOutroNumero";
  }
}

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type ResultadoUnificacao = {
  /**
   * `mesclada`: as mensagens passaram para a conversa do número/contato e a
   * conversa sem número foi apagada (vazia). `promovida`: não havia outra
   * conversa, então a própria conversa sem número passou a ter o telefone (ou o
   * contato). `nada`: já estava unificada ou não era uma conversa sem número.
   */
  acao: "mesclada" | "promovida" | "nada";
  /** Conversa que ficou (a do número/contato), quando houve. */
  conversationId: string | null;
  mensagensMovidas: number;
};

const NADA: ResultadoUnificacao = { acao: "nada", conversationId: null, mensagensMovidas: 0 };

/** O que a transação devolve: o resultado e as não-lidas que passaram de uma conversa para a outra. */
type SaidaDaTransacao = { resultado: ResultadoUnificacao; naoLidas: number };

// ─── O coração: juntar UMA conversa @lid com o número ────────────────────────

/**
 * Junta a conversa `conversationId` (sem número, `…@lid`) com a do telefone
 * `telefone`. Destino, nesta ordem: a conversa do contato (o dado em
 * `contactId`, ou o dono do número), ou a conversa solta desse número na mesma
 * conta. Sem nenhuma das duas, a própria conversa passa a ter o número (ou o
 * contato). Roda dentro do contexto de um time (`runWithTeam`/`runAsSystem`).
 */
async function juntarConversaLid(input: {
  conversationId: string;
  telefone: string;
  contactId: string | null;
}): Promise<ResultadoUnificacao> {
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("Sem time no contexto");
  const telefone = normalizePhone(input.telefone);
  if (!telefone) return NADA;

  for (let tentativa = 0; ; tentativa++) {
    try {
      const { resultado, naoLidas } = await db().$transaction(
        async (tx): Promise<SaidaDaTransacao> => {
          // 1) Trava por conversa de origem: duas unificações da mesma conversa
          //    (webhook + tela, ou dois webhooks) esperam a vez.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wa-lid:${teamId}:${input.conversationId}`}, 0))`;
          // 2) Trava a LINHA da origem: uma mensagem que chega nela agora (o
          //    INSERT pede lock na conversa pai) espera até acabarmos, em vez de
          //    ser apagada junto com a conversa.
          const travada = await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "Conversation" WHERE "id" = ${input.conversationId} AND "teamId" = ${teamId} FOR UPDATE`;
          if (travada.length === 0) return { resultado: NADA, naoLidas: 0 };

          const origem = await tx.conversation.findFirst({
            where: { id: input.conversationId },
            select: {
              id: true,
              canal: true,
              contactId: true,
              externalNumber: true,
              externalName: true,
              nomeAgenda: true,
              channelAccountId: true,
              unreadCount: true,
              lastMessageAt: true,
              lastMessagePreview: true,
              lastMessageDirecao: true,
              lastMessageSubject: true,
            },
          });
          // Já unificada (não existe mais) ou já com número: nada a fazer (idempotência).
          if (!origem || origem.canal !== "whatsapp" || origem.contactId !== null || !ehLid(origem.externalNumber)) {
            return { resultado: NADA, naoLidas: 0 };
          }

          const variantes = phoneVariants(telefone);
          let contactId = input.contactId;
          if (!contactId) {
            const dono = await tx.channelIdentifier.findFirst({
              where: ondeIdentificadorExato(teamId, "whatsapp", variantes),
              select: { contactId: true },
            });
            contactId = dono?.contactId ?? null;
          }
          const destino = await tx.conversation.findFirst({
            where: contactId
              ? { contactId, canal: origem.canal, channelAccountId: origem.channelAccountId, id: { not: origem.id } }
              : {
                  contactId: null,
                  ...ondeConversaPorNumero(teamId, variantes),
                  canal: origem.canal,
                  channelAccountId: origem.channelAccountId,
                  id: { not: origem.id },
                },
            select: { id: true, lastMessageAt: true, externalName: true, nomeAgenda: true },
          });

          if (!destino) {
            // Sem outra conversa: esta passa a ter o número (ou o contato).
            await tx.conversation.update({
              where: { id: origem.id },
              data: contactId ? { contactId, externalNumber: null } : { externalNumber: telefone },
            });
            return { resultado: { acao: "promovida", conversationId: origem.id, mensagensMovidas: 0 }, naoLidas: 0 };
          }

          await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${destino.id} AND "teamId" = ${teamId} FOR UPDATE`;
          const movidas = await tx.message.updateMany({
            where: { conversationId: origem.id },
            data: { conversationId: destino.id },
          });
          // A origem é mais recente → a prévia dela vai junto com o horário.
          const origemMaisNova =
            !!origem.lastMessageAt && (!destino.lastMessageAt || origem.lastMessageAt > destino.lastMessageAt);
          const nomeAgenda = destino.nomeAgenda ?? origem.nomeAgenda;
          const externalName = destino.externalName ?? nomeDePessoaValido(origem.externalName);
          await tx.conversation.update({
            where: { id: destino.id },
            data: {
              unreadCount: { increment: origem.unreadCount },
              ...(origemMaisNova
                ? {
                    lastMessageAt: origem.lastMessageAt,
                    lastMessagePreview: origem.lastMessagePreview,
                    lastMessageDirecao: origem.lastMessageDirecao,
                    lastMessageSubject: origem.lastMessageSubject,
                  }
                : {}),
              // Só PREENCHE nome que falta; nunca troca o que a conversa do número já tem.
              ...(nomeAgenda && nomeAgenda !== destino.nomeAgenda ? { nomeAgenda } : {}),
              ...(externalName && externalName !== destino.externalName ? { externalName } : {}),
            },
          });
          // Cinto e suspensório: NUNCA apagar conversa que ainda tenha mensagem
          // (apagar leva as mensagens junto, por cascade). Com a trava acima isto
          // não acontece; se acontecer, aborta a transação inteira.
          const restantes = await tx.message.count({ where: { conversationId: origem.id } });
          if (restantes > 0) throw new Error(`UnificacaoIncompleta: ${restantes} mensagem(ns) ficaram na conversa de origem`);
          await tx.conversation.deleteMany({ where: { id: origem.id } });
          return {
            resultado: { acao: "mesclada", conversationId: destino.id, mensagensMovidas: movidas.count },
            naoLidas: origem.unreadCount,
          };
        },
        { timeout: 30_000 },
      );
      if (naoLidas > 0) await invalidarNaoLidas(teamId); // duas conversas com não-lidas viraram uma
      if (resultado.acao !== "nada") {
        logger.info(
          { teamId, acao: resultado.acao, origem: input.conversationId, destino: resultado.conversationId, mensagens: resultado.mensagensMovidas },
          "[wa-lid] conversa sem número unificada",
        );
      }
      return resultado;
    } catch (e) {
      // Outra escrita criou a conversa do número entre a leitura e a gravação
      // (índice único parcial): relê e junta na que ganhou. Uma vez só.
      if (tentativa === 0 && isUniqueViolation(e)) continue;
      throw e;
    }
  }
}

// ─── Ponto de descoberta: o CRM Agro soube que `lid` é `telefone` ────────────────

/**
 * Guarda o par no mapa do time e junta as conversas sem número desse @lid com a
 * do telefone (uma por conta). É a chamada do ponto em que o número é
 * descoberto. Idempotente. Roda em `runAsSystem`/`runWithTeam`; exige poder de
 * mexer em conversa. Só toca as conversas desse @lid exato, nunca varre a base.
 */
export async function aplicarParLid(par: ParLid, origem: OrigemParLid): Promise<ResultadoUnificacao[]> {
  requireCan("messages.send");
  const teamId = getCurrentTeamId();
  const telefone = normalizePhone(par.telefone);
  if (!teamId || !telefone || !ehJidLid(par.lid)) return [];
  await gravarParesLid(basePrisma, teamId, [{ lid: par.lid, telefone }], origem);
  const conversas = await db().conversation.findMany({
    where: { contactId: null, canal: "whatsapp", ...ondeConversaPorNumero(teamId, [par.lid]), channelAccountId: { not: null } },
    select: { id: true },
  });
  const out: ResultadoUnificacao[] = [];
  for (const c of conversas) {
    out.push(await juntarConversaLid({ conversationId: c.id, telefone, contactId: null }));
  }
  return out;
}

// ─── Descoberta a partir de uma mensagem recebida (webhook → worker) ──────────

/** Quanto tempo a resposta "já procurei o @lid deste telefone" vale (por conta e telefone). */
const JA_PROCUREI_S = 30 * 86_400;
/** Conta sem conversa "sem número" esperando: não confere de novo por este tempo (poupa uma varredura por mensagem). */
const SEM_ESPERA_S = 10 * 60;
/** Consulta falhou (Evolution lenta ou fora): a conta descansa este tempo, para a fila do inbound não empilhar espera. */
const DESCANSO_APOS_FALHA_S = 5 * 60;

/**
 * Chamada de `receiveInbound`, DEPOIS de a mensagem estar gravada. Descobre o par
 * @lid ↔ telefone da pessoa que acabou de escrever e junta a conversa antiga sem
 * número (se houver). Nunca lança: uma falha aqui não pode derrubar a mensagem.
 *
 * Dois caminhos:
 * 1. o webhook trouxe o @lid junto (`remoteJid` = @lid, telefone em
 *    `remoteJidAlt`): o par já está na mão;
 * 2. Evolution 2.3.7: o webhook troca o @lid pelo telefone (o par só está no
 *    banco dela). Só então consulta a Evolution (SÓ leitura), e SÓ quando a
 *    conta tem alguma conversa sem número esperando, no máximo uma vez por
 *    telefone a cada 30 dias. Conta sem conversa @lid não paga quase nada (uma
 *    conferência a cada 10 min) e uma Evolution com falha deixa a conta
 *    descansar 5 min em vez de segurar cada mensagem por até 5 s.
 */
export async function descobrirEUnificarLid(input: {
  channelAccountId: string;
  instance: string | null;
  telefone: string;
  remoteJid: string | null | undefined;
}): Promise<void> {
  const conta = input.channelAccountId;
  try {
    if (!normalizePhone(input.telefone)) return; // só telefone de verdade (nunca o próprio @lid)
    if (ehJidLid(input.remoteJid)) {
      await aplicarParLid({ lid: input.remoteJid, telefone: input.telefone }, "webhook");
      return;
    }
    if (!input.instance) return;
    const chaveProcurado = `wa:lid:procurado:${conta}:${input.telefone}`;
    const chaveSemEspera = `wa:lid:sem-espera:${conta}`;
    const chaveFalha = `wa:lid:falha:${conta}`;
    // Uma ida ao Redis: já procurou este telefone, a conta não tem nada esperando, ou está descansando.
    const marcas = await redisEstado().mget(chaveProcurado, chaveSemEspera, chaveFalha);
    if (marcas.some((m) => m !== null)) return;
    const esperando = await db().conversation.findFirst({
      where: { channelAccountId: conta, contactId: null, canal: "whatsapp", externalNumber: { endsWith: "@lid" } },
      select: { id: true },
    });
    if (!esperando) {
      await redisEstado().set(chaveSemEspera, "1", "EX", SEM_ESPERA_S);
      return;
    }
    try {
      const lid = await descobrirLidDoTelefone({
        apiUrl: env.EVOLUTION_API_URL,
        apiKey: env.EVOLUTION_API_KEY,
        instance: input.instance,
        telefone: input.telefone,
      });
      if (lid) await aplicarParLid({ lid, telefone: input.telefone }, "evolution");
      // Só DEPOIS de dar certo (achou e juntou, ou a Evolution respondeu que não tem
      // par): não pergunta de novo tão cedo. Falha não deixa esta marca.
      await redisEstado().set(chaveProcurado, "1", "EX", JA_PROCUREI_S);
    } catch (e) {
      await redisEstado().set(chaveFalha, "1", "EX", DESCANSO_APOS_FALHA_S).catch(() => undefined);
      throw e;
    }
  } catch (e) {
    logger.warn(
      { conta, err: e instanceof Error ? e.message : String(e) },
      "[wa-lid] não deu para descobrir/unificar o @lid desta mensagem (a mensagem já foi gravada)",
    );
  }
}

// ─── Ação da tela: "Unificar com o contato" ───────────────────────────────────

/** Conversa sem número (`@lid`, sem contato) no escopo de quem age; senão erro. */
async function conversaSemNumero(conversationId: string) {
  const conv = await db().conversation.findFirst({
    where: { AND: [{ id: conversationId }, escopoConversa()] },
    select: {
      id: true,
      canal: true,
      contactId: true,
      externalNumber: true,
      channelAccountId: true,
      channelAccount: { select: { externalId: true, provider: true } },
      _count: { select: { messages: true } },
    },
  });
  if (!conv) throw new Error("ConversationNotFound");
  if (conv.canal !== "whatsapp" || conv.contactId !== null || !ehLid(conv.externalNumber)) return { conv, lid: null };
  return { conv, lid: conv.externalNumber! };
}

/** Telefone do @lid: primeiro o mapa do time; depois o banco da Evolution (só leitura). */
async function telefoneDoLid(
  teamId: string,
  lid: string,
  instance: string | null,
): Promise<{ telefone: string | null; fonte: "mapa" | "evolution" | null; evolutionIndisponivel: boolean }> {
  const noMapa = (await lerParesLid(basePrisma, teamId, [lid])).get(lid);
  if (noMapa) return { telefone: noMapa.telefone, fonte: "mapa", evolutionIndisponivel: false };
  if (!instance) return { telefone: null, fonte: null, evolutionIndisponivel: false };
  try {
    const telefone = await descobrirTelefoneDoLid({
      apiUrl: env.EVOLUTION_API_URL,
      apiKey: env.EVOLUTION_API_KEY,
      instance,
      lid,
    });
    return { telefone, fonte: telefone ? "evolution" : null, evolutionIndisponivel: false };
  } catch (e) {
    logger.warn({ lid: lidResumido(lid), err: e instanceof Error ? e.message : String(e) }, "[wa-lid] consulta à Evolution falhou");
    return { telefone: null, fonte: null, evolutionIndisponivel: true };
  }
}

export type SugestaoUnificacao = {
  /** A conversa é mesmo uma conversa sem número (só nela a ação faz sentido). */
  aplicavel: boolean;
  /** Telefone que o CRM Agro descobriu para esta conversa (E.164), ou null. */
  telefone: string | null;
  fonte: "mapa" | "evolution" | null;
  /** A Evolution não respondeu: o número pode existir, mas não deu para conferir agora. */
  evolutionIndisponivel: boolean;
  /** Contato dono desse telefone que quem age PODE alterar (é o dele ou "ver e editar de todos"). */
  contato: { id: string; nome: string } | null;
  /** O telefone é de um contato que quem age não pode alterar (de um colega): a unificação seria recusada. */
  numeroDeOutraPessoa: boolean;
  /** Já existe uma conversa desse número nesta conta (a unificação vai juntar as duas). */
  jaTemConversa: boolean;
  mensagens: number;
};

/**
 * O que o CRM Agro sabe para propor a unificação de uma conversa sem número: o
 * telefone (mapa do time ou banco da Evolution), o contato dono dele e se há
 * outra conversa do número. SÓ leitura, não grava nada.
 */
export async function sugerirUnificacaoLid(conversationId: string): Promise<SugestaoUnificacao> {
  requireCan("messages.send");
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("Sem time no contexto");
  const { conv, lid } = await conversaSemNumero(conversationId);
  const vazia: SugestaoUnificacao = {
    aplicavel: false,
    telefone: null,
    fonte: null,
    evolutionIndisponivel: false,
    contato: null,
    numeroDeOutraPessoa: false,
    jaTemConversa: false,
    mensagens: conv._count.messages,
  };
  if (!lid) return vazia;
  const instance = conv.channelAccount?.provider === "evolution" ? (conv.channelAccount.externalId ?? null) : null;
  const achado = await telefoneDoLid(teamId, lid, instance);
  const base = { ...vazia, aplicavel: true, telefone: achado.telefone, fonte: achado.fonte, evolutionIndisponivel: achado.evolutionIndisponivel };
  if (!achado.telefone) return base;
  const variantes = phoneVariants(achado.telefone);
  const dono = await db().channelIdentifier.findFirst({
    where: ondeIdentificadorExato(teamId, "whatsapp", variantes),
    select: { contactId: true },
  });
  // Mesmo escopo da unificação (ESCRITA): contato de colega que a pessoa só vê, ou nem vê, não serve.
  const contato = dono
    ? await db().contact.findFirst({ where: { AND: [{ id: dono.contactId }, escopoDoContato({ escrita: true })] }, select: { id: true, nome: true } })
    : null;
  const numeroDeOutraPessoa = !!dono && !contato;
  const outra = await db().conversation.findFirst({
    where: contato
      ? { contactId: contato.id, canal: "whatsapp", channelAccountId: conv.channelAccountId, id: { not: conv.id } }
      : { contactId: null, ...ondeConversaPorNumero(teamId, variantes), canal: "whatsapp", channelAccountId: conv.channelAccountId, id: { not: conv.id } },
    select: { id: true },
  });
  return { ...base, contato, numeroDeOutraPessoa, jaTemConversa: !!outra };
}

/** Para onde unificar: um contato escolhido na lista, ou o número que o CRM Agro descobriu. */
export type AlvoDaUnificacao = { contactId: string } | { usarNumeroEncontrado: true };

/**
 * "Unificar com o contato" (menu da conversa sem número). Move as mensagens da
 * conversa sem número para a conversa do contato (ou do número) e apaga a
 * conversa vazia. Exige poder de enviar mensagem, a conversa no escopo de
 * ESCRITA de quem age e, se escolheu o contato, que ele também esteja no
 * escopo. Se o WhatsApp já disse a qual número a conversa pertence e o contato
 * escolhido tem outro, recusa (`LidComOutroNumero`).
 */
export async function unificarConversaSemNumero(conversationId: string, alvo: AlvoDaUnificacao): Promise<ResultadoUnificacao> {
  requireCan("messages.send");
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("Sem time no contexto");
  const { conv, lid } = await conversaSemNumero(conversationId);
  await assertOwned("conversation", conversationId); // escrita: a conversa do número do colega pede "Ver e editar"
  if (!lid) throw new ConversaJaTemNumero();

  if ("contactId" in alvo) {
    await assertOwned("contact", alvo.contactId);
    const numeros = await db().channelIdentifier.findMany({
      where: { contactId: alvo.contactId, canal: "whatsapp" },
      orderBy: [{ invalido: "asc" }, { isPrimary: "desc" }, { createdAt: "asc" }],
      select: { valor: true, valorCifrado: true },
    });
    const numerosLegiveis = numeros.flatMap((n) => {
      const valor = valorDe(n);
      return valor ? [{ valor }] : [];
    });
    const primeiro = numerosLegiveis[0];
    if (!primeiro) throw new ContatoSemWhatsApp();
    const doContato = new Set(numerosLegiveis.flatMap((n) => phoneVariants(n.valor)));
    const conhecido = (await lerParesLid(basePrisma, teamId, [lid])).get(lid);
    if (conhecido && conhecido.origem !== "manual" && !phoneVariants(conhecido.telefone).some((v) => doContato.has(v))) {
      throw new LidComOutroNumero(conhecido.telefone);
    }
    // O telefone do contato que casa com o que o WhatsApp disse (ou o principal).
    const telefone = conhecido ? (numerosLegiveis.find((n) => phoneVariants(conhecido.telefone).includes(n.valor))?.valor ?? primeiro.valor) : primeiro.valor;
    await gravarParesLid(basePrisma, teamId, [{ lid, telefone }], "manual");
    return juntarConversaLid({ conversationId, telefone, contactId: alvo.contactId });
  }

  const instance = conv.channelAccount?.provider === "evolution" ? (conv.channelAccount.externalId ?? null) : null;
  const achado = await telefoneDoLid(teamId, lid, instance);
  if (!achado.telefone) throw new NumeroDoLidNaoEncontrado();
  // Se o número é de um contato, a mesma regra do contato escolhido na lista vale:
  // não junta com o contato de um colega que a pessoa não pode alterar.
  const dono = await db().channelIdentifier.findFirst({
    where: ondeIdentificadorExato(teamId, "whatsapp", phoneVariants(achado.telefone)),
    select: { contactId: true },
  });
  if (dono) await assertOwned("contact", dono.contactId);
  if (achado.fonte === "evolution") await gravarParesLid(basePrisma, teamId, [{ lid, telefone: achado.telefone }], "evolution");
  return juntarConversaLid({ conversationId, telefone: achado.telefone, contactId: dono?.contactId ?? null });
}
