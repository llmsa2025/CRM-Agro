"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Check, GitMerge, Heart, KanbanSquare, MoreVertical, Trash2, User, UserCheck, UserPlus, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AddToFunnelDialog, type FunnelOption } from "@/components/add-to-funnel-dialog";
import { INTERESSE_OPTS } from "@/components/ui/interesse-badge";
import { RELACIONAMENTO_STATUS } from "@/components/ui/status-badge";
import { RegisterContactDialog } from "./RegisterContactDialog";
import { UnificarConversaDialog } from "./UnificarConversaDialog";
import { toast } from "sonner";
import { addToFunnelNaConversaAction, deleteConversationAction, marcarOptOutNaConversaAction, setInteresseAction, setStatusDoContatoAction } from "./actions";
import type { Interesse } from "@prisma/client";

/** Status que se marca à mão. "Não quer contato" vem do "Pediu para sair" e não se desfaz por aqui. */
export type StatusMarcavel = "novo" | "ja_conversou" | "cliente";
const STATUS_MARCAVEIS: StatusMarcavel[] = ["novo", "ja_conversou", "cliente"];

/** Menu de ações (3 pontinhos) da conversa. */
export function ConversationActions({
  conversationId,
  contactId,
  interesse,
  status,
  nomeSugerido,
  externalNumber,
  funnels,
  onDeleted,
  onRegistered,
  onUnificada,
  onInteresseChange,
  onStatusChange,
}: {
  conversationId: string;
  contactId: string | null;
  interesse?: string;
  /** Status do contato (Nunca contatado, Contatado, Cliente, Não quer contato). */
  status?: string;
  /** Agenda do celular > pushName (null = não sabemos): pré-preenche o cadastro. */
  nomeSugerido: string | null;
  externalNumber: string | null;
  funnels: FunnelOption[];
  onDeleted: () => void;
  onRegistered: () => void;
  /** Conversa sem número unificada: recebe a conversa que ficou, para a tela abri-la. */
  onUnificada: (conversationId: string) => void;
  onInteresseChange?: (interesse: Interesse) => void;
  onStatusChange?: (status: StatusMarcavel) => void;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [funnelOpen, setFunnelOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [unificarOpen, setUnificarOpen] = useState(false);

  async function marcarInteresse(v: Interesse) {
    if (!contactId) return;
    onInteresseChange?.(v); // otimista
    const res = await setInteresseAction(contactId, v);
    if (res.ok) toast.success("Interesse atualizado");
    else toast.error("Falha ao atualizar interesse", { description: res.error });
  }

  /** Fecha o menu e só então abre o pop-up (menu aberto por trás travava os cliques depois de fechar o pop-up). */
  function abrirJanela(abrir: () => void) {
    setMenuOpen(false);
    setTimeout(abrir, 0);
  }

  async function marcarStatus(v: StatusMarcavel) {
    if (!contactId || v === status) return;
    const res = await setStatusDoContatoAction(contactId, v);
    if (res.ok) {
      onStatusChange?.(v);
      toast.success(`Status: ${RELACIONAMENTO_STATUS[v]?.label ?? v}`);
    } else toast.error("Não mudei o status", { description: res.error });
  }

  async function del() {
    if (!window.confirm("Excluir esta conversa? As mensagens serão removidas.")) return;
    const res = await deleteConversationAction(conversationId);
    if (res.ok) {
      toast.success("Conversa excluída");
      onDeleted();
    } else {
      toast.error("Falha ao excluir", { description: res.error });
    }
  }

  const registered = contactId !== null;
  // Conversa "sem número": o WhatsApp a identificou só pelo código anônimo (@lid).
  const semNumero = !registered && !!externalNumber?.endsWith("@lid");

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Ações da conversa">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {registered ? (
            <>
              <DropdownMenuItem onSelect={() => abrirJanela(() => setFunnelOpen(true))}>
                <KanbanSquare className="mr-2 h-4 w-4" />
                Criar card no funil
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => router.push(`/contatos/${contactId}`)}>
                <User className="mr-2 h-4 w-4" />
                Abrir / editar contato
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={async () => {
                  if (!confirm("Marcar que este contato pediu para sair? Ele sai de todas as campanhas e fluxos e não recebe mais mensagens automáticas.")) return;
                  const r = await marcarOptOutNaConversaAction(contactId);
                  if (r.ok) toast.success(r.summary ?? "Contato marcado: pediu para sair.");
                  else toast.error("Falha", { description: r.error });
                }}
              >
                <Ban className="mr-2 h-4 w-4" />
                Pediu para sair
              </DropdownMenuItem>
              {status === "opt_out" ? (
                <DropdownMenuItem disabled>
                  <UserCheck className="mr-2 h-4 w-4" />
                  Status: não quer contato
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <UserCheck className="mr-2 h-4 w-4" />
                    Marcar status
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {STATUS_MARCAVEIS.map((s) => (
                      <DropdownMenuItem key={s} onSelect={() => marcarStatus(s)}>
                        {s === status ? <Check className="mr-2 h-4 w-4" /> : <span className="mr-2 h-4 w-4" />}
                        {RELACIONAMENTO_STATUS[s]?.label ?? s}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Heart className="mr-2 h-4 w-4" />
                  Marcar interesse
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {INTERESSE_OPTS.map((o) => (
                    <DropdownMenuItem key={o.value} onSelect={() => marcarInteresse(o.value)}>
                      {o.value === interesse ? (
                        <Check className="mr-2 h-4 w-4" />
                      ) : (
                        <span className="mr-2 h-4 w-4" />
                      )}
                      {o.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          ) : (
            <>
              {semNumero && (
                <DropdownMenuItem onSelect={() => abrirJanela(() => setUnificarOpen(true))}>
                  <GitMerge className="mr-2 h-4 w-4" />
                  Unificar com o contato
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => abrirJanela(() => setRegisterOpen(true))}>
                <UserPlus className="mr-2 h-4 w-4" />
                Cadastrar contato
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem disabled>
            <Workflow className="mr-2 h-4 w-4" />
            Adicionar a fluxo
            <span className="ml-auto text-caption text-muted-foreground">em breve</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-danger-700 focus:text-danger-700"
            onSelect={(e) => {
              e.preventDefault();
              del();
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Excluir conversa
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {registered && (
        <AddToFunnelDialog
          acao={addToFunnelNaConversaAction}
          contactId={contactId}
          funnels={funnels}
          open={funnelOpen}
          onOpenChange={setFunnelOpen}
        />
      )}
      {semNumero && (
        <UnificarConversaDialog
          conversationId={conversationId}
          open={unificarOpen}
          onOpenChange={setUnificarOpen}
          onUnificada={onUnificada}
        />
      )}
      <RegisterContactDialog
        conversationId={conversationId}
        suggestedName={nomeSugerido}
        externalNumber={externalNumber}
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        onRegistered={onRegistered}
      />
    </>
  );
}
