"use client";

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent, TabCount } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { DialerClient } from "./DialerClient";
import { ContatosTab, type CallContactListItem } from "./ContatosTab";
import { LigacoesTab, type CallActivityItem } from "./LigacoesTab";
import { AtividadesTab, type PendingCallItem } from "./AtividadesTab";
import { ManualDialerDialog, type FunnelOption } from "./ManualDialerDialog";

type FunnelsProp = FunnelOption[];

/**
 * Tela de Ligações: 4 abas (Discador / Contatos / Ligações / Atividades) + o
 * discador pop-up global, abrível pelo cabeçalho ou pela aba Contatos.
 */
export function LigacoesClient({
  initialContacts,
  initialActivities,
  initialPending,
  funnels,
}: {
  initialContacts: { items: CallContactListItem[]; total: number };
  initialActivities: { items: CallActivityItem[]; nextCursor: string | null };
  initialPending: PendingCallItem[];
  funnels: FunnelsProp;
}) {
  const [dialerOpen, setDialerOpen] = useState(false);
  const [presetNumber, setPresetNumber] = useState<string>("");
  const [presetContactId, setPresetContactId] = useState<string | undefined>(undefined);
  const [presetContactName, setPresetContactName] = useState<string | undefined>(undefined);

  function abrirDiscador(opts?: { phoneNumber?: string; contactId?: string; contactName?: string }) {
    setPresetNumber(opts?.phoneNumber ?? "");
    setPresetContactId(opts?.contactId);
    setPresetContactName(opts?.contactName);
    setDialerOpen(true);
  }

  const feitasHoje = initialActivities.items.length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Ligações"
        subtitle={`${initialPending.length} na fila · ${feitasHoje} ${feitasHoje === 1 ? "feita" : "feitas"} hoje`}
        actions={
          <Button variant="outline" onClick={() => abrirDiscador()}>
            Discar número
          </Button>
        }
      />

      <Tabs defaultValue="discador">
        <TabsList>
          <TabsTrigger value="discador">Discador</TabsTrigger>
          <TabsTrigger value="contatos">
            Contatos <TabCount>{initialContacts.total}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="ligacoes">
            Ligações <TabCount>{feitasHoje}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="atividades">
            Atividades <TabCount>{initialPending.length}</TabCount>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="discador" className="mt-6">
          <DialerClient />
        </TabsContent>

        <TabsContent value="contatos" className="mt-6">
          <ContatosTab
            initial={initialContacts}
            funnels={funnels}
            onCall={(c) =>
              abrirDiscador({
                phoneNumber: c.telefone ?? "",
                contactId: c.id,
                contactName: c.nome,
              })
            }
          />
        </TabsContent>

        <TabsContent value="ligacoes" className="mt-6">
          <LigacoesTab initial={initialActivities} />
        </TabsContent>

        <TabsContent value="atividades" className="mt-6">
          <AtividadesTab initial={initialPending} funnels={funnels} onRefresh={() => {}} />
        </TabsContent>
      </Tabs>

      <ManualDialerDialog
        open={dialerOpen}
        onOpenChange={setDialerOpen}
        funnels={funnels}
        presetPhoneNumber={presetNumber}
        presetContactId={presetContactId}
        presetContactName={presetContactName}
      />
    </div>
  );
}
