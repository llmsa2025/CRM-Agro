"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cnaeFormatado, filtrarCnaes } from "@/lib/captacao-filtros";

type Tabela = readonly (readonly [string, string])[];

type Props = {
  escolhidos: string[];
  onAlternar: (codigo: string) => void;
  desativado?: boolean;
};

/**
 * Lista completa de CNAEs (tabela de subclasses do IBGE, 1.332 códigos), aberta pela seta. Carrega a tabela
 * só na primeira abertura, com busca por código ou por texto. Os já escolhidos ficam no topo.
 */
export function ListaDeCnaes({ escolhidos, onAlternar, desativado }: Props) {
  const [aberto, setAberto] = useState(false);
  const [tabela, setTabela] = useState<Tabela | null>(null);
  const [erro, setErro] = useState(false);
  const [busca, setBusca] = useState("");

  useEffect(() => {
    if (!aberto || tabela) return;
    let vivo = true;
    import("@/lib/cnaes-ibge")
      .then((m) => vivo && setTabela(m.CNAES_IBGE))
      .catch(() => vivo && setErro(true));
    return () => {
      vivo = false;
    };
  }, [aberto, tabela]);

  const { itens, total } = useMemo(() => (tabela ? filtrarCnaes(tabela, busca, 60) : { itens: [], total: 0 }), [tabela, busca]);
  const marcados = useMemo(() => (tabela ? tabela.filter(([c]) => escolhidos.includes(c)) : []), [tabela, escolhidos]);
  const demais = itens.filter(([c]) => !escolhidos.includes(c));

  const linha = ([codigo, nome]: readonly [string, string]) => (
    <li key={codigo}>
      <label className="flex items-start gap-2 py-0.5">
        <Checkbox checked={escolhidos.includes(codigo)} onCheckedChange={() => onAlternar(codigo)} disabled={desativado} className="mt-0.5" />
        <span>
          <span className="num">{cnaeFormatado(codigo)}</span> {nome}
        </span>
      </label>
    </li>
  );

  return (
    <details className="text-caption text-muted-foreground" onToggle={(e) => setAberto((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer select-none">Ver todos os CNAEs</summary>
      <div className="mt-2 space-y-2">
        {erro ? (
          <p>Não deu para carregar a lista de CNAEs. Digite os códigos no campo acima.</p>
        ) : !tabela ? (
          <p className="flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Carregando a lista
          </p>
        ) : (
          <>
            <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por código ou por texto, como 0115 ou soja" aria-label="Buscar CNAE" className="h-8" />
            <ul className="max-h-72 space-y-0 overflow-auto rounded-md border p-2 text-foreground">
              {marcados.map(linha)}
              {demais.map(linha)}
              {total === 0 && <li className="text-muted-foreground">Nenhum CNAE com esse texto.</li>}
            </ul>
            <p>{total > itens.length ? `Mostrando ${itens.length} de ${total}. Refine a busca para ver os outros.` : `${total} CNAEs.`}</p>
          </>
        )}
      </div>
    </details>
  );
}
