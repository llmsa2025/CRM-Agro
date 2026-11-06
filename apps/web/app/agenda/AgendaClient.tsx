"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import type { AppointmentDTO, OcupadoDTO } from "@crmagro/core";
import { GoogleAgendaConexao } from "@/components/agenda/google-agenda-conexao";
import {
  listAppointmentsAction,
  listOcupadosAction,
  minhaAgendaGoogleAction,
  desconectarGoogleAgendaAction,
  sincronizarGoogleAgendaAction,
  type AgendaGoogleState,
} from "./actions";
import { AppointmentDialog } from "./AppointmentDialog";

const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

/** Tipo → cor do ponto (dicionário de status v2). */
const TIPO: Record<string, { label: string; cor: string }> = {
  ligacao: { label: "Ligação", cor: "bg-info-500" },
  reuniao: { label: "Reunião", cor: "bg-brand-500" },
  reuniao_online: { label: "Online", cor: "bg-brand-500" },
  visita: { label: "Visita", cor: "bg-success-500" },
  follow_up: { label: "Retorno", cor: "bg-warning-500" },
  tarefa: { label: "Tarefa", cor: "bg-ink-3" },
  outro: { label: "Outro", cor: "bg-ink-3" },
};
const TIPO_TEXTO: Record<string, string> = {
  ligacao: "text-info-500",
  reuniao: "text-brand-500",
  reuniao_online: "text-brand-500",
  visita: "text-success-500",
  follow_up: "text-warning-500",
  tarefa: "text-ink-3",
  outro: "text-ink-3",
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function dayKey(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hhmm(iso: string) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const DIA_CURTO = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export function AgendaClient() {
  const today = new Date();
  const sp = useSearchParams();
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [items, setItems] = useState<AppointmentDTO[]>([]);
  // Blocos "Ocupado" da agenda pessoal (Google): a dona vê o título; os outros, só o horário.
  const [ocupados, setOcupados] = useState<OcupadoDTO[]>([]);
  // A grade passou do teto de "Ocupado" (equipe grande): a tela avisa em vez de parecer livre.
  const [ocupadosCortados, setOcupadosCortados] = useState(false);
  const [google, setGoogle] = useState<AgendaGoogleState | null>(null);
  const [tiposOcultos, setTiposOcultos] = useState<Set<string>>(new Set());
  // `?novo=1` abre o diálogo; `?contact=<id>&nome=<nome>&tipo=visita` (vindo do
  // Mapa ou da ficha) já chega com o contato travado e o tipo escolhido.
  const contatoDaUrl = sp?.get("contact") ? { id: sp.get("contact")!, nome: sp.get("nome") ?? "Contato" } : null;
  const tipoDaUrl = (sp?.get("tipo") ?? "").match(/^(tarefa|ligacao|reuniao|reuniao_online|visita|follow_up)$/) ? (sp!.get("tipo") as AppointmentDTO["tipo"]) : undefined;
  const [dialog, setDialog] = useState<{ mode: "new"; date?: string } | { mode: "edit"; appt: AppointmentDTO } | null>(
    sp?.get("novo") || contatoDaUrl ? { mode: "new" } : null,
  );

  const gridStart = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const s = new Date(first);
    s.setDate(1 - first.getDay());
    s.setHours(0, 0, 0, 0);
    return s;
  }, [cursor]);

  const days = useMemo(
    () =>
      Array.from({ length: 42 }, (_, i) => {
        const d = new Date(gridStart);
        d.setDate(gridStart.getDate() + i);
        return d;
      }),
    [gridStart],
  );

  const load = useCallback(async () => {
    const from = new Date(gridStart);
    const to = new Date(gridStart);
    to.setDate(to.getDate() + 42);
    const [ap, oc] = await Promise.all([
      listAppointmentsAction(from.toISOString(), to.toISOString()),
      listOcupadosAction(from.toISOString(), to.toISOString()).catch(() => ({ itens: [] as OcupadoDTO[], cortado: false })),
    ]);
    setItems(ap);
    setOcupados(oc.itens);
    setOcupadosCortados(oc.cortado);
  }, [gridStart]);

  useEffect(() => {
    void load();
  }, [load]);

  // Atualiza sozinha: a grade recarrega a cada minuto e ao voltar para a aba. Ao
  // voltar, também pede ao Google uma rodada (no máximo 1 a cada 30 s) e
  // recarrega de novo logo depois, para pegar o que mudou lá enquanto estava fora.
  const googleConectado = google?.conexao?.status === "connected" && google.liberada;
  const ultimoPedidoGoogle = useRef(0);
  useEffect(() => {
    const visivel = () => document.visibilityState === "visible";
    const voltou = () => {
      if (!visivel()) return;
      void load();
      if (!googleConectado || Date.now() - ultimoPedidoGoogle.current < 30_000) return;
      ultimoPedidoGoogle.current = Date.now();
      void sincronizarGoogleAgendaAction()
        .then(() => new Promise((r) => setTimeout(r, 5_000)))
        .then(() => (visivel() ? load() : undefined));
    };
    const timer = setInterval(() => visivel() && void load(), 60_000);
    document.addEventListener("visibilitychange", voltou);
    window.addEventListener("focus", voltou);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", voltou);
      window.removeEventListener("focus", voltou);
    };
  }, [load, googleConectado]);

  const carregarGoogle = useCallback(async () => {
    setGoogle(await minhaAgendaGoogleAction().catch(() => null));
  }, []);
  useEffect(() => {
    void carregarGoogle();
  }, [carregarGoogle]);

  const ocupadosPorDia = useMemo(() => {
    const map = new Map<string, OcupadoDTO[]>();
    for (const o of ocupados) {
      const k = dayKey(new Date(o.inicio));
      (map.get(k) ?? map.set(k, []).get(k)!).push(o);
    }
    return map;
  }, [ocupados]);

  const visiveis = useMemo(() => items.filter((a) => !tiposOcultos.has(a.tipo) && a.status !== "cancelado"), [items, tiposOcultos]);

  const byDay = useMemo(() => {
    const map = new Map<string, AppointmentDTO[]>();
    for (const a of visiveis) {
      const k = dayKey(new Date(a.inicio));
      (map.get(k) ?? map.set(k, []).get(k)!).push(a);
    }
    for (const list of map.values()) list.sort((a, b) => a.inicio.localeCompare(b.inicio));
    return map;
  }, [visiveis]);

  const contagem = useMemo(() => {
    const c: Record<string, number> = {};
    for (const a of items) if (new Date(a.inicio).getMonth() === cursor.m && a.status !== "cancelado") c[a.tipo] = (c[a.tipo] ?? 0) + 1;
    return c;
  }, [items, cursor.m]);

  const todayKey = dayKey(today);
  const hojeLista = (byDay.get(todayKey) ?? []).filter((a) => a.status === "pendente");
  const proximos = visiveis
    .filter((a) => a.status === "pendente" && new Date(a.inicio) > today && dayKey(new Date(a.inicio)) !== todayKey)
    .sort((a, b) => a.inicio.localeCompare(b.inicio))
    .slice(0, 5);
  const noMes = items.filter((a) => new Date(a.inicio).getMonth() === cursor.m && a.status !== "cancelado").length;

  function shift(delta: number) {
    setCursor((c) => {
      const d = new Date(c.y, c.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }
  function toggleTipo(t: string) {
    setTiposOcultos((prev) => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Agenda"
        subtitle={`${noMes} ${noMes === 1 ? "compromisso" : "compromissos"} em ${MESES[cursor.m]} · ${hojeLista.length} hoje`}
        actions={<Button onClick={() => setDialog({ mode: "new" })}>Novo compromisso</Button>}
      />

      <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="Calendário" className="flex min-w-0 flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="outline" size="icon-sm" onClick={() => shift(-1)} aria-label="Mês anterior">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => shift(1)} aria-label="Próximo mês">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCursor({ y: today.getFullYear(), m: today.getMonth() })}>
              Hoje
            </Button>
            <h2 className="ml-2 flex-1 font-serif text-h2 text-foreground first-letter:uppercase">
              {MESES[cursor.m]} de {cursor.y}
            </h2>
            <div role="group" aria-label="Filtrar por tipo" className="flex flex-wrap gap-4">
              {Object.entries(TIPO).map(([t, conf]) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={!tiposOcultos.has(t)}
                  onClick={() => toggleTipo(t)}
                  className={cn("num inline-flex items-center gap-1.5 text-small", tiposOcultos.has(t) ? "text-ink-3 line-through" : "text-ink-2")}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", conf.cor)} />
                  {conf.label} {contagem[t] ?? 0}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="grid grid-cols-7 pb-2 text-caption font-medium text-ink-3" aria-hidden>
              {WEEKDAYS.map((w) => (
                <span key={w} className="pl-2">
                  {w}
                </span>
              ))}
            </div>
            {ocupadosCortados && (
              <p className="pb-2 text-caption text-ink-3">
                Há mais horários &quot;Ocupado&quot; da equipe do que a grade consegue mostrar neste mês: os últimos dias podem parecer livres.
              </p>
            )}
            <div className="grid grid-cols-7 border-l border-t border-line">
              {days.map((d) => {
                const k = dayKey(d);
                const inMonth = d.getMonth() === cursor.m;
                const list = byDay.get(k) ?? [];
                const livres = Math.max(0, 3 - list.length);
                const ocupadosDoDia = ocupadosPorDia.get(k) ?? [];
                const isToday = k === todayKey;
                return (
                  <div
                    key={k}
                    // O quadrado inteiro do dia abre "novo compromisso" (o número segue como atalho de teclado).
                    onClick={() => setDialog({ mode: "new", date: k })}
                    className={cn(
                      "flex min-h-[98px] cursor-pointer flex-col gap-0.5 border-b border-r border-line p-1.5 hover:bg-accent/30",
                      !inMonth && "bg-muted/50",
                    )}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDialog({ mode: "new", date: k });
                      }}
                      aria-label={`Novo compromisso em ${d.getDate()} de ${MESES[d.getMonth()]}`}
                      className={cn(
                        "num self-start rounded-full px-1.5 text-small",
                        isToday ? "bg-brand-500 font-semibold text-white" : inMonth ? "text-ink-2 hover:bg-accent" : "text-ink-3",
                      )}
                    >
                      {d.getDate()}
                    </button>
                    {list.slice(0, 3).map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDialog({ mode: "edit", appt: a });
                        }}
                        title={`${hhmm(a.inicio)} ${a.titulo}`}
                        className={cn(
                          "num w-full truncate rounded px-1 py-0.5 text-left text-caption leading-4 hover:bg-accent",
                          a.status === "concluido" ? "text-ink-3 line-through" : "text-foreground",
                        )}
                      >
                        <span className={cn("font-medium", TIPO_TEXTO[a.tipo] ?? "text-ink-3")}>{hhmm(a.inicio)}</span> {a.titulo}
                      </button>
                    ))}
                    {ocupadosDoDia.slice(0, livres).map((o) => (
                      <span
                        key={o.id}
                        title={`${o.titulo ?? "Ocupado"} ${hhmm(o.inicio)} a ${hhmm(o.fim)}${o.meu || !o.pessoaNome ? "" : ` · ${o.pessoaNome}`}${o.quantidade > 1 ? ` (${o.quantidade} horários)` : ""}`}
                        className="num w-full truncate px-1 py-0.5 text-caption leading-4 text-ink-3"
                      >
                        <span className="font-medium">{hhmm(o.inicio)}</span> {o.titulo ?? "Ocupado"}{o.meu || !o.pessoaNome ? "" : ` · ${o.pessoaNome}`}
                        {o.quantidade > 1 ? ` (${o.quantidade})` : ""}
                      </span>
                    ))}
                    {list.length + ocupadosDoDia.length > 3 && (
                      <span className="px-1 text-caption text-ink-3">+{list.length + ocupadosDoDia.length - Math.min(3, list.length + ocupadosDoDia.length)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <aside className="flex flex-col gap-8">
          {/* A2: fora da lista de liberados e sem conexão, o cartão nem aparece. */}
          {google?.configurada && (google.liberada || google.conexao) && (
            <section aria-labelledby="t-google">
              <SectionHeader id="t-google" variant="aside" title="Agenda Google" />
              <GoogleAgendaConexao
                variante="lateral"
                volta="agenda"
                conexao={google.conexao}
                podeConectar={google.podeConectar}
                liberada={google.liberada}
                desconectar={async () => {
                  const r = await desconectarGoogleAgendaAction();
                  await carregarGoogle();
                  void load();
                  return r;
                }}
                sincronizar={sincronizarGoogleAgendaAction}
              />
            </section>
          )}
          <section aria-labelledby="t-hoje">
            <SectionHeader id="t-hoje" variant="aside" title={`Hoje · ${DIA_CURTO[today.getDay()]}, ${today.getDate()}`} />
            {hojeLista.length === 0 ? (
              <p className="py-4 text-small text-ink-2">Nenhum compromisso hoje.</p>
            ) : (
              hojeLista.map((a) => <Item key={a.id} a={a} hora={hhmm(a.inicio)} onOpen={() => setDialog({ mode: "edit", appt: a })} />)
            )}
          </section>
          <section aria-labelledby="t-prox">
            <SectionHeader id="t-prox" variant="aside" title="Próximos" />
            {proximos.length === 0 ? (
              <p className="py-4 text-small text-ink-2">Nada agendado nos próximos dias.</p>
            ) : (
              proximos.map((a) => {
                const d = new Date(a.inicio);
                return (
                  <Item
                    key={a.id}
                    a={a}
                    hora={`${DIA_CURTO[d.getDay()]} ${pad(d.getDate())}${d.getMonth() !== today.getMonth() ? `/${pad(d.getMonth() + 1)}` : ""}`}
                    sub={hhmm(a.inicio)}
                    onOpen={() => setDialog({ mode: "edit", appt: a })}
                  />
                );
              })
            )}
          </section>
        </aside>
      </div>

      {dialog && (
        <AppointmentDialog
          open
          onOpenChange={(v) => {
            if (!v) setDialog(null);
          }}
          initial={dialog.mode === "edit" ? dialog.appt : null}
          defaultDate={dialog.mode === "new" ? dialog.date : undefined}
          defaultTipo={dialog.mode === "new" ? tipoDaUrl : undefined}
          fixedContact={dialog.mode === "new" ? contatoDaUrl : undefined}
          googleConectado={google?.conexao?.status === "connected" && google.liberada}
          eu={google?.eu ?? null}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function Item({ a, hora, sub, onOpen }: { a: AppointmentDTO; hora: string; sub?: string; onOpen: () => void }) {
  const conf = TIPO[a.tipo] ?? TIPO.outro!;
  return (
    <button type="button" onClick={onOpen} className="grid w-full grid-cols-[68px_minmax(0,1fr)] gap-3 border-b border-line py-3 text-left hover:bg-accent/40">
      <span className="num pt-px text-small text-ink-2">{hora}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-caption text-ink-3">
          <span className={cn("h-1.5 w-1.5 rounded-full", conf.cor)} />
          {conf.label}
          {sub ? ` · ${sub}` : ""}
        </div>
        <div className="mt-0.5 truncate text-body">{a.titulo}</div>
        {a.contactNome && <div className="truncate text-caption text-ink-3">{a.contactNome}</div>}
      </div>
    </button>
  );
}
