"use client";

import { useEffect, useState } from "react";
import { Loader2, MessageSquarePlus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  listContactsForPickerAction,
  startConversationAction,
  type ContactPickerItem,
} from "./actions";

export function NewConversationButton({
  channelAccountId,
  onStarted,
  compact = false,
}: {
  channelAccountId: string | null;
  onStarted: (conversationId: string) => void;
  /** Só o ícone (com título), para caber ao lado da busca. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"contato" | "numero">("contato");
  const [search, setSearch] = useState("");
  const [contacts, setContacts] = useState<ContactPickerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [nome, setNome] = useState("");
  const [numero, setNumero] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || tab !== "contato") return;
    let active = true;
    setLoading(true);
    listContactsForPickerAction(search.trim() || undefined)
      .then((r) => active && setContacts(r))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [open, tab, search]);

  function reset() {
    setSearch("");
    setNome("");
    setNumero("");
    setTab("contato");
  }

  async function start(input: { contactId?: string; nome?: string; numero?: string }) {
    if (!channelAccountId) return;
    setBusy(true);
    const res = await startConversationAction({ channelAccountId, ...input });
    setBusy(false);
    if (res.ok && res.conversationId) {
      toast.success("Conversa iniciada");
      setOpen(false);
      reset();
      onStarted(res.conversationId);
    } else {
      toast.error("Falha ao iniciar conversa", { description: res.error });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (setOpen(v), v || reset())}>
      <DialogTrigger asChild>
        {compact ? (
          <Button variant="outline" size="icon-sm" disabled={!channelAccountId} aria-label="Nova conversa" title="Nova conversa">
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={!channelAccountId}>
            <MessageSquarePlus className="mr-1.5 h-4 w-4" />
            Nova conversa
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nova conversa</DialogTitle>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as "contato" | "numero")}>
          <TabsList className="w-full">
            <TabsTrigger value="contato" className="flex-1">
              Contato existente
            </TabsTrigger>
            <TabsTrigger value="numero" className="flex-1">
              Novo número
            </TabsTrigger>
          </TabsList>

          <TabsContent value="contato" className="mt-3 space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar contato…"
                className="pl-8"
              />
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {loading ? (
                <p className="py-4 text-center text-caption text-muted-foreground">Carregando…</p>
              ) : contacts.length === 0 ? (
                <p className="py-4 text-center text-caption text-muted-foreground">Nenhum contato.</p>
              ) : (
                contacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={busy || !c.telefone}
                    onClick={() => start({ contactId: c.id })}
                    className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-body hover:bg-muted/50 disabled:opacity-50"
                    title={c.telefone ? undefined : "Contato sem telefone"}
                  >
                    <span className="truncate font-medium">{c.nome}</span>
                    <span className="shrink-0 text-caption text-muted-foreground">{c.telefone ?? "sem telefone"}</span>
                  </button>
                ))
              )}
            </div>
          </TabsContent>

          <TabsContent value="numero" className="mt-3 space-y-3">
            <div className="space-y-1">
              <Label htmlFor="nc-nome">Nome *</Label>
              <Input id="nc-nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome do contato" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="nc-num">Número (com DDD) *</Label>
              <Input id="nc-num" value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="+55 65 99999-0000" />
            </div>
            <p className="text-caption text-muted-foreground">
              O contato é cadastrado automaticamente. Se o número já tiver histórico no WhatsApp,
              nasce como “já conversou”.
            </p>
            <Button
              className="w-full"
              disabled={busy || !nome.trim() || !numero.trim()}
              onClick={() => start({ nome: nome.trim(), numero: numero.trim() })}
            >
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Iniciar conversa
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
