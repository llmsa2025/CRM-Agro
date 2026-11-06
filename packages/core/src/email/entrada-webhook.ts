import { logger } from "../logger/index";
import { rateLimit } from "../rate-limit/service";
import { acharEncaminhamentoPeloToken, entradaDeEmailLigada } from "./encaminhamento";
import { CABECALHOS_ENTRADA, conferirAssinaturaDaEntrada, hashDoToken, tokenDoEndereco } from "./entrada-assinatura";
import type { EmailEncaminhadoJob } from "./entrada-encaminhada";
import { enfileirarEmailEncaminhado } from "./entrada-fila";

/**
 * Decide a resposta da rota de entrada de e-mail (`/api/webhooks/email-entrada`), no
 * mesmo molde do webhook do WhatsApp: a rota só repassa o pedido para cá.
 *
 * Respostas curtas e sem detalhe, no contrato da E1. Atenção ao 404: ele faz o
 * Cloudflare RECUSAR o e-mail para sempre, então só vale para endereço desconhecido
 * ou entrada desligada, nunca para falha passageira (banco ou fila fora é 503, e o
 * Cloudflare guarda o e-mail e tenta de novo).
 *
 * Não loga corpo, remetente, destinatário nem assunto.
 */

/** O Worker manda no máximo 262144 bytes; aqui há folga. */
export const LIMITE_ENTRADA_BYTES = 300_000;

export type DecisaoEntrada = { status: number; body: Record<string, unknown> };

const resposta = (status: number, ok = false): DecisaoEntrada => ({ status, body: { ok } });

export async function aceitarEmailEncaminhado(
  entrada: { cabecalhos: Headers; corpo: Buffer | null },
  enfileirar: (job: EmailEncaminhadoJob) => Promise<void> = enfileirarEmailEncaminhado,
): Promise<DecisaoEntrada> {
  const ligada = entradaDeEmailLigada();
  if (!ligada) return resposta(404);
  if (entrada.corpo === null) return resposta(413);

  const lido = (nome: string) => entrada.cabecalhos.get(nome);
  const carimbo = lido(CABECALHOS_ENTRADA.carimbo);
  const chegada = lido(CABECALHOS_ENTRADA.chegada);
  const para = lido(CABECALHOS_ENTRADA.para);
  const de = lido(CABECALHOS_ENTRADA.de);
  const tamanho = lido(CABECALHOS_ENTRADA.tamanho);
  const truncado = lido(CABECALHOS_ENTRADA.truncado);
  const assinatura = lido(CABECALHOS_ENTRADA.assinatura);
  if (carimbo === null || chegada === null || para === null || de === null || tamanho === null || truncado === null || assinatura === null) {
    return resposta(401);
  }

  if (!conferirAssinaturaDaEntrada(ligada.segredo, { carimbo, chegada, para, de, tamanho, truncado, assinatura }, entrada.corpo)) {
    return resposta(401);
  }

  const token = tokenDoEndereco(para, ligada.dominio);
  if (!token) return resposta(404);

  const limite = await rateLimit(`email-entrada:token:${hashDoToken(token).slice(0, 16)}`, 120, 60_000);
  if (!limite.allowed) return resposta(429);

  // O `teamId` vem SÓ do banco, nunca de cabeçalho. Falha passageira nunca vira 404.
  let encaminhamento: Awaited<ReturnType<typeof acharEncaminhamentoPeloToken>>;
  try {
    encaminhamento = await acharEncaminhamentoPeloToken(token);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[email-entrada] banco indisponível ao achar o endereço");
    return resposta(503);
  }
  if (!encaminhamento) return resposta(404);

  try {
    await enfileirar({
      encaminhamentoId: encaminhamento.id,
      teamId: encaminhamento.teamId,
      envelopeDe: de,
      rawB64: entrada.corpo.toString("base64"),
      chegadaEm: Number(chegada) || Date.now(),
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[email-entrada] fila indisponível");
    return resposta(503);
  }
  return resposta(200, true);
}
