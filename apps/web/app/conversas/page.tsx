import { runAsUser } from "@/lib/tenant";
import { db } from "@crmagro/db";
import { escopoCanal, listFunnels, startConversationWithContact } from "@crmagro/core";
import type { Canal } from "@prisma/client";
import { ConversationsClient, type ChannelAccountDTO } from "./ConversationsClient";
import type { FunnelOption } from "@/components/add-to-funnel-dialog";
import { canalEmBreve, semCanaisEmBreve } from "../integracoes/canais/abas";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ contact?: string; canal?: string }>;

/** Canais que abrem em Conversas (o `?canal=` de um canal em breve cai no WhatsApp). */
const CANAIS: Canal[] = (["whatsapp", "instagram", "linkedin", "email"] as Canal[]).filter((c) => !canalEmBreve(c));

export default async function ConversasPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const canal = (CANAIS.includes(sp.canal as Canal) ? sp.canal : "whatsapp") as Canal;

  const { accounts, funnels, initial } = await runAsUser(async () => {
    const rows = semCanaisEmBreve(
      (await db().channelAccount.findMany({
        where: escopoCanal(), // F3: os números que a pessoa vê
        orderBy: { createdAt: "asc" },
        select: { id: true, canal: true, label: true, provider: true, status: true },
      })) as ChannelAccountDTO[],
    );
    const funnels = await listFunnels();

    // Deep-link do ícone de canal na lista de contatos: abre (ou cria) a conversa
    // INTERNA daquele contato no canal, em vez de mandar pro app externo.
    let initial: { platform: Canal; accountId: string; conversationId: string } | null = null;
    if (sp.contact) {
      const account =
        rows.find((a) => a.canal === canal && a.status === "connected") ??
        rows.find((a) => a.canal === canal);
      if (account) {
        try {
          const { conversationId } = await startConversationWithContact(account.id, sp.contact);
          initial = { platform: canal, accountId: account.id, conversationId };
        } catch {
          // sem número/identifier no canal → abre o inbox normal, sem seleção.
        }
      }
    }
    return { accounts: rows, funnels, initial };
  });

  const funnelOptions: FunnelOption[] = funnels.items.map((f) => ({
    id: f.id,
    nome: f.nome,
    stages: f.stages.map((s) => ({ id: s.id, nome: s.nome })),
  }));

  return <ConversationsClient accounts={accounts} funnels={funnelOptions} initial={initial} />;
}
