import type { Prisma } from "@prisma/client";
import { db, tenantData } from "@crmagro/db";
import { whereDoEscopoPessoal, donoPadrao, donoValido } from "../tenancy/escopo";

/** Uma mensagem do chat do assistente (espelha o tipo do widget). */
export type AiMsg = {
  role: "user" | "assistant";
  content: string;
  tools?: { name: string; ok: boolean; write: boolean }[];
};

export type ConversaResumo = {
  id: string;
  titulo: string;
  updatedAt: number; // epoch ms
  count: number; // nº de mensagens
};
export type ConversaFull = ConversaResumo & { messages: AiMsg[] };

/**
 * Escopo por pessoa (auditoria de isolamento 09/2026). O histórico do
 * assistente era do TIME: qualquer membro listava, abria, sobrescrevia e
 * apagava a conversa do master — com respostas montadas a partir da base
 * inteira (contatos de todos os vendedores). Agora cada conversa tem dono
 * (`userId`): membro/só leitura vê só as dele; master, administrador e o
 * sistema veem as do time. O histórico do assistente é PESSOAL: o "ver tudo"
 * por tela não libera o dos colegas (`whereDoEscopoPessoal`). Conversa
 * antiga, sem dono, fica só para master e administrador.
 */
function escopoConversaIa(): Prisma.AiConversationWhereInput {
  return whereDoEscopoPessoal("userId") as Prisma.AiConversationWhereInput;
}

function sanitizeMessages(raw: unknown): AiMsg[] {
  if (!Array.isArray(raw)) return [];
  const out: AiMsg[] = [];
  for (const m of raw) {
    if (m && typeof m === "object" && "role" in m && "content" in m) {
      const mm = m as { role: unknown; content: unknown; tools?: unknown };
      if ((mm.role === "user" || mm.role === "assistant") && typeof mm.content === "string") {
        out.push({
          role: mm.role,
          content: mm.content,
          ...(Array.isArray(mm.tools) ? { tools: mm.tools as AiMsg["tools"] } : {}),
        });
      }
    }
  }
  return out;
}

/** Lista as conversas de quem pede (mais recentes primeiro), sem o corpo das mensagens. */
export async function listAiConversations(): Promise<ConversaResumo[]> {
  const rows = await db().aiConversation.findMany({
    where: escopoConversaIa(),
    orderBy: { updatedAt: "desc" },
    select: { id: true, titulo: true, updatedAt: true, messages: true },
  });
  return rows.map((r) => ({
    id: r.id,
    titulo: r.titulo,
    updatedAt: r.updatedAt.getTime(),
    count: sanitizeMessages(r.messages).length,
  }));
}

/** Uma conversa completa (com mensagens). null se não existir no escopo de quem pede. */
export async function getAiConversation(id: string): Promise<ConversaFull | null> {
  const r = await db().aiConversation.findFirst({
    where: { AND: [{ id }, escopoConversaIa()] },
    select: { id: true, titulo: true, updatedAt: true, messages: true },
  });
  if (!r) return null;
  const messages = sanitizeMessages(r.messages);
  return { id: r.id, titulo: r.titulo, updatedAt: r.updatedAt.getTime(), count: messages.length, messages };
}

function tituloDe(messages: AiMsg[], fallback?: string): string {
  const primeira = messages.find((m) => m.role === "user")?.content?.trim();
  const base = (fallback?.trim() || primeira || "Nova conversa").slice(0, 120);
  return base;
}

/**
 * Salva (cria ou atualiza) uma conversa de quem pede. Se `id` vier e estiver no
 * escopo dela, atualiza; senão cria uma NOVA (nunca sobrescreve a conversa de
 * outra pessoa nem de outro time). Devolve o resumo (com id definitivo).
 */
export async function saveAiConversation(input: {
  id?: string | null;
  titulo?: string;
  messages: AiMsg[];
}): Promise<ConversaResumo> {
  const prisma = db();
  const escopo = escopoConversaIa();
  const dono = donoPadrao();
  const messages = sanitizeMessages(input.messages);
  const titulo = tituloDe(messages, input.titulo);
  const messagesJson = messages as unknown as Prisma.InputJsonValue;

  if (input.id) {
    // updateMany com o escopo no where: conversa de outra pessoa (ou de outro
    // time, pela extensão de tenancy) não é tocada e cai na criação abaixo.
    const { count } = await prisma.aiConversation.updateMany({
      where: { AND: [{ id: input.id }, escopo] },
      data: { titulo, messages: messagesJson },
    });
    if (count === 1) {
      const r = await prisma.aiConversation.findFirst({
        where: { AND: [{ id: input.id }, escopo] },
        select: { id: true, titulo: true, updatedAt: true },
      });
      if (r) return { id: r.id, titulo: r.titulo, updatedAt: r.updatedAt.getTime(), count: messages.length };
    }
  }
  const r = await prisma.aiConversation.create({
    data: tenantData<Prisma.AiConversationUncheckedCreateInput>({
      titulo,
      messages: messagesJson,
      // Dono = quem conversa (FK: só quem existe no time; senão fica sem dono).
      userId: await donoValido(dono),
    }),
    select: { id: true, titulo: true, updatedAt: true },
  });
  return { id: r.id, titulo: r.titulo, updatedAt: r.updatedAt.getTime(), count: messages.length };
}

/** Apaga uma conversa de quem pede (a de outra pessoa não é tocada). */
export async function deleteAiConversation(id: string): Promise<void> {
  await db().aiConversation.deleteMany({ where: { AND: [{ id }, escopoConversaIa()] } });
}
