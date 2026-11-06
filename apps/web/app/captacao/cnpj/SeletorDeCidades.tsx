"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CIDADES_BUSCA_MAX, semAcento } from "@/lib/captacao-filtros";

type Props = {
  /** Cidades do estado escolhido (o servidor confere o nome de novo). */
  opcoes: string[];
  escolhidas: string[];
  onChange: (cidades: string[]) => void;
  /** Sem estado escolhido não há o que mostrar. */
  temEstado: boolean;
  desativado?: boolean;
};

/** Quantas sugestões desenhar de uma vez. Antes eram só 8 e a lista rolável não tinha o que rolar. */
const MAX_SUGESTOES = 150;

/**
 * Seleção múltipla de cidades: busca por nome (sem acento), lista curta de sugestões e chips que se
 * removem com um clique. A quantidade pedida vale para o total das cidades, não por cidade.
 */
export function SeletorDeCidades({ opcoes, escolhidas, onChange, temEstado, desativado }: Props) {
  const [texto, setTexto] = useState("");
  const [aberto, setAberto] = useState(false);

  const sugestoes = useMemo(() => {
    const t = semAcento(texto.trim());
    const livres = opcoes.filter((c) => !escolhidas.includes(c));
    return t ? livres.filter((c) => semAcento(c).includes(t)) : livres;
  }, [texto, opcoes, escolhidas]);
  // Desenha até MAX_SUGESTOES (MG tem 853 cidades); o resto aparece conforme a pessoa digita.
  const visiveis = sugestoes.slice(0, MAX_SUGESTOES);

  const cheio = escolhidas.length >= CIDADES_BUSCA_MAX;

  function adicionar(c: string) {
    if (cheio || escolhidas.includes(c)) return;
    onChange([...escolhidas, c]);
    setTexto("");
  }

  return (
    <div className="space-y-1.5">
      {escolhidas.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Cidades escolhidas">
          {escolhidas.map((c) => (
            <li key={c} className="inline-flex items-center gap-1 rounded-full border border-brand-500 bg-brand-100/40 py-0.5 pl-2.5 pr-1 text-caption">
              {c}
              <button
                type="button"
                onClick={() => onChange(escolhidas.filter((x) => x !== c))}
                disabled={desativado}
                aria-label={`Tirar ${c}`}
                className="rounded-full p-0.5 text-ink-2 hover:text-foreground disabled:opacity-50"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Input
          id="f-cidade"
          value={texto}
          onChange={(e) => {
            setTexto(e.target.value);
            setAberto(true);
          }}
          onFocus={() => setAberto(true)}
          onBlur={() => setTimeout(() => setAberto(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (visiveis[0]) adicionar(visiveis[0]);
            }
          }}
          placeholder={!temEstado ? "Escolha o estado primeiro" : cheio ? `No máximo ${CIDADES_BUSCA_MAX} cidades` : "Busque e escolha uma ou mais cidades"}
          disabled={desativado || !temEstado || cheio}
          autoComplete="off"
          role="combobox"
          aria-expanded={aberto && visiveis.length > 0}
          aria-controls="f-cidades-lista"
        />
        {aberto && temEstado && !cheio && visiveis.length > 0 && (
          <ul id="f-cidades-lista" role="listbox" className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md">
            {visiveis.map((c) => (
              <li key={c} role="option" aria-selected={false}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => adicionar(c)} className="w-full rounded px-2 py-1 text-left text-body hover:bg-muted">
                  {c}
                </button>
              </li>
            ))}
            {sugestoes.length > visiveis.length && (
              <li className="px-2 py-1 text-caption text-ink-3">
                Mais {sugestoes.length - visiveis.length} cidades: continue digitando para filtrar.
              </li>
            )}
          </ul>
        )}
      </div>
      <p className="text-caption text-muted-foreground">
        {escolhidas.length ? `${escolhidas.length} de ${CIDADES_BUSCA_MAX}. A quantidade pedida vale para o total das cidades.` : "Sem cidade, a busca vale para o estado todo."}
      </p>
    </div>
  );
}
