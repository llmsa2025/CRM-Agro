"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Building2, Search, CheckSquare, Download, Trash2, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ProspectDraftDTO } from "@crmagro/core";
import {
  captureCnpjsAction,
  listDraftsAction,
  importDraftsAction,
  discardDraftsAction,
} from "../actions";
import { DetalheDoRascunho, JaCadastrado, LimparFila, WhatsAppDoRascunho, selecionavel } from "../fila-extras";
import { botaoDaCaptura } from "@/lib/captacao-estado";
import { GiroDeBusca, ResultadoDaBusca, useAoTerminarDeBuscar, useBuscaEmAndamento } from "../andamento-da-busca";
import { PorFiltros } from "./PorFiltros";
import { PorSocios } from "./PorSocios";
import { VincularAContato } from "./VincularAContato";

export function CnpjCapture() {
  const [input, setInput] = useState("");
  // Lista grande de CNPJ vai para a fila do servidor: o estado dela vem de lá (vale ao recarregar e em outra aba).
  const { atual, iniciando: capturing, setIniciando: setCapturing, recarregar, andando } = useBuscaEmAndamento("cnpj");
  const botao = botaoDaCaptura({ iniciando: capturing, atual }, "Buscar");
  const [rows, setRows] = useState<ProspectDraftDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [soComContato, setSoComContato] = useState(false);
  const [soComWhatsApp, setSoComWhatsApp] = useState(false);
  const [soProdutor, setSoProdutor] = useState(false);
  const [acting, setActing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRows(
        await listDraftsAction({
          origem: "cnpj",
          soComContato,
          search: search.trim() || undefined,
          ...(soComWhatsApp ? { temWhatsApp: true } : {}),
          ...(soProdutor ? { produtorLabel: ["produtor", "provavel_produtor"] as const } : {}),
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [soComContato, soComWhatsApp, soProdutor, search]);

  // A fila persiste (§H.1): abrir a tela só lista. Limpar é o botão "Limpar fila".
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Enquanto a lista na fila anda, relê a fila de rascunhos; ao terminar, uma última vez.
  useEffect(() => {
    if (!andando) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [andando, refresh]);
  useAoTerminarDeBuscar(andando, () => void refresh());

  async function capturar() {
    if (botao.desativado) return;
    const cnpjs = input.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!cnpjs.length) {
      toast.error("Cole um ou mais CNPJs");
      return;
    }
    setCapturing(true);
    const r = await captureCnpjsAction(cnpjs);
    if (r.error) {
      setCapturing(false);
      toast.error("Falha na captura", { description: r.error });
      return;
    }
    if (r.enfileirados) {
      // Lista grande: roda no servidor. O botão fica desativado pelo estado que vem de lá.
      await recarregar();
      setCapturing(false);
      toast.success("Busca iniciada", { description: `${r.enfileirados} CNPJs na fila. O andamento aparece ao lado do botão.` });
      setInput("");
      return;
    }
    await recarregar();
    setCapturing(false);
    toast.success(`${r.criados ?? 0} empresa(s) capturada(s)`, {
      description: r.falhas?.length ? `${r.falhas.length} falharam (inválido/não encontrado)` : undefined,
    });
    setInput("");
    void refresh();
  }

  // Já cadastrado (regra do dono, 28/09): a linha não entra na seleção — nem
  // pelo "selecionar todos". Some da seleção também se virou contato no refresh.
  const selecionaveis = useMemo(() => rows.filter(selecionavel), [rows]);
  const allSelected = selecionaveis.length > 0 && selecionaveis.every((r) => sel.has(r.id));
  function toggleAll() {
    setSel(allSelected ? new Set() : new Set(selecionaveis.map((r) => r.id)));
  }
  function toggle(id: string) {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
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
    <div className="space-y-5">
      <div>
        <Link href="/captacao" className="mb-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Captação
        </Link>
        <h1 className="flex items-center gap-2 text-h1 font-semibold tracking-tight">
          <Building2 className="h-5 w-5" /> Busca de empresas
        </h1>
        <p className="text-body text-muted-foreground">
          Busque por CNPJ ou por filtros, revise os dados e importe só os que quiser. Nada entra na base sem seu OK.
        </p>
      </div>

      {/* Entrada: uma aba por jeito de buscar. Tudo cai na mesma fila de revisão abaixo. */}
      <Tabs defaultValue="cnpj" className="rounded-lg border bg-card p-4">
        <TabsList>
          <TabsTrigger value="cnpj">Por CNPJ</TabsTrigger>
          <TabsTrigger value="filtros">Por filtros</TabsTrigger>
          <TabsTrigger value="socios">Por sócios</TabsTrigger>
        </TabsList>
        <TabsContent value="cnpj">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={3}
            placeholder="Cole os CNPJs separados por vírgula, espaço ou quebra de linha…"
            disabled={botao.desativado}
          />
          <div className="mt-2 flex items-center justify-end gap-3">
            {botao.andamento && (
              <span className="num text-caption text-muted-foreground" role="status" aria-live="polite">
                {botao.andamento}
              </span>
            )}
            <Button onClick={capturar} disabled={botao.desativado} aria-busy={botao.desativado}>
              {botao.desativado ? <GiroDeBusca /> : <Search className="mr-1.5 h-4 w-4" />}
              {botao.rotulo}
            </Button>
          </div>
        </TabsContent>
        <TabsContent value="filtros">
          <PorFiltros botao={botao} atual={atual} setIniciando={setCapturing} recarregar={recarregar} />
        </TabsContent>
        <TabsContent value="socios">
          <PorSocios botao={botao} atual={atual} setIniciando={setCapturing} recarregar={recarregar} />
        </TabsContent>
      </Tabs>

      <ResultadoDaBusca atual={atual} />

      {/* Staging */}
      <div className="rounded-lg border">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filtrar por nome, CNAE, cidade…" className="h-8 pl-8" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={soComContato} onCheckedChange={(v) => setSoComContato(v === true)} />
            Só com contato (telefone/e-mail)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={soComWhatsApp} onCheckedChange={(v) => setSoComWhatsApp(v === true)} />
            Só com WhatsApp
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={soProdutor} onCheckedChange={(v) => setSoProdutor(v === true)} />
            Só produtor rural
          </label>
          <span className="text-caption text-muted-foreground">{rows.length} na fila</span>
          <LimparFila origem="cnpj" total={rows.length} onLimpa={() => { setSel(new Set()); void refresh(); }} />
        </div>

        {selIds.length > 0 && (
          <div className="flex items-center gap-2 border-b bg-brand-100/30 p-2">
            <span className="text-caption font-medium">{selIds.length} selecionado(s)</span>
            <Button size="sm" onClick={importar} disabled={acting}>
              {acting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
              Importar p/ CRM Agro
            </Button>
            <VincularAContato ids={selIds} onFeito={() => { setSel(new Set()); void refresh(); }} />
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
                <th className="px-3 py-2">Empresa</th>
                <th className="px-3 py-2">CNAE</th>
                <th className="px-3 py-2">Cidade/UF</th>
                <th className="px-3 py-2">Telefone</th>
                <th className="px-3 py-2">WhatsApp</th>
                <th className="px-3 py-2">E-mail</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">Carregando…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">Nada na fila. Busque acima e as empresas aparecem aqui para revisar.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className={"border-b hover:bg-muted/30 " + (selecionavel(r) && sel.has(r.id) ? "bg-brand-100/20" : "")}>
                    <td className="px-3 py-2">
                      <Checkbox
                        checked={selecionavel(r) && sel.has(r.id)}
                        onCheckedChange={() => toggle(r.id)}
                        disabled={!selecionavel(r)}
                        aria-label={selecionavel(r) ? `Selecionar ${r.empresa || r.nome}` : `${r.empresa || r.nome} já está cadastrado`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.empresa || r.nome}</div>
                      <div className="text-caption text-muted-foreground">{r.cnpj}</div>
                      <JaCadastrado r={r} />
                      <DetalheDoRascunho r={r} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground [overflow-wrap:anywhere]">{r.cnae ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{[r.cidade, r.uf].filter(Boolean).join("/") || "—"}</td>
                    <td className={"px-3 py-2 " + (r.telefone ? "" : "text-muted-foreground/50")}>{r.telefone ?? "—"}</td>
                    <td className="px-3 py-2"><WhatsAppDoRascunho r={r} /></td>
                    <td className={"px-3 py-2 [overflow-wrap:anywhere] " + (r.email ? "" : "text-muted-foreground/50")}>{r.email ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
