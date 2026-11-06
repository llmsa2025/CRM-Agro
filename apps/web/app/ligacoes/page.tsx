import { runAsUser } from "@/lib/tenant";
import { listCallActivities, listContactsForCalls, listPendingCalls, listFunnelsWithStats } from "@crmagro/core";
import { LigacoesClient } from "./LigacoesClient";

export const dynamic = "force-dynamic";

/**
 * Tela de Ligações — 4 abas:
 *  - Discador: fila progressiva (um contato por vez, resultado num clique)
 *  - Contatos: lista de contatos com telefone + busca (botão Ligar abre o pop-up)
 *  - Ligações: histórico de Activities de ligação (hoje)
 *  - Atividades: pendências (calls scheduled + manual_call do fluxo)
 *
 * O discador pop-up (número → liga → descrição + negócio/etapa → histórico) é
 * um modal global, abrível por um botão no header ou pela aba Contatos.
 */
export default async function LigacoesPage() {
  const { contacts, activities, pending, funnels } = await runAsUser(async () => {
    const [contacts, activities, pending, funnelsWithStages] = await Promise.all([
      listContactsForCalls({ limit: 50 }),
      listCallActivities({ limit: 100 }),
      listPendingCalls(),
      listFunnelsWithStats(),
    ]);
    return {
      contacts,
      activities,
      pending,
      funnels: funnelsWithStages.map((f) => ({
        id: f.id,
        nome: f.nome,
        stages: f.stages.map((s) => ({ id: s.id, nome: s.nome })),
      })),
    };
  }).catch(() => ({
    contacts: { items: [], total: 0 },
    activities: { items: [], nextCursor: null },
    pending: [],
    funnels: [],
  }));

  return (
    <div>
      <LigacoesClient
        initialContacts={contacts}
        initialActivities={activities}
        initialPending={pending}
        funnels={funnels}
      />
    </div>
  );
}
