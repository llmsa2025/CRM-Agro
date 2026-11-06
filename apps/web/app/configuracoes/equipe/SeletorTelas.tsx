"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { TELAS } from "@/lib/telas";

/**
 * Telas de uma pessoa (F2b). `valor` vazio = todas (padrão do papel); marcar
 * todas de novo volta ao vazio. O Painel é sempre liberado (página inicial).
 */
export function SeletorTelas({ valor, onChange, disabled }: { valor: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const todas = valor.length === 0;
  const marcada = (id: string) => id === "painel" || todas || valor.includes(id);
  function alternar(id: string, v: boolean) {
    const atual = todas ? TELAS.map((t) => t.id) : valor;
    const nova = v ? [...new Set([...atual, id])] : atual.filter((x) => x !== id);
    // Todas marcadas = vazio (acompanha as telas novas que vierem).
    onChange(TELAS.every((t) => t.id === "painel" || nova.includes(t.id)) ? [] : [...new Set(["painel", ...nova])]);
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
      {TELAS.map((t) => (
        <label key={t.id} className="inline-flex items-center gap-2 text-small">
          <Checkbox checked={marcada(t.id)} disabled={disabled || t.id === "painel"} onCheckedChange={(v) => alternar(t.id, v === true)} />
          {t.label}
        </label>
      ))}
    </div>
  );
}
