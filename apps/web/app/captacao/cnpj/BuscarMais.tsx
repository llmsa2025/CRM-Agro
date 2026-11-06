"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { CapturaAtual } from "@crmagro/core";
import type { botaoDaCaptura } from "@/lib/captacao-estado";
import { continuarBuscaPorFiltroAction } from "../actions";

type Props = {
  botao: ReturnType<typeof botaoDaCaptura>;
  atual: CapturaAtual | null;
  /** Quantas empresas a nova rodada traz (1 a 500). */
  limite: number;
  setIniciando: (v: boolean) => void;
  recarregar: () => Promise<void>;
};

/**
 * "Buscar mais": continua a busca por filtro (ou por sócio) anterior de onde ela parou, com os mesmos
 * filtros. Só aparece quando o servidor diz que a busca terminou antes do fim da fonte.
 */
export function BuscarMais({ botao, atual, limite, setIniciando, recarregar }: Props) {
  if (!atual || atual.emAndamento || !atual.status.podeContinuar) return null;
  async function buscarMais() {
    if (botao.desativado || !atual) return;
    setIniciando(true);
    const res = await continuarBuscaPorFiltroAction(atual.status.lote, limite);
    if (res.error) {
      setIniciando(false);
      return toast.error("Não deu para continuar", { description: res.error });
    }
    await recarregar();
    setIniciando(false);
    toast.success("Buscando mais empresas", { description: "Os mesmos filtros, de onde a busca parou." });
  }
  return (
    <Button type="button" variant="outline" onClick={buscarMais} disabled={botao.desativado}>
      Buscar mais
    </Button>
  );
}
