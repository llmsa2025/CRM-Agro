"use client";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TELAS_COM_DONO } from "@/lib/telas";

/** O que a pessoa vê e altera por tela: `ver` = de todos; `editar` = também altera (sempre dentro de `ver`). */
export type AcessoPorTela = { ver: string[]; editar: string[] };

type Opcao = "meus" | "ver" | "editar";

const OPCOES: { value: Opcao; label: string }[] = [
  { value: "meus", label: "Só os meus" },
  { value: "ver", label: "Ver de todos" },
  { value: "editar", label: "Ver e editar de todos" },
];

function opcaoDa(valor: AcessoPorTela, id: string): Opcao {
  if (valor.editar.includes(id)) return "editar";
  return valor.ver.includes(id) ? "ver" : "meus";
}

/**
 * "Ver tudo" e "editar" POR TELA (pedido do dono, 28/09): em cada tela com
 * registros que têm dono, a pessoa fica com "Só os meus" (mais os
 * compartilhados), "Ver de todos" (lê os dos colegas, não altera) ou "Ver e
 * editar de todos". O servidor confere de novo (`definirVerTudoEm` no core).
 */
export function SeletorVerTudo({ valor, onChange, disabled }: { valor: AcessoPorTela; onChange: (v: AcessoPorTela) => void; disabled?: boolean }) {
  function escolher(id: string, opcao: Opcao) {
    const semEla = { ver: valor.ver.filter((x) => x !== id), editar: valor.editar.filter((x) => x !== id) };
    if (opcao === "meus") return onChange(semEla);
    onChange({ ver: [...semEla.ver, id], editar: opcao === "editar" ? [...semEla.editar, id] : semEla.editar });
  }
  function todas(opcao: Opcao) {
    const ids = TELAS_COM_DONO.map((t) => t.id);
    onChange({ ver: opcao === "meus" ? [] : ids, editar: opcao === "editar" ? ids : [] });
  }
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-end gap-1 pb-1">
        <span className="pr-1 text-caption text-ink-3">Em todas:</span>
        {OPCOES.map((o) => (
          <Button key={o.value} variant="ghost" size="sm" className="text-caption text-ink-2" disabled={disabled} onClick={() => todas(o.value)}>
            {o.label}
          </Button>
        ))}
      </div>
      {TELAS_COM_DONO.map((t) => (
        <div key={t.id} className="flex items-center justify-between gap-4 border-t border-line py-2">
          <div className="min-w-0">
            <div className="text-small">{t.label}</div>
            {t.dica && <div className="text-caption text-ink-3">{t.dica}</div>}
          </div>
          <Select value={opcaoDa(valor, t.id)} onValueChange={(v) => escolher(t.id, v as Opcao)} disabled={disabled}>
            <SelectTrigger className="h-8 w-48 shrink-0 text-small" aria-label={`${t.label}: o que a pessoa vê e altera`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPCOES.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
  );
}

/**
 * Resumo curto para o botão da linha: "só os meus", "vê e edita de todos",
 * "vê de todos (edita só os seus)", "de todos em Contatos", "de todos em 3 telas".
 */
export function resumoVerTudo(valor: AcessoPorTela): string {
  const ver = TELAS_COM_DONO.filter((t) => valor.ver.includes(t.id));
  const editar = TELAS_COM_DONO.filter((t) => valor.editar.includes(t.id) && valor.ver.includes(t.id));
  if (ver.length === 0) return "só os meus";
  if (ver.length === TELAS_COM_DONO.length) {
    if (editar.length === TELAS_COM_DONO.length) return "vê e edita de todos";
    if (editar.length === 0) return "vê de todos (edita só os seus)";
    return "vê de todos, edita em parte";
  }
  if (ver.length === 1) return `de todos em ${ver[0]!.label}${editar.length ? "" : " (só ver)"}`;
  return `de todos em ${ver.length} telas`;
}
