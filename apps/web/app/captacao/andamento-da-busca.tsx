"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from "lucide-react";
import type { CapturaAtual, OrigemCaptura } from "@crmagro/core";
import { avisoDaBusca, type AvisoDaBusca, type TomDoAviso } from "@/lib/captacao-estado";
import { capturaAtualAction } from "./actions";

/**
 * Estado da busca em segundo plano (Maps, Instagram, CNPJ), lido do SERVIDOR: o botão "Buscar" e o
 * aviso de resultado dependem dele, não de uma variável da tela. Por isso vale ao recarregar a página
 * e numa segunda aba. As regras (botão desativado, "N de M", motivo da falha) são de
 * `lib/captacao-estado.ts`, com teste; aqui só há estado de React e desenho.
 */

/** A cada quantos ms a tela relê o estado enquanto há busca andando. */
const INTERVALO_MS = 3_000;

export function useBuscaEmAndamento(origem: OrigemCaptura) {
  const [atual, setAtual] = useState<CapturaAtual | null>(null);
  /** A action de iniciar ainda não respondeu, ou a tela está relendo o estado logo depois dela. */
  const [iniciando, setIniciando] = useState(false);

  const recarregar = useCallback(async () => {
    try {
      setAtual(await capturaAtualAction(origem));
    } catch {
      // falha de rede: mantém o que já estava na tela; a próxima leitura corrige
    }
  }, [origem]);

  useEffect(() => {
    void recarregar();
  }, [recarregar]);

  // Enquanto anda, relê a cada poucos segundos. Ao voltar para a aba (segunda aba, computador que
  // dormiu), relê na hora.
  const andando = Boolean(atual?.emAndamento);
  useEffect(() => {
    if (!andando) return;
    const t = setInterval(() => void recarregar(), INTERVALO_MS);
    return () => clearInterval(t);
  }, [andando, recarregar]);
  useEffect(() => {
    const aoVoltar = () => {
      if (document.visibilityState === "visible") void recarregar();
    };
    document.addEventListener("visibilitychange", aoVoltar);
    return () => document.removeEventListener("visibilitychange", aoVoltar);
  }, [recarregar]);

  return { atual, iniciando, setIniciando, recarregar, andando };
}

/** Roda `aoTerminar` uma vez quando a busca passa de "andando" para "terminou" (atualiza a fila, por exemplo). */
export function useAoTerminarDeBuscar(andando: boolean, aoTerminar: () => void) {
  const antes = useRef(andando);
  useEffect(() => {
    if (antes.current && !andando) aoTerminar();
    antes.current = andando;
  }, [andando, aoTerminar]);
}

const ESTILO: Record<TomDoAviso, { caixa: string; Icone: typeof Info }> = {
  ok: { caixa: "border-success-500/30 bg-success-100 text-success-700", Icone: CheckCircle2 },
  info: { caixa: "border-info-500/30 bg-info-100 text-info-700", Icone: Info },
  aviso: { caixa: "border-warning-500/30 bg-warning-100 text-warning-700", Icone: AlertTriangle },
  erro: { caixa: "border-danger-500/30 bg-danger-100 text-danger-700", Icone: AlertTriangle },
};

/** Caixa de aviso: título, o que aconteceu e o que fazer (texto do servidor), e o que já entrou na fila. */
export function AvisoDaBusca({ aviso, aoFechar }: { aviso: AvisoDaBusca; aoFechar?: () => void }) {
  const { caixa, Icone } = ESTILO[aviso.tom];
  return (
    <div role={aviso.tom === "erro" ? "alert" : "status"} className={"flex items-start gap-2 rounded-lg border p-3 text-caption " + caixa}>
      <Icone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="font-medium">{aviso.titulo}</div>
        <div>{aviso.texto}</div>
        {aviso.tentarDepois && <div>Tente depois das {aviso.tentarDepois}.</div>}
        {aviso.parcial && <div>{aviso.parcial}</div>}
      </div>
      {aoFechar && (
        <button type="button" onClick={aoFechar} aria-label="Fechar aviso" className="shrink-0 opacity-70 hover:opacity-100">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** Aviso do resultado da última busca (some sozinho depois de um tempo, e o usuário pode fechar). */
export function ResultadoDaBusca({ atual }: { atual: CapturaAtual | null }) {
  const [fechado, setFechado] = useState<string | null>(null);
  const aviso = avisoDaBusca(atual, Date.now());
  if (!aviso || !atual || fechado === atual.status.lote) return null;
  return <AvisoDaBusca aviso={aviso} aoFechar={() => setFechado(atual.status.lote)} />;
}

/** Ícone do botão enquanto busca. */
export function GiroDeBusca() {
  return <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />;
}
