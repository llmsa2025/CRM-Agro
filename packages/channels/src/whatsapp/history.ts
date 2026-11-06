import { z } from "zod";
import { evolutionHeaders, evolutionFetch, exigirOk, EVOLUTION_TIMEOUT_MS } from "./http";
import { analisarEvolutionInbound } from "./inbound";
import { ehJidLid } from "./lid";
import { phoneVariants } from "../phone";
import type { InboundMessage } from "../types";

const historyPageSchema = z.object({
  messages: z.object({
    total: z.number().int().nonnegative(),
    pages: z.number().int().nonnegative(),
    currentPage: z.number().int().positive(),
    records: z.array(z.unknown()),
  }),
});

export type WhatsAppHistoryPage = {
  total: number;
  pages: number;
  records: number;
  messages: InboundMessage[];
};

class EvolutionHistoryInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionHistoryInvalid";
  }
}

/** Tamanho padrão da página do histórico. */
export const WHATSAPP_HISTORY_PAGE_SIZE = 250;

/**
 * A Evolution usa `offset` como TAMANHO da página; o filtro recebe datas ISO.
 * `tamanho: 1` serve para só conferir o total (sem baixar 250 mensagens).
 */
export async function fetchWhatsAppHistoryPage(input: {
  apiUrl: string; apiKey: string; instance: string; page: number; until: string; tamanho?: number;
}): Promise<WhatsAppHistoryPage> {
  const res = await evolutionFetch(
    `${input.apiUrl.replace(/\/$/, "")}/chat/findMessages/${encodeURIComponent(input.instance)}`,
    {
      method: "POST",
      headers: evolutionHeaders(input.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        page: input.page, offset: input.tamanho ?? WHATSAPP_HISTORY_PAGE_SIZE,
        where: { messageTimestamp: { gte: "2009-01-01T00:00:00.000Z", lte: input.until } },
      }),
      cache: "no-store",
    },
    30_000,
    "Evolution histórico",
  );
  await exigirOk(res, "Evolution histórico");
  const { messages: data } = historyPageSchema.parse(await res.json());
  if (data.currentPage !== input.page) throw new EvolutionHistoryInvalid("Evolution devolveu outra página do histórico");
  if (input.page <= data.pages && data.records.length === 0) throw new EvolutionHistoryInvalid("Evolution devolveu uma página vazia do histórico");
  const messages: InboundMessage[] = [];
  for (const record of data.records) {
    const r = analisarEvolutionInbound({ instance: input.instance, data: record }, { preservarLidHistorico: true });
    // IDs e datas são obrigatórios no backfill: sem eles, retry duplica e a
    // mensagem antiga apareceria como se tivesse acabado de chegar.
    if (r.ok && r.msg.providerMessageId && r.msg.timestamp && (r.msg.text !== null || r.msg.media)) {
      messages.push(r.msg);
    }
  }
  return { total: data.total, pages: data.pages, records: data.records.length, messages };
}

type ChaveDaMensagem = { remoteJid?: unknown; remoteJidAlt?: unknown; senderPn?: unknown };

/**
 * O `@lid` do registro, se a Evolution o amarrou a ESTE número: `remoteJid` é o código anônimo e o telefone
 * (`remoteJidAlt`, ou `senderPn` nas versões antigas) é uma das variantes do número. Compara só os dígitos, sem
 * normalizar: número fora do padrão do Brasil também casa. Qualquer outro caso → null.
 */
function lidAmarradoAoNumero(key: ChaveDaMensagem | null | undefined, doNumero: ReadonlySet<string>): string | null {
  if (!key || typeof key.remoteJid !== "string" || !ehJidLid(key.remoteJid)) return null;
  const alt = key.remoteJidAlt ?? key.senderPn;
  if (typeof alt !== "string" || !alt.endsWith("@s.whatsapp.net")) return null;
  const telefone = alt.replace(/@.+$/, "").replace(/:\d+$/, "").replace(/\D/g, "");
  return doNumero.has(telefone) ? key.remoteJid : null;
}

/** Quantos códigos anônimos (`@lid`) a busca segue a partir das mensagens do número (um número tem 1; sobra folga). */
const LIDS_SEGUIDOS_NO_MAXIMO = 5;

/**
 * Todas as mensagens da conversa com UM número (as que a Evolution guardou do aparelho), da mais antiga à mais
 * nova. Uma consulta paginada por variante do número (com/sem o 9º dígito), em `remoteJid` e `remoteJidAlt`.
 * Lança se a Evolution falhar: quem chama decide (nunca devolve "vazio" por engano). `limite` protege contra
 * conversa gigante.
 *
 * SEGUE O CÓDIGO ANÔNIMO: a mensagem ao vivo vem gravada com o `@lid` em `remoteJid` e o telefone em
 * `remoteJidAlt`, mas as mensagens ANTIGAS da mesma conversa (o pacote de histórico do aparelho) só existem sob o
 * `@lid`, sem telefone. Buscar só pelo telefone devolvia a conversa pela metade (medido em 29/10/2026: metade das
 * mensagens dessas conversas ficava de fora). Por isso, ao achar um registro do número cujo `remoteJid` é um `@lid`
 * (mesmo que ele não seja uma mensagem de texto: uma reação já amarra o par), a busca consulta esse `@lid` também.
 * Só segue o código que a PRÓPRIA Evolution amarrou a este telefone (o `remoteJidAlt` é uma das variantes do
 * número): nunca adivinha de quem é um `@lid`.
 */
export async function fetchWhatsAppChatMessages(input: {
  apiUrl: string; apiKey: string; instance: string; number: string; limite?: number;
  /** Outros endereços da mesma pessoa (ex.: o código anônimo `...@lid` das mensagens antigas do aparelho). */
  jidsExtras?: string[];
}): Promise<InboundMessage[]> {
  const numero = input.number.startsWith("+") ? input.number : `+${input.number}`;
  const url = `${input.apiUrl.replace(/\/$/, "")}/chat/findMessages/${encodeURIComponent(input.instance)}`;
  const limite = input.limite ?? 5000;
  const porId = new Map<string, InboundMessage>();
  const variantes = phoneVariants(numero).map((v) => v.replace(/\D/g, ""));
  const doNumero = new Set(variantes);
  const fila = [...variantes.map((d) => `${d}@s.whatsapp.net`), ...(input.jidsExtras ?? [])];
  const naFila = new Set(fila);
  let lidsSeguidos = 0;
  for (let jid = fila.shift(); jid !== undefined; jid = fila.shift()) {
    for (let page = 1; porId.size < limite; page++) {
      const res = await evolutionFetch(
        url,
        {
          method: "POST",
          headers: evolutionHeaders(input.apiKey, { "Content-Type": "application/json" }),
          body: JSON.stringify({ page, offset: WHATSAPP_HISTORY_PAGE_SIZE, where: { key: { remoteJid: jid, remoteJidAlt: jid } } }),
          cache: "no-store",
        },
        30_000,
        "Evolution conversa do contato",
      );
      await exigirOk(res, "Evolution conversa do contato");
      const { messages: data } = historyPageSchema.parse(await res.json());
      for (const record of data.records) {
        // Qualquer registro amarra o @lid ao telefone, até o que não vira mensagem (reação, aviso do sistema).
        const lid = lidAmarradoAoNumero((record as { key?: ChaveDaMensagem } | null)?.key, doNumero);
        if (lid && !naFila.has(lid) && lidsSeguidos < LIDS_SEGUIDOS_NO_MAXIMO) {
          naFila.add(lid);
          fila.push(lid);
          lidsSeguidos++;
        }
        const r = analisarEvolutionInbound({ instance: input.instance, data: record }, { preservarLidHistorico: true });
        if (r.ok && r.msg.providerMessageId && r.msg.timestamp && (r.msg.text !== null || r.msg.media)) porId.set(r.msg.providerMessageId, r.msg);
      }
      if (page >= data.pages || data.records.length === 0) break;
    }
  }
  return [...porId.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

const findMessagesSchema = z
  .object({
    messages: z.object({ total: z.number() }).passthrough(),
  })
  .passthrough();

/**
 * Já existe histórico de conversa com este número na instância?
 *
 * A Evolution guarda o histórico sincronizado do aparelho (no Postgres dela).
 * Consultamos `/chat/findMessages` filtrando pelo JID e olhamos só o `total` —
 * NÃO importamos mensagens (não ocupa espaço no CRM Agro). Serve pro fluxo de
 * primeiro contato NÃO disparar pra quem já tem conversa.
 *
 * `number` em E.164 (com +). Duas armadilhas que faziam a resposta ser "não"
 * por engano:
 * - contato `@lid` (código anônimo): a Evolution grava a mensagem ao vivo com
 *   o `@lid` em `remoteJid` e o telefone só em `remoteJidAlt`; perguntar só
 *   por `remoteJid` não achava. Agora mandamos os dois campos;
 * - número BR com/sem o 9º dígito: o JID da conversa pode estar numa forma e o
 *   cadastro na outra. Perguntamos por CADA variante (`phoneVariants`), em
 *   paralelo.
 *
 * Retorno: `true` se QUALQUER variante tem mensagem; `null` (não sei) se
 * nenhuma achou e alguma consulta falhou; `false` só quando todas responderam
 * e nenhuma tem mensagem.
 *
 * Nota: a completude depende do `syncFullHistory` da instância (false = só
 * histórico recente). O check é confiável pra conversas recentes. Conversas
 * antigas só `@lid` (pacote de histórico, sem `remoteJidAlt`) continuam fora
 * do alcance — limite conhecido da Evolution (evolution-api#2663).
 */
export async function hasWhatsAppHistory(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
  number: string;
}): Promise<boolean | null> {
  const numero = input.number.startsWith("+") ? input.number : `+${input.number}`;
  const url = `${input.apiUrl.replace(/\/$/, "")}/chat/findMessages/${encodeURIComponent(input.instance)}`;
  // Uma consulta por variante do número (com/sem o 9º dígito), em paralelo.
  const jids = phoneVariants(numero).map((v) => `${v.replace(/\D/g, "")}@s.whatsapp.net`);
  const respostas = await Promise.all(jids.map((jid) => consultarHistoricoDoJid(url, input.apiKey, jid)));
  if (respostas.includes(true)) return true;
  // null = NÃO SEI (Evolution fora/lenta/erro). Antes devolvia false ("nunca
  // conversou") e o "não enviar se já houver conversa" deixava passar — o fluxo
  // escrevia para quem já era cliente (INT-15). Quem chama decide o que fazer.
  if (respostas.includes(null)) return null;
  return false;
}

/** Uma consulta ao `findMessages` por um JID (em `remoteJid` E `remoteJidAlt`). */
async function consultarHistoricoDoJid(url: string, apiKey: string, jid: string): Promise<boolean | null> {
  try {
    const res = await evolutionFetch(
      url,
      {
        method: "POST",
        headers: evolutionHeaders(apiKey, { "Content-Type": "application/json" }),
        // `offset` é o TAMANHO da página na Evolution (`limit` é ignorado); só
        // o `total` interessa. `remoteJidAlt` acha o contato `@lid`.
        body: JSON.stringify({ where: { key: { remoteJid: jid, remoteJidAlt: jid } }, offset: 1 }),
        cache: "no-store",
      },
      EVOLUTION_TIMEOUT_MS.history,
      "Evolution findMessages",
    );
    if (!res.ok) return null;
    const parsed = findMessagesSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.messages.total > 0 : null;
  } catch {
    return null;
  }
}
