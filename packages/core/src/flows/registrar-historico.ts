import { db } from "@crmagro/db";
import { ondeLidPorTelefone } from "../contacts/identificadores-cifra";
import { env } from "@crmagro/config";
import { fetchWhatsAppChatMessages, phoneVariants } from "@crmagro/channels";
import { importarPaginaHistorico } from "../integrations/whatsapp-historico";

/**
 * Passo `save_history`: traz a conversa do contato no WhatsApp (todas as mensagens que a Evolution guardou do
 * aparelho, ele tendo respondido ou não) e registra no histórico do contato.
 *
 * Dois registros, os dois idempotentes (rodar de novo só acrescenta o que faltava):
 *  1. as mensagens entram na conversa do contato (`importarPaginaHistorico`, único por `providerMessageId`);
 *  2. cada mensagem vira um registro de histórico (Activity "whatsapp", com a hora ORIGINAL), que é o que a ficha
 *     do contato e o agente de IA leem. Não duplica o que a plataforma já registrou ao vivo (mesma direção,
 *     mesmo texto e hora próxima).
 *
 * Lê só do banco da Evolution (não fala com o WhatsApp), então não precisa da conta conectada agora. O que o
 * aparelho nunca mandou à Evolution (o pacote de histórico vem uma vez, ao ler o QR) não existe aqui.
 *
 * Roda dentro do contexto do time (o executor já está em `runWithTeam`/`runAsSystem`). Lança se a Evolution falhar.
 */
const TOLERANCIA_MS = 120_000;
const TEXTO_MAX = 4000;

export async function registrarConversaNoHistorico(i: {
  teamId: string;
  accountId: string;
  instance: string;
  contactId: string;
  numero: string;
}): Promise<{ mensagens: number; novasNoHistorico: number }> {
  // Mensagens antigas do aparelho podem estar guardadas sob o código anônimo (`@lid`) da pessoa: busca por ele também.
  const telefones = phoneVariants(i.numero).map((v) => `+${v.replace(/\D/g, "")}`);
  const lids = await db().whatsAppLid.findMany({ where: ondeLidPorTelefone(i.teamId, telefones), select: { lid: true } });
  const msgs = await fetchWhatsAppChatMessages({
    apiUrl: env.EVOLUTION_API_URL,
    apiKey: env.EVOLUTION_API_KEY,
    instance: i.instance,
    number: i.numero,
    jidsExtras: lids.map((l) => l.lid),
  });
  if (msgs.length === 0) return { mensagens: 0, novasNoHistorico: 0 };

  await importarPaginaHistorico({ teamId: i.teamId, accountId: i.accountId, instance: i.instance }, msgs);

  const prisma = db();
  const existentes = await prisma.activity.findMany({
    where: { contactId: i.contactId, tipo: "whatsapp" },
    select: { direcao: true, conteudo: true, createdAt: true, meta: true },
  });
  const jaRegistrados = new Set<string>();
  const porConteudo = new Map<string, number[]>();
  for (const a of existentes) {
    const pid = (a.meta as { providerMessageId?: string } | null)?.providerMessageId;
    if (pid) jaRegistrados.add(pid);
    const chave = `${a.direcao}|${(a.conteudo ?? "").trim()}`;
    porConteudo.set(chave, [...(porConteudo.get(chave) ?? []), a.createdAt.getTime()]);
  }

  const novas: Array<{ contactId: string; tipo: "whatsapp"; direcao: "in" | "out"; conteudo: string; meta: object; createdAt: Date }> = [];
  for (const m of msgs) {
    if (!m.providerMessageId || jaRegistrados.has(m.providerMessageId)) continue;
    const direcao = m.fromMe ? "out" : "in";
    const conteudo = (m.text?.trim() || `[${m.media?.kind ?? "mensagem"}]`).slice(0, TEXTO_MAX);
    const quando = (m.timestamp ?? 0) * 1000;
    const parecidas = porConteudo.get(`${direcao}|${conteudo}`) ?? [];
    if (parecidas.some((t) => Math.abs(t - quando) <= TOLERANCIA_MS)) continue; // a plataforma já registrou ao vivo
    novas.push({
      contactId: i.contactId,
      tipo: "whatsapp",
      direcao,
      conteudo,
      meta: { providerMessageId: m.providerMessageId, origem: "historico_whatsapp" },
      createdAt: new Date(quando),
    });
  }
  if (novas.length > 0) await prisma.activity.createMany({ data: novas as never });
  return { mensagens: msgs.length, novasNoHistorico: novas.length };
}
