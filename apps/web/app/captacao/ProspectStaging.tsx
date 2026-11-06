"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, CheckSquare, Download, Trash2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import type { ProspectDraftDTO } from "@crmagro/core";
import { listDraftsAction, importDraftsAction, discardDraftsAction } from "./actions";
import { DetalheDoRascunho, JaCadastrado, LimparFila, WhatsAppDoRascunho, selecionavel } from "./fila-extras";
import { useAoTerminarDeBuscar } from "./andamento-da-busca";

/**
 * Grade de staging/pré-recebimento reutilizável (Maps/Instagram). Lista os
 * rascunhos pendentes de uma origem, filtra/seleciona e importa/descarta.
 * `atualizando` (a busca está andando, segundo o servidor) mantém a fila
 * atualizando a cada poucos segundos e a relê uma última vez quando termina.
 */
export function ProspectStaging({
  origem,
  atualizando = false,
}: {
  origem: string;
  atualizando?: boolean;
}) {
  const [rows, setRows] = useState<ProspectDraftDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [soComContato, setSoComContato] = useState(false);
  const [soComWhatsApp, setSoComWhatsApp] = useState(false);
  const [acting, setActing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRows(
        await listDraftsAction({
          origem,
          soComContato,
          search: search.trim() || undefined,
          ...(soComWhatsApp ? { temWhatsApp: true } : {}),
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [origem, soComContato, soComWhatsApp, search]);

  // A fila persiste (§H.1): abrir a tela só lista. Limpar é o botão "Limpar fila".
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Enquanto a busca anda (o worker ou a extensão vão preenchendo aos poucos), relê a fila.
  useEffect(() => {
    if (!atualizando) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [atualizando, refresh]);
  // Quando a busca termina, uma última leitura para trazer o que chegou no fim.
  useAoTerminarDeBuscar(atualizando, () => void refresh());

  // Já cadastrado (regra do dono, 28/09): a linha não entra na seleção — nem
  // pelo "selecionar todos". Some da seleção também se virou contato no refresh.
  const selecionaveis = useMemo(() => rows.filter(selecionavel), [rows]);
  const allSelected = selecionaveis.length > 0 && selecionaveis.every((r) => sel.has(r.id));
  function toggleAll() { setSel(allSelected ? new Set() : new Set(selecionaveis.map((r) => r.id))); }
  function toggle(id: string) {
    setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  const selIds = useMemo(() => selecionaveis.filter((r) => sel.has(r.id)).map((r) => r.id), [selecionaveis, sel]);

  async function importar() {
    setActing(true);
    const r = await importDraftsAction(selIds);
    setActing(false);
    if (r.error) return toast.error("Falha ao importar", { description: r.error });
    toast.success(`${r.importados ?? 0} contato(s) importado(s)`, {
      description: r.pulados ? `${r.pulados} já cadastrado(s), não importado(s)` : undefined,
    });
    setSel(new Set());
    void refresh();
  }
  async function descartar() {
    setActing(true);
    const r = await discardDraftsAction(selIds);
    setActing(false);
    if (r.error) return toast.error("Falha ao descartar", { description: r.error });
    toast.success(`${r.descartados ?? 0} descartado(s)`);
    setSel(new Set());
    void refresh();
  }

  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filtrar por nome, cidade…" className="h-8 pl-8" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={soComContato} onCheckedChange={(v) => setSoComContato(v === true)} />
          Só com contato
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={soComWhatsApp} onCheckedChange={(v) => setSoComWhatsApp(v === true)} />
          Só com WhatsApp
        </label>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={"mr-1.5 h-4 w-4 " + (loading ? "animate-spin" : "")} /> Atualizar
        </Button>
        <span className="text-caption text-muted-foreground">{rows.length} na fila</span>
        <LimparFila origem={origem} total={rows.length} onLimpa={() => { setSel(new Set()); void refresh(); }} />
      </div>

      {selIds.length > 0 && (
        <div className="flex items-center gap-2 border-b bg-brand-100/30 p-2">
          <span className="text-caption font-medium">{selIds.length} selecionado(s)</span>
          <Button size="sm" onClick={importar} disabled={acting}>
            {acting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
            Importar p/ CRM Agro
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={descartar} disabled={acting}>
            <Trash2 className="mr-1.5 h-4 w-4" /> Descartar
          </Button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-caption text-muted-foreground">
            <tr>
              <th className="w-8 px-3 py-2">
                <button type="button" onClick={toggleAll} disabled={selecionaveis.length === 0} aria-label="Selecionar todos os que ainda não estão cadastrados">
                  <CheckSquare className={"h-4 w-4 " + (allSelected ? "text-brand-600" : "text-muted-foreground")} />
                </button>
              </th>
              <th className="px-3 py-2">Nome</th>
              <th className="px-3 py-2">Telefone</th>
              <th className="px-3 py-2">WhatsApp</th>
              <th className="px-3 py-2">E-mail</th>
              <th className="px-3 py-2">Cidade/UF</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">Carregando…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">Nada na fila ainda. Faça uma busca acima e os resultados aparecem aqui.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className={"border-b hover:bg-muted/30 " + (selecionavel(r) && sel.has(r.id) ? "bg-brand-100/20" : "")}>
                  <td className="px-3 py-2">
                    <Checkbox
                      checked={selecionavel(r) && sel.has(r.id)}
                      onCheckedChange={() => toggle(r.id)}
                      disabled={!selecionavel(r)}
                      aria-label={selecionavel(r) ? `Selecionar ${r.nome}` : `${r.nome} já está cadastrado`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.nome}</div>
                    <JaCadastrado r={r} />
                    {r.empresa && r.empresa !== r.nome && <div className="text-caption text-muted-foreground">{r.empresa}</div>}
                    <DetalheDoRascunho r={r} />
                  </td>
                  <td className={"px-3 py-2 " + (r.telefone ? "" : "text-muted-foreground/50")}>{r.telefone ?? "—"}</td>
                  <td className="px-3 py-2"><WhatsAppDoRascunho r={r} /></td>
                  <td className={"px-3 py-2 [overflow-wrap:anywhere] " + (r.email ? "" : "text-muted-foreground/50")}>{r.email ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{[r.cidade, r.uf].filter(Boolean).join("/") || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
