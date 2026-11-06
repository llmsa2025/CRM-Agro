"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { dueAppointmentsAction } from "@/app/agenda/actions";

/**
 * Alerta na plataforma quando um compromisso da Agenda chega na hora.
 * Faz poll a cada 60s e mostra um toast por compromisso (deduplica por id).
 */
export function AgendaAlerts() {
  const alerted = useRef<Set<string>>(new Set());

  useEffect(() => {
    let stopped = false;
    async function tick() {
      try {
        const due = await dueAppointmentsAction();
        for (const a of due) {
          if (alerted.current.has(a.id)) continue;
          alerted.current.add(a.id);
          const hora = new Date(a.inicio).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
          toast(`🔔 ${a.titulo}`, {
            description: `Agora (${hora})${a.contactNome ? ` · ${a.contactNome}` : ""}`,
            duration: 15000,
          });
        }
      } catch {
        /* silencioso — alerta é best-effort */
      }
    }
    void tick();
    const id = setInterval(() => {
      if (!stopped) void tick();
    }, 60_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  return null;
}
