"use client";

import { mensagemParaTela } from "@/lib/erros";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/page-header";
import { StatusDot } from "@/components/ui/status-dot";

/**
 * Avisos no navegador (Web Push, item 1.6/1.10 e agenda §E): WhatsApp caiu,
 * motor degradado, lembrete de compromisso. Fluxo do PR #131:
 *  1. GET /api/push/chave-publica → null = push desligado no servidor;
 *  2. suporte: serviceWorker + PushManager (iPhone só como app na tela inicial);
 *  3. permissão pedida NUM CLIQUE (o navegador bloqueia pedido automático);
 *  4. registra /sw-push.js, assina e manda a assinatura para /api/push/assinatura.
 */
type Estado = "carregando" | "sem_suporte" | "desligado" | "bloqueado" | "inativo" | "ativo";

function base64UrlParaUint8(chave: string): Uint8Array {
  const padding = "=".repeat((4 - (chave.length % 4)) % 4);
  const b64 = (chave + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function PushSettings() {
  const [estado, setEstado] = useState<Estado>("carregando");
  const [chave, setChave] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
          if (vivo) setEstado("sem_suporte");
          return;
        }
        const r = await fetch("/api/push/chave-publica");
        const j = (await r.json()) as { chave: string | null };
        if (!vivo) return;
        if (!j.chave) {
          setEstado("desligado");
          return;
        }
        setChave(j.chave);
        if (Notification.permission === "denied") {
          setEstado("bloqueado");
          return;
        }
        const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
        const sub = await reg?.pushManager.getSubscription();
        setEstado(sub ? "ativo" : "inativo");
      } catch {
        if (vivo) setEstado("inativo");
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  async function ativar() {
    if (!chave) return;
    setOcupado(true);
    try {
      const permissao = await Notification.requestPermission();
      if (permissao !== "granted") {
        setEstado(permissao === "denied" ? "bloqueado" : "inativo");
        toast.error("Sem permissão do navegador para avisos.");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw-push.js");
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlParaUint8(chave) as BufferSource }));
      const r = await fetch("/api/push/assinatura", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!r.ok) throw new Error(`servidor respondeu ${r.status}`);
      setEstado("ativo");
      toast.success("Avisos ativados neste navegador");
    } catch (e) {
      toast.error("Não deu para ativar os avisos", { description: mensagemParaTela(e) });
    } finally {
      setOcupado(false);
    }
  }

  async function desativar() {
    setOcupado(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/assinatura", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setEstado("inativo");
      toast.success("Avisos desativados neste navegador");
    } catch (e) {
      toast.error("Não deu para desativar", { description: mensagemParaTela(e) });
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <SectionHeader
          title="Avisos no navegador"
          aside={
            estado === "ativo" ? (
              <StatusDot tone="ok">Ativos neste navegador</StatusDot>
            ) : estado === "carregando" ? null : (
              <StatusDot tone="empty">Desativados</StatusDot>
            )
          }
        />
        <p className="pt-4 text-small leading-relaxed text-ink-2">
          Você recebe um aviso mesmo com o CRM Agro fechado quando o WhatsApp cai, quando o motor de fluxos atrasa e nos
          lembretes da agenda. Cada navegador precisa ser ativado uma vez. No iPhone, só com o CRM Agro instalado na tela
          inicial.
        </p>
        <div className="flex items-center gap-3 pt-5">
          {estado === "sem_suporte" && <p className="text-small text-ink-2">Este navegador não suporta avisos.</p>}
          {estado === "desligado" && <p className="text-small text-ink-2">Avisos desligados no servidor. Peça ao administrador.</p>}
          {estado === "bloqueado" && (
            <p className="text-small text-ink-2">O navegador está bloqueando avisos deste site. Libere nas configurações do site e tente de novo.</p>
          )}
          {estado === "inativo" && (
            <Button onClick={ativar} disabled={ocupado}>
              Ativar avisos
            </Button>
          )}
          {estado === "ativo" && (
            <Button variant="outline" onClick={desativar} disabled={ocupado}>
              Desativar neste navegador
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
