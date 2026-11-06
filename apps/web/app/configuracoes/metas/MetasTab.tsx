"use client";

import { useEffect, useState, useTransition } from "react";
import { Plus, Pencil, Trash2, Target } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";

import {
  listMetas,
  createMeta,
  updateMeta,
  deleteMeta,
  type Meta,
} from "./actions";

/** Formata número como moeda BR (R$ X.XXX,XX). */
function formatarMoeda(v: number): string {
  return v.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
  });
}

type FormState = {
  id?: string;
  periodo: string;
  metaValor: string;
  toquesPorDia: string;
};

const EMPTY_FORM: FormState = {
  periodo: "",
  metaValor: "",
  toquesPorDia: "",
};

export function MetasTab() {
  const [metas, setMetas] = useState<Meta[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Carrega metas ao montar
  useEffect(() => {
    listMetas()
      .then((data) => setMetas(data))
      .catch(() => setMetas([]))
      .finally(() => setLoading(false));
  }, []);

  function abrirNova() {
    setForm(EMPTY_FORM);
    setError(null);
    setDialogOpen(true);
  }

  function abrirEditar(m: Meta) {
    setForm({
      id: m.id,
      periodo: m.periodo,
      metaValor: String(m.metaValor),
      toquesPorDia: String(m.toquesPorDia),
    });
    setError(null);
    setDialogOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const payload = {
      periodo: form.periodo,
      metaValor: Number(form.metaValor),
      toquesPorDia: Number(form.toquesPorDia),
    };

    startTransition(async () => {
      const action = form.id ?? undefined;
      const result = action
        ? await updateMeta({ id: action, ...payload })
        : await createMeta(payload);

      if (result.error) {
        setError(result.error);
        return;
      }

      // Recarrega lista
      const atualizadas = await listMetas();
      setMetas(atualizadas);
      setDialogOpen(false);
      setForm(EMPTY_FORM);
    });
  }

  async function handleExcluir(id: string) {
    if (!window.confirm("Tem certeza que deseja excluir esta meta?")) return;
    const result = await deleteMeta({ id });
    if (result.error) {
      setError(result.error);
      return;
    }
    const atualizadas = await listMetas();
    setMetas(atualizadas);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-h3">Metas</CardTitle>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" onClick={abrirNova}>
                <Plus className="mr-1 size-4" />
                Nova meta
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {form.id ? "Editar meta" : "Nova meta"}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="periodo">Período</Label>
                  <Input
                    id="periodo"
                    placeholder="2026-07"
                    value={form.periodo}
                    onChange={(e) =>
                      setForm({ ...form, periodo: e.target.value })
                    }
                    required
                  />
                  <p className="text-caption text-muted-foreground">
                    Formato: AAAA-MM
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="metaValor">Meta (R$)</Label>
                  <Input
                    id="metaValor"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="50000"
                    value={form.metaValor}
                    onChange={(e) =>
                      setForm({ ...form, metaValor: e.target.value })
                    }
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="toquesPorDia">Contatos/dia</Label>
                  <Input
                    id="toquesPorDia"
                    type="number"
                    min="1"
                    placeholder="50"
                    value={form.toquesPorDia}
                    onChange={(e) =>
                      setForm({ ...form, toquesPorDia: e.target.value })
                    }
                    required
                  />
                </div>
                {error && (
                  <p className="text-sm text-destructive">{error}</p>
                )}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                  >
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={pending}>
                    {pending ? "Salvando..." : "Salvar"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-body text-muted-foreground">Carregando...</p>
          ) : metas.length === 0 ? (
            <EmptyState
              icon={Target}
              title="Nenhuma meta definida"
              description="Crie sua primeira meta para começar a acompanhar o progresso."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Período</TableHead>
                  <TableHead className="text-right">Meta</TableHead>
                  <TableHead className="text-right">Contatos/dia</TableHead>
                  <TableHead className="w-[80px]">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {metas.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">{m.periodo}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatarMoeda(m.metaValor)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m.toquesPorDia}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => abrirEditar(m)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleExcluir(m.id)}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
