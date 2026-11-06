"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { ConexaoGoogleDTO } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";

export type EstadoAgendaGoogleConta = {
  configurada: boolean;
  conexao: ConexaoGoogleDTO | null;
  podeConectar: boolean;
  /** A pessoa está em GOOGLE_AGENDA_LIBERADOS (A2, até o Google verificar o app). */
  liberada: boolean;
};

/**
 * Lê (uma vez) a Agenda Google da pessoa logada. O menu da conta usa o estado
 * para esconder o item de quem não está liberado e não tem conexão (A2).
 */
export function useAgendaGoogleConta() {
  const [estado, setEstado] = useState<EstadoAgendaGoogleConta | null>(null);
  const [erro, setErro] = useState(false);
  useEffect(() => {
    let vivo = true;
    fetch("/api/conta/agenda-google")
      .then((r) => (r.ok ? (r.json() as Promise<EstadoAgendaGoogleConta>) : Promise.reject(new Error(String(r.status)))))
      .then((j) => vivo && setEstado(j))
      .catch(() => vivo && setErro(true));
    return () => {
      vivo = false;
    };
  }, []);
  return { estado, setEstado, erro };
}

/** O item "Minha Agenda Google" aparece? Só com o estado lido e (liberada OU conexão): sem isso, nem existe para a pessoa. */
export function agendaGoogleVisivel(estado: EstadoAgendaGoogleConta | null): boolean {
  return Boolean(estado && (estado.liberada || estado.conexao));
}

/**
 * "Agenda Google" no menu da conta: ver a própria conexão e DESCONECTAR
 * (revogar) de qualquer tela, sem depender de papel nem de tela liberada.
 * Conectar continua pela Agenda ou por Integrações.
 */
export function MinhaAgendaGoogleConta({
  estado,
  setEstado,
  erro,
  aoTerminar,
}: {
  estado: EstadoAgendaGoogleConta | null;
  setEstado: Dispatch<SetStateAction<EstadoAgendaGoogleConta | null>>;
  erro: boolean;
  aoTerminar?: () => void;
}) {
  const [ocupado, setOcupado] = useState(false);

  async function desconectar() {
    setOcupado(true);
    try {
      const r = await fetch("/api/conta/agenda-google", { method: "DELETE" });
      if (!r.ok) throw new Error(String(r.status));
      toast.success("Agenda Google desconectada. O acesso foi revogado na sua conta Google.");
      setEstado((e) => (e ? { ...e, conexao: null } : e));
      aoTerminar?.();
    } catch {
      toast.error("Não deu certo desconectar agora. Tente de novo.");
    } finally {
      setOcupado(false);
    }
  }

  if (erro) return <p className="text-body text-ink-2">Não foi possível ler a sua Agenda Google agora.</p>;
  if (!estado) return <Loader2 className="h-4 w-4 animate-spin text-ink-3" aria-label="Carregando" />;
  if (!estado.configurada) return <p className="text-body text-ink-2">A integração com o Google Agenda não está ligada neste servidor.</p>;
  if (!estado.conexao) {
    return (
      <p className="text-body text-ink-2">
        {estado.liberada ? (
          <>
            Nenhuma agenda conectada.{" "}
            {estado.podeConectar ? "Para conectar, abra a Agenda ou Integrações." : "Seu papel não conecta a agenda."}
          </>
        ) : (
          "A Agenda Google ainda não foi liberada para a sua conta."
        )}
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-body">{estado.conexao.email}</span>
        {estado.liberada ? (
          <StatusDot tone={estado.conexao.status === "connected" ? "ok" : "error"}>
            {estado.conexao.status === "connected" ? (estado.podeConectar ? "Conectada" : "Parada") : "Reconectar"}
          </StatusDot>
        ) : (
          <StatusDot tone="attention">Pausada</StatusDot>
        )}
      </div>
      {!estado.liberada ? (
        <p className="text-small text-ink-2">A sincronização está pausada até a Agenda Google ser liberada para a sua conta.</p>
      ) : null}
      <p className="text-small text-ink-2">
        Desconectar para a sincronização e revoga o acesso na sua conta Google. Os compromissos continuam no CRM Agro; os horários
        &quot;Ocupado&quot; da sua agenda pessoal saem.
      </p>
      <div>
        <Button variant="outline" className="text-danger-500 hover:text-danger-700" disabled={ocupado} onClick={() => void desconectar()}>
          {ocupado ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
          Desconectar minha Agenda Google
        </Button>
      </div>
    </div>
  );
}
