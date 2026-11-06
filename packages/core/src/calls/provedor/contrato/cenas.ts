import type { WebhookCru } from "../comum";
import type { ModoDeOriginarDeLigacao } from "../capacidades";
import type { FatoDeLigacao, RefDaLinhaDeLigacao, ResultadoDaNormalizacaoDeLigacao } from "../fato";
import type { CenarioDeContratoDeLigacao, DesfechoDeLigacaoDeTeste } from "./tipos";

/**
 * Cenas reutilizadas pela suíte de contrato e pelas conferências (`verificacoes.ts`): ligar, conduzir a
 * ligação até o fim, pegar os avisos e lê-los pelo adaptador. Tudo pela INTERFACE e pelo roteiro, sem saber
 * nada do provedor.
 */

/** Um erro lançado pela chamada, ou `undefined` se a chamada deu certo. */
export async function erroDe(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

export const nomeDoErro = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

export function linhaDoCenario(c: CenarioDeContratoDeLigacao): RefDaLinhaDeLigacao {
  if (!c.ctx.linha) throw new Error("O cenário de contrato precisa de uma linha no contexto.");
  return { contaExterna: c.ctx.linha.contaExterna, idExterno: c.ctx.linha.idExterno };
}

export type LigacaoDeTeste = {
  callId: string;
  destinoE164: string;
  linha: RefDaLinhaDeLigacao;
  providerCallId: string;
};

/** Pede ao provedor que ligue, por um destino novo (com permissão, a menos que `comPermissao: false`). */
export async function ligarParaTeste(
  c: CenarioDeContratoDeLigacao,
  opcoes: { modo?: ModoDeOriginarDeLigacao; gravar?: boolean; comPermissao?: boolean } = {},
): Promise<LigacaoDeTeste> {
  const destinoE164 = c.roteiro.novoDestino();
  if (opcoes.comPermissao !== false) c.roteiro.permitirDestino(destinoE164);
  const callId = c.roteiro.novoCallId();
  const linha = linhaDoCenario(c);
  const r = await c.provedor.originar(c.ctx, {
    callId,
    destinoE164,
    modo: opcoes.modo ?? c.provedor.capacidades.originar[0]!,
    linha,
    gravar: opcoes.gravar ?? false,
    urlDoCallback: null,
  });
  return { callId, destinoE164, linha, providerCallId: r.providerCallId };
}

/** Liga, deixa a rede conduzir a ligação até o fim e devolve os avisos que o provedor mandou dessa ligação. */
export async function ligarEConduzir(
  c: CenarioDeContratoDeLigacao,
  desfecho: DesfechoDeLigacaoDeTeste,
  opcoes: { gravar?: boolean } = {},
): Promise<LigacaoDeTeste & { avisos: WebhookCru[] }> {
  // Joga fora o que sobrou de uma cena anterior: os avisos desta ligação são só os dela.
  await c.roteiro.sacarAvisos();
  const l = await ligarParaTeste(c, opcoes);
  await c.roteiro.conduzir(l.providerCallId, desfecho);
  return { ...l, avisos: await c.roteiro.sacarAvisos() };
}

/** O aviso lido pelo adaptador (o corpo é JSON). */
export function normalizarAviso(c: CenarioDeContratoDeLigacao, req: WebhookCru): ResultadoDaNormalizacaoDeLigacao {
  return c.provedor.normalizarWebhook(JSON.parse(req.corpo));
}

export function normalizarAvisos(c: CenarioDeContratoDeLigacao, avisos: readonly WebhookCru[]): ResultadoDaNormalizacaoDeLigacao[] {
  return avisos.map((a) => normalizarAviso(c, a));
}

/** Os fatos de todos os avisos, na ordem em que chegaram. */
export const fatosDosAvisos = (c: CenarioDeContratoDeLigacao, avisos: readonly WebhookCru[]): FatoDeLigacao[] => normalizarAvisos(c, avisos).flatMap((r) => r.fatos);

/** Os fatos que encerram a ligação: o fim e a falha ao originar. */
export const ehFatoTerminalDeLigacao = (f: FatoDeLigacao): f is Extract<FatoDeLigacao, { tipo: "encerrada" | "falhou_ao_originar" }> =>
  f.tipo === "encerrada" || f.tipo === "falhou_ao_originar";

/** Os textos que identificam o telefone de uma ligação: com e sem o "+". Nunca podem aparecer num fato. */
export const formasDoTelefone = (destinoE164: string): string[] => [destinoE164, destinoE164.replace(/^\+/, "")];
