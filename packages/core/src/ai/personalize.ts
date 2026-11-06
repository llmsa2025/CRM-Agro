import { getAiMode } from "../integrations/service";
import { logger } from "../logger/index";
import { chamarIa, provedoresConectados, textoDaResposta } from "./provedores";
import { REGRA_ESTILO_HUMANO, limparEstiloIA } from "./estilo";

/**
 * Personalização controle de ritmo de mensagem por IA (geração de um único disparo, SEM
 * tools). Reescreve um texto-base (já com as variáveis do contato resolvidas)
 * numa versão VARIADA e natural, mantendo a intenção — para que envios em massa
 * não saiam idênticos (o maior sinal de spam/ban em WhatsApp/IG/LinkedIn).
 *
 * FAIL-OPEN: se a IA estiver desligada, sem chave conectada, ou a chamada falhar,
 * devolve o texto original — o envio nunca trava por causa da personalização.
 * Deve ser chamada DENTRO de runAsUserAction (contexto de tenant ativo, pois lê
 * a chave/governança do time). Ver [[crmagro-ia-sdr-grafo-aprendizado]].
 */

export type PersonalizeOptions = {
  instrucao?: string; // tom/objetivo/o que evitar
  contexto?: string; // descrição curta do contato (nome, empresa, cidade, atividade)
  provider?: "anthropic" | "glm";
};

export async function personalizeMessage(baseText: string, opts: PersonalizeOptions = {}): Promise<string> {
  const base = (baseText ?? "").trim();
  if (!base) return baseText;

  try {
    const mode = await getAiMode();
    if (mode === "off") return base;

    // Provedores conectados (mesma ordem do runAgent; 429/5xx → o próximo).
    const candidatos = await provedoresConectados(opts.provider);
    if (candidatos.length === 0) return base; // sem chave → fail-open

    const system = [
      "Você reescreve mensagens de prospecção para soarem naturais e ÚNICAS por contato.",
      "REGRAS:",
      "- Mantenha a MESMA intenção, oferta e chamada para ação da mensagem original.",
      "- Varie a redação (ordem das frases, saudação, conectivos), sem mudar o sentido.",
      "- NÃO invente fatos, nomes, números, links ou promessas que não estejam no texto/contexto.",
      "- Mantenha um tamanho semelhante ao original e o mesmo idioma (português).",
      "- NÃO use placeholders tipo {nome}; o texto já vem com os dados preenchidos.",
      "- Responda APENAS com a mensagem final, sem aspas, sem comentários, sem rótulos.",
      `- ${REGRA_ESTILO_HUMANO}`,
      opts.instrucao ? `Orientação do usuário: ${opts.instrucao}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const userMsg = [
      opts.contexto ? `Contexto do contato: ${opts.contexto}` : "",
      "Mensagem original a reescrever:",
      base,
    ]
      .filter(Boolean)
      .join("\n\n");

    const { data } = await chamarIa(
      candidatos,
      {
        max_tokens: 1024,
        temperature: 1, // variação é desejável aqui (controle de ritmo)
        system,
        messages: [{ role: "user", content: userMsg }],
      },
      { timeoutMs: 30_000 },
    );
    const text = limparEstiloIA(textoDaResposta(data));
    return text || base;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[ai-personalize] erro — usando texto original");
    return base;
  }
}
