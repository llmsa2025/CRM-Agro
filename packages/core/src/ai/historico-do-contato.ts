import { db } from "@crmagro/db";

/**
 * O que o CRM Agro já sabe sobre o contato, para o Agente IA montar a abordagem: as conversas (todos os canais) e
 * os registros do contato (ligações, anotações do time, mudanças de etapa).
 *
 * Duas consultas pequenas, rodadas em paralelo, com limite de linhas e de tamanho: o agente tem que ser rápido,
 * então o histórico é um resumo das últimas interações, não o prontuário inteiro.
 *
 * TUDO aqui é conteúdo de TERCEIROS ou interno: o chamador envolve o texto em `historicoNaoConfiavel` e NÃO o
 * põe nas fontes confiáveis da saída. Anotação interna entra para dar contexto e nunca pode ser citada ao contato
 * (a regra está no prompt).
 */

const MAX_MENSAGENS = 20;
const MAX_REGISTROS = 10;
const CORPO_MAX = 280;

export type HistoricoDoContato = {
  /** Texto pronto (cronológico, mais recente por último). Vazio = não há histórico. */
  texto: string;
  /** O contato já respondeu alguma vez. */
  temResposta: boolean;
  /** Quando chegou a última mensagem do contato (ou `null`). */
  ultimoInboundEm: Date | null;
};

const VAZIO: HistoricoDoContato = { texto: "", temResposta: false, ultimoInboundEm: null };

const DIA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });
const NOME_DO_CANAL: Record<string, string> = { whatsapp: "WhatsApp", email: "E-mail", instagram: "Instagram", linkedin: "LinkedIn" };

const limpar = (t: string | null | undefined, max = CORPO_MAX) => (t ?? "").trim().replace(/\s+/g, " ").slice(0, max);

/**
 * `excetoConversaId`: a conversa que o chamador já traz inteira (modo conversa), para não repetir as mesmas
 * mensagens. Nunca lança: sem histórico (ou com erro de leitura) a IA segue só com o cadastro.
 */
export async function historicoDoContato(contactId: string, opts: { excetoConversaId?: string } = {}): Promise<HistoricoDoContato> {
  try {
    const prisma = db();
    const [mensagens, registros] = await Promise.all([
      prisma.message.findMany({
        where: { conversation: { contactId }, ...(opts.excetoConversaId ? { conversationId: { not: opts.excetoConversaId } } : {}) },
        orderBy: { createdAt: "desc" },
        take: MAX_MENSAGENS,
        select: { direcao: true, conteudo: true, tipo: true, createdAt: true, conversation: { select: { canal: true } } },
      }),
      // WhatsApp e e-mail já aparecem como mensagens; aqui ficam os registros que só existem como atividade.
      // Os avisos que o próprio CRM Agro cria para o vendedor (`flow_notify`) não são história do contato.
      prisma.activity.findMany({
        where: { contactId, tipo: { in: ["call", "note", "stage_change"] } },
        orderBy: { createdAt: "desc" },
        take: MAX_REGISTROS * 3,
        select: { tipo: true, direcao: true, conteudo: true, meta: true, createdAt: true },
      }),
    ]);

    const itens: Array<{ em: Date; linha: string }> = [];
    for (const m of mensagens) {
      const canal = NOME_DO_CANAL[m.conversation.canal] ?? m.conversation.canal;
      const quem = m.direcao === "in" ? "Contato" : "Você";
      itens.push({ em: m.createdAt, linha: `[${canal}] ${quem}: ${limpar(m.conteudo) || `[${m.tipo}]`}` });
    }
    let nRegistros = 0;
    for (const a of registros) {
      if (nRegistros >= MAX_REGISTROS) break;
      const kind = (a.meta as { kind?: string } | null)?.kind;
      if (kind === "flow_notify") continue;
      const corpo = limpar(a.conteudo);
      if (!corpo) continue;
      const rotulo = a.tipo === "call" ? "Ligação" : a.tipo === "stage_change" ? "Etapa" : "Anotação do time";
      itens.push({ em: a.createdAt, linha: `[${rotulo}] ${corpo}` });
      nRegistros += 1;
    }
    if (itens.length === 0) return VAZIO;

    itens.sort((x, y) => x.em.getTime() - y.em.getTime());
    const entrantes = mensagens.filter((m) => m.direcao === "in");
    return {
      texto: itens.map((i) => `${DIA.format(i.em)} ${i.linha}`).join("\n"),
      temResposta: entrantes.length > 0,
      ultimoInboundEm: entrantes.length ? entrantes[0]!.createdAt : null,
    };
  } catch {
    return VAZIO;
  }
}
