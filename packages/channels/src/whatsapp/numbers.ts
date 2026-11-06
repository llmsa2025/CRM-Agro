import { z } from "zod";
import { evolutionHeaders, evolutionFetch, exigirOk } from "./http";

/**
 * "Tem WhatsApp?" SEM ENVIAR (Campanhas A.4): `POST /chat/whatsappNumbers/{instance}`
 * da Evolution pergunta ao WhatsApp se cada número tem conta. Não manda
 * mensagem, não abre conversa, não aparece para o dono do número.
 *
 * Um lote por chamada (quem chama divide em blocos de `WHATSAPP_NUMBERS_LOTE` e
 * pausa entre eles — muita consulta seguida é sinal de robô para o WhatsApp).
 * Lança `ChannelSendFailed` em erro de rede/HTTP (quem chama trata como "não
 * deu para saber").
 */

/** Números por chamada à Evolution. */
export const WHATSAPP_NUMBERS_LOTE = 50;
/** Teto de uma chamada (o plano pede 10 s). */
export const WHATSAPP_NUMBERS_TIMEOUT_MS = 10_000;

const respostaSchema = z.array(
  z
    .object({
      exists: z.boolean(),
      jid: z.string().nullish(),
      number: z.union([z.string(), z.number()]).nullish(),
      name: z.string().nullish(),
    })
    .passthrough(),
);

export type NumeroChecado = {
  /** O número como foi pedido (E.164). */
  numero: string;
  existe: boolean;
  jid: string | null;
  /** Nome que a INSTÂNCIA conhece (agenda/pushName) — só para o time dela. */
  nome: string | null;
};

const digitos = (s: string) => s.replace(/\D/g, "");

/**
 * Checa um lote (até 50) de números E.164. Devolve só os que a Evolution
 * respondeu; número ausente da resposta = "não deu para saber" (quem chama não
 * grava nada para ele).
 */
export async function checkWhatsAppNumbers(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
  numbers: readonly string[];
}): Promise<NumeroChecado[]> {
  if (input.numbers.length === 0) return [];
  if (input.numbers.length > WHATSAPP_NUMBERS_LOTE) {
    throw new RangeError(`checkWhatsAppNumbers: no máximo ${WHATSAPP_NUMBERS_LOTE} números por chamada`);
  }
  const url = `${input.apiUrl.replace(/\/$/, "")}/chat/whatsappNumbers/${encodeURIComponent(input.instance)}`;
  const res = await evolutionFetch(
    url,
    {
      method: "POST",
      headers: evolutionHeaders(input.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({ numbers: input.numbers.map(digitos) }),
      cache: "no-store",
    },
    WHATSAPP_NUMBERS_TIMEOUT_MS,
    "Evolution whatsappNumbers",
  );
  await exigirOk(res, "Evolution whatsappNumbers");
  const lido = respostaSchema.safeParse(await res.json().catch(() => null));
  if (!lido.success) return [];

  // A resposta ecoa o número pedido em `number`; o `jid` pode vir SEM o 9º
  // dígito (conta antiga no Brasil), então ele é só o plano B do casamento.
  const pedidos = new Map(input.numbers.map((n) => [digitos(n), n]));
  const semNono = (d: string) => (d.length === 13 && d.startsWith("55") ? d.slice(0, 4) + d.slice(5) : d);
  const pedidosSemNono = new Map(input.numbers.map((n) => [semNono(digitos(n)), n]));
  const out = new Map<string, NumeroChecado>();
  for (const r of lido.data) {
    const eco = r.number != null ? digitos(String(r.number)) : "";
    const doJid = r.jid ? digitos(r.jid.split("@")[0] ?? "") : "";
    const numero = pedidos.get(eco) ?? pedidos.get(doJid) ?? pedidosSemNono.get(semNono(doJid));
    if (!numero || out.has(numero)) continue;
    out.set(numero, {
      numero,
      existe: r.exists,
      jid: r.exists && r.jid ? r.jid : null,
      nome: r.exists && r.name?.trim() ? r.name.trim() : null,
    });
  }
  return [...out.values()];
}
