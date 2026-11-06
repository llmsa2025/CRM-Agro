"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";
import type { CampaignDTO, DestinatarioDTO, Previsao } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { StatusDot } from "@/components/ui/status-dot";
import { BalaoWhatsApp } from "@/components/whatsapp-texto";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatPhone } from "@/lib/format";
import {
  idsParaCampanhaAction,
  listContatosParaCampanhaAction as listContactsForPickerAction,
  tagsParaCampanhaAction,
  type ContatoDoPicker as ContactPickerItem,
} from "@/app/campanhas/actions";
import {
  estimateAction,
  getCampaignAction,
  listarDestinatariosAction,
  previewMessageAction,
  saveStepAction,
  startCampaignAction,
  uploadListAction,
} from "../actions";
import { ETAPAS, numeros, quando } from "../rotulos";

type Conta = { id: string; label: string; status: string; paused: boolean };
type Fluxo = { id: string; nome: string; status: string };
/** Outra campanha do time, para a regra "recebeu mensagem em outra campanha". */
export type OutraCampanha = { id: string; nome: string; enviados: number };

/** Rótulo humano das variáveis da mensagem (o código entre chaves fica no texto). */
const VARIAVEIS: { label: string; exemplo: string }[] = [
  { label: "Saudação", exemplo: "{saudacao}" },
  { label: "Primeiro nome", exemplo: "{primeiro_nome|tudo bem}" },
  { label: "Empresa", exemplo: "{empresa|sua fazenda}" },
  { label: "Cidade", exemplo: "{cidade|sua região}" },
  { label: "Estado", exemplo: "{estado}" },
  { label: "Cargo", exemplo: "{cargo}" },
];

/** Regra de quem já conversou, como aparece na revisão. */
const ROTULO_DA_REGRA: Record<string, string> = { hold: "segurar", skip: "pular", retomada: "retomada", enviar: "normal" };

/** Data e hora local no formato do `<input type="datetime-local">` (o `toISOString` daria a hora em UTC). */
function paraCampoDeData(iso: string | Date | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Segundos (como o banco guarda) para minutos na tela, com meio minuto de precisão. */
const segParaMin = (s: number) => Math.round((s / 60) * 2) / 2;

/** Intervalo em minutos para a revisão ("1 a 3 min", "30 s a 2 min"). */
function intervaloLegivel(minS: number, maxS: number): string {
  const um = (s: number) => (s < 60 ? `${s} s` : `${String(segParaMin(s)).replace(".", ",")} min`);
  return `${um(minS)} a ${um(maxS)}`;
}

function Passos({ atual, onIr, feitos, bloqueados = [] }: { atual: number; onIr: (n: number) => void; feitos: number; bloqueados?: number[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-8 gap-y-2">
      {ETAPAS.map((rotulo, i) => {
        const n = i + 1;
        const ativo = n === atual;
        const feito = n <= feitos;
        const clicavel = !bloqueados.includes(n) && (feito || n === atual || n === feitos + 1);
        return (
          <li key={rotulo}>
            <button
              type="button"
              disabled={!clicavel}
              onClick={() => onIr(n)}
              className={cn("num inline-flex items-center gap-2.5 text-body", ativo ? "font-medium text-foreground" : feito ? "text-ink-2 hover:text-foreground" : "text-ink-3")}
            >
              <span
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full border text-caption",
                  ativo ? "border-brand-500 bg-brand-500 text-white" : feito ? "border-brand-500 text-brand-500" : "border-line-strong text-ink-3",
                )}
              >
                {n}
              </span>
              {rotulo}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Num({ label, valor, tom }: { label: string; valor: number | string; tom?: "ok" | "attention" | "error" }) {
  return (
    <div className="flex flex-col gap-1 py-4 pr-6 first:pl-0 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-line [&:not(:first-child)]:pl-6">
      <span className="text-small text-ink-2">{label}</span>
      <span className={cn("num font-serif text-num", tom === "attention" && "text-warning-500", tom === "error" && "text-danger-500", tom === "ok" && "text-success-500")}>
        {valor}
      </span>
    </div>
  );
}

function Linha({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="num flex justify-between gap-3 border-b border-line py-2.5">
      <dt className="text-ink-2">{k}</dt>
      <dd className="truncate text-right">{v}</dd>
    </div>
  );
}

/** Rótulo da regra de quem já conversou, como aparece na revisão. */
function rotuloDaRegra(regra: string, outras: OutraCampanha[]): string {
  if (regra.startsWith("campanha:")) return `pular quem recebeu "${outras.find((o) => o.id === regra.slice(9))?.nome ?? "outra campanha"}"`;
  return ROTULO_DA_REGRA[regra] ?? regra;
}

export function CampaignWizard({
  inicial,
  contas,
  fluxos,
  outras = [],
  podeEditar,
  edicao = false,
}: {
  inicial: CampaignDTO;
  contas: Conta[];
  fluxos: Fluxo[];
  outras?: OutraCampanha[];
  podeEditar: boolean;
  /** Campanha pausada ou agendada: só mensagem e ritmo mudam (a lista e a regra ficam como estão). */
  edicao?: boolean;
}) {
  const router = useRouter();
  const [c, setC] = useState<CampaignDTO>(inicial);
  const feitos = useMemo(() => {
    let n = 0;
    if (c.lista?.estado === "pronta") n = 1;
    if (n === 1 && c.mensagem) n = 2;
    if (n === 2 && c.channelAccountId) n = 3;
    return n;
  }, [c]);
  const [etapa, setEtapa] = useState<number>(edicao ? 2 : Math.min(Math.max(inicial.etapa, 1), 4));
  const [pending, start] = useTransition();

  const recarregar = useCallback(async () => {
    const r = await getCampaignAction(c.id);
    if (r.ok) setC(r.campaign);
    return r;
  }, [c.id]);

  // ── Passo 1: lista ──────────────────────────────────────────────────────
  const [modo, setModo] = useState<"planilha" | "colados" | "contatos">(
    c.lista?.tipo === "colados" ? "colados" : c.lista?.tipo === "filtro" ? "contatos" : "planilha",
  );
  const [texto, setTexto] = useState("");
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [busca, setBusca] = useState("");
  const [tagFiltro, setTagFiltro] = useState("");
  const [tags, setTags] = useState<{ id: string; nome: string; count: number }[]>([]);
  const [resultados, setResultados] = useState<ContactPickerItem[]>([]);
  const [totalDoFiltro, setTotalDoFiltro] = useState(0);
  const [temMais, setTemMais] = useState(false);
  const [carregandoMais, setCarregandoMais] = useState(false);
  const [selecionandoTodos, setSelecionandoTodos] = useState(false);
  // Ids escolhidos. O nome só é conhecido de quem já apareceu na lista (os
  // vindos de "Selecionar todos" entram só pelo id).
  const [escolhidos, setEscolhidos] = useState<Set<string>>(new Set());
  const [nomes, setNomes] = useState<Map<string, string>>(new Map());
  const [regra, setRegra] = useState<string>(c.regraJaConversou);
  const [dias, setDias] = useState<number>(c.diasSemCampanha);
  const origemDaRegra = regra.startsWith("campanha:") ? regra.slice("campanha:".length) : "";
  const processando = c.lista?.estado === "processando";

  function guardarNomes(items: ContactPickerItem[]) {
    setNomes((m) => {
      const n = new Map(m);
      for (const r of items) n.set(r.id, r.nome);
      return n;
    });
  }

  useEffect(() => {
    if (modo !== "contatos" || tags.length) return;
    void tagsParaCampanhaAction().then(setTags);
  }, [modo, tags.length]);

  useEffect(() => {
    if (modo !== "contatos") return;
    let vivo = true;
    const t = setTimeout(async () => {
      const r = await listContactsForPickerAction({ search: busca, tag: tagFiltro });
      if (!vivo) return;
      setResultados(r.items);
      setTotalDoFiltro(r.total);
      setTemMais(r.temMais);
      guardarNomes(r.items);
    }, 250);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [busca, tagFiltro, modo]);

  async function carregarMais() {
    setCarregandoMais(true);
    try {
      const r = await listContactsForPickerAction({ search: busca, tag: tagFiltro }, resultados.length);
      setResultados((atual) => [...atual, ...r.items]);
      setTotalDoFiltro(r.total);
      setTemMais(r.temMais);
      guardarNomes(r.items);
    } finally {
      setCarregandoMais(false);
    }
  }

  async function selecionarTodosDoFiltro() {
    setSelecionandoTodos(true);
    try {
      const r = await idsParaCampanhaAction({ search: busca, tag: tagFiltro });
      if (!r.ok) return void toast.error("Não deu para selecionar todos", { description: r.error });
      setEscolhidos((atual) => new Set([...atual, ...r.ids]));
    } finally {
      setSelecionandoTodos(false);
    }
  }

  function alternar(id: string, on: boolean) {
    setEscolhidos((atual) => {
      const n = new Set(atual);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  const chipsEscolhidos = [...escolhidos].filter((id) => nomes.has(id)).slice(0, 12);
  const todosDaTelaEscolhidos = resultados.length > 0 && resultados.every((r) => escolhidos.has(r.id));

  // Enquanto a lista monta em segundo plano, relê a cada 2 s.
  useEffect(() => {
    if (!processando) return;
    const id = setInterval(() => void recarregar(), 2000);
    return () => clearInterval(id);
  }, [processando, recarregar]);

  function enviarLista() {
    const fd = new FormData();
    fd.set("campaignId", c.id);
    if (modo === "planilha") {
      if (!arquivo) return toast.error("Escolha a planilha");
      fd.set("file", arquivo);
    } else if (modo === "colados") {
      if (!texto.trim()) return toast.error("Cole os números");
      fd.set("texto", texto);
    } else {
      if (escolhidos.size === 0) return toast.error("Escolha ao menos um contato");
      fd.set("contactIds", JSON.stringify([...escolhidos]));
    }
    start(async () => {
      const r = await uploadListAction(fd);
      if (r.ok) {
        setC(r.campaign);
        toast.success("Lista recebida. Checando WhatsApp e histórico…");
      } else toast.error("Lista recusada", { description: r.error });
    });
  }

  // A regra vale na hora (antes só salvava em "Continuar"; quem trocava e
  // pulava de passo pelo topo ficava com a regra antiga no servidor).
  function escolherRegra(v: string) {
    const antes = regra;
    setRegra(v);
    if (v === "campanha:") return; // escolheu "outra campanha" e ainda falta dizer qual
    start(async () => {
      const r = await saveStepAction(c.id, 1, { regraJaConversou: v, diasSemCampanha: dias });
      if (r.ok) setC(r.campaign);
      else {
        setRegra(antes);
        toast.error("Não salvou", { description: r.error });
      }
    });
  }

  function salvarRegraEContinuar() {
    start(async () => {
      const r = await saveStepAction(c.id, 1, { regraJaConversou: regra, diasSemCampanha: dias });
      if (r.ok) {
        setC(r.campaign);
        setEtapa(2);
      } else toast.error("Não salvou", { description: r.error });
    });
  }

  // ── Passo 2: mensagem ───────────────────────────────────────────────────
  const [mensagem, setMensagem] = useState(c.mensagem ?? "");
  const [variacoes, setVariacoes] = useState<string[]>(Array.isArray(c.variacoes) ? (c.variacoes as string[]) : []);
  const [retomada, setRetomada] = useState(c.textoRetomada ?? "");
  const [amostra, setAmostra] = useState<DestinatarioDTO[]>([]);
  const [previaDe, setPreviaDe] = useState<string>("");
  const [previa, setPrevia] = useState<{ texto: string | null; variacao: number | null } | null>(null);
  const mensagemRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (etapa !== 2) return;
    listarDestinatariosAction(c.id, { status: ["queued", "held"] }).then((r) => {
      if (r.ok) {
        setAmostra(r.pagina.items.slice(0, 8));
        setPreviaDe((atual) => atual || r.pagina.items[0]?.contactId || "");
      }
    });
  }, [etapa, c.id]);

  function inserirVariavel(ex: string) {
    const el = mensagemRef.current;
    if (!el) return setMensagem((m) => m + ex);
    const ini = el.selectionStart ?? mensagem.length;
    const fim = el.selectionEnd ?? mensagem.length;
    const nova = mensagem.slice(0, ini) + ex + mensagem.slice(fim);
    setMensagem(nova);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(ini + ex.length, ini + ex.length);
    });
  }

  function dadosDaMensagem(): Record<string, unknown> {
    const dados: Record<string, unknown> = { mensagem };
    const vs = variacoes.map((v) => v.trim()).filter(Boolean);
    if (vs.length) dados.variacoes = vs;
    if (regra === "retomada" && retomada.trim()) dados.textoRetomada = retomada.trim();
    return dados;
  }

  function salvarMensagem(eContinuar: boolean) {
    start(async () => {
      const r = await saveStepAction(c.id, 2, dadosDaMensagem());
      if (r.ok) {
        setC(r.campaign);
        if (eContinuar) setEtapa(3);
        else toast.success("Mensagem salva");
      } else toast.error("Mensagem recusada", { description: r.error });
    });
  }

  function verPrevia() {
    if (!previaDe) return;
    start(async () => {
      // Salva antes, para a prévia usar o texto atual.
      const s = await saveStepAction(c.id, 2, dadosDaMensagem());
      if (!s.ok) {
        toast.error("Mensagem recusada", { description: s.error });
        return;
      }
      setC(s.campaign);
      const r = await previewMessageAction(c.id, previaDe);
      if (r.ok) setPrevia({ texto: r.texto, variacao: r.variacao });
      else toast.error("Sem prévia", { description: r.error });
    });
  }

  // ── Passo 3: ritmo ──────────────────────────────────────────────────────
  const [ritmo, setRitmo] = useState({
    channelAccountId: c.channelAccountId ?? contas.find((x) => x.status === "connected")?.id ?? "",
    flowId: c.flowId ?? "",
    limiteDiario: c.limiteDiario ?? ("" as number | ""),
    janelaInicio: c.janelaInicio,
    janelaFim: c.janelaFim,
    pausaAlmocoInicio: c.pausaAlmocoInicio ?? "",
    pausaAlmocoFim: c.pausaAlmocoFim ?? "",
    intervaloMinM: segParaMin(c.intervaloMinS),
    intervaloMaxM: segParaMin(c.intervaloMaxS),
    loteTamanho: c.loteTamanho,
    pausaLoteMinM: c.pausaLoteMinM,
    pausaLoteMaxM: c.pausaLoteMaxM,
    freioSaidasPct: c.freioSaidasPct,
    freioFalhasSeq: c.freioFalhasSeq,
    iniciaEm: paraCampoDeData(c.iniciaEm),
  });
  // Campanha que já começou (pausada) não muda a data de início; agendada ainda muda.
  const iniciaEmEditavel = c.status === "draft" || c.status === "scheduled";
  const [previsao, setPrevisao] = useState<Previsao | null>(null);
  const setR = <K extends keyof typeof ritmo>(k: K, v: (typeof ritmo)[K]) => setRitmo((r) => ({ ...r, [k]: v }));

  function salvarRitmo(eContinuar: boolean) {
    if (!ritmo.channelAccountId) return toast.error("Escolha o número que envia");
    if (iniciaEmEditavel && ritmo.iniciaEm && ritmo.iniciaEm !== paraCampoDeData(c.iniciaEm) && new Date(ritmo.iniciaEm) < new Date()) return toast.error("A data de início já passou", { description: "Escolha uma data futura ou deixe vazio para começar na próxima janela." });
    start(async () => {
      const dados = {
        channelAccountId: ritmo.channelAccountId,
        flowId: ritmo.flowId || null,
        limiteDiario: ritmo.limiteDiario === "" ? null : Number(ritmo.limiteDiario),
        janelaInicio: ritmo.janelaInicio,
        janelaFim: ritmo.janelaFim,
        pausaAlmocoInicio: ritmo.pausaAlmocoInicio || null,
        pausaAlmocoFim: ritmo.pausaAlmocoFim || null,
        intervaloMinS: Math.round(Number(ritmo.intervaloMinM) * 60),
        intervaloMaxS: Math.round(Number(ritmo.intervaloMaxM) * 60),
        loteTamanho: Number(ritmo.loteTamanho),
        pausaLoteMinM: Number(ritmo.pausaLoteMinM),
        pausaLoteMaxM: Number(ritmo.pausaLoteMaxM),
        freioSaidasPct: Number(ritmo.freioSaidasPct),
        freioFalhasSeq: Number(ritmo.freioFalhasSeq),
        iniciaEm: !iniciaEmEditavel ? (c.iniciaEm ? new Date(c.iniciaEm).toISOString() : null) : ritmo.iniciaEm ? new Date(ritmo.iniciaEm).toISOString() : null,
      };
      const r = await saveStepAction(c.id, 3, dados);
      if (!r.ok) {
        toast.error("Ritmo recusado", { description: r.error });
        return;
      }
      setC(r.campaign);
      const e = await estimateAction(c.id);
      if (e.ok) setPrevisao(e.previsao);
      if (edicao && eContinuar) {
        toast.success("Alterações salvas", { description: "Valem quando você retomar a campanha." });
        router.push(`/campanhas/${c.id}`);
        router.refresh();
      } else if (eContinuar) setEtapa(4);
      else toast.success("Ritmo salvo");
    });
  }

  useEffect(() => {
    if (etapa === 4 && !previsao) estimateAction(c.id).then((e) => e.ok && setPrevisao(e.previsao));
  }, [etapa, previsao, c.id]);

  // ── Passo 4: revisar e iniciar ──────────────────────────────────────────
  const [motivos, setMotivos] = useState<string[]>([]);
  function iniciar() {
    start(async () => {
      const r = await startCampaignAction(c.id);
      if (r.ok) {
        toast.success(r.campaign.status === "scheduled" ? "Campanha agendada" : "Campanha iniciada");
        router.refresh();
      } else {
        setMotivos(r.motivos ?? []);
        toast.error("A campanha ainda não pode começar", { description: r.motivos?.join(" · ") ?? r.error });
      }
    });
  }

  const resumo = c.lista?.resumo;
  const x = numeros(c.contagem);
  const conta = contas.find((k) => k.id === (etapa >= 3 ? ritmo.channelAccountId : c.channelAccountId));
  const variacoesSalvas = Array.isArray(c.variacoes) ? (c.variacoes as string[]) : [];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        breadcrumb={[{ label: "Campanhas", href: "/campanhas" }]}
        title={c.nome}
        subtitle={<Passos atual={etapa} onIr={setEtapa} feitos={edicao ? 3 : feitos} bloqueados={edicao ? [1, 4] : []} />}
        actions={
          <Button variant="ghost" onClick={() => router.push(edicao ? `/campanhas/${c.id}` : "/campanhas")}>
            {edicao ? "Voltar para a campanha" : "Salvar rascunho e sair"}
          </Button>
        }
      />

      {edicao && (
        <p className="rounded-md border border-line bg-muted/40 px-4 py-3 text-small text-ink-2">
          Você está editando uma campanha {c.status === "paused" ? "pausada" : "agendada"}. Mudam a mensagem, o fluxo e o ritmo; a lista e quem já recebeu ficam como estão. As mudanças valem para os próximos envios, quando você retomar.
        </p>
      )}

      {/* ───────── 1 · Lista ───────── */}
      {etapa === 1 && (
        <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex flex-col gap-8">
            <section>
              <SectionHeader title="De onde vem a lista" />
              <div role="tablist" className="flex gap-6 border-b border-line">
                {(
                  [
                    ["planilha", "Planilha"],
                    ["colados", "Colar números"],
                    ["contatos", "Escolher contatos"],
                  ] as const
                ).map(([v, l]) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={modo === v}
                    onClick={() => setModo(v)}
                    className={cn("-mb-px h-10 border-b-2 text-body", modo === v ? "border-foreground font-medium text-foreground" : "border-transparent text-ink-2 hover:text-foreground")}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <div className="pt-5">
                {modo === "planilha" && (
                  <div className="flex flex-col gap-3">
                    <Label htmlFor="planilha">Planilha (.xlsx ou .csv) com uma coluna de telefone</Label>
                    <Input id="planilha" type="file" accept=".xlsx,.csv,.txt" onChange={(e) => setArquivo(e.target.files?.[0] ?? null)} disabled={!podeEditar} />
                    <p className="text-caption text-ink-3">Colunas reconhecidas: telefone/celular/whatsapp, nome, empresa, cidade. Até 5.000 linhas.</p>
                  </div>
                )}
                {modo === "colados" && (
                  <div className="flex flex-col gap-3">
                    <Label htmlFor="colados">Um número por linha, com o nome antes se tiver (“Ana Ferreira; 65 99999-0000”)</Label>
                    <Textarea id="colados" rows={8} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={"Ana Ferreira; 65 99999-0000\n66 99999-7705"} disabled={!podeEditar} />
                  </div>
                )}
                {modo === "contatos" && (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar contato por nome, empresa ou telefone" className="sm:flex-1" />
                      <Select value={tagFiltro || "__todas__"} onValueChange={(v) => setTagFiltro(v === "__todas__" ? "" : v)}>
                        <SelectTrigger className="h-9 sm:w-56" aria-label="Filtrar por tag">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__todas__">Todas as tags</SelectItem>
                          {tags.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.nome} <span className="num text-ink-3">({t.count})</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-small text-ink-2">
                      <span className="num">
                        {totalDoFiltro} {totalDoFiltro === 1 ? "contato" : "contatos"}
                        {resultados.length < totalDoFiltro ? `, mostrando ${resultados.length}` : ""}
                      </span>
                      <div className="flex items-center gap-3">
                        {escolhidos.size > 0 && (
                          <button type="button" onClick={() => setEscolhidos(new Set())} className="font-medium text-ink-2 hover:text-foreground hover:underline">
                            Limpar seleção
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void selecionarTodosDoFiltro()}
                          disabled={selecionandoTodos || totalDoFiltro === 0 || !podeEditar}
                          className="inline-flex items-center gap-1.5 font-medium text-brand-500 hover:underline disabled:text-ink-3 disabled:no-underline"
                        >
                          {selecionandoTodos ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          Selecionar todos os <span className="num">{totalDoFiltro}</span>
                        </button>
                      </div>
                    </div>
                    <div className="max-h-96 overflow-y-auto">
                      {resultados.length > 0 && (
                        <label className="flex cursor-pointer items-center gap-3 border-b border-line py-2.5 text-small text-ink-2">
                          <Checkbox
                            checked={todosDaTelaEscolhidos}
                            onCheckedChange={(v) =>
                              setEscolhidos((atual) => {
                                const n = new Set(atual);
                                for (const r of resultados) {
                                  if (v) n.add(r.id);
                                  else n.delete(r.id);
                                }
                                return n;
                              })
                            }
                            disabled={!podeEditar}
                          />
                          Marcar os que estão na lista
                        </label>
                      )}
                      {resultados.map((r) => (
                        <label key={r.id} className="flex cursor-pointer items-center gap-3 border-b border-line py-2.5 text-body">
                          <Checkbox checked={escolhidos.has(r.id)} onCheckedChange={(v) => alternar(r.id, v === true)} disabled={!podeEditar} />
                          <span className="min-w-0 flex-1 truncate">{r.nome}</span>
                          <span className="num text-small text-ink-2">{formatPhone(r.telefone)}</span>
                        </label>
                      ))}
                      {resultados.length === 0 && <p className="py-6 text-center text-small text-ink-3">Nenhum contato com esse filtro.</p>}
                      {temMais && (
                        <div className="flex justify-center py-3">
                          <Button variant="outline" size="sm" onClick={() => void carregarMais()} disabled={carregandoMais}>
                            {carregandoMais ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                            Carregar mais
                          </Button>
                        </div>
                      )}
                    </div>
                    {escolhidos.size > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 text-small text-ink-2">
                        <span className="num">{escolhidos.size} escolhidos:</span>
                        {chipsEscolhidos.map((id) => (
                            <span key={id} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-caption">
                              {nomes.get(id)}
                              <button type="button" aria-label={`Tirar ${nomes.get(id)}`} onClick={() => alternar(id, false)}>
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                        {escolhidos.size > chipsEscolhidos.length && <span className="num text-caption text-ink-3">e mais {escolhidos.size - chipsEscolhidos.length}</span>}
                      </div>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-3 pt-5">
                  <Button onClick={enviarLista} disabled={pending || processando || !podeEditar} variant={resumo ? "outline" : "default"}>
                    {pending || processando ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {processando ? "Checando a lista…" : resumo ? "Trocar a lista" : "Checar a lista"}
                  </Button>
                  <span className="text-caption text-ink-3">Nada é enviado nesta etapa.</span>
                </div>
              </div>
            </section>

            {c.lista?.estado === "erro" && (
              <p className="flex items-start gap-2 text-small text-danger-500">
                <StatusDot tone="error" className="mt-[3px]" />
                {c.lista.erro ?? "A lista não pôde ser montada."}
              </p>
            )}

            {resumo && (
              <section>
                <SectionHeader title="O que a checagem achou" aside={<span className="num">{resumo.linhas} linhas na lista</span>} />
                <div className="grid grid-cols-4 border-b border-line">
                  <Num label="Na fila" valor={resumo.fila} tom="ok" />
                  <Num label="Segurados" valor={resumo.segurados} tom={resumo.segurados ? "attention" : undefined} />
                  <Num label="Pulados" valor={resumo.pulados} />
                  <Num label="Sem WhatsApp" valor={resumo.semWhatsApp} tom={resumo.semWhatsApp ? "error" : undefined} />
                </div>
                <dl className="grid grid-cols-2 gap-x-8 pt-3 text-small text-ink-2 sm:grid-cols-3">
                  <div className="num flex justify-between py-1.5">
                    <dt>Inválidos</dt>
                    <dd>{resumo.invalidos}</dd>
                  </div>
                  <div className="num flex justify-between py-1.5">
                    <dt>Duplicados</dt>
                    <dd>{resumo.duplicados}</dd>
                  </div>
                  <div className="num flex justify-between py-1.5">
                    <dt>Contatos novos criados</dt>
                    <dd>{resumo.contatosNovos}</dd>
                  </div>
                  {Object.entries(resumo.porMotivo).map(([m, n]) => (
                    <div key={m} className="num flex justify-between py-1.5">
                      <dt className="truncate pr-2">{m}</dt>
                      <dd>{n}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </div>

          <aside className="flex flex-col gap-8">
            <section>
              <SectionHeader variant="aside" title="Quem já conversou com você" />
              <div className="flex flex-col gap-3 pt-4">
                {(
                  [
                    ["hold", "Segurar para revisão", "fica de fora até você liberar"],
                    ["skip", "Pular", "não recebe esta campanha"],
                    ["retomada", "Mandar texto de retomada", "uma mensagem diferente, escrita no passo 2"],
                    ["campanha", "Recebeu mensagem em outra campanha", "pula quem já recebeu a mensagem dela, tenha chegado ou não"],
                    ["enviar", "Nenhuma", "recebe a mesma mensagem dos outros"],
                  ] as const
                ).map(([v, l, d]) => (
                  <div key={v}>
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="radio"
                        name="regra"
                        value={v}
                        checked={v === "campanha" ? regra.startsWith("campanha:") : regra === v}
                        onChange={() => escolherRegra(v === "campanha" ? `campanha:${origemDaRegra}` : v)}
                        className="mt-1 accent-brand-500"
                        disabled={!podeEditar}
                      />
                      <span>
                        <span className="block text-body">{l}</span>
                        <span className="block text-caption text-ink-3">{d}</span>
                      </span>
                    </label>
                    {v === "campanha" && regra.startsWith("campanha:") && (
                      <div className="pl-7 pt-2">
                        <Select value={origemDaRegra} onValueChange={(id) => escolherRegra(`campanha:${id}`)} disabled={!podeEditar}>
                          <SelectTrigger className="h-9" aria-label="Campanha">
                            <SelectValue placeholder="Escolha a campanha" />
                          </SelectTrigger>
                          <SelectContent>
                            {outras.map((o) => (
                              <SelectItem key={o.id} value={o.id}>
                                {o.nome} <span className="num text-ink-3">({o.enviados} enviadas)</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {outras.length === 0 && <p className="pt-1.5 text-caption text-ink-3">Você ainda não tem outra campanha.</p>}
                        <p className="pt-1.5 text-caption text-ink-3">Vale quem tinha mensagem enviada até a hora de iniciar. Quem não chegou a receber continua nesta campanha.</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
            <section>
              <SectionHeader variant="aside" title="Campanha recente" />
              <div className="flex items-center gap-3 pt-4 text-body">
                <span>Pular quem recebeu campanha há menos de</span>
                <Input type="number" min={0} max={365} value={dias} onChange={(e) => setDias(Number(e.target.value))} className="w-20" disabled={!podeEditar} />
                <span>dias</span>
              </div>
            </section>
            <div className="flex justify-end gap-2 border-t border-line pt-5">
              <Button onClick={salvarRegraEContinuar} disabled={pending || !resumo || processando || !podeEditar || regra === "campanha:"}>
                Continuar para a mensagem
              </Button>
            </div>
          </aside>
        </div>
      )}

      {/* ───────── 2 · Mensagem ───────── */}
      {etapa === 2 && (
        <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex flex-col gap-8">
            <section>
              <SectionHeader title="Mensagem" aside={<span className="num">{mensagem.length}/1000</span>} />
              <div className="flex flex-wrap items-center gap-1.5 pt-4">
                <span className="mr-1 text-small text-ink-3">Inserir</span>
                {VARIAVEIS.map((v) => (
                  <button key={v.label} type="button" onClick={() => inserirVariavel(v.exemplo)} className="rounded bg-muted px-2 py-1 text-caption font-medium text-ink-2 hover:bg-brand-100 hover:text-brand-500" disabled={!podeEditar}>
                    {v.label}
                  </button>
                ))}
              </div>
              <Textarea ref={mensagemRef} value={mensagem} onChange={(e) => setMensagem(e.target.value)} rows={7} className="mt-3" placeholder="{saudacao}, {primeiro_nome|tudo bem}? Aqui é o Marcos, da Agro Demo…" disabled={!podeEditar} />
              <p className="pt-2 text-caption text-ink-3">
                Só link de vídeo do YouTube ou do Instagram na primeira mensagem (outros links parecem spam para o WhatsApp); o WhatsApp mostra a capa do vídeo. O que vem depois de “|” é o texto usado quando o dado falta. As linhas em branco que você deixa saem do mesmo jeito. Use *negrito*, _itálico_ e ~riscado~ como no WhatsApp.
              </p>
            </section>

            <section>
              <SectionHeader
                title="Variações"
                aside={
                  variacoes.length < 5 && podeEditar ? (
                    <button type="button" onClick={() => setVariacoes((v) => [...v, ""])} className="font-medium text-brand-500 hover:underline">
                      + Adicionar variação
                    </button>
                  ) : undefined
                }
              />
              <p className="pt-3 text-small text-ink-2">Cada contato recebe uma das versões, sorteada. Textos diferentes deixam a conversa mais natural.</p>
              <div className="flex flex-col gap-3 pt-3">
                {variacoes.map((v, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="num mt-2 w-5 text-small text-ink-3">{String.fromCharCode(66 + i)}</span>
                    <Textarea value={v} onChange={(e) => setVariacoes((vs) => vs.map((x2, j) => (j === i ? e.target.value : x2)))} rows={3} disabled={!podeEditar} />
                    <Button variant="ghost" size="icon-sm" aria-label="Tirar variação" onClick={() => setVariacoes((vs) => vs.filter((_, j) => j !== i))} disabled={!podeEditar}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </section>

            {regra === "retomada" && (
              <section>
                <SectionHeader title="Texto de retomada" aside={<span>para quem já conversou com você</span>} />
                <Textarea value={retomada} onChange={(e) => setRetomada(e.target.value)} rows={4} className="mt-4" placeholder="{saudacao}, {primeiro_nome}! Faz um tempo que a gente conversou…" disabled={!podeEditar} />
              </section>
            )}

            <div className="flex justify-between gap-2 border-t border-line pt-5">
              {edicao ? (
                <Button variant="ghost" onClick={() => router.push(`/campanhas/${c.id}`)}>
                  Cancelar
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => setEtapa(1)}>
                  Voltar
                </Button>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => salvarMensagem(false)} disabled={pending || !mensagem.trim() || !podeEditar}>
                  Salvar
                </Button>
                <Button onClick={() => salvarMensagem(true)} disabled={pending || !mensagem.trim() || !podeEditar}>
                  Continuar para o ritmo
                </Button>
              </div>
            </div>
          </div>

          <aside className="flex flex-col gap-6">
            <section>
              <SectionHeader variant="aside" title="Prévia com um contato real" />
              <div className="flex flex-col gap-3 pt-4">
                <Select value={previaDe} onValueChange={setPreviaDe}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Escolha um contato da lista" />
                  </SelectTrigger>
                  <SelectContent>
                    {amostra.map((d) => (
                      <SelectItem key={d.contactId} value={d.contactId}>
                        {d.nome}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" onClick={verPrevia} disabled={pending || !previaDe || !mensagem.trim()}>
                  Ver como ele recebe
                </Button>
                {previa && (
                  <div className="rounded-md border border-line bg-muted/40 p-4">
                    {previa.texto ? (
                      <>
                        <BalaoWhatsApp texto={previa.texto} />
                        {/https?:\/\//i.test(previa.texto) && <p className="pt-2 text-caption text-ink-3">No WhatsApp, o cartão com a capa do vídeo aparece acima do link.</p>}
                      </>
                    ) : (
                      <p className="text-small text-ink-2">Este contato fica segurado: já conversou com você e a regra é retomada sem texto.</p>
                    )}
                    {previa.variacao !== null && <p className="num pt-2 text-caption text-ink-3">variação {String.fromCharCode(65 + previa.variacao)}</p>}
                  </div>
                )}
              </div>
            </section>
          </aside>
        </div>
      )}

      {/* ───────── 3 · Ritmo ───────── */}
      {etapa === 3 && (
        <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex flex-col gap-8">
            <section>
              <SectionHeader title="Número que envia" />
              <div className="grid gap-4 pt-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Conta de WhatsApp</Label>
                  <Select value={ritmo.channelAccountId} onValueChange={(v) => setR("channelAccountId", v)} disabled={!podeEditar || edicao}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Escolha o número" />
                    </SelectTrigger>
                    <SelectContent>
                      {contas.map((k) => (
                        <SelectItem key={k.id} value={k.id}>
                          {k.label}
                          {k.status !== "connected" ? " · desconectado" : k.paused ? " · pausado" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {contas.length === 0 && <p className="text-caption text-danger-500">Nenhum WhatsApp conectado. Conecte em Integrações.</p>}
                  {edicao && <p className="text-caption text-ink-3">O número não muda com a campanha em andamento: a checagem do histórico da lista foi feita por ele.</p>}
                </div>
                <div className="grid gap-1.5">
                  <Label>Limite por dia</Label>
                  <Input type="number" min={1} max={1000} value={ritmo.limiteDiario} onChange={(e) => setR("limiteDiario", e.target.value === "" ? "" : Number(e.target.value))} placeholder="pelo aquecimento do número" disabled={!podeEditar} />
                  <p className="text-caption text-ink-3">Preenchido, vale este número no lugar do aquecimento. Vazio = o aquecimento do número decide.</p>
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label>Quando alguém responder, entra no fluxo</Label>
                  <Select value={ritmo.flowId || "__none__"} onValueChange={(v) => setR("flowId", v === "__none__" ? "" : v)} disabled={!podeEditar}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Nenhum fluxo</SelectItem>
                      {fluxos.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.nome}
                          {f.status !== "active" ? ` · ${f.status}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>

            {iniciaEmEditavel && (
            <section>
              <SectionHeader title="Início da campanha" />
              <div className="grid gap-4 pt-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="inicia-em">Começar em</Label>
                  <div className="flex items-center gap-2">
                    <Input id="inicia-em" type="datetime-local" min={paraCampoDeData(new Date())} value={ritmo.iniciaEm} onChange={(e) => setR("iniciaEm", e.target.value)} disabled={!podeEditar} />
                    {ritmo.iniciaEm && podeEditar && (
                      <Button variant="ghost" size="icon-sm" aria-label="Tirar a data de início" onClick={() => setR("iniciaEm", "")}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <p className="text-caption text-ink-3">Nada sai antes desta data. Vazio = começa na próxima janela de horário.</p>
                </div>
              </div>
            </section>
            )}

            <section>
              <SectionHeader title="Janela de horário" aside={<span>dias úteis, sem feriado</span>} />
              <div className="grid gap-4 pt-4 sm:grid-cols-4">
                <div className="grid gap-1.5">
                  <Label>Começa</Label>
                  <Input type="time" value={ritmo.janelaInicio} onChange={(e) => setR("janelaInicio", e.target.value)} disabled={!podeEditar} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Pausa do almoço</Label>
                  <Input type="time" value={ritmo.pausaAlmocoInicio} onChange={(e) => setR("pausaAlmocoInicio", e.target.value)} disabled={!podeEditar} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Volta</Label>
                  <Input type="time" value={ritmo.pausaAlmocoFim} onChange={(e) => setR("pausaAlmocoFim", e.target.value)} disabled={!podeEditar} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Termina</Label>
                  <Input type="time" value={ritmo.janelaFim} onChange={(e) => setR("janelaFim", e.target.value)} disabled={!podeEditar} />
                </div>
              </div>
            </section>

            <section>
              <SectionHeader title="Ritmo entre mensagens" />
              <div className="grid gap-4 pt-4 sm:grid-cols-3">
                <div className="grid gap-1.5">
                  <Label>Intervalo (minutos)</Label>
                  <div className="flex items-center gap-2">
                    <Input type="number" min={0.5} max={60} step={0.5} value={ritmo.intervaloMinM} onChange={(e) => setR("intervaloMinM", Number(e.target.value))} disabled={!podeEditar} />
                    <span className="text-ink-3">a</span>
                    <Input type="number" min={0.5} max={60} step={0.5} value={ritmo.intervaloMaxM} onChange={(e) => setR("intervaloMaxM", Number(e.target.value))} disabled={!podeEditar} />
                  </div>
                  <p className="text-caption text-ink-3">Sorteado a cada envio, com “digitando…” antes. Mínimo de meio minuto.</p>
                </div>
                <div className="grid gap-1.5">
                  <Label>Lote</Label>
                  <Input type="number" min={1} max={50} value={ritmo.loteTamanho} onChange={(e) => setR("loteTamanho", Number(e.target.value))} disabled={!podeEditar} />
                  <p className="text-caption text-ink-3">Mensagens seguidas antes de uma pausa.</p>
                </div>
                <div className="grid gap-1.5">
                  <Label>Pausa entre lotes (minutos)</Label>
                  <div className="flex items-center gap-2">
                    <Input type="number" min={1} max={240} value={ritmo.pausaLoteMinM} onChange={(e) => setR("pausaLoteMinM", Number(e.target.value))} disabled={!podeEditar} />
                    <span className="text-ink-3">a</span>
                    <Input type="number" min={1} max={240} value={ritmo.pausaLoteMaxM} onChange={(e) => setR("pausaLoteMaxM", Number(e.target.value))} disabled={!podeEditar} />
                  </div>
                </div>
              </div>
            </section>

            <section>
              <SectionHeader title="Freios automáticos" aside={<span>a campanha pausa sozinha</span>} />
              <div className="grid gap-4 pt-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Pedidos de saída acima de (%)</Label>
                  <Input type="number" min={1} max={50} value={ritmo.freioSaidasPct} onChange={(e) => setR("freioSaidasPct", Number(e.target.value))} disabled={!podeEditar} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Falhas seguidas</Label>
                  <Input type="number" min={1} max={50} value={ritmo.freioFalhasSeq} onChange={(e) => setR("freioFalhasSeq", Number(e.target.value))} disabled={!podeEditar} />
                </div>
              </div>
            </section>

            <div className="flex justify-between gap-2 border-t border-line pt-5">
              <Button variant="ghost" onClick={() => setEtapa(2)}>
                Voltar
              </Button>
              <div className="flex gap-2">
                {!edicao && (
                  <Button variant="outline" onClick={() => salvarRitmo(false)} disabled={pending || !podeEditar}>
                    Salvar
                  </Button>
                )}
                <Button onClick={() => salvarRitmo(true)} disabled={pending || !podeEditar}>
                  {edicao ? "Salvar e voltar" : "Revisar e iniciar"}
                </Button>
              </div>
            </div>
          </div>

          <aside className="flex flex-col gap-6">
            <section>
              <SectionHeader variant="aside" title="Previsão" />
              {previsao ? (
                <dl className="pt-3 text-small">
                  <Linha k="Na fila" v={previsao.naFila} />
                  <Linha k="Por dia" v={previsao.porDia} />
                  {previsao.tetoDaConta !== null && !c.limiteDiario && previsao.porDia === previsao.tetoDaConta && (
                    <p className="pt-2 text-caption text-warning-500">
                      Sem limite por dia na campanha, vale o aquecimento do número: até {previsao.tetoDaConta} por dia hoje. Preencha o limite por dia para usar o seu número.
                    </p>
                  )}
                  <Linha k="Dias úteis" v={previsao.dias} />
                  <Linha k="Termina" v={quando(previsao.terminoPrevisto)} />
                </dl>
              ) : (
                <p className="pt-4 text-small text-ink-2">Salve o ritmo para ver quando termina.</p>
              )}
            </section>
          </aside>
        </div>
      )}

      {/* ───────── 4 · Revisar ───────── */}
      {etapa === 4 && (
        <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex flex-col gap-8">
            <section>
              <SectionHeader
                title="Lista"
                aside={
                  <button type="button" className="font-medium text-brand-500 hover:underline" onClick={() => setEtapa(1)}>
                    Editar
                  </button>
                }
              />
              <div className="grid grid-cols-4 border-b border-line">
                <Num label="Na fila" valor={x.naFila} tom="ok" />
                <Num label="Segurados" valor={x.segurados} tom={x.segurados ? "attention" : undefined} />
                <Num label="Pulados" valor={x.pulados} />
                <Num label="Já conversou" valor={rotuloDaRegra(regra, outras)} />
              </div>
            </section>
            <section>
              <SectionHeader
                title="Mensagem"
                aside={
                  <button type="button" className="font-medium text-brand-500 hover:underline" onClick={() => setEtapa(2)}>
                    Editar
                  </button>
                }
              />
              <div className="pt-4">
                <BalaoWhatsApp texto={c.mensagem ?? ""} />
              </div>
              {variacoesSalvas.length > 0 && (
                <p className="num pt-2 text-caption text-ink-3">
                  + {variacoesSalvas.length} {variacoesSalvas.length === 1 ? "variação" : "variações"}
                </p>
              )}
            </section>
            <section>
              <SectionHeader
                title="Ritmo"
                aside={
                  <button type="button" className="font-medium text-brand-500 hover:underline" onClick={() => setEtapa(3)}>
                    Editar
                  </button>
                }
              />
              <dl className="grid grid-cols-1 gap-x-8 pt-2 text-small sm:grid-cols-2">
                <Linha k="Número" v={conta?.label ?? "—"} />
                <Linha k="Janela" v={c.pausaAlmocoInicio ? `${c.janelaInicio} a ${c.pausaAlmocoInicio} e ${c.pausaAlmocoFim} a ${c.janelaFim}` : `${c.janelaInicio} a ${c.janelaFim}`} />
                <Linha k="Intervalo" v={intervaloLegivel(c.intervaloMinS, c.intervaloMaxS)} />
                <Linha k="Lote" v={`${c.loteTamanho} · pausa de ${c.pausaLoteMinM} a ${c.pausaLoteMaxM} min`} />
                <Linha k="Limite por dia" v={c.limiteDiario ? c.limiteDiario : "aquecimento"} />
                <Linha k="Freios" v={`saída > ${c.freioSaidasPct}% · ${c.freioFalhasSeq} falhas`} />
                <Linha k="Fluxo na resposta" v={fluxos.find((f) => f.id === c.flowId)?.nome ?? "nenhum"} />
                <Linha k="Começa" v={c.iniciaEm ? quando(c.iniciaEm, true) : "na próxima janela"} />
              </dl>
            </section>
            {motivos.length > 0 && (
              <section className="rounded-md border border-line p-4">
                <p className="text-body font-medium">Antes de iniciar, resolva:</p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {motivos.map((m) => (
                    <li key={m} className="flex items-start gap-2 text-small text-ink-2">
                      <StatusDot tone="attention" className="mt-[3px]" />
                      {m}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <aside className="flex flex-col gap-6">
            <section>
              <SectionHeader variant="aside" title="Previsão" />
              {previsao ? (
                <dl className="pt-3 text-small">
                  <Linha k="Na fila" v={previsao.naFila} />
                  <Linha k="Por dia" v={previsao.porDia} />
                  {previsao.tetoDaConta !== null && !c.limiteDiario && previsao.porDia === previsao.tetoDaConta && (
                    <p className="pt-2 text-caption text-warning-500">
                      Sem limite por dia na campanha, vale o aquecimento do número: até {previsao.tetoDaConta} por dia hoje. Preencha o limite por dia para usar o seu número.
                    </p>
                  )}
                  <Linha k="Termina" v={quando(previsao.terminoPrevisto)} />
                </dl>
              ) : (
                <p className="pt-4 text-small text-ink-2">Calculando…</p>
              )}
            </section>
            <div className="flex flex-col gap-2 border-t border-line pt-5">
              <Button onClick={iniciar} disabled={pending || !podeEditar}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {c.iniciaEm && new Date(c.iniciaEm) > new Date() ? "Agendar campanha" : "Iniciar campanha"}
              </Button>
              <p className="text-caption text-ink-3">Nada sai fora da janela. Você pode pausar a qualquer momento.</p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
