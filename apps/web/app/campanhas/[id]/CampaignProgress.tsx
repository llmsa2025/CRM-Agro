"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { CampaignDTO, DestinatarioDTO } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { StatusDot } from "@/components/ui/status-dot";
import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useSocket } from "@/lib/socket-client";
import { formatPhone, initialsOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { cancelCampaignAction, getCampaignAction, liberarSeguradosAction, listarDestinatariosAction, pauseCampaignAction, resumeCampaignAction } from "../actions";
import { CLASSIFICACAO, STATUS_CAMPANHA, hora, numeros, origemDaLista, pct, quando } from "../rotulos";

type Conta = { id: string; label: string; status: string; paused: boolean };
type Saude = { sent: number; limit: number; paused: boolean; warmupDay: number } | null;

function Cel({ label, valor, sub, tom }: { label: string; valor: number; sub?: string; tom?: "ok" | "attention" | "error" }) {
  return (
    <div className="flex flex-col gap-1 py-4 pr-5 first:pl-0 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-line [&:not(:first-child)]:pl-5">
      <span className="text-small text-ink-2">{label}</span>
      <span className="num font-serif text-num">{valor}</span>
      {sub && <span className={cn("num text-caption", tom === "ok" ? "text-success-500" : tom === "attention" ? "text-warning-500" : tom === "error" ? "text-danger-500" : "text-ink-3")}>{sub}</span>}
    </div>
  );
}

export function CampaignProgress({ inicial, conta, saude, podeEditar }: { inicial: CampaignDTO; conta: Conta | null; saude: Saude; podeEditar: boolean }) {
  const router = useRouter();
  const [c, setC] = useState<CampaignDTO>(inicial);
  const [respostas, setRespostas] = useState<DestinatarioDTO[]>([]);
  const [proximos, setProximos] = useState<DestinatarioDTO[]>([]);
  const [segurados, setSegurados] = useState<DestinatarioDTO[]>([]);
  const [pending, start] = useTransition();

  const carregar = useCallback(async () => {
    const [r, resp, prox, seg] = await Promise.all([
      getCampaignAction(c.id),
      listarDestinatariosAction(c.id, { status: ["replied", "opted_out"] }),
      listarDestinatariosAction(c.id, { status: ["queued", "sending"] }),
      listarDestinatariosAction(c.id, { status: ["held"] }),
    ]);
    if (r.ok) setC(r.campaign);
    if (resp.ok) setRespostas(resp.pagina.items);
    if (prox.ok) setProximos(prox.pagina.items.slice(0, 6));
    if (seg.ok) setSegurados(seg.pagina.items);
  }, [c.id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Ao vivo: cada tick do worker publica `campaign:changed`; relê (com debounce).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onEvento = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void carregar(), 800);
    };
    window.addEventListener("crmagro:campanha:mudou", onEvento);
    return () => {
      window.removeEventListener("crmagro:campanha:mudou", onEvento);
      if (t) clearTimeout(t);
    };
  }, [carregar]);
  useSocket({
    "campaign:changed": (ev) => {
      if (ev.campaignId === c.id) window.dispatchEvent(new CustomEvent("crmagro:campanha:mudou"));
    },
  });

  const x = numeros(c.contagem);
  const alvo = x.naFila + x.enviadas;
  const st = STATUS_CAMPANHA[c.status];
  const terminou = c.status === "done" || c.status === "canceled";

  function agir(fn: () => Promise<{ ok: true; campaign: CampaignDTO } | { ok: false; error: string }>, msg: string) {
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setC(r.campaign);
        toast.success(msg);
        router.refresh();
      } else toast.error("Não deu", { description: r.error });
    });
  }

  function liberar(ids: string[] | "todos") {
    start(async () => {
      const r = await liberarSeguradosAction(c.id, ids);
      if (r.ok) {
        toast.success(`${r.liberados} ${r.liberados === 1 ? "contato liberado" : "contatos liberados"} para a fila`);
        void carregar();
      } else toast.error("Não deu para liberar", { description: r.error });
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        breadcrumb={[{ label: "Campanhas", href: "/campanhas" }]}
        title={
          <span className="inline-flex flex-wrap items-baseline gap-4">
            {c.nome}
            <StatusDot tone={st.tone} size="md" className="font-sans">
              {st.label}
            </StatusDot>
          </span>
        }
        subtitle={`${x.total} contatos · ${origemDaLista(c)}${c.limiteDiario ? ` · ${c.limiteDiario} envios por dia` : ""}${c.terminoPrevisto && !terminou ? ` · termina ${quando(c.terminoPrevisto)}` : ""}${c.concluidaEm ? ` · terminou ${quando(c.concluidaEm)}` : ""}`}
        actions={
          podeEditar && !terminou ? (
            <>
              {c.status === "sending" || c.status === "scheduled" ? (
                <Button variant="outline" onClick={() => agir(() => pauseCampaignAction(c.id), "Campanha pausada")} disabled={pending}>
                  Pausar
                </Button>
              ) : null}
              {c.status === "paused" || c.status === "scheduled" ? (
                <Button variant="outline" onClick={() => router.push(`/campanhas/${c.id}?editar=1`)} disabled={pending}>
                  Editar
                </Button>
              ) : null}
              {c.status === "paused" ? (
                <Button onClick={() => agir(() => resumeCampaignAction(c.id), "Campanha retomada")} disabled={pending}>
                  Retomar
                </Button>
              ) : null}
              <Button
                variant="ghost"
                className="text-danger-500 hover:text-danger-700"
                disabled={pending}
                onClick={() => {
                  if (confirm("Cancelar a campanha? Quem está na fila não recebe mais nada. Não dá para desfazer.")) agir(() => cancelCampaignAction(c.id), "Campanha cancelada");
                }}
              >
                Cancelar
              </Button>
            </>
          ) : undefined
        }
      />

      {c.status === "paused" && c.pausadoMotivo && (
        <p className="flex items-start gap-2.5 border-y border-line py-3 text-small text-ink-2">
          <StatusDot tone="attention" className="mt-[3px]" />
          <span>
            Pausada: {c.pausadoMotivo}.{podeEditar ? " Resolva e clique em Retomar." : ""}
          </span>
        </p>
      )}

      <section aria-label="Funil da campanha" className="grid grid-cols-3 border-y border-line sm:grid-cols-6">
        <Cel label="Na fila" valor={x.naFila} sub={c.terminoPrevisto && !terminou ? `até ${quando(c.terminoPrevisto)}` : x.naFila === 0 ? "vazia" : undefined} />
        <Cel label="Enviadas" valor={x.enviadas} sub={`${pct(x.enviadas, alvo)}% da lista`} />
        <Cel label="Entregues" valor={x.entregues} sub={`${pct(x.entregues, x.enviadas)}% das enviadas`} />
        <Cel label="Lidas" valor={x.lidas} sub={`${pct(x.lidas, x.entregues)}% das entregues`} />
        <Cel label="Responderam" valor={x.responderam} sub={`${pct(x.responderam, x.enviadas)}% das enviadas`} tom="ok" />
        <Cel label="Pediram para sair" valor={x.sairam} sub={`${(x.enviadas ? (x.sairam / x.enviadas) * 100 : 0).toFixed(1).replace(".", ",")}% · limite ${c.freioSaidasPct}%`} tom={x.sairam && (x.sairam / Math.max(1, x.enviadas)) * 100 > c.freioSaidasPct ? "error" : undefined} />
      </section>

      <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-labelledby="t-resp" className="min-w-0">
          <SectionHeader
            id="t-resp"
            title={
              <>
                Respostas para tratar <span className="num text-ink-3">{respostas.length}</span>
              </>
            }
            aside={
              <Link href="/conversas" className="font-medium text-brand-500 hover:underline">
                Abrir em Conversas →
              </Link>
            }
          />
          {respostas.length === 0 ? (
            <p className="py-8 text-body text-ink-2">Nenhuma resposta ainda.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {respostas.map((d) => {
                const cl = d.status === "opted_out" ? CLASSIFICACAO.saiu! : CLASSIFICACAO[d.classificacao ?? "outro"] ?? CLASSIFICACAO.outro!;
                return (
                  <li key={d.id} className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3.5 border-b border-line py-4">
                    <Avatar className="h-8 w-8 self-start">
                      <AvatarFallback>{d.nome.startsWith("+") ? "#" : initialsOf(d.nome) || "?"}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="num text-body font-medium">{d.nome.startsWith("+") ? formatPhone(d.nome) : d.nome}</span>
                        <StatusDot tone={cl.tone}>{cl.label}</StatusDot>
                        <span className="num text-caption text-ink-3">{d.repliedAt ? quando(d.repliedAt, true) : ""}</span>
                      </div>
                      <div className="num text-small text-ink-2">{formatPhone(d.telefone)}</div>
                    </div>
                    {d.status === "opted_out" ? (
                      <span className="text-small text-ink-3">Removido de todas as campanhas</span>
                    ) : (
                      <div className="flex gap-2">
                        <Button asChild variant="outline">
                          <Link href={`/conversas?contact=${d.contactId}&canal=whatsapp`}>Responder</Link>
                        </Button>
                        <Button asChild variant="ghost">
                          <Link href={`/contatos/${d.contactId}`}>Ficha</Link>
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className="flex flex-col gap-8 min-w-0">
          <section aria-labelledby="h-prox">
            <SectionHeader id="h-prox" variant="aside" title="Próximos envios" />
            {proximos.length === 0 ? (
              <p className="py-4 text-small text-ink-2">{terminou ? "Campanha encerrada." : "Fila vazia."}</p>
            ) : (
              proximos.map((d) => (
                <div key={d.id} className="num flex items-baseline justify-between gap-3 border-b border-line py-2.5 text-small">
                  <span className="truncate">{d.nome.startsWith("+") ? formatPhone(d.nome) : d.nome}</span>
                  <span className="shrink-0 text-ink-2">{d.status === "sending" ? "enviando…" : d.scheduledAt ? hora(d.scheduledAt) : "na fila"}</span>
                </div>
              ))
            )}
          </section>

          <section aria-labelledby="h-saude">
            <SectionHeader id="h-saude" variant="aside" title="Saúde do número hoje" />
            {conta && saude ? (
              <div className="flex flex-col gap-2 pt-3 text-small">
                <div className="num flex items-center justify-between">
                  <span>{conta.label}</span>
                  <span className="text-ink-2">
                    {saude.sent} / {saude.limit}
                  </span>
                </div>
                <Progress value={pct(saude.sent, saude.limit)} />
                <div className="flex items-center justify-between text-caption text-ink-3">
                  <span>{saude.warmupDay ? `aquecimento · dia ${saude.warmupDay}` : "limite diário"}</span>
                  {conta.status !== "connected" ? <StatusDot tone="error">desconectado</StatusDot> : saude.paused ? <StatusDot tone="attention">pausado</StatusDot> : <StatusDot tone="ok">conectado</StatusDot>}
                </div>
                <div className="num flex justify-between pt-2">
                  <span className="text-ink-2">Entrega</span>
                  <span>{pct(x.entregues, x.enviadas)}%</span>
                </div>
                <div className="num flex justify-between">
                  <span className="text-ink-2">Falhas</span>
                  <span>{x.falhas}</span>
                </div>
              </div>
            ) : (
              <p className="py-4 text-small text-ink-2">Sem número vinculado.</p>
            )}
          </section>

          {x.segurados > 0 && (
            <section aria-labelledby="h-seg">
              <SectionHeader id="h-seg" variant="aside" title={`Segurados · ${x.segurados}`} />
              <p className="pt-3 text-small leading-relaxed text-ink-2">Ficaram de fora para você revisar (já conversavam com você ou o histórico não pôde ser checado).</p>
              <div className="flex flex-col pt-2">
                {segurados.slice(0, 6).map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-3 border-b border-line py-2 text-small">
                    <span className="min-w-0 truncate">
                      {d.nome}
                      {d.motivo && <span className="text-ink-3"> · {d.motivo}</span>}
                    </span>
                    {podeEditar && !terminou && (
                      <button type="button" onClick={() => liberar([d.id])} className="shrink-0 font-medium text-brand-500 hover:underline" disabled={pending}>
                        Liberar
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {podeEditar && !terminou && (
                <div className="pt-3">
                  <Button variant="outline" onClick={() => liberar("todos")} disabled={pending}>
                    Liberar todos os {x.segurados}
                  </Button>
                </div>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
