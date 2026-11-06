import Link from "next/link";
import { currentUser, runAsUser } from "@/lib/tenant";
import { runVendoComo } from "@crmagro/db";

import {
  prospeccaoResumo,
  taxas,
  atividadeRecente,
  listaDoDia,
  atividadeSemana,
  funilResumido,
  listAppointments,
  listarPessoasDoTime,
  type Period,
  type ItemDia,
  type AtividadeRecenteItem,
  type AppointmentDTO,
  DEFAULT_TZ,
} from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/page-header";
import { StatusDot } from "@/components/ui/status-dot";
import { Progress } from "@/components/ui/progress";
import { PeriodToggle } from "./period-toggle";
import { formatBRLCompact, formatTime, relativeTime, daysLabel } from "@/lib/format";
import { RealtimeRefresh } from "@/components/dashboard/realtime-refresh";
import { ActivityChartLazy } from "@/components/dashboard/activity-chart-lazy";
import { TaskCheck } from "@/components/task-check";
import { cn } from "@/lib/utils";
import { FiltroVendedor } from "@/components/escopo/filtro-vendedor";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ period?: string; vendedor?: string }>;

function greeting(): string {
  // Hora no fuso do usuário (Brasil) — o servidor roda em UTC.
  const h =
    Number(
      new Intl.DateTimeFormat("pt-BR", { timeZone: DEFAULT_TZ, hour: "numeric", hour12: false }).format(new Date()),
    ) % 24;
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

const PERIOD_LABEL: Record<Period, string> = { hoje: "hoje", semana: "na semana", mes: "no mês" };

/** Início e fim do dia de hoje no fuso do time (para a agenda). */
function hojeIntervalo(): { from: string; to: string } {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
  const inicio = new Date(`${partes}T00:00:00-03:00`);
  const fim = new Date(inicio.getTime() + 86_400_000);
  return { from: inicio.toISOString(), to: fim.toISOString() };
}

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const period = (["hoje", "semana", "mes"].includes(sp.period ?? "") ? sp.period : "hoje") as Period;
  const usuario = await currentUser();
  const primeiroNome = (usuario?.name ?? "").trim().split(" ")[0] || null;

  // "Todos / por pessoa" (F4): quem vê o time todo escolhe uma pessoa e lê o
  // Painel como ela (o core só estreita). A lista de pessoas só vem para quem
  // vê tudo; id fora dela é ignorado.
  // O Painel segue Contatos ("ver tudo" em Contatos lista a equipe).
  const pessoas = await runAsUser(() => listarPessoasDoTime("contatos"));
  const vendedor = pessoas.length > 1 && pessoas.some((x) => x.id === sp.vendedor) ? sp.vendedor! : null;
  const vendoOutro = vendedor !== null && vendedor !== usuario?.id;
  const podeMarcar = usuario?.role !== "viewer" && !vendoOutro;
  const [prosp, taxasData, recentes, lista, semana, funis, agenda] = await runAsUser(async () => {
    const ler = () =>
      Promise.all([
        prospeccaoResumo(),
        taxas(period),
        atividadeRecente(6),
        listaDoDia({ userId: vendedor ?? usuario?.id ?? "" }),
        atividadeSemana(),
        funilResumido(),
        listAppointments(hojeIntervalo()).catch(() => [] as AppointmentDTO[]),
      ]);
    return vendedor ? runVendoComo(vendedor, ler) : ler();
  });

  const today = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", timeZone: DEFAULT_TZ });
  const p = prosp[period];
  const negociosAbertos = funis.reduce((a, f) => a + f.total, 0);
  const valorAberto = funis.reduce((a, f) => a + f.valor, 0);
  const itens = lista.pendentes;
  const feitas = lista.feitas;
  const parados = itens.filter((i) => i.kind === "deal_parado").length;
  const funilParado = itens.find((i): i is Extract<ItemDia, { kind: "deal_parado" }> => i.kind === "deal_parado");
  const agendaPendente = agenda.filter((a) => a.status !== "cancelado");

  return (
    <div className="flex flex-col gap-8">
      <RealtimeRefresh />

      {/* Cabeçalho: data + saudação serif; período à direita. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-small text-ink-3 first-letter:uppercase">{today}</div>
          <h1 className="mt-1 font-serif text-title text-foreground">
            {greeting()}
            {primeiroNome ? `, ${primeiroNome}` : ""}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FiltroVendedor pessoas={pessoas.map((x) => ({ id: x.id, nome: x.nome, ativo: x.ativo }))} param="vendedor" rotuloTodos="Equipe toda" />
          <PeriodToggle current={period} />
        </div>
      </div>

      {/* Faixa de números: em linha, separados por hairline — não cards. */}
      <section aria-label="Resumo" className="grid grid-cols-1 border-y border-line sm:grid-cols-3">
        <div className="flex flex-col gap-1.5 py-4 pr-6 sm:border-r sm:border-line">
          <div className="text-small text-ink-2">Prospecções {PERIOD_LABEL[period]}</div>
          <div className="num font-serif text-num">
            {p.feitas}
            {p.base > 0 && <span className="text-[18px] text-ink-3"> · meta {p.base}</span>}
          </div>
          {p.base > 0 ? (
            <div className="flex items-center gap-3">
              <Progress value={Math.min(100, p.pct)} className="w-40" indicatorClassName={p.bateu ? "bg-success-500" : undefined} />
              <span className="num text-caption text-ink-2">{p.bateu ? "meta batida" : `faltam ${p.restantes} para a meta`}</span>
            </div>
          ) : (
            <Link href="/configuracoes" className="text-caption text-ink-2 hover:text-foreground">
              Defina uma meta em Configurações →
            </Link>
          )}
        </div>
        <div className="flex flex-col gap-1.5 py-4 sm:border-r sm:border-line sm:px-6">
          <div className="text-small text-ink-2">Responderam {PERIOD_LABEL[period]}</div>
          <div className="num font-serif text-num">{taxasData.respostas}</div>
          <div className="num text-caption text-ink-2">
            {taxasData.respostaPct}% de {taxasData.contatosProspectados}{" "}
            {taxasData.contatosProspectados === 1 ? "contato prospectado" : "contatos prospectados"} · {taxasData.clientes} clientes
          </div>
        </div>
        <div className="flex flex-col gap-1.5 py-4 sm:px-6">
          <div className="text-small text-ink-2">Negócios abertos</div>
          <div className="num font-serif text-num">
            {negociosAbertos}
            {valorAberto > 0 && <span className="text-[18px] text-ink-3"> · {formatBRLCompact(valorAberto)}</span>}
          </div>
          {parados > 0 ? (
            <Link href={funilParado ? `/funis/${funilParado.funilId}` : "/funis"} className="num text-caption text-warning-500 hover:underline">
              {parados} {parados === 1 ? "parado" : "parados"} há 7+ dias →
            </Link>
          ) : (
            <span className="text-caption text-ink-2">nenhum parado há mais de 7 dias</span>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Sua lista de hoje */}
        <section aria-labelledby="t-lista" className="min-w-0">
          <SectionHeader
            id="t-lista"
            title="Sua lista de hoje"
            aside={
              <span className="num">
                {feitas.length > 0 ? `${feitas.length} de ${feitas.length + itens.length} feitas` : `${itens.length} pendentes`}
              </span>
            }
          />
          {itens.length === 0 ? (
            <p className="py-10 text-center text-body text-ink-2">
              Tudo em dia. Nenhum negócio parado, lead sem primeiro contato ou follow-up vencido.
            </p>
          ) : (
            <div>
              {itens.map((item) => (
                <ItemDiaRow key={`${item.kind}-${item.id}`} item={item} podeMarcar={podeMarcar} />
              ))}
            </div>
          )}
          {feitas.length > 0 && (
            <details className="group pt-3">
              <summary className="cursor-pointer list-none text-small font-medium text-brand-500 hover:underline">
                <span className="group-open:hidden">Ver as {feitas.length} feitas</span>
                <span className="hidden group-open:inline">Esconder as feitas</span>
              </summary>
              <div className="pt-2">
                {feitas.map((item) => (
                  <ItemDiaRow key={`${item.kind}-${item.id}`} item={item} podeMarcar={podeMarcar} feita />
                ))}
              </div>
            </details>
          )}
          <p className="pt-3 text-caption text-ink-3">
            Negócios parados há mais de 7 dias, leads sem primeiro contato e follow-ups de fluxo vencidos.
          </p>
        </section>

        {/* Lateral: funis, agenda, atividade recente */}
        <aside className="flex flex-col gap-9">
          <section aria-labelledby="t-funis">
            <SectionHeader
              id="t-funis"
              variant="aside"
              title="Funis"
              aside={
                <Link href="/funis" className="font-medium text-brand-500 hover:underline">
                  Ver todos
                </Link>
              }
            />
            {funis.length === 0 ? (
              <p className="py-4 text-small text-ink-2">Nenhum funil ainda.</p>
            ) : (
              funis.map((f) => (
                <div key={f.id} className="flex flex-col gap-2 border-b border-line py-4">
                  <div className="flex items-center gap-3">
                    <Link href={`/funis/${f.id}`} className="min-w-0 flex-1 truncate text-body font-medium hover:underline">
                      {f.nome}
                    </Link>
                    <span className="num text-small text-ink-2">
                      {f.total} · {formatBRLCompact(f.valor)}
                    </span>
                  </div>
                  {f.total > 0 && (
                    <div className="flex h-[3px] gap-px overflow-hidden rounded-full bg-muted" aria-hidden>
                      {f.etapas.map((e, i) =>
                        e.count > 0 ? (
                          <div
                            key={i}
                            className="h-full bg-brand-500"
                            style={{ width: `${(e.count / f.total) * 100}%`, opacity: 1 - i * 0.14 }}
                            title={`${e.nome}: ${e.count}`}
                          />
                        ) : null,
                      )}
                    </div>
                  )}
                  <div className="num truncate text-caption text-ink-3">
                    {f.etapas.filter((e) => e.count > 0).map((e) => `${e.nome} ${e.count}`).join(" · ") || "sem negócios"}
                  </div>
                </div>
              ))
            )}
          </section>

          <section aria-labelledby="t-agenda">
            <SectionHeader
              id="t-agenda"
              variant="aside"
              title="Agenda de hoje"
              aside={
                <Link href="/agenda" className="font-medium text-brand-500 hover:underline">
                  Abrir agenda
                </Link>
              }
            />
            {agendaPendente.length === 0 ? (
              <p className="py-4 text-small text-ink-2">Nenhum compromisso hoje.</p>
            ) : (
              agendaPendente.map((a) => (
                <div key={a.id} className="flex gap-4 border-b border-line py-3.5 text-body">
                  <span className="num w-11 shrink-0 text-ink-2">{formatTime(a.inicio)}</span>
                  <div className="min-w-0 flex-1">
                    <div className={a.status === "concluido" ? "text-ink-3 line-through" : ""}>{a.titulo}</div>
                    {a.contactNome && (
                      <div className="mt-0.5 truncate text-caption text-ink-3">
                        {a.contactId ? (
                          <Link href={`/contatos/${a.contactId}`} className="hover:underline">
                            {a.contactNome}
                          </Link>
                        ) : (
                          a.contactNome
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </section>

          <section aria-labelledby="t-recente">
            <SectionHeader id="t-recente" variant="aside" title="Atividade recente" />
            {recentes.length === 0 ? (
              <p className="py-4 text-small text-ink-2">Nenhuma atividade ainda.</p>
            ) : (
              recentes.map((a) => <AtividadeRow key={a.id} a={a} />)
            )}
          </section>
        </aside>
      </div>

      {/* Prospecção por dia — abaixo, largura total. */}
      <section aria-labelledby="t-semana">
        <SectionHeader id="t-semana" title="Prospecção por dia" aside={<span>enviadas e respostas nos últimos 7 dias</span>} />
        <div className="pt-4">
          <ActivityChartLazy data={semana} />
        </div>
      </section>
    </div>
  );
}

const ATIVIDADE_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  email: "E-mail",
  call: "Ligação",
  note: "Nota",
  stage_change: "Mudança de etapa",
};

function AtividadeRow({ a }: { a: AtividadeRecenteItem }) {
  const canal = ATIVIDADE_LABEL[a.tipo] ?? a.tipo;
  const dir = a.direcao === "in" ? "recebido" : a.direcao === "out" ? "enviado" : null;
  return (
    <Link href={`/contatos/${a.contatoId}`} className="flex items-start gap-3 border-b border-line py-3 transition-colors hover:bg-accent/40">
      <StatusDot tone={a.direcao === "in" ? "ok" : a.tipo === "stage_change" ? "info" : "brand"} className="mt-[3px]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body">
          <span className="font-medium">{a.contato}</span>
          <span className="text-ink-2">
            {" "}
            · {canal}
            {dir ? ` ${dir}` : ""}
          </span>
        </div>
        {a.resumo ? <div className="truncate text-caption text-ink-3">{a.resumo}</div> : null}
      </div>
      <span className="shrink-0 text-caption text-ink-3">{relativeTime(a.createdAt)}</span>
    </Link>
  );
}

/** Linha da lista do dia: check (feita), o que fazer + por quê + a ação. */
function ItemDiaRow({ item, podeMarcar, feita = false }: { item: ItemDia; podeMarcar: boolean; feita?: boolean }) {
  const check = podeMarcar ? <TaskCheck chave={item.chave} feita={feita} label={item.contato} /> : null;
  const linha = cn("flex items-center gap-4 border-b border-line py-4", feita && "text-ink-3 [&_.font-medium]:font-normal");
  if (item.kind === "deal_parado") {
    return (
      <div className={linha}>
        {check}
        <div className="min-w-0 flex-1">
          <div className="text-body">
            <span className="font-medium">Retomar {item.contato}</span>
            <span className="text-ink-2"> · {item.funil}, etapa {item.etapa}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-small">
            <StatusDot tone="attention">Parado há {daysLabel(item.desde)}</StatusDot>
            <span className="num text-ink-3">· {formatBRLCompact(item.valor)}</span>
          </div>
        </div>
        <Button asChild variant="outline">
          <Link href={`/funis/${item.funilId}`}>Ver negócio</Link>
        </Button>
      </div>
    );
  }
  if (item.kind === "followup_vencido") {
    return (
      <div className={linha}>
        {check}
        <div className="min-w-0 flex-1">
          <div className="text-body">
            <span className="font-medium">Follow-up vencido de {item.contato}</span>
            {item.empresa && <span className="text-ink-2"> · {item.empresa}</span>}
          </div>
          <div className="mt-0.5 text-small">
            <StatusDot tone="attention">
              fluxo {item.fluxo} · venceu {relativeTime(item.venceuEm)}
            </StatusDot>
          </div>
        </div>
        <Button asChild variant="ghost">
          <Link href={`/fluxos/${item.fluxoId}`}>Fluxo</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/contatos/${item.contatoId}`}>Abrir</Link>
        </Button>
      </div>
    );
  }
  return (
    <div className={linha}>
      {check}
      <div className="min-w-0 flex-1">
        <div className="text-body">
          <span className="font-medium">Primeiro contato com {item.contato}</span>
          {item.empresa && <span className="text-ink-2"> · {item.empresa}</span>}
        </div>
        <div className="mt-0.5 text-small">
          <StatusDot tone="empty">
            Nunca contatado · {item.origem ?? "manual"} · {relativeTime(item.criadoEm)}
          </StatusDot>
        </div>
      </div>
      <Button asChild variant="ghost">
        <Link href="/ligacoes">Ligar</Link>
      </Button>
      <Button asChild variant="outline">
        <Link href={`/contatos/${item.id}`}>Abrir</Link>
      </Button>
    </div>
  );
}
