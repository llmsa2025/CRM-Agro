"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PhoneCall, Pencil, CornerDownRight, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { redirectEnrollmentAction, completeManualCallAction } from "../actions";
import { updateContactAction } from "../../contatos/actions";

export type ReviewRow = {
  id: string;
  contactId: string;
  contactNome: string;
  contactEmpresa: string | null;
  contactTelefone: string | null;
  contactEmail: string | null;
  contactTags: string[];
  status: string;
  motivo: string;
  currentNodeId: string;
  currentNodeType: string | null;
  erro: string | null;
  updatedAt: string;
};

type NodeOpt = { id: string; tipo: string; label: string };

export function FlowHistorico({
  flowId,
  rows,
  nodes,
}: {
  flowId: string;
  rows: ReviewRow[];
  nodes: NodeOpt[];
}) {
  const [editar, setEditar] = useState<ReviewRow | null>(null);
  const [ligar, setLigar] = useState<ReviewRow | null>(null);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border p-4 text-body text-muted-foreground">
        Nada para revisar. Contatos travados (revenda segurada, ligação pendente) ou com falha
        aparecem aqui. Você edita, define o destino e devolve ao fluxo.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {rows.map((r) => (
          <RowCard
            key={r.id}
            flowId={flowId}
            row={r}
            nodes={nodes}
            onEditar={() => setEditar(r)}
            onLigar={() => setLigar(r)}
          />
        ))}
      </div>
      {editar && <EditarContatoDialog row={editar} onClose={() => setEditar(null)} />}
      {ligar && <LigacaoDialog flowId={flowId} row={ligar} onClose={() => setLigar(null)} />}
    </>
  );
}

function RowCard({
  flowId,
  row,
  nodes,
  onEditar,
  onLigar,
}: {
  flowId: string;
  row: ReviewRow;
  nodes: NodeOpt[];
  onEditar: () => void;
  onLigar: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [destino, setDestino] = useState<string>("");

  function devolver() {
    start(async () => {
      const toNodeId = destino === "__end__" ? null : destino || null;
      const res = await redirectEnrollmentAction(flowId, row.id, toNodeId);
      if (res.ok) {
        toast.success("Devolvido ao fluxo");
        router.refresh();
      } else toast.error("Falha", { description: res.error });
    });
  }

  const isCall = row.currentNodeType === "manual_call";

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/contatos/${row.contactId}`} className="text-body font-medium hover:underline">
          {row.contactNome}
        </Link>
        {row.contactEmpresa && <span className="text-caption text-muted-foreground">{row.contactEmpresa}</span>}
        <Badge variant={row.status === "failed" ? "destructive" : "warning"}>{row.motivo}</Badge>
        {row.contactTags.includes("Tem Histórico") && <Badge variant="outline-muted">Tem Histórico</Badge>}
      </div>
      {row.erro && <p className="mt-1 text-caption text-danger-700">{row.erro}</p>}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={onEditar}>
          <Pencil className="mr-1.5 h-3.5 w-3.5" /> Editar contato
        </Button>
        {isCall && (
          <Button size="sm" onClick={onLigar}>
            <PhoneCall className="mr-1.5 h-3.5 w-3.5" /> Marcar ligação feita
          </Button>
        )}
        <Button asChild size="sm" variant="ghost">
          <Link href={`/contatos/${row.contactId}`}>
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Abrir contato
          </Link>
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          <Select value={destino} onValueChange={setDestino}>
            <SelectTrigger className="h-8 w-52">
              <SelectValue placeholder="Definir destino…" />
            </SelectTrigger>
            <SelectContent>
              {nodes.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {n.label}
                </SelectItem>
              ))}
              <SelectItem value="__end__">Encerrar inscrição</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={devolver} disabled={pending || !destino}>
            <CornerDownRight className="mr-1.5 h-3.5 w-3.5" /> Devolver
          </Button>
        </div>
      </div>
    </div>
  );
}

function EditarContatoDialog({ row, onClose }: { row: ReviewRow; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [nome, setNome] = useState(row.contactNome);
  const [empresa, setEmpresa] = useState(row.contactEmpresa ?? "");
  const [telefone, setTelefone] = useState(row.contactTelefone ?? "");
  const [email, setEmail] = useState(row.contactEmail ?? "");

  function salvar() {
    start(async () => {
      const fd = new FormData();
      fd.set("id", row.contactId);
      fd.set("nome", nome);
      fd.set("empresa", empresa);
      fd.set("telefone", telefone);
      fd.set("email", email);
      const res = await updateContactAction(undefined, fd);
      if (res.ok) {
        toast.success("Contato atualizado");
        onClose();
        router.refresh();
      } else toast.error("Falha ao salvar", { description: res.error });
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar contato</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Nome</Label>
            <Input value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Empresa</Label>
            <Input value={empresa} onChange={(e) => setEmpresa(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Telefone</Label>
            <Input value={telefone} onChange={(e) => setTelefone(e.target.value)} placeholder="+55 …" />
          </div>
          <div className="space-y-1">
            <Label>E-mail</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={salvar} disabled={pending || !nome.trim()}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LigacaoDialog({
  flowId,
  row,
  onClose,
}: {
  flowId: string;
  row: ReviewRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [resumo, setResumo] = useState("");
  const [observacao, setObservacao] = useState("");

  function concluir() {
    start(async () => {
      const res = await completeManualCallAction(flowId, row.id, { resumo, observacao });
      if (res.ok) {
        toast.success("Ligação registrada. Fluxo retomado");
        onClose();
        router.refresh();
      } else toast.error("Falha", { description: res.error });
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ligação com {row.contactNome}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {row.contactTelefone && (
            <p className="text-body text-muted-foreground">
              Telefone: <span className="font-medium text-foreground">{row.contactTelefone}</span>
            </p>
          )}
          <div className="space-y-1">
            <Label>Resumo da ligação</Label>
            <Textarea value={resumo} onChange={(e) => setResumo(e.target.value)} rows={3} placeholder="O que foi conversado…" />
          </div>
          <div className="space-y-1">
            <Label>Observação (opcional)</Label>
            <Input value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Próximo passo, combinado…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={concluir} disabled={pending}>
            Marcar como feita e avançar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
