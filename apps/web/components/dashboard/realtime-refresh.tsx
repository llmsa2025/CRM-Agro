"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSocket } from "@/lib/socket-client";

/**
 * Atualiza o Painel em tempo real. Escuta `dashboard:changed` (emitido a cada
 * toque/atividade que mexe nos números) e chama `router.refresh()`.
 *
 * Velocidade: o Painel custa ~25 consultas por render (auditoria DP-07). Por
 * isso o refresh é LIMITADO a 1 a cada 20 s por aba e só roda com a aba
 * visível — uma rajada de eventos vira um refetch, e aba escondida não gasta.
 */
const INTERVALO_MIN_MS = 20_000;

export function RealtimeRefresh() {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ultimoRef = useRef(0);
  const pendenteRef = useRef(false);

  const executar = useCallback(() => {
    pendenteRef.current = false;
    ultimoRef.current = Date.now();
    router.refresh();
  }, [router]);

  const agendar = useCallback(() => {
    if (document.visibilityState !== "visible") {
      pendenteRef.current = true;
      return;
    }
    if (timerRef.current) return; // já há um refresh agendado
    const espera = Math.max(1_500, INTERVALO_MIN_MS - (Date.now() - ultimoRef.current));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      executar();
    }, espera);
  }, [executar]);

  useEffect(() => {
    // Ao voltar para a aba, aplica o refresh que ficou pendente.
    const onVisivel = () => {
      if (document.visibilityState === "visible" && pendenteRef.current) agendar();
    };
    document.addEventListener("visibilitychange", onVisivel);
    return () => {
      document.removeEventListener("visibilitychange", onVisivel);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [agendar]);

  useSocket({ "dashboard:changed": agendar });

  return null;
}
