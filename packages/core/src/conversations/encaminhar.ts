import { z } from "zod";
import type { Canal, Prisma } from "@prisma/client";
import { db } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";
import { consumeSendQuota, devolverCotaDeEnvio } from "../channels-limit/service";
import { replyEmailInConversation } from "../email/service";
import { configDoTimeComCache } from "../motor-do-dia/send-window";
import { DEFAULT_TZ } from "../motor-do-dia/tz";
import { assertMediaAllowed, isMediaMimeAllowed } from "../storage/media-policy";
import { baixarArquivo, storageEnabled } from "../storage/service";
import {
  ESPACO_ENTRE_ENVIOS_MS,
  MAX_DESTINOS_ENCAMINHAR,
  MAX_DESTINOS_NA_LISTA,
  MAX_MENSAGENS_ENCAMINHAR,
} from "./encaminhar-limites";
import { escopoConversa } from "./escopo";
import { ehLid, nomeCompleto, nomeDaConversa } from "./nome";
import { buscaDeConversa, sendMediaMessage, sendMessage } from "./service";

export { ESPACO_ENTRE_ENVIOS_MS, MAX_DESTINOS_ENCAMINHAR, MAX_DESTINOS_NA_LISTA, MAX_MENSAGENS_ENCAMINHAR };

/**
 * "Compartilhar" (encaminhar) mensagem das Conversas.
 *
 * Regras (todas no SERVIDOR, a tela só espelha):
 * - MESMO canal: mensagem de WhatsApp só vai para conversa de WhatsApp (de
 *   qualquer número conectado do time a que a pessoa tem acesso de escrita);
 *   e-mail só para e-mail. Instagram e LinkedIn ainda não enviam pelas
 *   Conversas, então também não encaminham.
 * - Só para conversa que a pessoa pode USAR (escopo de escrita) e do próprio
 *   time. Conversa alheia, de outro time ou inexistente dão a MESMA recusa (não
 *   serve de oráculo de ids).
 * - "Já conversou?": o destino precisa ter histórico (mensagem trocada ou
 *   relacionamento já iniciado). Encaminhar não pode virar primeiro contato
 *   frio, que é o que o controle de ritmo e as regras de campanha controlam.
 * - Quem pediu para sair (opt-out) não recebe.
 * - Controle de ritmo: cada envio gasta a cota diária do número de destino
 *   (`consumeSendQuota`, com aquecimento e pausa) e há pausa entre os envios.
 * - Teto de 5 destinos e 10 mensagens por vez.
 * - O envio de verdade é o do serviço de sempre (`sendMessage`,
 *   `sendMediaMessage`, `replyEmailInConversation`), com `requireCan`. A mídia
 *   é reenviada pelo servidor a partir do arquivo guardado (nada passa pelo
 *   navegador) e a mensagem nova aponta para o mesmo arquivo do Storage (a
 *   limpeza de mídia já preserva arquivo ainda usado por outra mensagem).
 * - O WhatsApp (Evolution) não expõe a marca "Encaminhada": a mensagem sai
 *   normal. No e-mail vale o costume: assunto "Fwd:" e cabeçalho do original.
 *
 * Falha parcial nunca vira erro geral: o resultado diz, por destino, quantas
 * saíram e o que aconteceu com as que não saíram.
 */

/** Pedido inválido (limites, mensagem que não existe, canal sem suporte). A mensagem já é para a pessoa ler. */
export class EncaminhamentoInvalido extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncaminhamentoInvalido";
  }
}

const ROTULO_CANAL: Record<Canal, string> = {
  whatsapp: "WhatsApp",
  email: "e-mail",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

const MSG = {
  destinoNaoEncontrado: "Conversa não encontrada ou sem permissão para enviar por ela.",
  optOut: "Este contato pediu para sair e não recebe mensagens.",
  semHistorico: "Ainda não houve conversa com este contato. Envie a primeira mensagem pela própria conversa.",
  semTelefone: "Esta conversa antiga não tem telefone.",
  contaPausada: "O número está pausado.",
  cotaDoDia: "O número chegou ao limite de envios de hoje.",
  arquivoIlegivel: "Não consegui ler o arquivo da mensagem para reenviar.",
  midiaRecusada: "O WhatsApp não aceitou o envio do arquivo.",
  falhaGenerica: "Não foi possível enviar.",
} as const;

const entradaSchema = z.object({
  messageIds: z
    .array(z.string().min(1))
    .min(1, "Escolha ao menos uma mensagem.")
    .max(MAX_MENSAGENS_ENCAMINHAR, `Encaminhe até ${MAX_MENSAGENS_ENCAMINHAR} mensagens por vez.`),
  destinoIds: z
    .array(z.string().min(1))
    .min(1, "Escolha ao menos uma conversa.")
    .max(MAX_DESTINOS_ENCAMINHAR, `Escolha até ${MAX_DESTINOS_ENCAMINHAR} conversas por vez.`),
});

/** Valida o pedido (ids repetidos contam uma vez). Lança `EncaminhamentoInvalido` com a frase pronta. */
function validarEntrada(entrada: unknown): { messageIds: string[]; destinoIds: string[] } {
  const bruto = (entrada ?? {}) as { messageIds?: unknown; destinoIds?: unknown };
  const unicos = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((x) => (typeof x === "string" ? x : "")))] : []);
  const r = entradaSchema.safeParse({ messageIds: unicos(bruto.messageIds), destinoIds: unicos(bruto.destinoIds) });
  if (!r.success) throw new EncaminhamentoInvalido(r.error.issues[0]?.message ?? "Pedido inválido.");
  return r.data;
}

// ─── Regras puras do destino ────────────────────────────────────────────────

/** O que a regra de destino precisa saber da conversa. */
export type DestinoParaConferir = {
  lastMessageAt: Date | null;
  contactId: string | null;
  externalNumber: string | null;
  contact: { relacionamentoStatus: string } | null;
};

/**
 * Este destino pode receber um encaminhamento? Devolve a frase da recusa ou
 * `null`. Já conversou = há mensagem na conversa OU o contato já não é "novo"
 * (`ja_conversou`/`cliente`, a mesma leitura da lista de campanha).
 */
export function recusaDoDestino(d: DestinoParaConferir, canal: Canal): string | null {
  if (d.contact?.relacionamentoStatus === "opt_out") return MSG.optOut;
  if (canal === "whatsapp" && !d.contactId && ehLid(d.externalNumber)) return MSG.semTelefone;
  const jaConversou = d.lastMessageAt !== null || (d.contact !== null && d.contact.relacionamentoStatus !== "novo");
  if (!jaConversou) return MSG.semHistorico;
  return null;
}

/** O mesmo critério da `recusaDoDestino`, em `where` do Prisma (para a lista só oferecer quem pode receber). */
function elegivelParaReceber(): Prisma.ConversationWhereInput {
  return {
    AND: [
      { OR: [{ lastMessageAt: { not: null } }, { contact: { relacionamentoStatus: { in: ["ja_conversou", "cliente"] } } }] },
      // Escrito com `contactId: null` de propósito: `NOT` sobre relação opcional exclui a linha sem contato.
      { OR: [{ contactId: null }, { contact: { relacionamentoStatus: { not: "opt_out" } } }] },
      { NOT: { AND: [{ contactId: null }, { externalNumber: { endsWith: "@lid" } }] } },
    ],
  };
}

// ─── Lista de destinos ──────────────────────────────────────────────────────

export type DestinoDeEncaminhamento = {
  id: string;
  nome: string;
  /** Telefone (só dígitos/E.164) quando a conversa é de WhatsApp. */
  numero: string | null;
  /** E-mail do contato quando a conversa é de e-mail. */
  email: string | null;
  /** Nome da conta (número/caixa) por onde a mensagem sairia: o mesmo contato pode aparecer em mais de uma. */
  conta: string;
  contaId: string | null;
};

/**
 * Conversas para onde a mensagem da conversa `conversationId` pode ir: só do
 * MESMO canal dela, em qualquer conta conectada do time que a pessoa possa usar,
 * já com histórico, sem opt-out, sem a própria conversa. Busca por nome/número.
 */
export async function listarDestinosDeEncaminhamento(conversationId: string, busca?: string): Promise<DestinoDeEncaminhamento[]> {
  requireCan("messages.send");
  const prisma = db();
  const origem = await prisma.conversation.findFirst({
    where: { AND: [{ id: conversationId }, escopoConversa()] },
    select: { id: true, canal: true },
  });
  if (!origem) throw new EncaminhamentoInvalido("Conversa não encontrada.");
  if (origem.canal !== "whatsapp" && origem.canal !== "email") {
    throw new EncaminhamentoInvalido(`Ainda não dá para encaminhar mensagens de ${ROTULO_CANAL[origem.canal]}.`);
  }
  const termo = busca?.trim().slice(0, 100);
  const convs = await prisma.conversation.findMany({
    where: {
      canal: origem.canal,
      id: { not: origem.id },
      AND: [escopoConversa({ escrita: true }), elegivelParaReceber(), ...(termo ? [buscaDeConversa(termo)] : [])],
    },
    select: {
      id: true,
      canal: true,
      externalNumber: true,
      externalName: true,
      nomeAgenda: true,
      channelAccountId: true,
      channelAccount: { select: { label: true } },
      contact: {
        select: {
          nome: true,
          sobrenome: true,
          identifiers: { where: { canal: { in: ["whatsapp", "email"] } }, select: { canal: true, valor: true, valorCifrado: true, isPrimary: true } },
        },
      },
    },
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    take: MAX_DESTINOS_NA_LISTA,
  });
  return convs.map((c): DestinoDeEncaminhamento => {
    const idents = c.contact?.identifiers ?? [];
    const primeiro = (canal: string) => {
      const doCanal = idents.filter((i) => i.canal === canal);
      return (doCanal.find((i) => i.isPrimary) ?? doCanal[0])?.valor ?? null;
    };
    return {
      id: c.id,
      nome: nomeDaConversa({
        contatoNome: nomeCompleto(c.contact?.nome, c.contact?.sobrenome),
        nomeAgenda: c.nomeAgenda,
        externalName: c.externalName,
        externalNumber: c.externalNumber,
      }),
      numero: c.canal === "whatsapp" ? (primeiro("whatsapp") ?? (ehLid(c.externalNumber) ? null : c.externalNumber)) : null,
      email: c.canal === "email" ? primeiro("email") : null,
      conta: c.channelAccount?.label ?? "",
      contaId: c.channelAccountId,
    };
  });
}

// ─── Encaminhar ─────────────────────────────────────────────────────────────

export type ResultadoDestino = {
  conversationId: string;
  nome: string;
  /** Quantos envios saíram (WhatsApp: mensagens; e-mail: 1 e-mail com todas). Inclui as "não confirmadas". */
  enviadas: number;
  /** Destas, as que o WhatsApp não confirmou (podem já ter chegado: conferir no celular). */
  naoConfirmadas: number;
  /** Quantos envios eram para sair. */
  total: number;
  /** `null` = tudo certo. Senão, a frase pronta do que aconteceu. */
  erro: string | null;
};

export type ResultadoEncaminhamento = {
  destinos: ResultadoDestino[];
  /** Destinos em que tudo saiu. */
  ok: number;
  /** Destinos com algum problema. */
  falhas: number;
};

export type OpcoesEncaminhar = {
  /** Pausa entre envios (ms). Padrão: `ESPACO_ENTRE_ENVIOS_MS`. Os testes passam 0. */
  espacoMs?: number;
  /** Espera injetável (testes). */
  dormir?: (ms: number) => Promise<void>;
};

type Origem = {
  id: string;
  direcao: string;
  tipo: string;
  conteudo: string | null;
  mediaPath: string | null;
  mediaMime: string | null;
  createdAt: Date;
  meta: unknown;
  conversation: { canal: Canal };
};

type Destino = {
  id: string;
  nome: string;
  channelAccountId: string | null;
  enviadas: number;
  naoConfirmadas: number;
  total: number;
  /** Já falhou: não recebe mais nada neste encaminhamento (a ordem da conversa não pode embaralhar). */
  erro: string | null;
};

/**
 * Frase da falha, sem vazar detalhe técnico. Alguns erros do serviço são
 * `new Error("Codigo")` (sem classe): a chave é o nome da classe ou, sem ele, a mensagem.
 */
function mensagemDoErro(e: unknown): string {
  const nome = e instanceof Error ? e.name : "";
  const bruta = e instanceof Error ? e.message : "";
  const msg = bruta.replace(/^[A-Za-z]+: /, "");
  const chave = nome && nome !== "Error" ? nome : bruta;
  switch (chave) {
    case "ContactSemWhatsApp":
      return "O contato não tem WhatsApp cadastrado.";
    case "HistoricoSemTelefone":
    case "EnvioAindaNaoConfirmado":
      return msg || MSG.falhaGenerica;
    case "ChannelNotImplemented":
      return "Este canal ainda não envia mensagens.";
    case "ForbiddenError":
    case "EdicaoNaoPermitida":
    case "OwnedNotFound":
      return "Sem permissão para enviar por esta conversa.";
    case "ConversationNotFound":
      return MSG.destinoNaoEncontrado;
    case "contato sem e-mail cadastrado":
      return "O contato não tem e-mail cadastrado.";
    case "conversa de e-mail inválida":
      return "Esta conversa não tem um contato com e-mail.";
    default:
      if (/nenhuma conta de e-mail conectada/i.test(bruta)) return "Nenhuma caixa de e-mail conectada para enviar.";
      logger.warn({ erro: chave || "desconhecido" }, "[encaminhar] falha no envio");
      return MSG.falhaGenerica;
  }
}

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** "30/09/2026 14:05" no fuso do time. */
function dataHoraBR(d: Date, timeZone: string): string {
  const partes = new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? "";
  return `${p("day")}/${p("month")}/${p("year")} ${p("hour")}:${p("minute")}`;
}

/** "Fwd: assunto", sem empilhar "Fwd: Fwd:". */
export function assuntoEncaminhado(assunto: string | null | undefined): string {
  const base = (assunto ?? "").trim().replace(/^((fwd?|enc)\s*:\s*)+/i, "").trim();
  return `Fwd: ${base || "(sem assunto)"}`;
}

/** Corpo do e-mail encaminhado: cabeçalho do original (de, para, data, assunto) e o texto, um bloco por mensagem. */
export function montarCorpoEncaminhado(
  itens: { de?: string | null; para?: string | null; assunto?: string | null; data: Date; corpo: string | null }[],
  timeZone: string = DEFAULT_TZ,
): string {
  return itens
    .map((i) => {
      const cab = [
        "Mensagem encaminhada",
        "",
        ...(i.de ? [`De: ${i.de}`] : []),
        ...(i.para ? [`Para: ${i.para}`] : []),
        `Data: ${dataHoraBR(i.data, timeZone)}`,
        `Assunto: ${(i.assunto ?? "").trim() || "(sem assunto)"}`,
        "",
      ];
      return `${cab.join("\n")}\n${(i.corpo ?? "").trim()}`;
    })
    .join("\n\n");
}

/**
 * Encaminha as mensagens (na ordem em que aconteceram) para as conversas de
 * destino. Roda dentro de runWithTeam. Lança `EncaminhamentoInvalido` só para
 * pedido inválido (nada é enviado); problema de um destino vai no resultado.
 */
export async function encaminharMensagens(entrada: unknown, opts: OpcoesEncaminhar = {}): Promise<ResultadoEncaminhamento> {
  requireCan("messages.send");
  const { messageIds, destinoIds } = validarEntrada(entrada);
  const prisma = db();

  // Origem: só mensagem de conversa que a pessoa pode ler, do time dela.
  const origens = (await prisma.message.findMany({
    where: { id: { in: messageIds }, conversation: escopoConversa() },
    select: {
      id: true,
      direcao: true,
      tipo: true,
      conteudo: true,
      mediaPath: true,
      mediaMime: true,
      createdAt: true,
      meta: true,
      conversation: { select: { canal: true } },
    },
  })) as Origem[];
  if (origens.length !== messageIds.length) throw new EncaminhamentoInvalido("Mensagem não encontrada.");
  const canal = origens[0]!.conversation.canal;
  if (origens.some((o) => o.conversation.canal !== canal)) {
    throw new EncaminhamentoInvalido("As mensagens escolhidas são de canais diferentes.");
  }
  if (canal !== "whatsapp" && canal !== "email") {
    throw new EncaminhamentoInvalido(`Ainda não dá para encaminhar mensagens de ${ROTULO_CANAL[canal]}.`);
  }
  origens.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  if (canal === "whatsapp") conferirConteudoDoWhatsApp(origens);

  // Destinos: conferidos ANTES de enviar qualquer coisa.
  const convs = await prisma.conversation.findMany({
    where: { AND: [{ id: { in: destinoIds } }, escopoConversa({ escrita: true })] },
    select: {
      id: true,
      canal: true,
      lastMessageAt: true,
      contactId: true,
      externalNumber: true,
      externalName: true,
      nomeAgenda: true,
      channelAccountId: true,
      contact: { select: { nome: true, sobrenome: true, relacionamentoStatus: true } },
    },
  });
  const porId = new Map(convs.map((c) => [c.id, c]));
  const todos: Destino[] = [];
  const ativos: Destino[] = [];
  for (const id of destinoIds) {
    const c = porId.get(id);
    if (!c) {
      todos.push({ id, nome: "Conversa", channelAccountId: null, enviadas: 0, naoConfirmadas: 0, total: 0, erro: MSG.destinoNaoEncontrado });
      continue;
    }
    const nome = nomeDaConversa({
      contatoNome: nomeCompleto(c.contact?.nome, c.contact?.sobrenome),
      nomeAgenda: c.nomeAgenda,
      externalName: c.externalName,
      externalNumber: c.externalNumber,
    });
    const d: Destino = {
      id: c.id,
      nome,
      channelAccountId: c.channelAccountId,
      enviadas: 0,
      naoConfirmadas: 0,
      total: canal === "email" ? 1 : origens.length,
      erro: null,
    };
    todos.push(d);
    if (c.canal !== canal) {
      // Recusa no servidor (não só na tela): WhatsApp só vai para WhatsApp, e-mail só para e-mail.
      d.erro = `Só dá para encaminhar dentro do mesmo canal (esta conversa é de ${ROTULO_CANAL[c.canal]}).`;
      continue;
    }
    const recusa = recusaDoDestino(c, canal);
    if (recusa) {
      d.erro = recusa;
      continue;
    }
    ativos.push(d);
  }

  const espacoMs = opts.espacoMs ?? ESPACO_ENTRE_ENVIOS_MS;
  const dormir = opts.dormir ?? esperar;
  let jaEnviouAlgum = false;
  /** Pausa humana entre um envio e o seguinte (nunca antes do primeiro). */
  const pausar = async () => {
    if (jaEnviouAlgum && espacoMs > 0) await dormir(espacoMs + Math.floor(Math.random() * espacoMs * 0.5));
    jaEnviouAlgum = true;
  };
  /** Gasta 1 envio da cota do número de destino; `false` = recusado (o destino para com o motivo). */
  const gastarCota = async (d: Destino): Promise<boolean> => {
    if (!d.channelAccountId) return true;
    const r = await consumeSendQuota(d.channelAccountId);
    if (r.allowed) return true;
    d.erro = r.reason === "paused" ? MSG.contaPausada : MSG.cotaDoDia;
    return false;
  };
  const devolverCota = async (d: Destino) => {
    if (d.channelAccountId) await devolverCotaDeEnvio(d.channelAccountId).catch(() => undefined);
  };

  if (canal === "email") {
    const tz = (await configDoTimeComCache()).timezone || DEFAULT_TZ;
    const corpo = montarCorpoEncaminhado(
      origens.map((o) => {
        const meta = (o.meta ?? {}) as { subject?: string; from?: string; to?: string };
        return { de: meta.from ?? null, para: meta.to ?? null, assunto: meta.subject ?? null, data: o.createdAt, corpo: o.conteudo };
      }),
      tz,
    );
    const assunto = assuntoEncaminhado((origens[0]!.meta as { subject?: string } | null)?.subject);
    for (const d of ativos) {
      await pausar();
      if (!(await gastarCota(d))) continue;
      try {
        await replyEmailInConversation(d.id, corpo, assunto);
        d.enviadas = 1;
      } catch (e) {
        await devolverCota(d);
        d.erro = mensagemDoErro(e);
      }
    }
  } else {
    for (const o of origens) {
      const vivos = ativos.filter((d) => !d.erro);
      if (vivos.length === 0) break;
      // Mídia: o servidor lê o arquivo guardado UMA vez e reenvia a cada destino.
      let base64: string | null = null;
      if (o.tipo !== "text") {
        try {
          const bytes = await baixarArquivo(o.mediaPath!);
          assertMediaAllowed(o.mediaMime!, bytes.byteLength);
          base64 = Buffer.from(bytes).toString("base64");
        } catch (e) {
          logger.warn({ erro: e instanceof Error ? e.name : "desconhecido" }, "[encaminhar] não leu a mídia guardada");
          for (const d of vivos) d.erro = MSG.arquivoIlegivel;
          continue;
        }
      }
      for (const d of vivos) {
        await pausar();
        if (!(await gastarCota(d))) continue;
        try {
          if (o.tipo === "text") {
            await sendMessage(d.id, o.conteudo!);
            d.enviadas++;
          } else {
            const enviada = await sendMediaMessage(d.id, {
              mediaPath: o.mediaPath!,
              mediaMime: o.mediaMime!,
              base64: base64!,
              caption: o.conteudo ?? undefined,
            });
            if (enviada.status === "failed") {
              // Ficou só na plataforma (o provedor recusou): não conta como enviada nem gasta a cota.
              await devolverCota(d);
              d.erro = MSG.midiaRecusada;
            } else {
              d.enviadas++;
              if (enviada.status === "unconfirmed") d.naoConfirmadas++;
            }
          }
        } catch (e) {
          await devolverCota(d);
          d.erro = mensagemDoErro(e);
        }
      }
    }
  }

  const destinos = todos.map((d): ResultadoDestino => {
    // Parou no meio: diz até onde foi (ex.: "Enviadas 2 de 5. O número está pausado.").
    const parcial = d.erro && d.enviadas > 0 && d.enviadas < d.total;
    return {
      conversationId: d.id,
      nome: d.nome,
      enviadas: d.enviadas,
      naoConfirmadas: d.naoConfirmadas,
      total: d.total,
      erro: d.erro ? (parcial ? `Enviadas ${d.enviadas} de ${d.total}. ${d.erro}` : d.erro) : null,
    };
  });
  const falhas = destinos.filter((d) => d.erro !== null).length;
  return { destinos, ok: destinos.length - falhas, falhas };
}

/** Confere, antes de enviar qualquer coisa, que cada mensagem de WhatsApp tem o que reenviar. */
function conferirConteudoDoWhatsApp(origens: Origem[]): void {
  for (const o of origens) {
    if (o.tipo === "text") {
      if (!o.conteudo?.trim()) throw new EncaminhamentoInvalido("Uma das mensagens está vazia e não dá para encaminhar.");
      continue;
    }
    if (!o.mediaPath || !o.mediaMime) throw new EncaminhamentoInvalido("Uma das mídias não está disponível para reenviar.");
    if (!isMediaMimeAllowed(o.mediaMime)) throw new EncaminhamentoInvalido("Um dos arquivos é de um tipo que o CRM Agro não reenvia.");
  }
  if (origens.some((o) => o.tipo !== "text") && !storageEnabled()) {
    throw new EncaminhamentoInvalido("O armazenamento de mídia não está configurado no servidor.");
  }
}
