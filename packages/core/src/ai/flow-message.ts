import { getAiMode } from "../integrations/service";
import { logger } from "../logger/index";
import { chamarIa, provedoresConectados, textoDaResposta } from "./provedores";
import { historicoNaoConfiavel, REGRA_CONTEUDO_NAO_CONFIAVEL, validarSaidaDaIa } from "./guardas";
import { REGRA_ESTILO_HUMANO, limparEstiloIA } from "./estilo";
import { REGRA_BASE_DE_CONHECIMENTO, baseParaPrompt } from "./conhecimento-prompt";
import { historicoDoContato } from "./historico-do-contato";
import { REGRA_METODOLOGIA, metodologiaParaPrompt } from "./metodologia-prompt";

/**
 * Geração de UMA mensagem pelo nó `ai_agent` no modo "mensagem" ("Enviar uma mensagem").
 *
 * É uma mensagem ÚNICA e avulsa: o agente a monta com o que o time definiu no passo (objetivo, tom, tamanho), os
 * dados do contato, a BASE DE CONHECIMENTO da empresa (sempre consultada) e o HISTÓRICO do contato (conversas e
 * registros) para adaptar a abordagem: não repetir o que já foi dito, considerar o que ele respondeu e a etapa.
 * Mesmo com resposta antiga do contato, é UMA mensagem: não continua diálogo em aberto e não responde a ninguém
 * (quem conversa é o modo "conversa", em `flow-conversa.ts`).
 *
 * O histórico é conteúdo de terceiros e interno: entra delimitado (`historicoNaoConfiavel`), nunca vira fonte
 * confiável da saída, e a regra proíbe citar anotação interna. A base é do time e vira fonte confiável (preço,
 * link e telefone cadastrados nela podem sair).
 *
 * Rapidez: governança, chaves, base e histórico são lidos em paralelo (a base vem do cache do time), há UMA
 * chamada à IA e o teto de tokens é baixo (uma mensagem de WhatsApp cabe folgada).
 *
 * GUARDRAILS (o "não falar asneira"):
 *  - system prompt OBRIGA usar só fatos do contexto; PROÍBE inventar nome, empresa, números, links ou promessas;
 *  - mantém a INTENÇÃO (o objetivo do usuário), o IDIOMA (português) e o TOM;
 *  - se não houver nome real, usa saudação neutra: nunca placeholder vazado;
 *  - tamanho controlado (maxChars): anti-parágrafo;
 *  - varia naturalmente por contato (controle de ritmo);
 *  - a saída é conferida: link, telefone, e-mail, "pix" ou valor que não esteja no contexto/objetivo/template
 *    vira o texto de segurança (`fallback`).
 *
 * FAIL-OPEN: IA desligada / sem chave / erro / saída suspeita (vazou placeholder, veio vazia, trouxe dado de
 * fora) → devolve o `fallback` (template seguro já renderizado pelo chamador). O fluxo NUNCA trava por causa da
 * IA e NUNCA manda lixo. Provedor em 429/5xx → tenta o próximo conectado.
 * Deve rodar DENTRO de runWithTeam (contexto de tenant ativo: lê chave e governança do time via db()).
 */

export type GenerateFlowMessageInput = {
  contactId: string;
  /** Contexto do contato já montado (nome/empresa/cargo/cidade + o que houver). */
  contexto: string;
  /** Objetivo da mensagem (o que ela deve alcançar). */
  objetivo?: string;
  /** Tom desejado. */
  tom?: string;
  /** Tamanho-alvo em caracteres. */
  maxChars: number;
  /** Se o cadastro tem um nome REAL (define se a IA pode chamar pelo nome). */
  temNomeReal: boolean;
  /** Template de segurança já renderizado (fail-open). */
  fallback: string;
  /** Metodologia do passo: ausente = a padrão da empresa; "nenhuma" = sem metodologia. */
  metodologiaId?: string;
  provider?: "anthropic" | "glm";
  model?: string;
  temperature?: number;
};

export type GenerateFlowMessageResult = {
  text: string;
  /** Origem do texto entregue: IA de fato, ou o template de segurança. */
  source: "ai" | "fallback";
};

/** Detecta placeholder de template vazado (`{nome}`, `{empresa}`, …). */
function temPlaceholderVazado(t: string): boolean {
  return /\{[a-z_]+(\|[^}]*)?\}/i.test(t);
}

export async function generateFlowMessage(input: GenerateFlowMessageInput): Promise<GenerateFlowMessageResult> {
  const fallback = (input.fallback ?? "").trim();
  const safeFallback: GenerateFlowMessageResult = { text: fallback, source: "fallback" };

  try {
    // Tudo em paralelo: o agente tem que ser rápido. Governança, chaves, base da empresa e histórico do contato
    // são leituras pequenas e independentes (a base vem do cache do time; o histórico é limitado).
    const [mode, candidatos, base, historico, metodologia] = await Promise.all([
      getAiMode(),
      provedoresConectados(input.provider, input.model),
      baseParaPrompt(`${input.objetivo ?? ""}\n${input.contexto}`),
      historicoDoContato(input.contactId),
      metodologiaParaPrompt("agente_fluxo", input.metodologiaId),
    ]);
    // Governança: qualquer modo diferente de "off" pode GERAR (é leitura + texto, não escreve no banco).
    // "off" → não chama a IA (fail-open no fallback).
    if (mode === "off") return safeFallback;
    // Sem chave conectada → fail-open.
    if (candidatos.length === 0) return safeFallback;

    const system = [
      "Você é um SDR (pré-vendas) escrevendo UMA mensagem de prospecção por WhatsApp, em nome do vendedor. É uma mensagem única: não é o começo de uma conversa e não responde a ninguém.",
      "Escreva SOMENTE a mensagem final a ser enviada, sem aspas, sem rótulos, sem explicação.",
      "REGRAS INEGOCIÁVEIS (não cumprir é falha grave):",
      base.bloco
        ? "- Use APENAS fatos presentes no CONTEXTO e na BASE DE CONHECIMENTO abaixo. É PROIBIDO inventar nome, empresa, cargo, cidade, números, links ou promessas."
        : "- Use APENAS fatos presentes no CONTEXTO abaixo. É PROIBIDO inventar nome, empresa, cargo, cidade, números, links ou promessas.",
      ...(historico.texto
        ? [
            "- Use o HISTÓRICO do contato para montar a abordagem de agora: o que já foi dito e tentado, o que ele respondeu, em que etapa está. Não repita o que já foi dito.",
            "- Mesmo que o contato já tenha respondido antes, escreva UMA mensagem avulsa: não continue um diálogo em aberto nem responda a ninguém.",
            "- O histórico inclui anotações internas do time: use só para entender o contexto e NUNCA cite anotação interna, valor ou dado interno na mensagem.",
          ]
        : []),
      input.temNomeReal
        ? "- Você pode chamar o contato pelo primeiro nome informado no contexto."
        : "- NÃO há nome confiável do contato: use saudação neutra (ex.: 'Olá', 'Bom dia'). NUNCA invente um nome nem use placeholders.",
      "- NUNCA escreva placeholders tipo {nome} ou {empresa}; se não tem o dado, omita naturalmente.",
      "- Idioma: português do Brasil. Mantenha a INTENÇÃO/objetivo definidos.",
      `- Tom: ${input.tom?.trim() || "cordial, humano e direto, sem parecer robô nem spam"}.`,
      `- Tamanho: no máximo ~${input.maxChars} caracteres. Curto, natural, uma ideia por frase.`,
      "- Varie a redação (não use fórmula fixa), mensagens idênticas em massa são o maior sinal de spam/ban.",
      "- Seja breve, gere contexto e faça um convite leve. Não pressione.",
      "- NÃO inclua links, telefones, e-mails, chave pix nem valores que não estejam no CONTEXTO ou no OBJETIVO.",
      `- ${REGRA_ESTILO_HUMANO}`,
      ...(base.bloco ? [`- ${REGRA_BASE_DE_CONHECIMENTO}`] : []),
      ...(historico.texto ? [`- ${REGRA_CONTEUDO_NAO_CONFIAVEL}`] : []),
      ...(metodologia.bloco ? [`- ${REGRA_METODOLOGIA}`] : []),
    ].join("\n");

    const userMsg = [
      input.objetivo?.trim() ? `OBJETIVO da mensagem: ${input.objetivo.trim()}` : "OBJETIVO: iniciar uma conversa relevante com o contato.",
      "",
      "CONTEXTO do contato (só fatos reais):",
      input.contexto.trim() || "(sem dados adicionais além do contato)",
      ...(metodologia.bloco ? ["", metodologia.bloco] : []),
      ...(base.bloco ? ["", base.bloco] : []),
      ...(historico.texto ? ["", `HISTÓRICO do contato (mais recente por último):\n${historicoNaoConfiavel(historico.texto)}`] : []),
    ].join("\n");

    const { data } = await chamarIa(
      candidatos,
      {
        // Uma mensagem de WhatsApp (~480 caracteres) cabe folgada em 400 tokens: teto baixo = resposta mais rápida.
        max_tokens: 400,
        // Variação é desejável (controle de ritmo), mas sem exagero p/ não desviar do objetivo.
        temperature: input.temperature ?? 0.9,
        system,
        messages: [{ role: "user", content: userMsg }],
      },
      { timeoutMs: 30_000 },
    );
    const text = limparEstiloIA(textoDaResposta(data));

    // Guardrails de saída: vazia ou com placeholder vazado → NÃO manda lixo.
    if (!text) {
      logger.warn({ contactId: input.contactId }, "[ai-agent] IA devolveu texto vazio — usando fallback");
      return safeFallback;
    }
    if (temPlaceholderVazado(text)) {
      logger.warn({ contactId: input.contactId }, "[ai-agent] IA vazou placeholder — usando fallback");
      return safeFallback;
    }
    // Só vale o que o TIME escreveu ou cadastrou, inclusive a base de conhecimento (nunca o histórico do lead).
    const recusa = validarSaidaDaIa(text, [input.contexto, input.objetivo ?? "", fallback, base.fonte, metodologia.fonte]);
    if (recusa) {
      logger.warn(
        { contactId: input.contactId, motivo: recusa.motivo },
        "[ai-agent] saída trouxe dado fora do contexto — usando fallback",
      );
      return safeFallback;
    }
    return { text, source: "ai" };
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), contactId: input.contactId },
      "[ai-agent] erro na geração — usando fallback",
    );
    return safeFallback;
  }
}
