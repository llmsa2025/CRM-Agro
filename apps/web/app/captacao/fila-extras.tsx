"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusDot } from "@/components/ui/status-dot";
import type { ProspectDraftDTO } from "@crmagro/core";
import { clearPendingDraftsAction } from "./actions";

/**
 * "Limpar fila" com confirmação (produto §H.1). A fila da captação persiste:
 * abrir ou recarregar a tela não apaga mais nada — antes, cada visita jogava
 * fora o que o worker tinha capturado (e a checagem de WhatsApp já gasta).
 */
export function LimparFila({ origem, total, onLimpa }: { origem: string; total: number; onLimpa: () => void }) {
  const [aberto, setAberto] = useState(false);
  const [limpando, setLimpando] = useState(false);

  async function limpar() {
    setLimpando(true);
    const r = await clearPendingDraftsAction(origem);
    setLimpando(false);
    if (r.error) return toast.error("Falha ao limpar a fila", { description: r.error });
    setAberto(false);
    toast.success("Fila limpa");
    onLimpa();
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setAberto(true)} disabled={total === 0}>
        <Trash2 className="mr-1.5 h-4 w-4" /> Limpar fila
      </Button>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Limpar a fila?</DialogTitle>
            <DialogDescription>
              {total === 1 ? "O resultado que ainda não foi importado sai" : `Os ${total} resultados que ainda não foram importados saem`} da
              fila. Contatos já importados não são afetados.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAberto(false)} disabled={limpando}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={limpar} disabled={limpando}>
              {limpando && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Limpar fila
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Rascunho que já é contato (regra do dono, 28/09). A linha mostra a que
 * CONTATO a empresa está vinculada (link para a ficha; se são vários, o
 * primeiro e "+N") e, em letra pequena, quem é o responsável. Quem não pode ver
 * o contato (só vê os seus) recebe apenas "Já cadastrado" e o responsável, sem
 * o nome do contato. A linha não pode ser selecionada nem importada: para
 * trabalhar o contato de um colega, o gestor muda o responsável.
 */
export function JaCadastrado({ r }: { r: ProspectDraftDTO }) {
  if (!r.jaExiste) return null;
  const contato = r.vinculo?.contato ?? null;
  const outros = r.vinculo?.outros ?? 0;
  return (
    <div className="mt-0.5 space-y-0.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <StatusDot tone="done" className="whitespace-normal">
          Já cadastrado
        </StatusDot>
        {contato && (
          <span className="text-caption">
            <span className="text-muted-foreground">Contato: </span>
            <Link href={`/contatos/${contato.id}`} className="font-medium text-brand-600 hover:underline">
              {contato.nome}
            </Link>
            {outros > 0 && <span className="text-muted-foreground"> +{outros}</span>}
          </span>
        )}
      </div>
      <div className="text-caption text-muted-foreground">Responsável: {r.jaExisteResponsavel ?? "outra pessoa"}</div>
    </div>
  );
}

/** A linha pode ser selecionada para importar? (a já cadastrada, não). */
export const selecionavel = (r: ProspectDraftDTO) => !r.jaExiste;

/** "Tem WhatsApp?" do rascunho (§H.2): checado sem enviar mensagem nenhuma. */
export function WhatsAppDoRascunho({ r }: { r: ProspectDraftDTO }) {
  if (!r.telefone) return <span className="text-ink-3">—</span>;
  if (r.temWhatsApp === true) return <StatusDot tone="ok">Tem</StatusDot>;
  if (r.temWhatsApp === false) return <StatusDot tone="done">Não tem</StatusDot>;
  return <StatusDot tone="empty">Não checado</StatusDot>;
}

const PRODUTOR: Record<NonNullable<ProspectDraftDTO["produtorLabel"]>, string> = {
  produtor: "Produtor rural",
  provavel_produtor: "Provável produtor",
  nao_produtor: "",
};

/** Linha de detalhe sob o nome: avaliação do Maps, produtor (CNPJ) e bio do Instagram (§H.3–H.5). */
export function DetalheDoRascunho({ r }: { r: ProspectDraftDTO }) {
  const partes: string[] = [];
  if (r.avaliacao != null) {
    const nota = r.avaliacao.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    partes.push(r.avaliacoes != null ? `★ ${nota} (${r.avaliacoes.toLocaleString("pt-BR")})` : `★ ${nota}`);
  }
  if (r.produtorLabel && PRODUTOR[r.produtorLabel]) partes.push(PRODUTOR[r.produtorLabel]);
  if (!partes.length && !r.bio) return null;
  return (
    <div className="text-caption text-muted-foreground">
      {partes.join(" · ")}
      {r.bio && <div className="line-clamp-2 max-w-[48ch]">{r.bio}</div>}
    </div>
  );
}
