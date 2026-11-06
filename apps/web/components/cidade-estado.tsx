"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UFS_BR, semAcento } from "@/lib/captacao-filtros";
import { municipiosDaUfAction } from "@/app/captacao/actions";

/**
 * Campos "Estado (UF)" + "Cidade" para escolher em vez de digitar: o estado é uma caixa de seleção e a
 * cidade é uma busca que sugere os municípios daquele estado (base do IBGE já no CRM Agro). Serve para os
 * formulários de contato e de empresa.
 *
 * - O valor continua sendo texto simples (`estado` = "MT", `cidade` = "Alta Floresta"), então nada muda no
 *   servidor nem nos dados já cadastrados.
 * - Valor antigo que não está na lista (digitado à mão, outro formato) é mantido e continua editável.
 * - Sem a lista de municípios (base não carregada, erro de rede) a cidade vira campo livre: nunca trava o cadastro.
 * - A lista de sugestões abre como um pop-up pequeno logo abaixo do campo de cidade (por cima do formulário,
 *   sem empurrar nada). Se não couber embaixo, dentro da área visível da janela, abre para cima.
 */

const selectClasse =
  "flex h-9 w-full rounded-md border border-line-strong bg-background px-3 py-1 text-body text-foreground focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50";

/** Quantas sugestões desenhar de uma vez (MG tem 853 cidades; o resto aparece ao digitar). */
const MAX_SUGESTOES = 150;

/** Altura máxima do pop-up (`max-h-48`), em px: abaixo disso de espaço livre, a lista abre para cima. */
const ALTURA_POPUP = 192;

/** Primeiro ancestral com rolagem (a janela do cadastro); sem ele, vale a tela. */
function areaVisivel(el: HTMLElement): { top: number; bottom: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") {
      const r = p.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}

// Uma consulta por estado por sessão: abrir vários formulários não repete o pedido.
const cacheMunicipios = new Map<string, Promise<string[]>>();
function municipiosDe(uf: string): Promise<string[]> {
  let p = cacheMunicipios.get(uf);
  if (!p) {
    p = municipiosDaUfAction(uf).catch(() => {
      cacheMunicipios.delete(uf); // falhou: deixa tentar de novo na próxima vez
      return [] as string[];
    });
    cacheMunicipios.set(uf, p);
  }
  return p;
}

/** "mt " → "MT" quando é uma UF; qualquer outra coisa volta como veio (sem espaços). */
export function ufNormalizada(v: string): string {
  const u = v.trim().toUpperCase();
  return (UFS_BR as readonly string[]).includes(u) ? u : v.trim();
}

export type CidadeEstado = { cidade: string; estado: string };

type Props = {
  cidade: string;
  estado: string;
  onChange: (v: CidadeEstado) => void;
  /** Prefixo dos ids (ligam o rótulo ao campo). */
  idPrefix?: string;
  desativado?: boolean;
  rotuloEstado?: string;
  rotuloCidade?: string;
  className?: string;
};

export function CidadeEstadoCampos({
  cidade,
  estado,
  onChange,
  idPrefix,
  desativado,
  rotuloEstado = "Estado (UF)",
  rotuloCidade = "Cidade",
  className,
}: Props) {
  const gerado = useId();
  const base = idPrefix ?? gerado;
  const uf = ufNormalizada(estado);
  const ufConhecida = (UFS_BR as readonly string[]).includes(uf);

  const [opcoes, setOpcoes] = useState<string[]>([]);
  const [aberto, setAberto] = useState(false);
  const [destaque, setDestaque] = useState(0);
  const [paraCima, setParaCima] = useState(false);
  const campoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ufConhecida) {
      setOpcoes([]);
      return;
    }
    let vivo = true;
    municipiosDe(uf).then((n) => vivo && setOpcoes(n));
    return () => {
      vivo = false;
    };
  }, [uf, ufConhecida]);

  const busca = semAcento(cidade.trim());
  const sugestoes = useMemo(() => {
    if (!busca) return opcoes;
    // O que COMEÇA com o texto vem antes do que só contém.
    const comeca: string[] = [];
    const contem: string[] = [];
    for (const c of opcoes) {
      const s = semAcento(c);
      if (s.startsWith(busca)) comeca.push(c);
      else if (s.includes(busca)) contem.push(c);
    }
    return [...comeca, ...contem];
  }, [opcoes, busca]);
  // Já escolhida (texto igual a uma cidade da lista): não precisa mostrar a lista de novo.
  const jaEscolhida = opcoes.some((c) => semAcento(c) === busca);
  const visiveis = sugestoes.slice(0, MAX_SUGESTOES);

  function escolher(c: string) {
    onChange({ cidade: c, estado: uf });
    setAberto(false);
  }

  function mudarUf(novo: string) {
    // Trocar de estado invalida a cidade antiga; só preserva se não havia estado (cadastro antigo só com cidade).
    onChange({ estado: novo, cidade: uf ? "" : cidade });
  }

  function aoSair() {
    setTimeout(() => setAberto(false), 120);
    // Texto igual a uma cidade da lista (sem acento/maiúscula) vira o nome certo.
    const exata = opcoes.find((c) => semAcento(c) === busca);
    if (exata && exata !== cidade) onChange({ cidade: exata, estado: uf });
  }

  const mostrarLista = aberto && ufConhecida && !jaEscolhida && visiveis.length > 0;

  // Mede uma vez ao abrir (não a cada letra, para a lista não pular): sem espaço embaixo e com mais em cima, abre para cima.
  // Layout effect: decide antes de pintar, senão a lista aparece embaixo por um instante e pula.
  useLayoutEffect(() => {
    if (!mostrarLista || !campoRef.current) return;
    const campo = campoRef.current.getBoundingClientRect();
    const area = areaVisivel(campoRef.current);
    const embaixo = area.bottom - campo.bottom;
    const emCima = campo.top - area.top;
    setParaCima(embaixo < ALTURA_POPUP && emCima > embaixo);
  }, [mostrarLista]);

  return (
    <div className={className ?? "grid grid-cols-[minmax(0,1fr)_6.5rem] gap-3"}>
      <div className="grid content-start gap-1.5">
        <Label className="text-caption" htmlFor={`${base}-cidade`}>{rotuloCidade}</Label>
        <div ref={campoRef} className="relative">
          <Input
            id={`${base}-cidade`}
            value={cidade}
            onChange={(e) => {
              onChange({ cidade: e.target.value, estado: uf });
              setAberto(true);
              setDestaque(0);
            }}
            onFocus={() => setAberto(true)}
            onBlur={aoSair}
            onKeyDown={(e) => {
              if (!mostrarLista) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setDestaque((d) => Math.min(d + 1, visiveis.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setDestaque((d) => Math.max(d - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                escolher(visiveis[Math.min(destaque, visiveis.length - 1)]!);
              } else if (e.key === "Escape") {
                setAberto(false);
              }
            }}
            placeholder={ufConhecida || uf ? "Digite para buscar" : "Escolha o estado"}
            disabled={desativado}
            autoComplete="off"
            role="combobox"
            aria-expanded={mostrarLista}
            aria-controls={`${base}-cidades`}
          />
          {mostrarLista && (
            <ul
              id={`${base}-cidades`}
              role="listbox"
              className={
                "absolute left-0 right-0 z-30 max-h-48 overflow-y-auto rounded-md border border-line bg-popover p-1 shadow-popover " +
                (paraCima ? "bottom-full mb-1" : "top-full mt-1")
              }
            >
              {visiveis.map((c, i) => (
                <li key={c} role="option" aria-selected={i === destaque}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => escolher(c)}
                    className={"w-full rounded px-2 py-1 text-left text-body hover:bg-muted " + (i === destaque ? "bg-muted" : "")}
                  >
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
      </div>
      <div className="grid content-start gap-1.5">
        <Label className="text-caption" htmlFor={`${base}-uf`}>{rotuloEstado}</Label>
        <select
          id={`${base}-uf`}
          className={selectClasse}
          value={uf}
          onChange={(e) => mudarUf(e.target.value)}
          disabled={desativado}
        >
          <option value="">Selecione</option>
          {/* Valor antigo fora da lista (ex.: "Mato Grosso") continua aparecendo até a pessoa trocar. */}
          {uf && !ufConhecida && <option value={uf}>{uf}</option>}
          {UFS_BR.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * Versão para formulários de `action` (FormData): guarda o valor internamente e entrega nos campos
 * escondidos `cidade` e `estado` (ou nos nomes passados).
 */
export function CidadeEstadoForm({
  cidadeInicial,
  estadoInicial,
  nomeCidade = "cidade",
  nomeEstado = "estado",
  idPrefix,
}: {
  cidadeInicial?: string | null;
  estadoInicial?: string | null;
  nomeCidade?: string;
  nomeEstado?: string;
  idPrefix?: string;
}) {
  const [v, setV] = useState<CidadeEstado>({ cidade: cidadeInicial ?? "", estado: estadoInicial ?? "" });
  return (
    <>
      <input type="hidden" name={nomeCidade} value={v.cidade} />
      <input type="hidden" name={nomeEstado} value={v.estado} />
      <CidadeEstadoCampos cidade={v.cidade} estado={v.estado} onChange={setV} idPrefix={idPrefix} />
    </>
  );
}
