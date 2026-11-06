"use client";

import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatPhone } from "@/lib/format";
import type { SugestaoUnificacao } from "@crmagro/core";
import {
  listContactsForPickerAction,
  sugerirUnificacaoAction,
  unificarConversaAction,
  type ContactPickerItem,
} from "./actions";

/**
 * "Unificar com o contato": a conversa "sem número" (o WhatsApp a identifica só
 * por um código anônimo) é da mesma pessoa que já tem conversa com o número. As
 * mensagens passam para a conversa do contato e a conversa sem número some.
 * Nada é apagado. Confirmação clara antes de gravar (não dá para desfazer).
 */
export function UnificarConversaDialog({
  conversationId,
  open,
  onOpenChange,
  onUnificada,
}: {
  conversationId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Recebe a conversa que ficou (a do contato/número), para a tela abri-la. */
  onUnificada: (conversationId: string) => void;
}) {
  const [sugestao, setSugestao] = useState<SugestaoUnificacao | null>(null);
  const [carregandoSugestao, setCarregandoSugestao] = useState(false);
  const [busca, setBusca] = useState("");
  const [contatos, setContatos] = useState<ContactPickerItem[]>([]);
  const [carregandoContatos, setCarregandoContatos] = useState(false);
  // O que a pessoa escolheu e ainda vai confirmar: um contato da lista ou o número que o CRM Agro achou.
  const [escolha, setEscolha] = useState<{ tipo: "contato"; contato: ContactPickerItem } | { tipo: "numero" } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // Ao abrir: o que o CRM Agro já sabe desta conversa (só leitura).
  useEffect(() => {
    if (!open) return;
    let ativo = true;
    setSugestao(null);
    setEscolha(null);
    setBusca("");
    setCarregandoSugestao(true);
    sugerirUnificacaoAction(conversationId)
      .then((r) => {
        if (!ativo) return;
        if (r.ok) setSugestao(r.sugestao);
        else toast.error("Não foi possível consultar a conversa", { description: r.error });
      })
      .finally(() => ativo && setCarregandoSugestao(false));
    return () => {
      ativo = false;
    };
  }, [open, conversationId]);

  // Busca de contato por nome ou número.
  useEffect(() => {
    if (!open) return;
    let ativo = true;
    setCarregandoContatos(true);
    listContactsForPickerAction(busca.trim() || undefined)
      .then((r) => ativo && setContatos(r))
      .finally(() => ativo && setCarregandoContatos(false));
    return () => {
      ativo = false;
    };
  }, [open, busca]);

  async function confirmar() {
    if (!escolha) return;
    setOcupado(true);
    const res = await unificarConversaAction(
      escolha.tipo === "contato"
        ? { conversationId, contactId: escolha.contato.id }
        : { conversationId, usarNumeroEncontrado: true },
    );
    setOcupado(false);
    if (res.ok && res.conversationId) {
      toast.success("Conversas unificadas", { description: "As mensagens estão na conversa do contato." });
      onOpenChange(false);
      onUnificada(res.conversationId);
    } else {
      toast.error("Não foi possível unificar", { description: res.error });
    }
  }

  const mensagens = sugestao?.mensagens ?? 0;
  const resumoMensagens = mensagens === 1 ? "A 1 mensagem desta conversa passa" : `As ${mensagens} mensagens desta conversa passam`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Unificar com o contato</DialogTitle>
          <DialogDescription>
            O WhatsApp identificou esta conversa antiga só por um código anônimo, sem o telefone. Se ela é da mesma
            pessoa que já tem conversa com o número, junte as duas.
          </DialogDescription>
        </DialogHeader>

        {escolha ? (
          <div className="space-y-3" aria-live="polite">
            <p className="text-body">
              {escolha.tipo === "contato" ? (
                <>
                  Unificar esta conversa com <strong>{escolha.contato.nome}</strong>
                  {escolha.contato.telefone ? ` (${formatPhone(escolha.contato.telefone)})` : ""}?
                </>
              ) : (
                <>Unificar esta conversa com o número {sugestao?.telefone ? formatPhone(sugestao.telefone) : ""}?</>
              )}
            </p>
            <p className="text-caption text-muted-foreground">
              {resumoMensagens} para a conversa dessa pessoa e esta conversa deixa de aparecer. Nenhuma mensagem é apagada. Não
              dá para desfazer.
            </p>
            <DialogFooter>
              {/* O foco vai para "Voltar": é o caminho seguro numa ação que não dá para desfazer. */}
              <Button variant="outline" onClick={() => setEscolha(null)} disabled={ocupado} autoFocus>
                Voltar
              </Button>
              <Button onClick={confirmar} disabled={ocupado}>
                {ocupado ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Unificar
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            {carregandoSugestao ? (
              <p className="text-caption text-muted-foreground">Procurando o número desta conversa…</p>
            ) : sugestao?.telefone && sugestao.numeroDeOutraPessoa ? (
              <p className="rounded-md border bg-muted/40 p-3 text-caption text-muted-foreground">
                O CRM Agro encontrou o número desta conversa ({formatPhone(sugestao.telefone)}), mas ele é de um contato de outra
                pessoa da equipe, então você não pode juntar as conversas. Peça a ela ou ao administrador.
              </p>
            ) : sugestao?.telefone ? (
              <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                <p className="text-body">
                  O CRM Agro encontrou o número desta conversa: <strong>{formatPhone(sugestao.telefone)}</strong>.
                </p>
                <p className="text-caption text-muted-foreground">
                  {sugestao.contato
                    ? `Esse número é do contato ${sugestao.contato.nome}${sugestao.jaTemConversa ? ", que já tem uma conversa." : "."}`
                    : sugestao.jaTemConversa
                      ? "Já existe uma conversa com esse número, ainda sem contato cadastrado."
                      : "Nenhum contato tem esse número. Ao unificar, esta conversa passa a ter o número e você poderá responder."}
                </p>
                <Button size="sm" onClick={() => setEscolha({ tipo: "numero" })}>
                  Unificar com esse número
                </Button>
              </div>
            ) : sugestao?.evolutionIndisponivel ? (
              <p className="text-caption text-muted-foreground">
                Não deu para consultar o WhatsApp agora, então o CRM Agro não sabe o número. Você ainda pode escolher o contato na
                lista.
              </p>
            ) : (
              <p className="text-caption text-muted-foreground">
                O CRM Agro não encontrou o número desta conversa. Escolha na lista o contato que é a mesma pessoa.
              </p>
            )}

            <div className="space-y-2">
              <p className="text-label">Ou escolha o contato</p>
              <div className="relative">
                <Search aria-hidden="true" className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder="Buscar por nome ou número"
                  className="pl-8"
                  aria-label="Buscar contato por nome ou número"
                />
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {carregandoContatos ? (
                  <p className="py-3 text-center text-caption text-muted-foreground">Carregando…</p>
                ) : contatos.length === 0 ? (
                  <p className="py-3 text-center text-caption text-muted-foreground">Nenhum contato.</p>
                ) : (
                  contatos.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      disabled={!c.telefone}
                      onClick={() => setEscolha({ tipo: "contato", contato: c })}
                      className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-body hover:bg-muted/50 disabled:opacity-50"
                      title={c.telefone ? undefined : "Contato sem telefone: cadastre o número primeiro"}
                    >
                      <span className="truncate font-medium">{c.nome}</span>
                      <span className="shrink-0 text-caption text-muted-foreground">
                        {c.telefone ? formatPhone(c.telefone) : "sem telefone"}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
