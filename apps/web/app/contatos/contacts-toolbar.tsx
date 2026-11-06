"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { INTERESSE_OPTS } from "@/components/ui/interesse-badge";
import { RELACIONAMENTO_OPTS } from "@/components/ui/status-badge";
import { FiltroVendedor, type PessoaLite } from "@/components/escopo/filtro-vendedor";

const ALL = "__all__";
/** Igual a BUSCA_MIN_CARACTERES do core (o componente de cliente não importa o core). */
const BUSCA_MIN_CARACTERES = 2;

/** Busca ao vivo + filtros de relacionamento, interesse e origem (URL como estado). */
export function ContactsToolbar({
  origens,
  pessoas = [],
  buscaExata = false,
}: {
  origens: string[];
  pessoas?: PessoaLite[];
  /** A cifra de e-mail e telefone está em indice/ligada: telefone e e-mail só se acham pelo valor inteiro. */
  buscaExata?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const search = sp?.get("search") ?? "";
  const status = sp?.get("status") ?? "";
  const interesse = sp?.get("interesse") ?? "";
  const origem = sp?.get("origem") ?? "";
  const dono = sp?.get("dono") ?? "";

  const [term, setTerm] = useState(search);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTerm(search);
  }, [search]);

  function update(key: string, value: string) {
    const params = new URLSearchParams(sp?.toString() ?? "");
    if (value && value !== ALL) params.set(key, value);
    else params.delete(key);
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  function onSearchChange(value: string) {
    setTerm(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Com 1 letra só ainda não é busca: espera a pessoa digitar mais (apagar tudo limpa a busca na hora).
    const tamanho = value.trim().length;
    if (tamanho > 0 && tamanho < BUSCA_MIN_CARACTERES) return;
    debounceRef.current = setTimeout(() => update("search", value.trim()), 300);
  }

  const hasFilters = Boolean(search || status || interesse || origem || dono);
  const curtoDemais = term.trim().length > 0 && term.trim().length < BUSCA_MIN_CARACTERES;
  // O termo parece um pedaço de telefone ou e-mail: avisa que essa busca é pelo valor inteiro.
  const pareceTelefoneOuEmail = /@/.test(term) || (/^[\d\s().+-]+$/.test(term) && term.replace(/\D/g, "").length >= 4);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-[260px] flex-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <Input
            name="search"
            value={term}
            placeholder={buscaExata ? "Buscar por nome, empresa, CNPJ, telefone, e-mail completo ou palavra do histórico" : "Buscar por nome, empresa, CNPJ, telefone, e-mail ou palavra do histórico"}
            aria-describedby="busca-ajuda"
            className="pl-9"
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        {curtoDemais && (
          <p id="busca-ajuda" className="mt-1 text-xs text-ink-3">
            Digite pelo menos {BUSCA_MIN_CARACTERES} letras para buscar.
          </p>
        )}
        {!curtoDemais && buscaExata && pareceTelefoneOuEmail && (
          <p id="busca-ajuda" className="mt-1 text-xs text-ink-3">Telefone e e-mail são buscados pelo valor completo. Digite o número ou o endereço inteiro.</p>
        )}
      </div>

      <Select value={status || ALL} onValueChange={(v) => update("status", v)}>
        <SelectTrigger className="h-9 w-[190px]" aria-label="Relacionamento">
          <SelectValue placeholder="Relacionamento" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Relacionamento: todos</SelectItem>
          {RELACIONAMENTO_OPTS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={interesse || ALL} onValueChange={(v) => update("interesse", v)}>
        <SelectTrigger className="h-9 w-[160px]" aria-label="Interesse">
          <SelectValue placeholder="Interesse" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Interesse: todos</SelectItem>
          {INTERESSE_OPTS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={origem || ALL} onValueChange={(v) => update("origem", v)}>
        <SelectTrigger className="h-9 w-[160px]" aria-label="Origem">
          <SelectValue placeholder="Origem" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Origem: todas</SelectItem>
          {origens.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* F3d: "por vendedor" — só para quem vê o time todo. */}
      <FiltroVendedor pessoas={pessoas} />

      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={() => router.push(pathname ?? "/contatos")}>
          <X className="h-4 w-4" />
          Limpar
        </Button>
      )}
    </div>
  );
}
