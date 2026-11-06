import type { CallStatus } from "@prisma/client";
import type { CapacidadesDeLigacao } from "../provedor/capacidades";
import { ehOrigemDoProvedorDeLigacao, type EntradaDaLinhaDoTempoDeLigacao } from "./linha-do-tempo";

/**
 * A FASE da ligação na tela. Funções puras. Generaliza
 * `faseDaLigacao` e `semConfirmacao` de `calls/whatsapp-fatos.ts` da branch do WhatsApp.
 */

export type FaseDaLigacao = "preparando" | "conectando" | "chamando" | "em_andamento" | "encerrada";

/** Sem aviso do provedor por mais que isto (e sem atender), a ligação que avisa ao vivo vira "sem confirmação". */
export const PRAZO_SEM_CONFIRMACAO_DE_LIGACAO_MS = 3 * 60_000;

const STATUS_QUE_ENCERRAM: readonly CallStatus[] = ["completed", "no_answer", "busy", "failed"];

/**
 * Em que pé a ligação está. Só fato do provedor (`webhook` ou `consulta`) conta: o fechamento sintético do CRM Agro
 * não diz que a ligação tocou nem que foi atendida.
 */
export function faseDaLigacao(c: { status: CallStatus; providerCallId: string | null; linhaDoTempo: readonly EntradaDaLinhaDoTempoDeLigacao[] }): FaseDaLigacao {
  if (STATUS_QUE_ENCERRAM.includes(c.status)) return "encerrada";
  const doProvedor = c.linhaDoTempo.filter((e) => ehOrigemDoProvedorDeLigacao(e.origem));
  if (doProvedor.some((e) => e.fato.tipo === "atendida")) return "em_andamento";
  if (doProvedor.some((e) => e.fato.tipo === "chamando")) return "chamando";
  return c.providerCallId ? "conectando" : "preparando";
}

/**
 * O provedor não confirmou nada a tempo: a ligação ainda não atendeu e já passou do prazo. A tela diz "sem
 * confirmação" e a ligação NÃO conta como feita.
 *
 * O prazo depende de `eventosAoVivo`: o provedor que só avisa o fim não manda "chamando" nem "atendida", então
 * nunca fica "sem confirmação" no meio da ligação (quem fecha a ligação sem fim é o varredor, F1B-12).
 */
export function semConfirmacaoDaLigacao(
  c: { fase: FaseDaLigacao; criadaEm: Date },
  agora: Date,
  matriz: Pick<CapacidadesDeLigacao, "eventosAoVivo">,
): boolean {
  if (!matriz.eventosAoVivo) return false;
  return (c.fase === "preparando" || c.fase === "conectando" || c.fase === "chamando") && agora.getTime() - c.criadaEm.getTime() > PRAZO_SEM_CONFIRMACAO_DE_LIGACAO_MS;
}
