import { z } from "zod";
import { evolutionHeaders, evolutionFetch, exigirOk, EVOLUTION_TIMEOUT_MS } from "./http";
import { normalizePhone, phoneVariants } from "../phone";

/**
 * Par "código anônimo do WhatsApp (@lid) ↔ telefone" da MESMA pessoa.
 *
 * Por que existe: o WhatsApp identifica
 * cada vez mais as conversas por um código anônimo (`184469901234567@lid`) no
 * lugar do telefone. A Evolution 2.3.7 GRAVA a mensagem ao vivo com
 * `key.remoteJid` = @lid e `key.remoteJidAlt` = telefone, e só depois troca o
 * `remoteJid` pelo telefone para mandar o webhook. Resultado:
 *
 * - no WEBHOOK o par não aparece (só o telefone);
 * - no BANCO da Evolution (`POST /chat/findMessages`) o par está inteiro;
 * - as mensagens do pacote de histórico só têm o @lid (sem `remoteJidAlt`).
 *
 * Esta leitura (SÓ leitura, nunca envia nada ao WhatsApp) acha o par no banco da
 * Evolution, do mesmo jeito que o "já conversou?" (`hasWhatsAppHistory`): o
 * filtro manda o mesmo JID em `remoteJid` E `remoteJidAlt` (a consulta é um OU).
 */

export type ParLid = {
  /** Código anônimo completo, como a Evolution guarda (`…@lid`). */
  lid: string;
  /** Telefone em E.164 (`+5566999998888`). */
  telefone: string;
};

/** `…@lid` de verdade: só dígitos antes do sufixo (grupo, canal e telefone ficam de fora). */
export function ehJidLid(jid: string | null | undefined): jid is string {
  return !!jid && /^\d+@lid$/.test(jid);
}

/** JID de telefone (`5566…@s.whatsapp.net`) → E.164; qualquer outra coisa → null. */
function telefoneDoJid(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith("@s.whatsapp.net")) return null;
  return normalizePhone(jid.replace(/@.+$/, "").replace(/:\d+$/, ""));
}

/**
 * Par de UMA `key` de mensagem da Evolution: `remoteJid` é o @lid e o telefone
 * vem em `remoteJidAlt` (ou `senderPn`, nome antigo do campo). Sem os dois → null.
 */
export function parLidDaChave(key: {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  senderPn?: string | null;
}): ParLid | null {
  if (!ehJidLid(key.remoteJid)) return null;
  const telefone = telefoneDoJid(key.remoteJidAlt) ?? telefoneDoJid(key.senderPn);
  return telefone ? { lid: key.remoteJid, telefone } : null;
}

const registroSchema = z
  .object({
    key: z
      .object({
        remoteJid: z.string().nullish(),
        remoteJidAlt: z.string().nullish(),
        senderPn: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

const paginaSchema = z.object({
  messages: z.object({
    pages: z.number().int().nonnegative(),
    records: z.array(z.unknown()),
  }),
});

/** Registros por página e páginas lidas no máximo (as mais NOVAS vêm primeiro). */
const TAMANHO_DA_PAGINA = 50;
const PAGINAS_NO_MAXIMO = 2;

/**
 * Procura, no banco da Evolution, os pares @lid ↔ telefone das mensagens de um
 * JID: pelo telefone (`5566…@s.whatsapp.net`) acha o @lid da pessoa; pelo @lid
 * acha o telefone. A Evolution devolve a mais nova primeiro, e é a mensagem AO
 * VIVO (a que tem o `remoteJidAlt`) que carrega o par: quem já escreveu depois
 * da conexão aparece logo na primeira página. Só do pacote de histórico (sem
 * `remoteJidAlt`) → lista vazia: o par não existe em lugar nenhum.
 *
 * Erro de rede/HTTP LANÇA (quem chama trata como "não deu para saber", não
 * como "não tem par"). Nunca envia mensagem.
 */
export async function buscarParesLidNaEvolution(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
  /** `…@s.whatsapp.net` (achar o @lid) ou `…@lid` (achar o telefone). */
  jid: string;
}): Promise<ParLid[]> {
  const url = `${input.apiUrl.replace(/\/$/, "")}/chat/findMessages/${encodeURIComponent(input.instance)}`;
  const achados = new Map<string, ParLid>();
  for (let page = 1; page <= PAGINAS_NO_MAXIMO; page++) {
    const res = await evolutionFetch(
      url,
      {
        method: "POST",
        headers: evolutionHeaders(input.apiKey, { "Content-Type": "application/json" }),
        // `offset` é o TAMANHO da página na Evolution; o mesmo JID nos dois campos
        // (OU) acha as mensagens gravadas com o @lid em `remoteJid`.
        body: JSON.stringify({ where: { key: { remoteJid: input.jid, remoteJidAlt: input.jid } }, offset: TAMANHO_DA_PAGINA, page }),
        cache: "no-store",
      },
      EVOLUTION_TIMEOUT_MS.history,
      "Evolution findMessages (par @lid)",
    );
    await exigirOk(res, "Evolution findMessages (par @lid)");
    const lido = paginaSchema.safeParse(await res.json());
    if (!lido.success) throw new Error("Evolution devolveu um formato inesperado ao buscar o par @lid");
    for (const registro of lido.data.messages.records) {
      const r = registroSchema.safeParse(registro);
      if (!r.success) continue;
      const par = parLidDaChave(r.data.key);
      // Registro de OUTRA pessoa nunca entra: o par tem de casar com o JID pedido.
      if (par && !achados.has(par.lid) && pertenceAoJid(par, input.jid)) achados.set(par.lid, par);
    }
    if (achados.size > 0 || page >= lido.data.messages.pages) break;
  }
  return [...achados.values()];
}

/** O par é da pessoa do JID pedido (o @lid igual, ou o telefone numa das variantes com/sem o 9). */
function pertenceAoJid(par: ParLid, jid: string): boolean {
  if (jid.endsWith("@lid")) return par.lid === jid;
  const digitos = jid.replace(/@.+$/, "");
  return phoneVariants(par.telefone).some((v) => v.replace(/\D/g, "") === digitos);
}

/** Telefone da pessoa dono deste @lid, ou null (sem par no banco da Evolution). */
export async function descobrirTelefoneDoLid(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
  lid: string;
}): Promise<string | null> {
  if (!ehJidLid(input.lid)) return null;
  const pares = await buscarParesLidNaEvolution({ ...input, jid: input.lid });
  return pares[0]?.telefone ?? null;
}

/**
 * @lid da pessoa deste telefone, ou null. Pergunta por CADA variante do número
 * (com e sem o 9º dígito: o JID da conversa pode estar numa forma e o cadastro
 * na outra), em paralelo. Falha em qualquer uma sem achar em outra → lança
 * (não dá para dizer "não tem").
 */
export async function descobrirLidDoTelefone(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
  telefone: string;
}): Promise<string | null> {
  const jids = phoneVariants(input.telefone).map((v) => `${v.replace(/\D/g, "")}@s.whatsapp.net`);
  const respostas = await Promise.allSettled(
    jids.map((jid) => buscarParesLidNaEvolution({ apiUrl: input.apiUrl, apiKey: input.apiKey, instance: input.instance, jid })),
  );
  for (const r of respostas) {
    if (r.status === "fulfilled" && r.value[0]) return r.value[0].lid;
  }
  const falha = respostas.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (falha) throw falha.reason;
  return null;
}
