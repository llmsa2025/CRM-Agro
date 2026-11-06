import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Entrada de e-mail por encaminhamento (Gmail → Cloudflare → CRM Agro): a assinatura
 * HMAC que o Email Worker (`deploy/cloudflare/email-entrada/worker.js`) põe em
 * cada entrega e que a rota do CRM Agro (E4) confere. Funções puras, sem banco.
 *
 * O contrato é o da ficha E1 ("Contrato da entrega"). Mudar um lado sem mudar o
 * outro faz toda entrega falhar com 401.
 */

/** Cabeçalhos da entrega (o Worker os põe, a rota os lê). */
export const CABECALHOS_ENTRADA = {
  carimbo: "x-crmagro-carimbo",
  chegada: "x-crmagro-chegada",
  para: "x-crmagro-para",
  de: "x-crmagro-de",
  tamanho: "x-crmagro-tamanho",
  truncado: "x-crmagro-truncado",
  assinatura: "x-crmagro-assinatura",
} as const;

/** Os campos assinados, como chegam nos cabeçalhos (todos em texto). */
export type CamposDaEntrada = {
  /** Segundos unix de quando o Worker assinou. */
  carimbo: string;
  /** Milissegundos unix de quando o e-mail chegou ao Worker. */
  chegada: string;
  para: string;
  de: string;
  tamanho: string;
  /** `"0"` ou `"1"`. */
  truncado: string;
};

/** Diferença máxima, em segundos, entre o carimbo e o relógio do CRM Agro (contra repetição de pedido). */
export const TOLERANCIA_CARIMBO_S = 300;

/**
 * `HMAC-SHA256(segredo, ["v1", carimbo, chegada, para, de, tamanho, truncado, sha256hex(corpo)].join("\n"))`,
 * em hexadecimal minúsculo. Idêntico ao `montarPedido` do Worker.
 */
export function assinaturaDaEntrada(segredo: string, c: CamposDaEntrada, corpo: Buffer): string {
  const hashDoCorpo = createHash("sha256").update(corpo).digest("hex");
  const texto = ["v1", c.carimbo, c.chegada, c.para, c.de, c.tamanho, c.truncado, hashDoCorpo].join("\n");
  return createHmac("sha256", segredo).update(texto).digest("hex");
}

/**
 * Confere a assinatura e o carimbo. Comparação em tempo constante; assinatura de
 * outro tamanho dá `false` sem lançar (o `timingSafeEqual` lança com tamanhos
 * diferentes, por isso o tamanho é conferido antes).
 */
export function conferirAssinaturaDaEntrada(
  segredo: string,
  c: CamposDaEntrada & { assinatura: string },
  corpo: Buffer,
  agoraMs: number = Date.now(),
): boolean {
  const carimbo = Number(c.carimbo);
  if (!c.carimbo.trim() || !Number.isFinite(carimbo)) return false;
  if (Math.abs(agoraMs / 1000 - carimbo) > TOLERANCIA_CARIMBO_S) return false;

  const esperada = Buffer.from(assinaturaDaEntrada(segredo, c, corpo));
  const recebida = Buffer.from(c.assinatura);
  if (esperada.length !== recebida.length) return false;
  return timingSafeEqual(esperada, recebida);
}

/** Escapa o texto para entrar literal numa expressão regular (os pontos do domínio, em especial). */
function escaparParaRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/**
 * O código (32 hex) de um endereço `r+<código>@<domínio>`, ou `null` se o endereço
 * não for desse formato ou for de outro domínio. Ignora maiúsculas e espaços nas pontas.
 */
export function tokenDoEndereco(para: string, dominio: string): string | null {
  const alvo = dominio.trim().toLowerCase();
  if (!alvo) return null;
  const achou = new RegExp(`^r\\+([0-9a-f]{32})@${escaparParaRegex(alvo)}$`).exec(para.trim().toLowerCase());
  return achou ? achou[1]! : null;
}

/** sha256 hex do código: é o que fica no banco para achar a caixa (o código em si só existe cifrado). */
export function hashDoToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
