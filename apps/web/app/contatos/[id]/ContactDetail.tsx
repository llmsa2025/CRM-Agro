"use client";

import { useState, type ReactNode } from "react";
import { Search, FileText, Check, CheckCheck, X, AlertTriangle, Mail } from "lucide-react";
import Link from "next/link";
import { AudioPlayer } from "@/components/audio-player";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AppointmentDialog } from "@/app/agenda/AppointmentDialog";
import { CompaniesManager } from "./CompaniesManager";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabCount } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { StatusDoContato } from "./StatusDoContato";
import { nomeCompleto } from "@/lib/nome";
import { InteresseBadge } from "@/components/ui/interesse-badge";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { TagPill } from "@/components/ui/tag-pill";
import { formatBRLCompact, formatDate, formatWhen, formatPhone, initialsOf, daysSince } from "@/lib/format";
import { NoteForm } from "./forms";
import { AddToFunnelDialog, type FunnelOption } from "@/components/add-to-funnel-dialog";
import { cn } from "@/lib/utils";
import { EnriquecerPessoa } from "./EnriquecerPessoa";
import { AgroDoContato, type AgroDaFicha } from "./AgroDoContato";

export type Activity = {
  id: string;
  tipo: string;
  direcao: string | null;
  conteudo: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

export type Contact = {
  id: string;
  nome: string;
  email: string | null;
  telefone: string | null;
  relacionamentoStatus: string;
  interesse: string;
  produtorLabel: string | null;
  cidade: string | null;
  estado: string | null;
  endereco: string | null;
  cargo: string | null;
  origem: string | null;
  sobrenome: string | null;
  cpf: string | null;
  instagram: string | null;
  linkedin: string | null;
  tags: string[];
  createdAt: string;
  /** Área (ha) e faturamento anual (R$), opcionais. */
  areaHa: number | null;
  faturamentoAnual: number | null;
  /** Camada do mapa, se houver. */
  camada: { nome: string; cor: string } | null;
  /** Responsável pelo contato e se está aberto ao time (F4). */
  donoNome?: string | null;
  compartilhado?: boolean;
  /** Verificador do agro: o que o contato é e por quê. */
  agro: AgroDaFicha;
};

export type EmailItem = {
  id: string;
  subject: string;
  to: string | null;
  body: string | null;
  direcao: string;
  status: string;
  at: string;
};

export type CompanyItem = {
  id: string;
  papel: string;
  nome: string;
  cnpj: string | null;
  ie: string | null;
  site: string | null;
  email: string | null;
  telefone: string | null;
  endereco: string | null;
  cidade: string | null;
  estado: string | null;
  instagram: string | null;
  linkedin: string | null;
  naturezaJuridica: string | null;
  /** Fonte e data de cada campo preenchido pelo Enriquecer (vem de `Company.enrichment.campos`). */
  proveniencia?: Record<string, { fonteRotulo: string; consultadoEm: string }>;
  /** Dados públicos da Receita guardados com o OK da pessoa (razão social, fantasia, situação...). */
  dadosPublicos?: { rotulo: string; valor: string; fonteRotulo: string; consultadoEm: string }[];
  socios?: { nome: string; qualificacao: string | null; cpfExibicao: string | null }[];
  /** Ativa ou não na Receita; null/ausente = o CRM Agro ainda não conferiu. */
  situacao?: { ativa: boolean; descricao: string | null; consultadoEm: string } | null;
};

export type DealItem = {
  id: string;
  funnelId: string;
  valor: string;
  status: string;
  enteredStageAt: string;
  stage: { nome: string; funnel: { nome: string } };
};

const MSG_TYPES = new Set(["whatsapp", "email"]);

const PRODUTOR: Record<string, string> = {
  produtor: "Produtor rural",
  provavel_produtor: "Provável produtor",
  nao_produtor: "Não produtor",
};

function labelFor(tipo: string): string {
  switch (tipo) {
    case "whatsapp":
      return "WhatsApp";
    case "email":
      return "E-mail";
    case "call":
      return "Ligação";
    case "stage_change":
      return "Mudança de etapa";
    case "note":
      return "Nota";
    default:
      return tipo;
  }
}

function toneFor(a: Activity): StatusTone {
  if (a.direcao === "in") return "ok";
  if (a.tipo === "stage_change") return "info";
  if (a.tipo === "note") return "done";
  return "brand";
}

/** Título curto da atividade, como se lê no histórico ("Ana respondeu", "WhatsApp enviado"). */
function tituloDe(a: Activity, primeiroNome: string): string {
  if (a.tipo === "stage_change") return "Negócio movido";
  if (a.tipo === "note") return "Nota";
  if (a.tipo === "call") return "Ligação";
  if (a.direcao === "in") return `${primeiroNome} respondeu`;
  return `${labelFor(a.tipo)} enviado`;
}

function DataRow({ label, value, children }: { label: string; value?: string | null; children?: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 border-b border-line py-2.5 text-body">
      <dt className="text-small text-ink-3">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children ?? value ?? <span className="text-ink-3">—</span>}</dd>
    </div>
  );
}

/** Mídia da atividade tocável/visível direto no histórico. */
function MediaInline({ url, mime, legenda }: { url: string; mime: string | null; legenda: string | null }) {
  const m = mime ?? "";
  const cap = legenda && legenda !== "[audio]" && legenda !== "[image]" && legenda !== "[doc]" ? legenda : null;
  return (
    <div className="mt-1.5 space-y-1">
      {m.startsWith("audio/") ? (
        <AudioPlayer src={url} mime={m} />
      ) : m.startsWith("image/") ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={cap ?? "imagem"} className="max-h-52 w-auto max-w-full rounded-md" />
        </a>
      ) : (
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-body text-brand-500 hover:underline">
          <FileText className="h-4 w-4" /> {cap ?? "Abrir documento"}
        </a>
      )}
      {cap && !m.startsWith("doc") ? <p className="text-body text-ink-2">{cap}</p> : null}
    </div>
  );
}

/** Uma linha do histórico: ponto no trilho, título, contexto e conteúdo. */
function ActivityEntry({ a, primeiroNome }: { a: Activity; primeiroNome: string }) {
  const isMsg = MSG_TYPES.has(a.tipo);
  const [aberto, setAberto] = useState(false);
  const texto = a.conteudo ?? "";
  const longo = texto.length > 180;

  return (
    <div className="relative flex gap-4 pb-6 last:pb-0">
      <div className="flex w-3 shrink-0 flex-col items-center">
        <StatusDot tone={toneFor(a)} className="mt-[7px]" />
        <span className="mt-2 w-px flex-1 bg-line" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-body font-medium">{tituloDe(a, primeiroNome)}</span>
          <span className="num shrink-0 text-small text-ink-3" title={formatDate(a.createdAt)}>
            {formatWhen(a.createdAt)}
          </span>
        </div>
        <div className="text-small text-ink-2">
          {labelFor(a.tipo)}
          {isMsg ? (a.direcao === "in" ? " · recebida" : " · enviada") : ""}
        </div>
        {a.mediaUrl ? (
          <MediaInline url={a.mediaUrl} mime={a.mediaMime} legenda={a.conteudo} />
        ) : a.tipo === "stage_change" && a.meta ? (
          <p className="mt-1 text-body text-ink-2">
            {(a.meta.de as string | null) ?? "?"} → <span className="text-foreground">{(a.meta.para as string | null) ?? "?"}</span>
          </p>
        ) : texto ? (
          <p className={cn("mt-1.5 whitespace-pre-wrap text-body leading-relaxed text-ink-2 [overflow-wrap:anywhere]", !aberto && longo && "line-clamp-3")}>
            {isMsg ? `“${texto}”` : texto}
          </p>
        ) : null}
        {longo && (
          <button type="button" onClick={() => setAberto((v) => !v)} className="mt-1 text-small font-medium text-brand-500 hover:underline">
            {aberto ? "Mostrar menos" : "Ver tudo"}
          </button>
        )}
      </div>
    </div>
  );
}

const DEAL_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  open: { label: "aberto", tone: "ok" },
  won: { label: "ganho", tone: "ok" },
  lost: { label: "perdido", tone: "error" },
};

export function ContactDetail({
  contact,
  companies,
  emails,
  activities,
  deals,
  funnels,
  actions,
  podeMarcarStatus = false,
}: {
  contact: Contact;
  companies: CompanyItem[];
  emails: EmailItem[];
  activities: Activity[];
  deals: DealItem[];
  funnels: FunnelOption[];
  /** Menu "…" com editar/excluir (vem do server). */
  actions?: ReactNode;
  /** Pode mudar o status (Nunca contatado, Contatado, Cliente) ali mesmo na ficha. */
  podeMarcarStatus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [agendaOpen, setAgendaOpen] = useState(false);
  const term = q.trim().toLowerCase();
  const filteredActs = term
    ? activities.filter((a) => (a.conteudo ?? "").toLowerCase().includes(term) || labelFor(a.tipo).toLowerCase().includes(term))
    : activities;
  const mensagens = filteredActs.filter((a) => MSG_TYPES.has(a.tipo));
  const ligacoes = filteredActs.filter((a) => a.tipo === "call");
  const primeiroNome = contact.nome.trim().split(" ")[0] || "Contato";
  const waNumero = contact.telefone?.replace(/\D/g, "");
  const abertos = deals.filter((d) => d.status === "open");

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        breadcrumb={[{ label: "Contatos", href: "/contatos" }]}
        leading={
          <Avatar className="h-[52px] w-[52px]">
            <AvatarFallback className="font-serif text-[18px] font-normal">{initialsOf(nomeCompleto(contact)) || "?"}</AvatarFallback>
          </Avatar>
        }
        title={nomeCompleto(contact)}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <StatusDoContato contactId={contact.id} status={contact.relacionamentoStatus} podeEditar={podeMarcarStatus} />
            {contact.interesse !== "nao_avaliado" && (
              <>
                <span className="text-ink-3">·</span>
                <InteresseBadge interesse={contact.interesse} />
              </>
            )}
            {contact.produtorLabel && PRODUTOR[contact.produtorLabel] && (
              <>
                <span className="text-ink-3">·</span>
                <span>{PRODUTOR[contact.produtorLabel]}</span>
              </>
            )}
            {(contact.cidade || contact.estado) && (
              <>
                <span className="text-ink-3">·</span>
                <span>{[contact.cidade, contact.estado].filter(Boolean).join("/")}</span>
              </>
            )}
            {contact.donoNome && (
              <>
                <span className="text-ink-3">·</span>
                <span>Responsável: {contact.donoNome}</span>
              </>
            )}
            {contact.compartilhado && (
              <>
                <span className="text-ink-3">·</span>
                <span>compartilhado com o time</span>
              </>
            )}
          </span>
        }
        actions={
          <>
            {actions}
            <Button variant="outline" onClick={() => setAgendaOpen(true)}>
              Agendar
            </Button>
            {contact.telefone && (
              <Button asChild variant="outline">
                <Link href="/ligacoes">Ligar</Link>
              </Button>
            )}
            {waNumero && (
              <Button asChild>
                <Link href={`/conversas?contact=${contact.id}&canal=whatsapp`}>WhatsApp</Link>
              </Button>
            )}
          </>
        }
      />
      <AppointmentDialog open={agendaOpen} onOpenChange={setAgendaOpen} fixedContact={{ id: contact.id, nome: nomeCompleto(contact) }} />

      <div className="grid grid-cols-1 gap-x-10 gap-y-10 lg:grid-cols-[264px_minmax(0,1fr)] 2xl:grid-cols-[264px_minmax(0,1fr)_320px] 2xl:gap-x-14">
        {/* Coluna 1 — Pessoa + Empresa */}
        <aside className="flex flex-col gap-8">
          <section aria-labelledby="t-pessoa">
            <SectionHeader id="t-pessoa" variant="aside" title="Pessoa" />
            <dl>
              <DataRow label="WhatsApp">
                {contact.telefone ? (
                  <span className="num">{formatPhone(contact.telefone)}</span>
                ) : (
                  <span className="text-ink-3">—</span>
                )}
              </DataRow>
              <DataRow label="E-mail" value={contact.email} />
              {contact.cargo && <DataRow label="Papel" value={contact.cargo} />}
              <DataRow label="Cidade" value={[contact.cidade, contact.estado].filter(Boolean).join("/") || null} />
              {contact.areaHa != null && (
                <DataRow label="Área" value={`${contact.areaHa.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ha`} />
              )}
              {contact.faturamentoAnual != null && (
                <DataRow label="Faturamento anual" value={formatBRLCompact(contact.faturamentoAnual)} />
              )}
              {contact.camada && (
                <DataRow label="Camada">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: contact.camada.cor }} aria-hidden />
                    {contact.camada.nome}
                  </span>
                </DataRow>
              )}
              {contact.endereco && <DataRow label="Endereço" value={contact.endereco} />}
              {contact.cpf && <DataRow label="CPF" value={contact.cpf} />}
              {contact.instagram && <DataRow label="Instagram" value={contact.instagram} />}
              {contact.linkedin && <DataRow label="LinkedIn" value={contact.linkedin} />}
              <DataRow label="Origem" value={contact.origem} />
              <DataRow label="Criado">
                <span className="num">{daysSince(contact.createdAt)}</span>
              </DataRow>
            </dl>
            <div className="pt-2">
              <EnriquecerPessoa
                contactId={contact.id}
                inicial={{
                  nome: nomeCompleto(contact),
                  cidade: contact.cidade,
                  estado: contact.estado,
                  email: contact.email,
                  telefone: contact.telefone,
                  cpf: contact.cpf,
                }}
              />
            </div>
            {contact.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-3">
                {contact.tags.map((t) => (
                  <TagPill key={t} nome={t} />
                ))}
              </div>
            )}
          </section>

          <section aria-label="Empresa">
            <CompaniesManager contactId={contact.id} companies={companies} />
          </section>

          <AgroDoContato contactId={contact.id} agro={contact.agro} podeEditar={podeMarcarStatus} />
        </aside>

        {/* Coluna 2 — Histórico */}
        <section aria-labelledby="t-hist" className="min-w-0">
          <Tabs defaultValue="tudo">
            <div className="flex flex-wrap items-end gap-x-6 border-b border-line">
              <h2 id="t-hist" className="pb-2 font-serif text-h2 text-foreground">
                Histórico
              </h2>
              <TabsList className="border-0">
                <TabsTrigger value="tudo">
                  Tudo <TabCount>{filteredActs.length}</TabCount>
                </TabsTrigger>
                <TabsTrigger value="mensagens">
                  Mensagens <TabCount>{mensagens.length}</TabCount>
                </TabsTrigger>
                <TabsTrigger value="ligacoes">
                  Ligações <TabCount>{ligacoes.length}</TabCount>
                </TabsTrigger>
                <TabsTrigger value="emails">
                  E-mails <TabCount>{emails.length}</TabCount>
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="flex flex-col gap-4 pt-4">
              <NoteForm contactId={contact.id} />
              {activities.length > 6 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar no histórico" className="h-8 pl-9 text-small" />
                </div>
              )}
            </div>

            <TabsContent value="tudo">
              <Timeline items={filteredActs} primeiroNome={primeiroNome} vazio="Nenhuma atividade registrada ainda." q={q} />
            </TabsContent>
            <TabsContent value="mensagens">
              <Timeline items={mensagens} primeiroNome={primeiroNome} vazio="Nenhuma mensagem trocada ainda." q={q} />
            </TabsContent>
            <TabsContent value="ligacoes">
              <Timeline items={ligacoes} primeiroNome={primeiroNome} vazio="Nenhuma ligação registrada." q={q} />
            </TabsContent>
            <TabsContent value="emails">
              <EmailsTab emails={emails} />
            </TabsContent>
          </Tabs>
        </section>

        {/* Coluna 3 — Negócios */}
        <aside className="flex flex-col gap-8 lg:col-span-2 2xl:col-span-1">
          <section aria-labelledby="t-neg">
            <SectionHeader
              id="t-neg"
              variant="aside"
              title="Negócios"
              aside={<AddToFunnelDialog contactId={contact.id} funnels={funnels} />}
            />
            {deals.length === 0 ? (
              <p className="py-4 text-small text-ink-2">Este contato ainda não está em nenhum funil.</p>
            ) : (
              deals.map((d) => {
                const st = DEAL_STATUS[d.status] ?? { label: d.status, tone: "done" as StatusTone };
                return (
                  <div key={d.id} className="flex flex-col gap-1 border-b border-line py-3.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-body font-medium">{d.stage.funnel.nome}</span>
                      <StatusDot tone={st.tone}>{d.stage.nome}</StatusDot>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-small">
                      <span className="num text-ink-2">
                        {st.label} · {daysSince(d.enteredStageAt)}
                        {Number(d.valor) > 0 ? ` · ${formatBRLCompact(Number(d.valor))}` : ""}
                      </span>
                      <Link href={`/funis/${d.funnelId}`} className="font-medium text-brand-500 hover:underline">
                        Ver negócio
                      </Link>
                    </div>
                  </div>
                );
              })
            )}
            {abertos.length > 1 && <p className="pt-2 text-caption text-ink-3">{abertos.length} negócios abertos ao mesmo tempo.</p>}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Timeline({ items, primeiroNome, vazio, q }: { items: Activity[]; primeiroNome: string; vazio: string; q: string }) {
  if (items.length === 0) {
    return <p className="py-8 text-center text-body text-ink-2">{q.trim() ? `Nada encontrado para “${q}”.` : vazio}</p>;
  }
  return (
    <div className="pt-2">
      {items.map((a) => (
        <ActivityEntry key={a.id} a={a} primeiroNome={primeiroNome} />
      ))}
    </div>
  );
}

/** Status de e-mail: enviado · entregue · aberto · bloqueado · falhou. */
function EmailStatus({ status }: { status: string }) {
  if (status === "read")
    return (
      <span className="inline-flex items-center gap-1 text-caption font-medium text-success-500" title="Aberto/lido">
        <CheckCheck className="h-3.5 w-3.5" /> Aberto
      </span>
    );
  if (status === "delivered")
    return (
      <span className="inline-flex items-center gap-1 text-caption text-ink-3" title="Entregue">
        <CheckCheck className="h-3.5 w-3.5" /> Entregue
      </span>
    );
  if (status === "bounced")
    return (
      <span className="inline-flex items-center gap-1 text-caption text-warning-500" title="Bloqueado/devolvido">
        <AlertTriangle className="h-3.5 w-3.5" /> Bloqueado
      </span>
    );
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 text-caption text-danger-500" title="Falhou ao enviar">
        <X className="h-3.5 w-3.5" /> Falhou
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-caption text-ink-3" title="Enviado">
      <Check className="h-3.5 w-3.5" /> Enviado
    </span>
  );
}

/** Aba E-mails do contato: assunto, destinatário, status e prévia. */
function EmailsTab({ emails }: { emails: EmailItem[] }) {
  if (emails.length === 0) {
    return (
      <p className="py-8 text-center text-body text-ink-2">
        Nenhum e-mail trocado com este contato ainda. Envie por um fluxo (passo “Enviar e-mail”) e o status aparece aqui.
      </p>
    );
  }
  return (
    <div className="pt-2">
      {emails.map((e) => {
        const recebido = e.direcao === "in";
        return (
          <div key={e.id} className="border-b border-line py-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Mail className="h-4 w-4 shrink-0 text-ink-3" />
                <span className="min-w-0 truncate text-body font-medium">{e.subject}</span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {recebido ? <StatusDot tone="ok">Recebido</StatusDot> : <EmailStatus status={e.status} />}
                <span className="num text-caption text-ink-3">{formatWhen(e.at)}</span>
              </div>
            </div>
            {e.to && (
              <p className="mt-0.5 text-caption text-ink-3">
                {recebido ? "de" : "para"} {e.to}
              </p>
            )}
            {e.body && <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-body text-ink-2 [overflow-wrap:anywhere]">{e.body}</p>}
          </div>
        );
      })}
    </div>
  );
}
