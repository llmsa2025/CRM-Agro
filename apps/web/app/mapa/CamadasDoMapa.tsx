"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Layers, Loader2, MoreHorizontal, Plus } from "lucide-react";
import type { CamadaDTO } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { createCamadaAction, deleteCamadaAction, moverContatosParaCamadaAction, updateCamadaAction } from "./actions";

/** "Sem camada" — mesmo valor do core (`SEM_CAMADA`); o cliente não importa valor do core. */
export const SEM_CAMADA = "__none__";

type Editor = { id: string | null; nome: string; cor: string; moverDepois?: boolean };

/**
 * Camadas do mapa, como no Google My Maps: cada camada com a sua cor, liga e
 * desliga (a última visível não desliga), cria, renomeia, muda a cor, exclui
 * e recebe os contatos visíveis de uma vez. As contagens são da região visível
 * (resumo); camada desligada mostra o total dela, apagado.
 */
export function CamadasDoMapa({
  camadas,
  semCamadaTotal,
  cores,
  porCamada,
  ocultas,
  onAlternar,
  podeEditar,
  idsVisiveis,
  emAgrupamento,
  onMudou,
}: {
  camadas: CamadaDTO[];
  semCamadaTotal: number;
  cores: string[];
  porCamada: Record<string, number> | null;
  ocultas: string[];
  onAlternar: (id: string, visivel: boolean) => void;
  podeEditar: boolean;
  /** Ids dos contatos visíveis (só quando o mapa mostra um a um). */
  idsVisiveis: string[] | null;
  /** O mapa está em agrupamentos do servidor: "aproxime para ver um a um". */
  emAgrupamento: boolean;
  onMudou: () => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pending, start] = useTransition();
  const corPadrao = cores[0] ?? "#1F4A3A";
  const linhas = [...camadas.map((c) => ({ id: c.id, nome: c.nome, cor: c.cor, total: c.contatos })), { id: SEM_CAMADA, nome: "Sem camada", cor: "#69706B", total: semCamadaTotal }];
  const visiveis = linhas.filter((l) => !ocultas.includes(l.id)).length;

  function alternar(id: string, marcar: boolean) {
    if (!marcar && visiveis <= 1) {
      toast.message("Deixe pelo menos uma camada visível");
      return;
    }
    onAlternar(id, marcar);
  }

  function moverVisiveis(camadaId: string) {
    const ids = idsVisiveis ?? [];
    if (!ids.length) return;
    start(async () => {
      const r = await moverContatosParaCamadaAction(ids, camadaId);
      if (!r.ok) return void toast.error("Não deu para mover", { description: r.error });
      const nome = camadas.find((c) => c.id === camadaId)?.nome ?? "a camada";
      toast.success(`${r.movidos} ${r.movidos === 1 ? "contato movido" : "contatos movidos"} para ${nome}`);
      onMudou();
    });
  }

  function salvar() {
    if (!editor) return;
    const nome = editor.nome.trim();
    if (!nome) return void toast.error("Dê um nome à camada");
    start(async () => {
      const r = editor.id ? await updateCamadaAction(editor.id, { nome, cor: editor.cor }) : await createCamadaAction({ nome, cor: editor.cor });
      if (!r.ok) return void toast.error(editor.id ? "Não deu para salvar a camada" : "Não deu para criar a camada", { description: r.error });
      const moverDepois = editor.moverDepois;
      setEditor(null);
      if (moverDepois && idsVisiveis?.length) {
        const m = await moverContatosParaCamadaAction(idsVisiveis, r.camada.id);
        if (!m.ok) toast.error("Camada criada, mas os contatos não entraram", { description: m.error });
        else toast.success(`Camada ${r.camada.nome} criada com ${m.movidos} ${m.movidos === 1 ? "contato" : "contatos"}`);
      } else toast.success(editor.id ? "Camada salva" : `Camada ${r.camada.nome} criada`);
      onMudou();
    });
  }

  function excluir(c: { id: string; nome: string; total: number }) {
    const aviso = c.total ? ` Os ${c.total} contatos dela voltam para "Sem camada".` : "";
    if (!confirm(`Excluir a camada "${c.nome}"?${aviso}`)) return;
    start(async () => {
      const r = await deleteCamadaAction(c.id);
      if (!r.ok) return void toast.error("Não deu para excluir", { description: r.error });
      toast.success("Camada excluída");
      onMudou();
    });
  }

  const nVisiveis = idsVisiveis?.length ?? 0;

  return (
    <div className="border-t border-line py-3">
      <div className="flex items-center justify-between">
        <span className="text-caption font-medium uppercase tracking-wide text-ink-3">Camadas</span>
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-3" />}
      </div>

      <div className="flex flex-col pt-1.5">
        {linhas.map((l) => {
          const visivel = !ocultas.includes(l.id);
          const naRegiao = porCamada ? (porCamada[l.id] ?? 0) : null;
          const editavel = podeEditar && l.id !== SEM_CAMADA;
          if (editor?.id === l.id) return <EditorCamada key={l.id} editor={editor} cores={cores} onChange={setEditor} onSalvar={salvar} onCancelar={() => setEditor(null)} pending={pending} />;
          return (
            <div key={l.id} className="group flex items-center gap-2 py-1 text-small">
              <Checkbox checked={visivel} onCheckedChange={(v) => alternar(l.id, v === true)} aria-label={`Mostrar ${l.nome}`} />
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: l.cor }} aria-hidden />
              <span className={cn("min-w-0 flex-1 truncate", !visivel && "text-ink-3")}>{l.nome}</span>
              <span className={cn("num text-caption", visivel ? "text-ink-2" : "text-ink-3")} title={visivel ? "Na região visível" : "Total da camada"}>
                {visivel && naRegiao !== null ? naRegiao : l.total}
              </span>
              {editavel ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label={`Opções de ${l.nome}`} className="rounded p-0.5 text-ink-3 opacity-60 hover:bg-accent hover:text-foreground group-hover:opacity-100">
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEditor({ id: l.id, nome: l.nome, cor: l.cor })}>Renomear ou mudar a cor</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-danger-500 focus:text-danger-500" onSelect={() => excluir(l)}>
                      Excluir
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span className="w-5" aria-hidden />
              )}
            </div>
          );
        })}
      </div>

      {podeEditar && (
        <div className="flex flex-col gap-2 pt-2">
          {editor && editor.id === null ? (
            <EditorCamada editor={editor} cores={cores} onChange={setEditor} onSalvar={salvar} onCancelar={() => setEditor(null)} pending={pending} />
          ) : (
            <button
              type="button"
              onClick={() => setEditor({ id: null, nome: "", cor: cores[camadas.length % Math.max(1, cores.length)] ?? corPadrao })}
              className="inline-flex items-center gap-1.5 self-start text-small font-medium text-brand-500 hover:underline"
            >
              <Plus className="h-3.5 w-3.5" /> Nova camada
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="justify-start"
                disabled={pending || emAgrupamento || nVisiveis === 0}
                title={emAgrupamento ? "Aproxime para ver os contatos um a um" : undefined}
              >
                <Layers className="h-3.5 w-3.5" />
                {emAgrupamento ? "Aproxime para mover os visíveis" : `Adicionar os ${nVisiveis} visíveis à camada`}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel className="text-caption font-normal text-ink-3">Mover os {nVisiveis} contatos visíveis para…</DropdownMenuLabel>
              {camadas.map((c) => (
                <DropdownMenuItem key={c.id} onSelect={() => moverVisiveis(c.id)}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.cor }} aria-hidden />
                  {c.nome}
                </DropdownMenuItem>
              ))}
              {camadas.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onSelect={() => setEditor({ id: null, nome: "", cor: cores[camadas.length % Math.max(1, cores.length)] ?? corPadrao, moverDepois: true })}
              >
                <Plus className="h-3.5 w-3.5" /> Nova camada…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

/** Linha de edição: nome + as cores + Salvar/Cancelar (criar e renomear usam a mesma). */
function EditorCamada({
  editor,
  cores,
  onChange,
  onSalvar,
  onCancelar,
  pending,
}: {
  editor: Editor;
  cores: string[];
  onChange: (e: Editor) => void;
  onSalvar: () => void;
  onCancelar: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-2">
      <Input
        autoFocus
        value={editor.nome}
        onChange={(e) => onChange({ ...editor, nome: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSalvar();
          if (e.key === "Escape") onCancelar();
        }}
        placeholder={editor.moverDepois ? "Nome da camada nova" : "Ex.: Acima de 5.000 ha"}
        maxLength={60}
        className="h-8 text-small"
      />
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Cor da camada">
        {cores.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={editor.cor === c}
            aria-label={`Cor ${c}`}
            onClick={() => onChange({ ...editor, cor: c })}
            className={cn("h-5 w-5 rounded-full ring-offset-1 ring-offset-background", editor.cor === c && "ring-2 ring-ink-2")}
            style={{ background: c }}
          />
        ))}
      </div>
      {editor.moverDepois && <p className="text-caption text-ink-3">Os contatos visíveis entram nela ao salvar.</p>}
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancelar} disabled={pending}>
          Cancelar
        </Button>
        <Button size="sm" onClick={onSalvar} disabled={pending || !editor.nome.trim()}>
          Salvar
        </Button>
      </div>
    </div>
  );
}
