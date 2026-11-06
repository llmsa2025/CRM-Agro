import { metodologiaParaIa } from "../metodologias/service";
import type { FinalidadeDaMetodologia } from "../metodologias/modelos";

/**
 * A metodologia escolhida no prompt da IA (Agente IA dos fluxos e Assistente).
 *
 * A metodologia diz COMO conduzir a abordagem (ordem das perguntas, o que evitar). O que dizer vem do
 * objetivo/orientação do passo, e os fatos vêm do cadastro, da base de conhecimento e do histórico. Por isso o
 * bloco entra com uma regra de precedência e a IA não cita o nome da técnica ao contato.
 *
 * O texto é escrito pelo time: entra nas fontes confiáveis da saída, como a orientação.
 */

const TAG = "metodologia";

export const REGRA_METODOLOGIA = [
  `O bloco <${TAG}> diz COMO conduzir a abordagem (a ordem das perguntas e o que evitar).`,
  "Siga-o para estruturar o que você escreve, mas o OBJETIVO ou a ORIENTAÇÃO do passo manda no que dizer, e os fatos vêm só do contexto, da base e do histórico.",
  "Nunca cite o nome da técnica ao contato.",
].join(" ");

export function blocoDaMetodologia(nome: string, conteudo: string): string {
  const limpo = conteudo.replace(/<\s*\/?\s*metodologia[^>]*>/gi, "[tag removida]");
  return `METODOLOGIA a seguir (${nome}):\n<${TAG}>\n${limpo}\n</${TAG}>`;
}

export type MetodologiaParaPrompt = { bloco: string; fonte: string; nome: string };

const VAZIA: MetodologiaParaPrompt = { bloco: "", fonte: "", nome: "" };

/** `id` ausente = a padrão da finalidade; "nenhuma" = sem metodologia. Nunca lança. */
export async function metodologiaParaPrompt(finalidade: FinalidadeDaMetodologia, id?: string | null): Promise<MetodologiaParaPrompt> {
  const m = await metodologiaParaIa(finalidade, id);
  if (!m) return VAZIA;
  return { bloco: blocoDaMetodologia(m.nome, m.conteudo), fonte: m.conteudo, nome: m.nome };
}
