"use client";

import { mensagemParaTela } from "@/lib/erros";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { ConexaoGoogleDTO } from "@crmagro/core";
import { LogoFerramenta } from "@/components/brand-icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { formatWhen } from "@/lib/format";

/** Resultado da volta do Google (`?google=...`), mostrado uma vez. */
const RESULTADO: Record<string, { ok: boolean; texto: string }> = {
  conectado: { ok: true, texto: "Agenda Google conectada. A primeira sincronização começa em instantes." },
  cancelado: { ok: false, texto: "Conexão cancelada na tela do Google." },
  expirou: { ok: false, texto: "O pedido de conexão expirou ou veio de outro navegador. Tente de novo." },
  "sem-agenda": { ok: false, texto: "O Google não liberou a agenda. Conecte de novo e marque a permissão da agenda." },
  "outra-pessoa": { ok: false, texto: "Esta conta Google já está conectada por outra pessoa no CRM Agro." },
  "nao-liberada": {
    ok: false,
    texto: "A Agenda Google ainda não foi liberada para a sua conta. Ela abre para todos quando o Google terminar de verificar o CRM Agro.",
  },
  "sem-permissao": {
    ok: false,
    texto: "Sem permissão para conectar a agenda: é preciso papel de membro (não \"só leitura\") e a tela Agenda ou Integrações. Fale com o administrador.",
  },
  indisponivel: { ok: false, texto: "A integração com o Google Agenda não está configurada neste servidor." },
  configuracao: { ok: false, texto: "A integração com o Google está mal configurada (cliente OAuth). Avise o administrador." },
  falhou: { ok: false, texto: "Não foi possível conectar agora. Tente de novo em instantes." },
};

const STATUS: Record<ConexaoGoogleDTO["status"], { label: string; tone: StatusTone }> = {
  connected: { label: "Conectada", tone: "ok" },
  reauth_required: { label: "Reconectar", tone: "error" },
  error: { label: "Com erro", tone: "error" },
};

type Acao = () => Promise<{ ok?: boolean; error?: string }>;

/**
 * "Minha Agenda Google" (decisão 3): cada pessoa conecta/desconecta a PRÓPRIA
 * agenda. Usada em Integrações (linha) e na Agenda (lateral). As ações chegam
 * por props (cada tela passa as suas, com a tela certa conferida).
 */
export function GoogleAgendaConexao({
  conexao,
  volta,
  desconectar,
  sincronizar,
  variante = "linha",
  podeConectar = true,
  liberada = true,
}: {
  conexao: ConexaoGoogleDTO | null;
  volta: "integracoes" | "agenda";
  desconectar: Acao;
  sincronizar: Acao;
  variante?: "linha" | "lateral";
  /** Só leitura (ou sem a tela) não conecta: o botão some (desconectar continua). */
  podeConectar?: boolean;
  /**
   * A pessoa está em GOOGLE_AGENDA_LIBERADOS (A2, até o Google verificar o app).
   * Falso e sem conexão: o cartão nem aparece. Falso e com conexão: a
   * sincronização está PARADA (só desconectar).
   */
  liberada?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [confirmar, setConfirmar] = useState(false);
  const [ocupado, setOcupado] = useState<"desconectar" | "sincronizar" | null>(null);

  // Volta do Google: um aviso e a URL limpa (sem o `?google=`).
  useEffect(() => {
    const codigo = sp?.get("google");
    if (!codigo) return;
    const r = RESULTADO[codigo] ?? RESULTADO.falhou!;
    if (r.ok) toast.success(r.texto);
    else toast.error(r.texto);
    const resto = new URLSearchParams(sp.toString());
    resto.delete("google");
    router.replace(resto.size ? `${pathname}?${resto.toString()}` : pathname);
  }, [sp, pathname, router]);

  const conectar = `/api/integracoes/google/conectar?volta=${volta}`;
  // Fora da lista de liberados, com conexão de antes: o worker não sincroniza.
  const pausada = Boolean(conexao) && !liberada;
  const st = conexao ? (pausada ? { label: "Pausada", tone: "attention" as StatusTone } : STATUS[conexao.status]) : { label: "Não conectada", tone: "empty" as StatusTone };
  const sub = conexao
    ? [
        conexao.email,
        pausada ? "sincronização pausada" : conexao.ultimaSincronizacaoEm ? `sincronizada ${formatWhen(conexao.ultimaSincronizacaoEm)}` : "sincronizando…",
      ].join(" · ")
    : "compromissos, convidados e Google Meet";

  async function rodar(qual: "desconectar" | "sincronizar", acao: Acao) {
    setOcupado(qual);
    const r = await acao().catch((e: unknown) => ({ error: mensagemParaTela(e) }));
    setOcupado(null);
    if (r.error) {
      toast.error("Não deu certo", { description: r.error });
      return false;
    }
    return true;
  }

  const desconectarBotao = (
    <Button variant="ghost" disabled={ocupado !== null} onClick={() => setConfirmar(true)}>
      Desconectar
    </Button>
  );
  const botoes = conexao && !liberada ? (
    // Fora da lista de liberados (A2): a Agenda Google ainda não abriu para esta
    // conta. Desconectar (revogar o acesso) continua sempre possível.
    <>
      <span className="text-small text-ink-3">Volta quando a Agenda Google for liberada</span>
      {desconectarBotao}
    </>
  ) : conexao && !podeConectar ? (
    // Virou "só leitura" ou perdeu a tela: a sincronização está parada, mas
    // desconectar (revogar o acesso) continua sempre possível.
    <>
      <span className="text-small text-ink-3">Sincronização parada</span>
      {desconectarBotao}
    </>
  ) : !conexao ? (
    podeConectar ? (
      <Button asChild variant="outline">
        <a href={conectar}>Conectar</a>
      </Button>
    ) : (
      <span className="text-small text-ink-3">Seu papel não conecta a agenda</span>
    )
  ) : conexao.status !== "connected" ? (
    <>
      {podeConectar ? (
        <Button asChild>
          <a href={conectar}>Reconectar</a>
        </Button>
      ) : null}
      {desconectarBotao}
    </>
  ) : (
    <>
      <Button
        variant="ghost"
        disabled={ocupado !== null}
        onClick={async () => {
          if (await rodar("sincronizar", sincronizar)) toast.success("Sincronização pedida. Em instantes a agenda está em dia.");
        }}
      >
        {ocupado === "sincronizar" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
        Sincronizar agora
      </Button>
      {desconectarBotao}
    </>
  );

  // Sem conexão e fora da lista de liberados (A2): o cartão nem aparece. Fica
  // depois dos hooks (o aviso da volta do Google acima continua valendo).
  if (!liberada && !conexao) return null;

  return (
    <>
      {variante === "linha" ? (
        <div className="flex flex-wrap items-center gap-4 border-b border-line py-3.5">
          <LogoFerramenta id="google-agenda" />
          <div className="min-w-0 flex-1">
            <div className="text-body font-medium">Minha Agenda Google</div>
            <div className="num truncate text-small text-ink-2">{sub}</div>
            {conexao?.ultimoErro && conexao.status !== "connected" ? (
              <div className="truncate text-small text-danger-500">{conexao.ultimoErro}</div>
            ) : null}
          </div>
          <StatusDot tone={st.tone}>{st.label}</StatusDot>
          <div className="flex gap-1">{botoes}</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 py-4">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-small text-ink-2">{conexao ? conexao.email : "Veja seus compromissos no Google e crie o Meet junto."}</span>
            <StatusDot tone={st.tone}>{st.label}</StatusDot>
          </div>
          <div className="flex flex-wrap gap-1">{botoes}</div>
        </div>
      )}

      <Dialog open={confirmar} onOpenChange={setConfirmar}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Desconectar a Agenda Google?</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 text-body text-ink-2">
            <p>O CRM Agro para de sincronizar e o acesso é revogado na sua conta Google.</p>
            <p>Os compromissos continuam no CRM Agro. Os horários &quot;Ocupado&quot; da sua agenda pessoal saem.</p>
            <p>Se você entra no CRM Agro com o Google, o Google vai pedir a sua permissão de novo no próximo login.</p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setConfirmar(false)} disabled={ocupado !== null}>
              Manter conectada
            </Button>
            <Button
              variant="outline"
              className="text-danger-500 hover:text-danger-700"
              disabled={ocupado !== null}
              onClick={async () => {
                if (await rodar("desconectar", desconectar)) {
                  toast.success("Agenda Google desconectada");
                  setConfirmar(false);
                  router.refresh();
                }
              }}
            >
              {ocupado === "desconectar" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Desconectar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
