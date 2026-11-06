import { z } from "zod";
import { db } from "@crmagro/db";
import { getAiMode } from "../integrations/service";
import { logger } from "../logger/index";
import { chamarIa, provedoresConectados, textoDaResposta } from "./provedores";
import { historicoNaoConfiavel, REGRA_CONTEUDO_NAO_CONFIAVEL, validarSaidaDaIa } from "./guardas";
import { REGRA_ESTILO_HUMANO, limparEstiloIA } from "./estilo";
import { REGRA_BASE_DE_CONHECIMENTO, baseParaPrompt } from "./conhecimento-prompt";
import { historicoDoContato } from "./historico-do-contato";
import { REGRA_METODOLOGIA, metodologiaParaPrompt } from "./metodologia-prompt";

/**
 * Um TURNO de conversa do nó `ai_agent` no modo "conversa".
 *
 * A cada vez que o contato responde (ou na abertura), o motor chama esta função com a orientação do time, o
 * contexto do contato e o histórico da conversa. A IA devolve UMA decisão em JSON:
 *
 * - `responder`: a próxima mensagem da conversa;
 * - `passar_para_humano`: a pessoa pede algo que o agente não deve tratar (preço, proposta, agenda, reclamação,
 *   "quero falar com alguém", sinal claro de compra). Pode vir com uma frase curta de transição;
 * - `encerrar`: sem interesse, pediu para parar, número errado, ou fim natural. Pode vir com uma despedida.
 *
 * Diferente do `generateFlowMessage`, aqui NÃO há texto de segurança: no meio de uma conversa, um texto
 * pré-escrito fora de contexto é pior que silêncio. Se a IA falha ou a saída não passa nas guardas, a decisão
 * é `falhou` e o motor tenta de novo mais tarde e, esgotadas as tentativas, passa para uma pessoa.
 *
 * As guardas são as mesmas do envio de uma mensagem: o histórico (texto do contato) entra delimitado como
 * conteúdo NÃO confiável, e a saída é conferida contra o que o TIME escreveu (contexto, orientação e base de conhecimento): link,
 * telefone, e-mail, "pix" ou valor que só aparece no histórico não sai.
 *
 * Deve rodar DENTRO de runWithTeam (lê chave, governança e histórico do time via db()).
 */

export type DecisaoDoAgente =
  | { acao: "responder"; texto: string }
  | { acao: "passar_para_humano"; motivo: string; texto?: string }
  | { acao: "encerrar"; motivo: string; texto?: string }
  | { acao: "falhou"; motivo: MotivoDaFalhaDaIa };

export type MotivoDaFalhaDaIa = "ia_desligada" | "sem_chave" | "erro" | "resposta_invalida" | "saida_recusada";

export type TurnoDaConversaInput = {
  contactId: string;
  /** A conversa de WhatsApp em que o agente fala (histórico e "novas mensagens" saem dela). */
  conversationId: string;
  /** Contexto do contato já montado (só fatos do cadastro). */
  contexto: string;
  /** Orientação da conversa escrita pelo time (confiável). */
  orientacao: string;
  tom?: string;
  maxChars: number;
  temNomeReal: boolean;
  /** Primeira mensagem do agente (o contato ainda não falou com ele). */
  abertura: boolean;
  /** Mensagens que o agente já mandou nesta conversa, e o teto. */
  enviadas: number;
  maxRespostas: number;
  /** Metodologia do passo: ausente = a padrão da empresa; "nenhuma" = sem metodologia. */
  metodologiaId?: string;
  provider?: "anthropic" | "glm";
  model?: string;
  temperature?: number;
};

export type TurnoDaConversa = {
  decisao: DecisaoDoAgente;
  /** Quando chegou a última mensagem do contato que a IA leu (ou `null` se ele ainda não falou). */
  ultimoInboundEm: Date | null;
  /** Instante em que o histórico foi lido: mensagem do contato depois disso a IA ainda não viu. */
  lidoEm: Date;
};

const HISTORICO_MAX = 30;

// ─── Decisão da IA (JSON) ───────────────────────────────────────────────────

const decisaoBrutaSchema = z.object({
  acao: z.enum(["responder", "passar_para_humano", "encerrar"]),
  texto: z.string().optional().nullable(),
  motivo: z.string().optional().nullable(),
});

/** Placeholder de template vazado (`{nome}`, `{empresa}`, …). */
function temPlaceholderVazado(t: string): boolean {
  return /\{[a-z_]+(\|[^}]*)?\}/i.test(t);
}

/** Tira cerca de código (```json … ```) que alguns modelos põem em volta do JSON. */
function semCercaDeCodigo(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

/**
 * Lê a resposta da IA. Espera um objeto JSON; sem nenhuma chave `{` no texto, trata como a própria mensagem
 * (alguns modelos ignoram o formato). Qualquer outra coisa que não seja um JSON válido é recusada.
 */
export function lerDecisaoDaIa(bruto: string): { acao: "responder" | "passar_para_humano" | "encerrar"; texto: string; motivo: string } | null {
  const limpo = semCercaDeCodigo(bruto);
  if (!limpo) return null;
  const ini = limpo.indexOf("{");
  const fim = limpo.lastIndexOf("}");
  if (ini === -1 && fim === -1) return { acao: "responder", texto: limpo, motivo: "" };
  if (ini === -1 || fim <= ini) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(limpo.slice(ini, fim + 1));
  } catch {
    return null;
  }
  const r = decisaoBrutaSchema.safeParse(obj);
  if (!r.success) return null;
  return { acao: r.data.acao, texto: (r.data.texto ?? "").trim(), motivo: (r.data.motivo ?? "").trim().slice(0, 300) };
}

/**
 * Confere o texto que a IA quer mandar. Devolve o texto limpo, ou o motivo da recusa. Nunca devolve texto com
 * placeholder, vazio, longo demais ou com dado de fora do que o time escreveu.
 */
export function conferirTextoDoAgente(
  texto: string,
  opcoes: { maxChars: number; fontesConfiaveis: string[]; contactId?: string },
): { ok: true; texto: string } | { ok: false; motivo: "resposta_invalida" | "saida_recusada" } {
  const limpo = limparEstiloIA(texto).trim();
  if (!limpo) return { ok: false, motivo: "resposta_invalida" };
  if (temPlaceholderVazado(limpo)) return { ok: false, motivo: "resposta_invalida" };
  // Conversa de WhatsApp com ensaio é sinal de robô: três vezes o tamanho-alvo já é demais.
  if (limpo.length > opcoes.maxChars * 3) return { ok: false, motivo: "resposta_invalida" };
  const recusa = validarSaidaDaIa(limpo, opcoes.fontesConfiaveis);
  if (recusa) {
    logger.warn({ contactId: opcoes.contactId, motivo: recusa.motivo }, "[ai-agent] conversa: saída trouxe dado fora do contexto");
    return { ok: false, motivo: "saida_recusada" };
  }
  return { ok: true, texto: limpo };
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

export function promptDaConversa(
  input: Pick<TurnoDaConversaInput, "tom" | "maxChars" | "temNomeReal" | "abertura" | "enviadas" | "maxRespostas">,
  extras: { temBase?: boolean; temHistoricoDoContato?: boolean; temMetodologia?: boolean } = {},
): string {
  const { temBase = false, temHistoricoDoContato = false, temMetodologia = false } = extras;
  const restantes = Math.max(0, input.maxRespostas - input.enviadas);
  return [
    "Você é um SDR (pré-vendas) conversando por WhatsApp com um contato, em nome do vendedor.",
    'Responda SOMENTE com um objeto JSON, sem texto antes nem depois: {"acao": "responder" | "passar_para_humano" | "encerrar", "texto": "...", "motivo": "..."}',
    "AÇÕES:",
    '- "responder": em "texto", escreva a próxima mensagem da conversa.',
    '- "passar_para_humano": use quando a pessoa pede para falar com alguém, pede preço, proposta, prazo ou condição que a ORIENTAÇÃO não cobre, quer agendar ou fechar, reclama, ou traz um assunto que você não deve tratar. Em "motivo", diga em uma frase o que a pessoa quer. "texto" é opcional: no máximo uma frase curta dizendo que alguém do time vai continuar, sem prometer horário nem preço.',
    '- "encerrar": use quando a pessoa diz que não tem interesse, pede para parar de receber mensagens, é o número errado, ou a conversa já chegou ao fim natural. "texto" é opcional: uma despedida curta e educada. Nunca insista depois de um "não". Em "motivo", diga por quê.',
    "REGRAS INEGOCIÁVEIS (não cumprir é falha grave):",
    "- Siga a ORIENTAÇÃO do time. Use APENAS fatos presentes na ORIENTAÇÃO, no CONTEXTO e no HISTÓRICO. É PROIBIDO inventar nome, empresa, cargo, cidade, números, preços, prazos, links ou promessas.",
    input.temNomeReal
      ? "- Você pode chamar o contato pelo primeiro nome informado no contexto."
      : "- NÃO há nome confiável do contato: use saudação neutra (ex.: 'Olá', 'Bom dia'). NUNCA invente um nome nem use placeholders.",
    "- NUNCA escreva placeholders tipo {nome} ou {empresa}.",
    "- Idioma: português do Brasil.",
    `- Tom: ${input.tom?.trim() || "cordial, humano e direto, sem parecer robô nem spam"}.`,
    `- Tamanho: no máximo ~${input.maxChars} caracteres por mensagem. Curto, natural, uma ideia por mensagem. Sem listas longas.`,
    "- Responda ao que o contato acabou de dizer, sem repetir o que já foi dito.",
    "- Você não ouve áudio nem vê imagem ou documento (aparecem como [audio], [image], [doc]): peça com educação que a pessoa escreva, ou passe para uma pessoa.",
    "- NÃO inclua links, telefones, e-mails, chave pix nem valores que não estejam na ORIENTAÇÃO ou no CONTEXTO.",
    input.abertura
      ? '- É a SUA PRIMEIRA mensagem (o contato ainda não falou com você): use a ação "responder", seja breve, gere contexto e faça um convite leve à conversa. Não pressione.'
      : restantes <= 1
        ? '- Esta é a SUA ÚLTIMA mensagem permitida nesta conversa: feche de forma natural ("encerrar") ou, se a pessoa ainda precisa de algo, passe para uma pessoa ("passar_para_humano").'
        : `- Você ainda pode mandar ${restantes} mensagens nesta conversa.`,
    `- ${REGRA_ESTILO_HUMANO}`,
    `- ${REGRA_CONTEUDO_NAO_CONFIAVEL}`,
    ...(temBase ? [`- ${REGRA_BASE_DE_CONHECIMENTO}`] : []),
    ...(temMetodologia ? [`- ${REGRA_METODOLOGIA}`] : []),
    ...(temHistoricoDoContato
      ? [
          "- O HISTÓRICO do contato (outras conversas e registros) mostra o que já foi tentado e dito: use para adaptar a abordagem e não repetir. Ele inclui anotações internas do time: use só para entender o contexto e NUNCA cite anotação interna, valor ou dado interno ao contato.",
        ]
      : []),
  ].join("\n");
}

// ─── Histórico ──────────────────────────────────────────────────────────────

async function lerHistorico(conversationId: string): Promise<{ transcript: string; ultimoInboundEm: Date | null; ultimasDoContato: string }> {
  const msgs = await db().message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORICO_MAX,
    select: { direcao: true, conteudo: true, tipo: true, createdAt: true },
  });
  const cron = msgs.reverse();
  const ultimoInbound = [...cron].reverse().find((m) => m.direcao === "in");
  const linhas = cron.map((m) => {
    const quem = m.direcao === "in" ? "Contato" : "Você";
    const corpo = (m.conteudo ?? `[${m.tipo}]`).trim().replace(/\s+/g, " ").slice(0, 400);
    return `${quem}: ${corpo}`;
  });
  // O que o contato acabou de dizer: a pergunta da busca na base de conhecimento.
  const ultimasDoContato = cron
    .filter((m) => m.direcao === "in")
    .slice(-3)
    .map((m) => (m.conteudo ?? "").trim().replace(/\s+/g, " ").slice(0, 400))
    .join("\n");
  return { transcript: linhas.join("\n"), ultimoInboundEm: ultimoInbound?.createdAt ?? null, ultimasDoContato };
}

// ─── O turno ────────────────────────────────────────────────────────────────

export async function gerarTurnoDaConversa(input: TurnoDaConversaInput): Promise<TurnoDaConversa> {
  const lidoEm = new Date();
  const semLeitura = (decisao: DecisaoDoAgente): TurnoDaConversa => ({ decisao, ultimoInboundEm: null, lidoEm });
  try {
    // Tudo em paralelo (o agente tem que ser rápido): governança, chaves, a conversa e o histórico do contato.
    // A base da empresa vem logo depois, do cache do time, já com a pergunta do contato.
    const [mode, candidatos, { transcript, ultimoInboundEm, ultimasDoContato }, historicoContato, metodologia] = await Promise.all([
      getAiMode(),
      provedoresConectados(input.provider, input.model),
      lerHistorico(input.conversationId),
      historicoDoContato(input.contactId, { excetoConversaId: input.conversationId }),
      metodologiaParaPrompt("agente_fluxo", input.metodologiaId),
    ]);
    // Governança: "off" não chama a IA. Aqui isso é uma falha (o motor passa para uma pessoa), não um texto pronto.
    if (mode === "off") return semLeitura({ acao: "falhou", motivo: "ia_desligada" });
    if (candidatos.length === 0) return semLeitura({ acao: "falhou", motivo: "sem_chave" });
    const base = await baseParaPrompt(`${input.orientacao}\n${ultimasDoContato}`);

    const userMsg = [
      `ORIENTAÇÃO do time para esta conversa:\n${input.orientacao.trim()}`,
      "",
      "CONTEXTO do contato (só fatos reais):",
      input.contexto.trim() || "(sem dados adicionais além do contato)",
      "",
      ...(metodologia.bloco ? [metodologia.bloco, ""] : []),
      ...(base.bloco ? [base.bloco, ""] : []),
      ...(historicoContato.texto ? [`HISTÓRICO do contato (outras conversas e registros, mais recente por último):\n${historicoNaoConfiavel(historicoContato.texto)}`, ""] : []),
      transcript
        ? `HISTÓRICO da conversa (mais recente por último):\n${historicoNaoConfiavel(transcript)}`
        : "HISTÓRICO: nenhuma mensagem trocada ainda.",
    ].join("\n");

    const { data } = await chamarIa(
      candidatos,
      {
        // JSON curto com uma mensagem de WhatsApp: teto baixo = resposta mais rápida.
        max_tokens: 700,
        temperature: input.temperature ?? 0.7,
        system: promptDaConversa(input, { temBase: base.bloco !== "", temHistoricoDoContato: historicoContato.texto !== "", temMetodologia: metodologia.bloco !== "" }),
        messages: [{ role: "user", content: userMsg }],
      },
      { timeoutMs: 30_000 },
    );

    const lida = lerDecisaoDaIa(textoDaResposta(data));
    if (!lida) {
      logger.warn({ contactId: input.contactId }, "[ai-agent] conversa: a IA não devolveu uma decisão legível");
      return { decisao: { acao: "falhou", motivo: "resposta_invalida" }, ultimoInboundEm, lidoEm };
    }
    // Na abertura só vale mandar a mensagem: não há o que "passar" nem "encerrar" antes de falar.
    if (input.abertura && lida.acao !== "responder") {
      return { decisao: { acao: "falhou", motivo: "resposta_invalida" }, ultimoInboundEm, lidoEm };
    }

    const fontesConfiaveis = [input.contexto, input.orientacao, base.fonte, metodologia.fonte];
    const conferir = (texto: string) => conferirTextoDoAgente(texto, { maxChars: input.maxChars, fontesConfiaveis, contactId: input.contactId });

    if (lida.acao === "responder") {
      const c = conferir(lida.texto);
      return { decisao: c.ok ? { acao: "responder", texto: c.texto } : { acao: "falhou", motivo: c.motivo }, ultimoInboundEm, lidoEm };
    }

    // Passar para uma pessoa ou encerrar: o texto é opcional. Texto que não passa nas guardas NÃO derruba a
    // decisão: a decisão vale, só a frase é descartada.
    let texto: string | undefined;
    if (lida.texto) {
      const c = conferir(lida.texto);
      if (c.ok) texto = c.texto;
    }
    const motivo = lida.motivo || (lida.acao === "encerrar" ? "conversa encerrada pela IA" : "a IA pediu uma pessoa");
    return { decisao: { acao: lida.acao, motivo, ...(texto ? { texto } : {}) }, ultimoInboundEm, lidoEm };
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), contactId: input.contactId },
      "[ai-agent] conversa: erro ao pedir a decisão à IA",
    );
    return semLeitura({ acao: "falhou", motivo: "erro" });
  }
}
