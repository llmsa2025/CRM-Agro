"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AppointmentDTO } from "@crmagro/core";
import {
  createAppointmentAction,
  updateAppointmentAction,
  setAppointmentStatusAction,
  deleteAppointmentAction,
  desvincularDoGoogleAction,
  confirmarDoGoogleAction,
  listAgendaContactsAction,
  listTeamUsersAction,
  emailDoContatoAction,
  type AgendaContactItem,
  type AgendaUserItem,
} from "./actions";
import { decidirCliqueFora, decidirEsc, estadoAoLimpar } from "./contato-combobox";

const TIPOS = [
  { v: "ligacao", label: "Ligação" },
  { v: "reuniao", label: "Reunião" },
  { v: "reuniao_online", label: "Reunião online" },
  { v: "visita", label: "Visita" },
  { v: "follow_up", label: "Retorno" },
  { v: "tarefa", label: "Tarefa" },
  { v: "outro", label: "Outro" },
] as const;

/** Lembrete (produto §E): minutos de antecedência; "none" = sem lembrete. */
const LEMBRETES = [
  { v: "none", label: "Sem lembrete" },
  { v: "0", label: "Na hora" },
  { v: "10", label: "10 minutos antes" },
  { v: "30", label: "30 minutos antes" },
  { v: "60", label: "1 hora antes" },
  { v: "1440", label: "1 dia antes" },
] as const;

/** Duração (o Google exige o fim; antes era sempre 1 h). */
const DURACOES = [
  { v: "15", label: "15 minutos" },
  { v: "30", label: "30 minutos" },
  { v: "45", label: "45 minutos" },
  { v: "60", label: "1 hora" },
  { v: "90", label: "1 h 30" },
  { v: "120", label: "2 horas" },
  { v: "240", label: "4 horas" },
] as const;

/** Espelha o limite do core (MAX_CONVIDADOS) — componente cliente não importa valor do core. */
const MAX_CONVIDADOS = 50;
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function toDateInput(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function toTimeInput(d: Date) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/**
 * "Manter" a duração que o compromisso já tem quando ela não está na lista
 * (25/50 min do Google, 1h15, dia inteiro, vários dias, sem fim): trocar a
 * nota ou o lembrete nunca reescreve o fim — nem avisa os convidados.
 */
const DURACAO_MANTER = "manter";

function duracaoOriginalMin(a: AppointmentDTO): number | null {
  if (!a.fim) return null;
  return Math.round((new Date(a.fim).getTime() - new Date(a.inicio).getTime()) / 60_000);
}
function duracaoInicial(a: AppointmentDTO | null | undefined): string {
  if (!a) return "60";
  if (a.diaInteiro) return DURACAO_MANTER;
  const min = duracaoOriginalMin(a);
  if (min === null) return DURACAO_MANTER;
  return DURACOES.some((d) => d.v === String(min)) ? String(min) : DURACAO_MANTER;
}
function rotuloDaDuracaoAtual(a: AppointmentDTO): string {
  const min = duracaoOriginalMin(a);
  if (a.diaInteiro) {
    const dias = Math.max(1, Math.round((min ?? 1440) / 1440));
    return dias > 1 ? `Dia inteiro (${dias} dias)` : "Dia inteiro";
  }
  if (min === null) return "Sem fim definido";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h ? `${h} h` : ""}${h && m ? " " : ""}${m ? `${m} min` : ""} (atual)`;
}
/** Endereço da reunião para o rótulo do link (só o domínio). */
function dominio(link: string): string {
  try {
    return new URL(link).hostname;
  } catch {
    return "link";
  }
}

type CreateTipo = AppointmentDTO["tipo"];
/** Convidado na tela: colega (pelo id) ou e-mail (contato ou avulso). */
type Convidado = { email: string | null; nome: string | null; userId: string | null; resposta?: string };

const RESPOSTA: Record<string, string> = { accepted: "confirmou", declined: "recusou", tentative: "talvez" };

export function AppointmentDialog({
  open,
  onOpenChange,
  onSaved,
  initial,
  defaultDate,
  defaultTipo,
  fixedContact,
  googleConectado,
  eu,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved?: (a: AppointmentDTO) => void;
  initial?: AppointmentDTO | null;
  defaultDate?: string; // yyyy-mm-dd
  /** Tipo pré-escolhido ao criar (ex.: "visita" pela ficha do contato). */
  defaultTipo?: CreateTipo;
  fixedContact?: { id: string; nome: string } | null;
  /** A pessoa LOGADA tem a Agenda Google conectada (muda o texto do convite e do Meet). */
  googleConectado?: boolean;
  /** Id de quem está logado: o texto fala em "seu Google Agenda" só quando o responsável é a própria pessoa. */
  eu?: string | null;
}) {
  const editing = Boolean(initial);
  const base = initial ? new Date(initial.inicio) : defaultDate ? new Date(`${defaultDate}T09:00`) : new Date();
  // Evento de OUTRA pessoa no Google (a daqui é só convidada): horário e
  // convidados mudam lá; aqui ficam só para leitura.
  const soLeituraNoGoogle = initial?.googlePapel === "convidado";

  const [titulo, setTitulo] = useState(initial?.titulo ?? "");
  const [tipo, setTipo] = useState<string>(initial?.tipo ?? defaultTipo ?? "tarefa");
  const [date, setDate] = useState(toDateInput(base));
  const [time, setTime] = useState(toTimeInput(base));
  const [duracao, setDuracao] = useState<string>(duracaoInicial(initial));
  const [descricao, setDescricao] = useState(initial?.descricao ?? "");
  const [convidados, setConvidados] = useState<Convidado[]>(
    (initial?.convidados ?? []).map((c) => ({ email: c.email, nome: c.nome, userId: c.userId, resposta: c.resposta })),
  );
  const [novoEmail, setNovoEmail] = useState("");
  const [local, setLocal] = useState(initial?.local ?? "");
  const [lembrete, setLembrete] = useState<string>(
    initial ? (initial.lembreteMin === null ? "none" : String(initial.lembreteMin)) : "30",
  );
  const [responsavelId, setResponsavelId] = useState<string>(initial?.responsavelId ?? "");
  const [usuarios, setUsuarios] = useState<AgendaUserItem[]>([]);
  const [saving, setSaving] = useState(false);

  // Contato ligado (fixo quando vem do contato; busca quando vem da Agenda).
  const [contact, setContact] = useState<{ id: string; nome: string; email?: string | null } | null>(
    fixedContact ?? (initial?.contactId ? { id: initial.contactId, nome: initial.contactNome ?? "Contato" } : null),
  );
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<AgendaContactItem[]>([]);
  const [showList, setShowList] = useState(false);
  const comboRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listaId = useId();
  // A lista só existe visualmente com resultados; é isso que o Esc/clique fora precisam enxergar.
  const listaVisivel = !contact && showList && results.length > 0;

  // Só busca os resultados; quem abre a lista é o foco/digitação (senão ela reabria sozinha
  // depois de fechada e "não saía" da frente).
  useEffect(() => {
    if (fixedContact || contact || !open) return;
    let cancelado = false;
    const t = setTimeout(async () => {
      const r = await listAgendaContactsAction(search || undefined);
      if (!cancelado) setResults(r);
    }, 250);
    return () => {
      cancelado = true;
      clearTimeout(t);
    };
  }, [search, open, fixedContact, contact]);

  // Clique/toque fora do combobox fecha a lista (e só ela).
  useEffect(() => {
    if (!listaVisivel) return;
    function aoPressionar(e: PointerEvent) {
      const dentro = Boolean(comboRef.current && e.target instanceof Node && comboRef.current.contains(e.target));
      if (decidirCliqueFora(true, dentro).fecharLista) setShowList(false);
    }
    document.addEventListener("pointerdown", aoPressionar);
    return () => document.removeEventListener("pointerdown", aoPressionar);
  }, [listaVisivel]);

  // Ao fechar o diálogo a lista volta fechada na próxima abertura.
  useEffect(() => {
    if (!open) setShowList(false);
  }, [open]);

  function limparContato() {
    const e = estadoAoLimpar();
    setContact(e.contact);
    setSearch(e.search);
    setShowList(e.showList);
    // Volta o foco para o campo de busca (ele reaparece no próximo render).
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  // E-mail do contato (para sugerir como convidado) quando ele veio sem.
  useEffect(() => {
    if (!open || !contact || contact.email !== undefined) return;
    let vivo = true;
    emailDoContatoAction(contact.id)
      .then((email) => {
        if (vivo) setContact((c) => (c && c.id === contact.id ? { ...c, email } : c));
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [open, contact]);

  // Usuários do time (responsável e colega convidado) — uma vez por abertura.
  useEffect(() => {
    if (!open) return;
    listTeamUsersAction()
      .then(setUsuarios)
      .catch(() => setUsuarios([]));
  }, [open]);

  const jaConvidado = (email: string) => convidados.some((c) => c.email === email);

  function adicionarEmail(bruto: string): boolean {
    const email = bruto.trim().toLowerCase().replace(/[,;]+$/, "");
    if (!email) return false;
    if (!EMAIL_OK.test(email)) {
      toast.error("E-mail inválido", { description: email });
      return false;
    }
    if (convidados.length >= MAX_CONVIDADOS) {
      toast.error(`No máximo ${MAX_CONVIDADOS} convidados`);
      return false;
    }
    if (!jaConvidado(email)) setConvidados((l) => [...l, { email, nome: null, userId: null }]);
    return true;
  }

  function adicionarColega(u: AgendaUserItem) {
    if (convidados.some((c) => c.userId === u.id)) return;
    if (convidados.length >= MAX_CONVIDADOS) {
      toast.error(`No máximo ${MAX_CONVIDADOS} convidados`);
      return;
    }
    setConvidados((l) => [...l, { email: null, nome: u.nome, userId: u.id }]);
  }

  async function salvar() {
    if (!titulo.trim()) {
      toast.error("Informe um título");
      return;
    }
    const inicio = new Date(`${date}T${time}`);
    if (isNaN(inicio.getTime())) {
      toast.error("Data/hora inválida");
      return;
    }
    // E-mail digitado e não adicionado: entra junto (ou avisa se inválido).
    let lista = convidados;
    if (novoEmail.trim()) {
      const email = novoEmail.trim().toLowerCase();
      if (!EMAIL_OK.test(email)) {
        toast.error("E-mail do convidado inválido", { description: email });
        return;
      }
      if (!jaConvidado(email)) lista = [...lista, { email, nome: null, userId: null }];
      setNovoEmail("");
    }
    setSaving(true);
    // Horário: na edição, só vai se a pessoa mexeu no início ou na duração
    // (senão uma troca de nota reescreveria o fim e avisaria os convidados).
    const inicioMudou = !initial || date !== toDateInput(base) || time !== toTimeInput(base);
    const duracaoMudou = !initial || duracao !== duracaoInicial(initial);
    let fim: Date | null;
    if (duracao === DURACAO_MANTER && initial) {
      const min = duracaoOriginalMin(initial);
      fim = min === null ? null : new Date(inicio.getTime() + min * 60_000);
    } else {
      fim = new Date(inicio.getTime() + Number(duracao) * 60_000);
    }
    const horario =
      !soLeituraNoGoogle && (inicioMudou || duracaoMudou) ? { inicio: inicio.toISOString(), fim: fim ? fim.toISOString() : null } : {};
    const comuns = {
      // O convite saiu pelo Google Agenda de outra pessoa: título, tipo, nota,
      // local e convidados nem vão (só ela muda; aqui só remarca ou cancela).
      ...(travadoPeloGoogleDoResponsavel
        ? {}
        : {
            titulo: titulo.trim(),
            tipo: tipo as CreateTipo,
            descricao: descricao.trim() || undefined,
            local: local.trim() || null,
          }),
      contactId: contact?.id ?? null,
      // Evento de outra pessoa no Google: os convidados são os de lá (não mexe).
      ...(soLeituraNoGoogle || travadoPeloGoogleDoResponsavel
        ? {}
        : { convidados: lista.map((c) => (c.userId ? { userId: c.userId } : { email: c.email, nome: c.nome })) }),
      lembreteMin: lembrete === "none" ? null : Number(lembrete),
      // "Eu" no seletor é "" (não existe a opção "do time"). Criando, sem valor o
      // servidor usa quem cria; `null` deixaria o compromisso sem dono e ele nunca
      // iria ao Google Agenda de ninguém. Editando o compromisso de OUTRA pessoa,
      // escolher "Eu" o passa para quem está logado; se ele já era "do time", o
      // "Eu" mostrado não muda nada.
      responsavelId: responsavelId || (initial?.responsavelId ? (eu ?? undefined) : undefined),
    };
    const res = editing
      ? await updateAppointmentAction(initial!.id, { ...comuns, ...horario })
      : await createAppointmentAction({ ...comuns, titulo: titulo.trim(), inicio: inicio.toISOString(), fim: fim ? fim.toISOString() : null });
    setSaving(false);
    if (res.ok) {
      toast.success(editing ? "Compromisso atualizado" : "Compromisso criado");
      onSaved?.(res.appointment!);
      onOpenChange(false);
    } else {
      toast.error("Falha ao salvar", { description: res.error });
    }
  }

  async function mudarStatus(status: "concluido" | "cancelado" | "pendente", aviso: string) {
    const r = await setAppointmentStatusAction(initial!.id, status);
    if (r.ok) {
      toast.success(aviso);
      onSaved?.({ ...initial!, status });
      onOpenChange(false);
    } else toast.error("Falha", { description: r.error });
  }

  async function manterNoCrmAgro() {
    const r = await confirmarDoGoogleAction(initial!.id);
    if (r.ok) {
      toast.success("Mantido no CRM Agro. O time passa a ver este compromisso.");
      onSaved?.(r.appointment ?? initial!);
      onOpenChange(false);
    } else toast.error("Falha", { description: r.error });
  }

  async function tirarDoCrmAgro() {
    const r = await desvincularDoGoogleAction(initial!.id);
    if (r.ok) {
      toast.success("Tirado do CRM Agro. No seu Google Agenda nada mudou; aqui o horário fica na sua agenda pessoal e os outros veem só \"Ocupado\".");
      onSaved?.(initial!);
      onOpenChange(false);
    } else toast.error("Falha", { description: r.error });
  }

  const tipoLabel = TIPOS.find((t) => t.v === tipo)?.label ?? "Compromisso";
  const temConvidados = convidados.length > 0;
  // Com convidados ou no Google, "excluir" vira cancelar (os convidados são avisados).
  const cancelaEmVezDeExcluir = Boolean(initial && (initial.convidados.length > 0 || initial.google));
  // Texto do cancelamento: só promete aviso que de fato sai.
  const avisoDoCancelamento = !initial
    ? "Cancelado"
    : soLeituraNoGoogle
      ? "Cancelado só no CRM Agro: o evento é de outra pessoa no Google e ninguém foi avisado"
      : initial.google
        ? "Cancelado · os convidados são avisados"
        : initial.convidados.length
          ? "Cancelado · o cancelamento vai por e-mail aos convidados (se o time tiver caixa de e-mail conectada)"
          : "Cancelado";
  const sugestaoContato = contact?.email && !jaConvidado(contact.email) ? contact.email : null;
  const colegasLivres = usuarios.filter((u) => !convidados.some((c) => c.userId === u.id));
  // O responsável é a própria pessoa? ("" no seletor = "Eu".) Só então o texto
  // fala do Google Agenda DELA; o convite de quem não é o responsável sai por e-mail.
  const responsavelSouEu = !responsavelId || (Boolean(eu) && responsavelId === eu);
  const podeTirarDoCrmAgro = Boolean(initial && initial.origem === "google" && initial.googlePapel && (!initial.responsavelId || initial.responsavelId === eu));
  // Veio da Agenda Google da pessoa e ela ainda não confirmou: só ela vê.
  const podeManterNoCrmAgro = Boolean(initial?.privado && eu && initial.responsavelId === eu);
  // O convite saiu pelo Google Agenda do responsável e quem edita é outra
  // pessoa (sem trocar o responsável): só remarca ou cancela — o resto iria
  // aos clientes pela conta Google dele. O servidor recusa do mesmo jeito.
  const travadoPeloGoogleDoResponsavel = Boolean(
    initial?.conviteNoGoogle && eu && initial.responsavelId !== eu && (responsavelId || null) === (initial.responsavelId ?? null),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Descolado das bordas da tela: altura máxima com folga e rolagem interna quando não couber.
        className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-md"
        // Esc com a lista de contatos aberta fecha só a lista, não o diálogo.
        onEscapeKeyDown={(e) => {
          const d = decidirEsc(listaVisivel);
          if (d.impedirFecharDialogo) e.preventDefault();
          if (d.fecharLista) setShowList(false);
        }}
        // Clique no fundo com a lista aberta fecha só a lista.
        onInteractOutside={(e) => {
          const d = decidirCliqueFora(listaVisivel, false);
          if (d.impedirFecharDialogo) e.preventDefault();
          if (d.fecharLista) setShowList(false);
        }}
      >
        <DialogHeader>
          <DialogTitle>{editing ? "Editar compromisso" : `Novo compromisso`}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          {initial?.reuniaoLink && (
            <a
              href={initial.reuniaoLink}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-small font-medium text-brand-500 hover:underline"
            >
              {initial.reuniaoProvedor === "meet" ? "Entrar na reunião (Google Meet)" : `Entrar na reunião (${dominio(initial.reuniaoLink)})`}
            </a>
          )}
          {podeManterNoCrmAgro && (
            <div className="grid gap-2 rounded-md border border-line-strong p-3 text-small">
              <p>
                Só você vê este compromisso: ele veio da sua Agenda Google. Se é de trabalho, mantenha no CRM Agro e o time passa a vê-lo;
                se não é, tire do CRM Agro.
              </p>
              <Button variant="outline" className="justify-self-start" onClick={() => void manterNoCrmAgro()} disabled={saving}>
                Manter no CRM Agro
              </Button>
            </div>
          )}
          {travadoPeloGoogleDoResponsavel && (
            <p className="text-caption text-ink-3">
              O convite saiu pelo Google Agenda de {initial?.responsavelNome ?? "quem é o responsável"}: aqui você só remarca ou cancela. Título,
              tipo, local, nota e convidados, só {initial?.responsavelNome ?? "o responsável"} muda.
            </p>
          )}
          {initial && (initial.google || initial.origem === "google") && (
            <p className="text-caption text-ink-3">
              {soLeituraNoGoogle
                ? "Evento de outra pessoa no Google Agenda: horário e convidados mudam só lá"
                : initial.origem === "google"
                  ? "Veio do Google Agenda"
                  : "No Google Agenda do responsável"}
              {initial.google === "pendente" ? " · enviando a última alteração…" : ""}
              {initial.google === "reconectar" ? " · parado: o responsável precisa reconectar a Agenda Google para a alteração chegar lá" : ""}
            </p>
          )}
          <div className="grid gap-1.5">
            <Label>Tipo</Label>
            <Select value={tipo} onValueChange={setTipo} disabled={travadoPeloGoogleDoResponsavel}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIPOS.map((t) => (
                  <SelectItem key={t.v} value={t.v}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tipo === "reuniao_online" && !initial?.reuniaoLink && (
              <p className="text-caption text-ink-3">
                {responsavelSouEu && googleConectado
                  ? "O link do Google Meet é criado junto, na sua Agenda Google."
                  : "O link do Google Meet é criado quando o responsável tem a Agenda Google conectada."}
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label>Título</Label>
            <Input
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder={tipo === "visita" ? "Ex.: Visita à Fazenda Boa Vista" : "Ex.: Ligar para o produtor"}
              autoFocus
              disabled={travadoPeloGoogleDoResponsavel}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label>Data</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={soLeituraNoGoogle} />
            </div>
            <div className="grid gap-1.5">
              <Label>Hora</Label>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={soLeituraNoGoogle || initial?.diaInteiro} />
            </div>
            <div className="grid gap-1.5">
              <Label>Duração</Label>
              <Select value={duracao} onValueChange={setDuracao} disabled={soLeituraNoGoogle}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {initial && duracaoInicial(initial) === DURACAO_MANTER && (
                    <SelectItem value={DURACAO_MANTER}>{rotuloDaDuracaoAtual(initial)}</SelectItem>
                  )}
                  {DURACOES.map((d) => (
                    <SelectItem key={d.v} value={d.v}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {!fixedContact && (
            <div
              ref={comboRef}
              className="relative grid gap-1.5"
              onKeyDown={(e) => {
                // Tab sai do campo: a lista não pode ficar aberta para trás.
                if (e.key === "Tab") setShowList(false);
              }}
            >
              <Label htmlFor={`${listaId}-busca`}>Contato (opcional)</Label>
              {contact ? (
                <div className="flex h-9 items-center justify-between rounded-md border border-line-strong px-3 text-body">
                  {contact.nome}
                  <button
                    type="button"
                    onClick={limparContato}
                    aria-label="Remover contato"
                    className="inline-flex items-center gap-1 text-caption text-ink-2 hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                    remover
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <Input
                    ref={inputRef}
                    id={`${listaId}-busca`}
                    role="combobox"
                    aria-expanded={listaVisivel}
                    aria-controls={listaId}
                    aria-autocomplete="list"
                    autoComplete="off"
                    className={search ? "pr-8" : undefined}
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setShowList(true);
                    }}
                    onFocus={() => setShowList(true)}
                    placeholder="Buscar contato"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={limparContato}
                      aria-label="Limpar busca de contato"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-2 hover:text-foreground"
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  )}
                </div>
              )}
              {listaVisivel && (
                <div
                  id={listaId}
                  role="listbox"
                  aria-label="Contatos"
                  className="absolute left-0 right-0 top-full z-30 mt-1 max-h-48 overflow-y-auto rounded-md border border-line bg-popover shadow-popover"
                >
                  {results.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => {
                        setContact(r);
                        setShowList(false);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-body hover:bg-accent"
                    >
                      {r.nome}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {fixedContact && (
            <p className="text-small text-ink-2">
              Ligado a <span className="font-medium text-foreground">{fixedContact.nome}</span>
              {tipo === "visita" ? " · o endereço do contato vai para o mapa" : ""}
            </p>
          )}

          {(tipo === "visita" || tipo === "reuniao" || local) && (
            <div className="grid gap-1.5">
              <Label>Local</Label>
              <Input
                value={local}
                onChange={(e) => setLocal(e.target.value)}
                placeholder="Fazenda, cidade ou endereço"
                disabled={travadoPeloGoogleDoResponsavel}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Lembrete</Label>
              <Select value={lembrete} onValueChange={setLembrete}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEMBRETES.map((l) => (
                    <SelectItem key={l.v} value={l.v}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Responsável</Label>
              <Select value={responsavelId || "__eu__"} onValueChange={(v) => setResponsavelId(v === "__eu__" ? "" : v)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__eu__">Eu</SelectItem>
                  {usuarios.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Convidados (opcional)</Label>
            {temConvidados && (
              <ul className="flex flex-wrap gap-1.5" aria-label="Convidados">
                {convidados.map((c) => (
                  <li
                    key={c.userId ?? c.email}
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-line-strong py-0.5 pl-2 pr-1 text-small"
                  >
                    <span className="truncate">{c.nome ?? c.email}</span>
                    {c.resposta && RESPOSTA[c.resposta] ? <span className="text-ink-3">· {RESPOSTA[c.resposta]}</span> : null}
                    {soLeituraNoGoogle || travadoPeloGoogleDoResponsavel ? null : (
                      <button
                        type="button"
                        aria-label={`Tirar ${c.nome ?? c.email}`}
                        onClick={() => setConvidados((l) => l.filter((x) => x !== c))}
                        className="rounded p-0.5 text-ink-3 hover:bg-accent hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!soLeituraNoGoogle && !travadoPeloGoogleDoResponsavel && (
            <div className="flex gap-2">
              <Input
                type="email"
                value={novoEmail}
                onChange={(e) => setNovoEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "," || e.key === ";") {
                    e.preventDefault();
                    if (adicionarEmail(novoEmail)) setNovoEmail("");
                  }
                }}
                placeholder="convidado@empresa.com.br"
              />
              {colegasLivres.length > 0 && (
                <Select
                  value=""
                  onValueChange={(id) => {
                    const u = usuarios.find((x) => x.id === id);
                    if (u) adicionarColega(u);
                  }}
                >
                  <SelectTrigger className="h-9 w-[150px] shrink-0" aria-label="Convidar colega">
                    <SelectValue placeholder="+ colega" />
                  </SelectTrigger>
                  <SelectContent>
                    {colegasLivres.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.nome}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            )}
            {sugestaoContato && !soLeituraNoGoogle && !travadoPeloGoogleDoResponsavel && (
              <button type="button" onClick={() => adicionarEmail(sugestaoContato)} className="self-start text-small font-medium text-brand-500 hover:underline">
                + Convidar {contact?.nome} ({sugestaoContato})
              </button>
            )}
            <p className="text-caption text-ink-3">
              {soLeituraNoGoogle
                ? "Os convidados são os do evento no Google de quem organizou."
                : travadoPeloGoogleDoResponsavel
                  ? "Os convidados foram convidados pelo Google Agenda do responsável: só ele inclui ou tira alguém."
                  : responsavelSouEu
                    ? googleConectado
                      ? "O convite sai pelo seu Google Agenda (Enter adiciona o e-mail)."
                      : "Recebem um convite de calendário por e-mail (Enter adiciona o e-mail)."
                    : "Quem você incluir recebe o convite por e-mail. Se o responsável já convidou pelo Google Agenda dele, só ele muda os convidados."}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label>Nota (opcional)</Label>
            <Textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              rows={2}
              placeholder={`Detalhes da ${tipoLabel.toLowerCase()}`}
              disabled={travadoPeloGoogleDoResponsavel}
            />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {editing ? (
            <div className="flex flex-wrap gap-2">
              {initial!.status === "pendente" && (
                <Button variant="outline" onClick={() => void mudarStatus("concluido", "Concluído")} disabled={saving}>
                  Concluir
                </Button>
              )}
              {initial!.status === "cancelado" ? (
                // Reabrir convida de novo pela conta Google do responsável: só ele.
                travadoPeloGoogleDoResponsavel ? null : (
                  <Button variant="ghost" onClick={() => void mudarStatus("pendente", "Compromisso reaberto")} disabled={saving}>
                    Reabrir
                  </Button>
                )
              ) : cancelaEmVezDeExcluir ? (
                <Button
                  variant="ghost"
                  className="text-danger-500 hover:text-danger-700"
                  onClick={() => void mudarStatus("cancelado", avisoDoCancelamento)}
                  disabled={saving}
                >
                  Cancelar compromisso
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  className="text-danger-500 hover:text-danger-700"
                  onClick={async () => {
                    const r = await deleteAppointmentAction(initial!.id);
                    if (r.ok) {
                      toast.success("Excluído");
                      onSaved?.(initial!);
                      onOpenChange(false);
                    } else toast.error("Falha", { description: r.error });
                  }}
                  disabled={saving}
                >
                  Excluir
                </Button>
              )}
              {podeTirarDoCrmAgro && (
                <Button
                  variant="ghost"
                  title="O compromisso sai do CRM Agro e o horário volta para a sua agenda pessoal (os outros veem só Ocupado). Nada muda no seu Google Agenda."
                  onClick={() => void tirarDoCrmAgro()}
                  disabled={saving}
                >
                  Tirar do CRM Agro
                </Button>
              )}
            </div>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Fechar
            </Button>
            <Button onClick={salvar} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {editing ? "Salvar" : "Criar"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
