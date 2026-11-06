import { currentUser, runAsUser } from "@/lib/tenant";
import { TaskCheck } from "@/components/task-check";
import { cn } from "@/lib/utils";
import Link from "next/link";

import { listaDoDia, contatosParaRevisar, prospeccaoResumo, listAppointments, type ItemDia, type AppointmentDTO, DEFAULT_TZ } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { Progress } from "@/components/ui/progress";
import { StatusDot } from "@/components/ui/status-dot";
import { formatBRLCompact, formatTime, relativeTime, daysLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

function hojeIntervalo(): { from: string; to: string } {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const inicio = new Date(`${partes}T00:00:00-03:00`);
  return { from: inicio.toISOString(), to: new Date(inicio.getTime() + 86_400_000).toISOString() };
}

export default async function AtividadesPage() {
  const usuario = await currentUser();
  const podeMarcar = usuario?.role !== "viewer";
  const [lista, revisar, prosp, agenda] = await runAsUser(async () =>
    Promise.all([
      listaDoDia({ userId: usuario?.id ?? "" }),
      contatosParaRevisar(),
      prospeccaoResumo(),
      listAppointments(hojeIntervalo()).catch(() => [] as AppointmentDTO[]),
    ]),
  );

  const tarefas = lista.pendentes;
  const feitas = lista.feitas;
  const ligar = tarefas.filter((t) => t.kind === "lead_sem_toque");
  const negocios = tarefas.filter((t) => t.kind === "deal_parado");
  const followups = tarefas.filter((t) => t.kind === "followup_vencido");
  const total = tarefas.length + revisar.length;
  const hoje = prosp.hoje;
  const agendaHoje = agenda.filter((a) => a.status !== "cancelado");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Atividades"
        subtitle={`${total} ${total === 1 ? "pendente" : "pendentes"} · ${feitas.length} ${feitas.length === 1 ? "feita" : "feitas"} hoje · ${hoje.feitas} prospecções`}
      />

      <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="Lista do dia" className="min-w-0">
          {total === 0 && feitas.length === 0 ? (
            <EmptyState
              title="Nada pendente por agora"
              description="Quando houver leads para contatar, negócios parados ou contatos a revisar, eles aparecem aqui."
            />
          ) : (
            <div className="flex flex-col gap-8">
              {followups.length > 0 && (
                <Grupo titulo="Responder e retomar" count={followups.length}>
                  {followups.map((t) => (
                    <TarefaRow key={`${t.kind}-${t.id}`} item={t} podeMarcar={podeMarcar} />
                  ))}
                </Grupo>
              )}
              {ligar.length > 0 && (
                <Grupo titulo="Ligar" count={ligar.length}>
                  {ligar.map((t) => (
                    <TarefaRow key={`${t.kind}-${t.id}`} item={t} podeMarcar={podeMarcar} />
                  ))}
                </Grupo>
              )}
              {negocios.length > 0 && (
                <Grupo titulo="Negócios parados" count={negocios.length}>
                  {negocios.map((t) => (
                    <TarefaRow key={`${t.kind}-${t.id}`} item={t} podeMarcar={podeMarcar} />
                  ))}
                </Grupo>
              )}
              {feitas.length > 0 && (
                <Grupo titulo="Feitas hoje" count={feitas.length}>
                  {feitas.map((t) => (
                    <TarefaRow key={`${t.kind}-${t.id}`} item={t} podeMarcar={podeMarcar} feita />
                  ))}
                </Grupo>
              )}
              {revisar.length > 0 && (
                <Grupo titulo="Revisar dados" count={revisar.length}>
                  {revisar.map((c) => (
                    <div key={c.id} className="flex items-center gap-4 border-b border-line py-3.5">
                      <div className="min-w-0 flex-1">
                        <div className="text-body font-medium">{c.nome}</div>
                        <div className="mt-0.5 text-small text-ink-2">
                          {[
                            c.numeroErrado && `número errado${c.numeroErrado.motivo ? ` (${c.numeroErrado.motivo})` : ""}`,
                            c.faltaWhatsapp && "sem WhatsApp",
                            c.faltaEmail && "sem e-mail",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                      <Button asChild variant="outline">
                        <Link href={`/contatos/${c.id}`}>Revisar</Link>
                      </Button>
                    </div>
                  ))}
                </Grupo>
              )}
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-9">
          <section aria-labelledby="t-toques">
            <SectionHeader id="t-toques" variant="aside" title="Prospecções hoje" />
            <div className="flex flex-col gap-2 pt-4">
              <div className="num font-serif text-num">
                {hoje.feitas}
                {hoje.base > 0 && <span className="text-[18px] text-ink-3"> · meta {hoje.base}</span>}
              </div>
              {hoje.base > 0 ? (
                <>
                  <Progress value={Math.min(100, hoje.pct)} indicatorClassName={hoje.bateu ? "bg-success-500" : undefined} />
                  <div className="num text-small text-ink-2">{hoje.bateu ? "meta batida" : `faltam ${hoje.restantes} para a meta`}</div>
                </>
              ) : (
                <Link href="/configuracoes" className="text-small text-ink-2 hover:text-foreground">
                  Defina uma meta diária em Configurações →
                </Link>
              )}
            </div>
          </section>
          <section aria-labelledby="t-ag">
            <SectionHeader
              id="t-ag"
              variant="aside"
              title="Agenda de hoje"
              aside={
                <Link href="/agenda" className="font-medium text-brand-500 hover:underline">
                  Abrir agenda
                </Link>
              }
            />
            {agendaHoje.length === 0 ? (
              <p className="py-4 text-small text-ink-2">Nenhum compromisso hoje.</p>
            ) : (
              agendaHoje.map((a) => (
                <div key={a.id} className="flex gap-4 border-b border-line py-3.5 text-body">
                  <span className="num w-11 shrink-0 text-ink-2">{formatTime(a.inicio)}</span>
                  <div className="min-w-0">
                    <div className={a.status === "concluido" ? "text-ink-3 line-through" : ""}>{a.titulo}</div>
                    {a.contactNome && <div className="mt-0.5 text-caption text-ink-3">{a.contactNome}</div>}
                  </div>
                </div>
              ))
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Grupo({ titulo, count, children }: { titulo: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <SectionHeader title={titulo} aside={<span className="num">{count}</span>} />
      {children}
    </section>
  );
}

function TarefaRow({ item, podeMarcar, feita = false }: { item: ItemDia; podeMarcar: boolean; feita?: boolean }) {
  const check = podeMarcar ? <TaskCheck chave={item.chave} feita={feita} label={item.contato} /> : null;
  const linha = cn("flex items-center gap-4 border-b border-line py-3.5", feita && "text-ink-3 [&_.font-medium]:font-normal");
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
          <Link href={`/funis/${item.funilId}`}>Ver no funil</Link>
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
          <span className="font-medium">Ligar para {item.contato}</span>
          {item.empresa && <span className="text-ink-2"> · {item.empresa}</span>}
        </div>
        <div className="mt-0.5 text-small">
          <StatusDot tone="empty">
            Nunca contatado · lead {item.origem ? `de ${item.origem}` : "novo"} · {relativeTime(item.criadoEm)}
          </StatusDot>
        </div>
      </div>
      <Button asChild variant="ghost">
        <Link href={`/contatos/${item.id}`}>Abrir</Link>
      </Button>
      <Button asChild variant="outline">
        <Link href="/ligacoes">Ligar</Link>
      </Button>
    </div>
  );
}
