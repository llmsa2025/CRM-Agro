"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { FiltroVendedor, type PessoaLite } from "@/components/escopo/filtro-vendedor";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Copy,
  Loader2,
  MoreVertical,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Send,
  Trash2,
  FileText,
  UserRoundCheck,
  UserRoundPen,
  X,
} from "lucide-react";
import {
  addStageAction,
  createDealAction,
  dealDetailAction,
  deleteDealAction,
  deleteStageAction,
  duplicateDealAction,
  transferirNegocioAction,
  duplicateStageAction,
  moveDealAction,
  renameStageAction,
  searchDealContactsAction,
  addDealNoteAction,
  sendDealMediaAction,
  updateDealAction,
  type DealDetailDTO,
  type DealContactItem,
  listFunnelDealsAction,
} from "../actions";
import { AudioPlayer } from "@/components/audio-player";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusDot } from "@/components/ui/status-dot";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatBRLCompact, relativeTime, daysLabel } from "@/lib/format";

type Deal = {
  id: string;
  valor: string;
  enteredStageAt: string;
  contact: { id: string; nome: string; empresa: string | null };
};
// Etapa paginada (item 2.4): `deals` é a página carregada; `total`/`valor`
// vêm do banco; `nextCursor` = tem mais para "Carregar mais".
type Stage = { id: string; nome: string; cor: string | null; total: number; valor: number; nextCursor: string | null; deals: Deal[] };
type Fechados = { won: { total: number; valor: number }; lost: { total: number; valor: number } };
type Funnel = { id: string; nome: string; stages: Stage[]; fechados: Fechados };

const STALE_DAYS = 7;

function isStale(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() > STALE_DAYS * 86400_000;
}

/** Pessoas para "Transferir para" no menu do card (F3d; vazio = não é administrador). */
const TransferirPara = createContext<PessoaLite[]>([]);

type AcaoDoCard = "duplicate" | "delete" | { transferir: PessoaLite };

function DealCard({
  deal,
  overlay,
  onAction,
  onOpen,
}: {
  deal: Deal;
  overlay?: boolean;
  onAction?: (a: AcaoDoCard, deal: Deal) => void;
  onOpen?: (deal: Deal) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: deal.id });
  const transferirPara = useContext(TransferirPara);
  const stale = isStale(deal.enteredStageAt);
  return (
    <div
      ref={setNodeRef}
      onClick={() => !overlay && onOpen?.(deal)}
      className={[
        "group relative rounded-md border border-line bg-background p-3.5 transition-colors hover:border-line-strong",
        overlay ? "cursor-grabbing shadow-popover" : "cursor-pointer",
        isDragging && !overlay ? "opacity-40" : "",
      ].join(" ")}
      {...attributes}
      {...listeners}
    >
      {!overlay && onAction && (
        <div
          className="absolute right-1 top-1 opacity-0 transition-opacity group-hover:opacity-100"
          // impede que o clique/arraste no menu inicie o drag OU abra o modal do card
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost-subtle" size="icon-sm" className="h-6 w-6" aria-label="Ações do card">
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem asChild>
                <Link href={`/contatos/${deal.contact.id}`}>
                  <UserRoundPen className="mr-2 h-4 w-4" />
                  Editar contato
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAction("duplicate", deal)}>
                <Copy className="mr-2 h-4 w-4" />
                Duplicar
              </DropdownMenuItem>
              {transferirPara.length > 0 && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <UserRoundCheck className="mr-2 h-4 w-4" />
                    Transferir para
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {transferirPara.map((p) => (
                      <DropdownMenuItem key={p.id} onSelect={() => onAction({ transferir: p }, deal)}>
                        {p.nome}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-danger-700 focus:bg-danger-100"
                onSelect={() => onAction("delete", deal)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Excluir
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div className="pr-5 text-body font-medium leading-tight">{deal.contact.nome}</div>
      <div className="mt-0.5 truncate text-small text-ink-2">{deal.contact.empresa ?? "—"}</div>
      <div className="num mt-3 flex items-center justify-between gap-2 text-small">
        {stale ? (
          <StatusDot tone="attention">Parado há {daysLabel(deal.enteredStageAt)}</StatusDot>
        ) : (
          <span className="text-ink-3">{daysLabel(deal.enteredStageAt)}</span>
        )}
        <span className="font-medium text-foreground">
          {Number(deal.valor) > 0 ? formatBRLCompact(Number(deal.valor)) : <span className="font-normal text-ink-3">sem valor</span>}
        </span>
      </div>
    </div>
  );
}

function StageColumn({
  stage,
  index,
  onAddDeal,
  onDealAction,
  onStageAction,
  onOpenDeal,
  onLoadMore,
  loadingMore,
}: {
  stage: Stage;
  index: number;
  onAddDeal: (stageId: string) => void;
  onDealAction: (a: AcaoDoCard, deal: Deal) => void;
  onStageAction: (a: "rename" | "duplicate" | "delete", stage: Stage) => void;
  onOpenDeal: (deal: Deal) => void;
  onLoadMore: (stageId: string) => void;
  loadingMore: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = stage.valor;
  const restantes = Math.max(0, stage.total - stage.deals.length);
  void index;

  return (
    <div
      ref={setNodeRef}
      className={[
        // Altura pela viewport: a LISTA de cards rola por dentro da coluna.
        "flex h-[calc(100vh-15rem)] w-[268px] shrink-0 flex-col rounded-md transition-colors",
        isOver ? "bg-brand-100/50" : "",
      ].join(" ")}
    >
      <div className="group/col flex h-9 items-center gap-2 border-b border-line pb-2">
        <span className="text-body font-semibold">{stage.nome}</span>
        <span className="num text-small text-ink-3">{stage.total}</span>
        <span className="num ml-auto text-small text-ink-2">{total > 0 ? formatBRLCompact(total) : ""}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="h-6 w-6 text-ink-3 opacity-0 group-hover/col:opacity-100 data-[state=open]:opacity-100" aria-label="Ações da etapa">
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onSelect={() => onStageAction("rename", stage)}>
              <Pencil className="mr-2 h-4 w-4" />
              Renomear
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onStageAction("duplicate", stage)}>
              <Copy className="mr-2 h-4 w-4" />
              Duplicar
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-danger-700 focus:bg-danger-100"
              onSelect={() => onStageAction("delete", stage)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Excluir etapa
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex min-h-[40px] flex-1 flex-col gap-2 overflow-y-auto pt-3">
        {stage.deals.map((d) => (
          <DealCard key={d.id} deal={d} onAction={onDealAction} onOpen={onOpenDeal} />
        ))}
        {stage.nextCursor && restantes > 0 && (
          <button
            type="button"
            onClick={() => onLoadMore(stage.id)}
            disabled={loadingMore}
            className="num flex shrink-0 items-center justify-center rounded-md border border-line py-1.5 text-small text-ink-2 transition-colors hover:text-foreground disabled:opacity-60"
          >
            {loadingMore ? "Carregando…" : `Carregar mais · ${restantes} ${restantes === 1 ? "restante" : "restantes"}`}
          </button>
        )}
        <button
          onClick={() => onAddDeal(stage.id)}
          className="flex shrink-0 items-center gap-1 self-start rounded-md px-1 py-1 text-small text-ink-3 transition-colors hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          Negócio
        </button>
      </div>
    </div>
  );
}

export function KanbanBoard({
  funnel: funnelProp,
  pessoas = [],
  transferirPara = [],
  dono,
}: {
  funnel: Funnel;
  /** "Por vendedor" (F3d): a equipe, só para quem vê o time todo. */
  pessoas?: PessoaLite[];
  /** "Transferir para" nos cards (só o administrador). */
  transferirPara?: PessoaLite[];
  /** Vendedor filtrado (o "carregar mais" usa o mesmo filtro). */
  dono?: string;
}) {
  const router = useRouter();

  // Páginas extras por etapa ("Carregar mais"). Cada `router.refresh()` traz um
  // `funnel` novo do servidor e zera as extras — a primeira página volta fresca.
  const [extras, setExtras] = useState<Record<string, { deals: Deal[]; nextCursor: string | null }>>({});
  const [carregandoMais, setCarregandoMais] = useState<string | null>(null);
  useEffect(() => setExtras({}), [funnelProp]);
  const funnel = useMemo<Funnel>(
    () => ({
      ...funnelProp,
      stages: funnelProp.stages.map((s) => {
        const ex = extras[s.id];
        if (!ex) return s;
        const vistos = new Set(s.deals.map((d) => d.id));
        return { ...s, nextCursor: ex.nextCursor, deals: [...s.deals, ...ex.deals.filter((d) => !vistos.has(d.id))] };
      }),
    }),
    [funnelProp, extras],
  );

  async function carregarMais(stageId: string) {
    const stage = funnel.stages.find((s) => s.id === stageId);
    if (!stage?.nextCursor || carregandoMais) return;
    setCarregandoMais(stageId);
    try {
      const pagina = await listFunnelDealsAction(funnel.id, { stageId, cursor: stage.nextCursor, ...(dono ? { dono } : {}) });
      setExtras((e) => ({
        ...e,
        [stageId]: {
          deals: [...(e[stageId]?.deals ?? []), ...pagina.items.map((d) => ({ id: d.id, valor: d.valor, enteredStageAt: d.enteredStageAt, contact: d.contact }))],
          nextCursor: pagina.nextCursor,
        },
      }));
    } catch {
      toast.error("Não consegui carregar mais negócios");
    } finally {
      setCarregandoMais(null);
    }
  }
  const [pending, startTransition] = useTransition();
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [dealModal, setDealModal] = useState<Deal | null>(null);

  // Diálogo "novo negócio" — controlado; abre pré-selecionando a etapa clicada.
  const [dealOpen, setDealOpen] = useState(false);
  const [presetStage, setPresetStage] = useState<string | undefined>();

  // Diálogo "renomear etapa".
  const [renaming, setRenaming] = useState<Stage | null>(null);
  const [renameVal, setRenameVal] = useState("");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Filtra os cards por nome/empresa (busca retrátil).
  const stages = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return funnel.stages;
    return funnel.stages.map((s) => ({
      ...s,
      deals: s.deals.filter(
        (d) =>
          d.contact.nome.toLowerCase().includes(term) ||
          (d.contact.empresa ?? "").toLowerCase().includes(term),
      ),
    }));
  }, [funnel.stages, q]);

  function onDragStart(event: DragStartEvent) {
    const deal = funnel.stages.flatMap((s) => s.deals).find((d) => d.id === event.active.id);
    setActiveDeal(deal ?? null);
  }

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveDeal(null);
    if (!over || active.id === over.id) return;
    const dealId = String(active.id);
    const toStageId = String(over.id);
    const fromStage = funnel.stages.find((s) => s.deals.some((d) => d.id === dealId));
    if (fromStage?.id === toStageId) return;
    const toStage = funnel.stages.find((s) => s.id === toStageId);
    const deal = fromStage?.deals.find((d) => d.id === dealId);
    const dealName = deal?.contact.nome ?? "Negócio";
    try {
      await moveDealAction(dealId, toStageId);
      router.refresh();
      toast.success(`${dealName} movido para ${toStage?.nome ?? "?"}`, {
        description: `De ${fromStage?.nome ?? "?"}`,
        action: fromStage
          ? {
              label: "Desfazer",
              onClick: async () => {
                await moveDealAction(dealId, fromStage.id);
                router.refresh();
              },
            }
          : undefined,
      });
    } catch {
      toast.error("Não foi possível mover o negócio.");
    }
  }

  function openNewDeal(stageId?: string) {
    setPresetStage(stageId);
    setDealOpen(true);
  }

  function onDealAction(a: AcaoDoCard, deal: Deal) {
    startTransition(async () => {
      if (typeof a === "object") {
        if (!confirm(`Transferir o negócio de ${deal.contact.nome} para ${a.transferir.nome}?`)) return;
        const res = await transferirNegocioAction(funnel.id, deal.id, a.transferir.id);
        toast[res.ok ? "success" : "error"](res.ok ? `Negócio agora com ${a.transferir.nome}` : "Não deu para transferir", { description: res.error });
      } else if (a === "duplicate") {
        const res = await duplicateDealAction({ funnelId: funnel.id, dealId: deal.id });
        toast[res.ok ? "success" : "error"](res.ok ? "Negócio duplicado" : "Falha", { description: res.error });
      } else {
        if (!confirm(`Excluir o negócio de ${deal.contact.nome}?`)) return;
        const fd = new FormData();
        fd.set("dealId", deal.id);
        fd.set("funnelId", funnel.id);
        const res = await deleteDealAction(undefined, fd);
        toast[res.ok ? "success" : "error"](res.ok ? "Negócio excluído" : "Falha", { description: res.error });
      }
      router.refresh();
    });
  }

  function onStageAction(a: "rename" | "duplicate" | "delete", stage: Stage) {
    if (a === "rename") {
      setRenaming(stage);
      setRenameVal(stage.nome);
      return;
    }
    startTransition(async () => {
      if (a === "duplicate") {
        const res = await duplicateStageAction({ funnelId: funnel.id, stageId: stage.id });
        toast[res.ok ? "success" : "error"](res.ok ? "Etapa duplicada" : "Falha", { description: res.error });
      } else {
        if (!confirm(`Excluir a etapa "${stage.nome}"?`)) return;
        const res = await deleteStageAction({ funnelId: funnel.id, stageId: stage.id });
        toast[res.ok ? "success" : "error"](res.ok ? "Etapa excluída" : "Não foi possível excluir", {
          description: res.error,
        });
      }
      router.refresh();
    });
  }

  function confirmRename() {
    if (!renaming) return;
    const nome = renameVal.trim();
    if (!nome) return;
    startTransition(async () => {
      const res = await renameStageAction({ funnelId: funnel.id, stageId: renaming.id, nome });
      if (res.ok) {
        toast.success("Etapa renomeada");
        setRenaming(null);
        router.refresh();
      } else {
        toast.error("Falha", { description: res.error });
      }
    });
  }

  const totalDeals = funnel.stages.reduce((a, s) => a + s.total, 0);
  const totalValor = funnel.stages.reduce((a, s) => a + s.valor, 0);
  const parados = funnel.stages.reduce((a, s) => a + s.deals.filter((d) => isStale(d.enteredStageAt)).length, 0);
  const fechados = funnel.fechados.won.total + funnel.fechados.lost.total;

  return (
    <TransferirPara.Provider value={transferirPara}>
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumb={[{ label: "Funis", href: "/funis" }]}
        title={funnel.nome}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-x-2">
            <span>
              {totalDeals} {totalDeals === 1 ? "negócio aberto" : "negócios abertos"}
              {totalValor > 0 ? ` · ${formatBRLCompact(totalValor)} em aberto` : ""}
            </span>
            {parados > 0 && (
              <StatusDot tone="attention">
                {parados} {parados === 1 ? "parado" : "parados"} há mais de {STALE_DAYS} dias
              </StatusDot>
            )}
            {fechados > 0 && (
              <span className="num text-ink-3">
                · {funnel.fechados.won.total} {funnel.fechados.won.total === 1 ? "ganho" : "ganhos"} · {funnel.fechados.lost.total} {funnel.fechados.lost.total === 1 ? "perdido" : "perdidos"}
              </span>
            )}
          </span>
        }
        actions={
          <>
            {/* F3d: "por vendedor" — só para quem vê o time todo. */}
            <FiltroVendedor pessoas={pessoas} />
            {searchOpen ? (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
                <Input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar negócio"
                  className="h-[34px] w-56 pl-9"
                  onBlur={() => !q && setSearchOpen(false)}
                />
                <button
                  onClick={() => {
                    setQ("");
                    setSearchOpen(false);
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-foreground"
                  aria-label="Fechar busca"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <Button variant="outline" onClick={() => setSearchOpen(true)}>
                Filtrar
              </Button>
            )}
            <Button onClick={() => openNewDeal()}>Novo negócio</Button>
          </>
        }
      />

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="flex gap-7 overflow-x-auto pb-2">
          {stages.map((s, i) => (
            <StageColumn
              key={s.id}
              stage={s}
              index={i}
              onAddDeal={openNewDeal}
              onDealAction={onDealAction}
              onStageAction={onStageAction}
              onOpenDeal={setDealModal}
              onLoadMore={carregarMais}
              loadingMore={carregandoMais === s.id}
            />
          ))}
          <AddStageColumn funnelId={funnel.id} />
        </div>
        <DragOverlay>
          {activeDeal ? <DealCard deal={activeDeal} overlay /> : null}
        </DragOverlay>
      </DndContext>

      <NewDealDialog
        open={dealOpen}
        onOpenChange={setDealOpen}
        funnelId={funnel.id}
        stages={funnel.stages.map((s) => ({ id: s.id, nome: s.nome }))}
        presetStage={presetStage}
        onDone={() => router.refresh()}
      />

      {/* Renomear etapa */}
      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Renomear etapa</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirmRename()}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenaming(null)}>
              Cancelar
            </Button>
            <Button size="sm" onClick={confirmRename} disabled={pending || !renameVal.trim()}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal do negócio (abre ao clicar no card) */}
      <DealModal
        deal={dealModal}
        stages={funnel.stages.map((s) => ({ id: s.id, nome: s.nome }))}
        onClose={() => setDealModal(null)}
      />
    </div>
    </TransferirPara.Provider>
  );
}

/** Modal do negócio: dados do card + histórico do contato. Clicar no card abre isto. */
/** Render de mídia (áudio/imagem/doc) num item de feedback do negócio. */
function DealMediaInline({ url, mime, legenda }: { url: string; mime: string | null; legenda: string | null }) {
  const m = mime ?? "";
  if (m.startsWith("audio/")) return <AudioPlayer src={url} mime={m} />;
  if (m.startsWith("image/"))
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt={legenda ?? "imagem"} className="max-h-40 w-auto max-w-full rounded-md" />
      </a>
    );
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 text-body text-brand-600 hover:underline"
    >
      <FileText className="h-4 w-4" /> {legenda || "Abrir documento"}
    </a>
  );
}

function DealModal({
  deal,
  stages,
  onClose,
}: {
  deal: Deal | null;
  stages: { id: string; nome: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<DealDetailDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"feedback" | "anexos">("feedback");
  const [q, setQ] = useState("");
  const [nota, setNota] = useState("");
  const [anexoNome, setAnexoNome] = useState("");
  const [editando, setEditando] = useState(false);
  const [editValor, setEditValor] = useState("");
  const [editStage, setEditStage] = useState("");
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    if (!deal) return;
    setLoading(true);
    dealDetailAction(deal.id)
      .then((d) => setDetail(d))
      .finally(() => setLoading(false));
  }, [deal]);

  useEffect(() => {
    if (!deal) return;
    setDetail(null);
    setTab("feedback");
    setQ("");
    setNota("");
    setAnexoNome("");
    setEditando(false);
    load();
  }, [deal, load]);

  function salvarEdicao() {
    if (!detail) return;
    const valorNum = editValor.trim() === "" ? 0 : Number(editValor.replace(/\./g, "").replace(",", "."));
    start(async () => {
      const res = await updateDealAction(detail.id, {
        valor: valorNum,
        stageId: editStage || undefined,
      });
      if (res.ok) {
        setEditando(false);
        load();
        router.refresh();
      } else toast.error("Falha ao salvar", { description: res.error });
    });
  }

  function enviarNota() {
    if (!deal || !nota.trim()) return;
    start(async () => {
      const res = await addDealNoteAction(deal.id, nota);
      if (res.ok) {
        setNota("");
        load();
        router.refresh();
      } else toast.error("Falha ao salvar", { description: res.error });
    });
  }

  function anexar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !deal) return;
    // Na aba Anexos o "nome do documento" é a legenda; no Feedback, a nota.
    const nome = tab === "anexos" ? anexoNome : nota;
    start(async () => {
      const fd = new FormData();
      fd.set("dealId", deal.id);
      fd.set("file", file);
      fd.set("conteudo", nome);
      const res = await sendDealMediaAction(fd);
      if (res.ok) {
        setNota("");
        setAnexoNome("");
        load();
        router.refresh();
      } else toast.error("Falha no anexo", { description: res.error });
    });
  }

  const hist = detail?.historico ?? [];
  const term = q.trim().toLowerCase();
  const feedbackItems = term ? hist.filter((h) => (h.conteudo ?? "").toLowerCase().includes(term)) : hist;
  const anexos = hist.filter((h) => h.mediaUrl);

  return (
    <Dialog open={!!deal} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {deal?.contact.nome ?? "Negócio"}
            {detail && <StatusBadge status={detail.contato.status} />}
          </DialogTitle>
        </DialogHeader>
        {loading || !detail ? (
          <div className="space-y-2 py-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-[250px_1fr]">
            {/* Esquerda: contato + negócio */}
            <div className="space-y-3">
              <div className="space-y-1.5 rounded-md border p-3 text-body">
                <Campo label="Empresa" valor={detail.contato.empresa ?? "—"} />
                <Campo label="Telefone" valor={detail.contato.telefone ?? "—"} />
                <Campo label="E-mail" valor={detail.contato.email ?? "—"} />
                {editando ? (
                  <>
                    <div className="pt-1">
                      <span className="text-caption text-muted-foreground">Valor</span>
                      <Input
                        value={editValor}
                        onChange={(e) => setEditValor(e.target.value)}
                        inputMode="decimal"
                        placeholder="0"
                        className="mt-0.5 h-8"
                      />
                    </div>
                    <div>
                      <span className="text-caption text-muted-foreground">Etapa</span>
                      <select
                        value={editStage}
                        onChange={(e) => setEditStage(e.target.value)}
                        className="mt-0.5 h-8 w-full rounded-md border bg-background px-2 text-body"
                      >
                        {stages.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.nome}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-2 pt-1.5">
                      <Button size="sm" onClick={salvarEdicao} disabled={pending} className="flex-1">
                        Salvar
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditando(false)} disabled={pending}>
                        Cancelar
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <Campo label="Valor" valor={formatBRLCompact(Number(detail.valor))} />
                    <Campo label="Funil" valor={detail.funil.nome} />
                    <Campo label="Etapa" valor={detail.etapa} />
                    <Campo label="Na etapa desde" valor={relativeTime(detail.enteredStageAt)} />
                  </>
                )}
              </div>
              {!editando && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    setEditValor(String(detail.valor));
                    setEditStage(stages.find((s) => s.nome === detail.etapa)?.id ?? stages[0]?.id ?? "");
                    setEditando(true);
                  }}
                >
                  <Pencil className="mr-1.5 h-4 w-4" /> Editar negócio
                </Button>
              )}
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href={`/contatos/${detail.contato.id}`}>
                  <UserRoundPen className="mr-1.5 h-4 w-4" /> Abrir contato
                </Link>
              </Button>
            </div>

            {/* Direita: Feedback / Anexos */}
            <div className="flex min-w-0 flex-col">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex gap-1">
                  {(["feedback", "anexos"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTab(t)}
                      className={`rounded-md px-2.5 py-1 text-body font-medium ${
                        tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t === "feedback" ? "Feedback" : `Anexos (${anexos.length})`}
                    </button>
                  ))}
                </div>
                {tab === "feedback" && (
                  <div className="relative w-44">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…" className="h-8 pl-8" />
                  </div>
                )}
              </div>

              <input
                ref={fileRef}
                type="file"
                className="hidden"
                accept="image/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                onChange={anexar}
              />
              {tab === "feedback" ? (
                <>
                  <div className="h-72 space-y-2 overflow-y-auto rounded-md border p-2.5">
                    {feedbackItems.length === 0 ? (
                      <p className="py-6 text-center text-caption text-muted-foreground">Sem feedback ainda.</p>
                    ) : (
                      feedbackItems.map((h) => (
                        <div key={h.id} className="border-b pb-2 last:border-0 last:pb-0">
                          <div className="mb-0.5 text-caption text-muted-foreground">{relativeTime(h.at)}</div>
                          {h.mediaUrl ? (
                            <DealMediaInline url={h.mediaUrl} mime={h.mediaMime} legenda={h.conteudo} />
                          ) : null}
                          {h.conteudo ? (
                            <p className="whitespace-pre-wrap break-words text-body">{h.conteudo}</p>
                          ) : null}
                        </div>
                      ))
                    )}
                  </div>
                  <div className="mt-2 flex items-end gap-2">
                    <input
                      ref={fileRef}
                      type="file"
                      className="hidden"
                      accept="image/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                      onChange={anexar}
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() => fileRef.current?.click()}
                      disabled={pending}
                      aria-label="Anexar"
                    >
                      <Paperclip className="h-4 w-4" />
                    </Button>
                    <Textarea
                      value={nota}
                      onChange={(e) => setNota(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          enviarNota();
                        }
                      }}
                      placeholder="Escreva um feedback ou anexe algo…"
                      rows={1}
                      className="min-h-[38px] max-h-32 resize-none"
                    />
                    <Button size="icon" onClick={enviarNota} disabled={pending || !nota.trim()} aria-label="Enviar">
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mb-2 flex items-end gap-2">
                    <Input
                      value={anexoNome}
                      onChange={(e) => setAnexoNome(e.target.value)}
                      placeholder="Nome do documento (opcional)"
                      className="h-9"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => fileRef.current?.click()}
                      disabled={pending}
                    >
                      <Paperclip className="mr-1.5 h-4 w-4" /> Anexar
                    </Button>
                  </div>
                  <div className="h-72 space-y-2 overflow-y-auto rounded-md border p-2.5">
                    {anexos.length === 0 ? (
                      <p className="py-6 text-center text-caption text-muted-foreground">Nenhum anexo ainda.</p>
                    ) : (
                    anexos.map((h) => (
                      <div key={h.id} className="rounded-md border p-2">
                        <div className="mb-1 text-caption text-muted-foreground">
                          {new Date(h.at).toLocaleString("pt-BR")} · {(h.mediaMime ?? "arquivo").split("/")[0]}
                        </div>
                        <DealMediaInline url={h.mediaUrl!} mime={h.mediaMime} legenda={h.conteudo} />
                      </div>
                    ))
                  )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Campo({ label, valor, mono }: { label: string; valor: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className={mono ? "font-mono text-body" : "text-body font-medium"}>{valor}</p>
    </div>
  );
}

/** Coluna "+ etapa" no fim do board — cria uma etapa nova inline. */
function AddStageColumn({ funnelId }: { funnelId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [nome, setNome] = useState("");

  function submit() {
    const n = nome.trim();
    if (!n) return;
    startTransition(async () => {
      const res = await addStageAction({ funnelId, nome: n });
      if (res.ok) {
        setNome("");
        setAdding(false);
        router.refresh();
      } else {
        toast.error("Falha", { description: res.error });
      }
    });
  }

  return (
    <div className="w-[240px] shrink-0">
      {adding ? (
        <div className="rounded-lg border border-dashed p-2">
          <Input
            autoFocus
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="Nome da etapa"
            className="h-8"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setAdding(false);
            }}
            onBlur={() => !nome && setAdding(false)}
          />
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" onClick={submit} disabled={pending || !nome.trim()}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Adicionar"}
            </Button>
            <Button variant="ghost-subtle" size="sm" onClick={() => setAdding(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-3 text-body text-muted-foreground transition-colors hover:border-brand-400 hover:text-brand-600"
        >
          <Plus className="h-4 w-4" />
          Nova etapa
        </button>
      )}
    </div>
  );
}

/** Diálogo de novo negócio (card). Reusa contatos/etapas; pré-seleciona etapa. */
function NewDealDialog({
  open,
  onOpenChange,
  funnelId,
  stages,
  presetStage,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  funnelId: string;
  stages: { id: string; nome: string }[];
  presetStage?: string;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [contactId, setContactId] = useState("");
  const [stageId, setStageId] = useState(presetStage ?? stages[0]?.id ?? "");
  const [valor, setValor] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DealContactItem[]>([]);
  const [selected, setSelected] = useState<DealContactItem | null>(null);

  // Sincroniza a etapa pré-selecionada e zera a busca quando o diálogo abre.
  useEffect(() => {
    if (open) {
      setStageId(presetStage ?? stages[0]?.id ?? "");
      setSelected(null);
      setQuery("");
      setResults([]);
      setContactId("");
    }
  }, [open, presetStage, stages]);

  // Busca de contato por match PARCIAL (debounce). "Mar" acha Marcos, Marta…
  useEffect(() => {
    if (selected || query.trim().length < 1) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setResults(await searchDealContactsAction(query));
    }, 250);
    return () => clearTimeout(t);
  }, [query, selected]);

  function submit() {
    if (!contactId || !stageId) {
      toast.error("Selecione contato e etapa");
      return;
    }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("funnelId", funnelId);
      fd.set("stageId", stageId);
      fd.set("contactId", contactId);
      if (valor) fd.set("valor", valor);
      const res = await createDealAction(undefined, fd);
      if (res.ok) {
        toast.success("Negócio criado");
        setContactId("");
        setValor("");
        onOpenChange(false);
        onDone();
      } else {
        toast.error("Falha", { description: res.error });
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo negócio</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Contato</Label>
            {selected ? (
              <div className="rounded-md border p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-body font-medium">{selected.nome}</span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setSelected(null);
                      setContactId("");
                      setQuery("");
                    }}
                  >
                    Trocar
                  </Button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-caption text-muted-foreground">Telefone</Label>
                    <Input value={selected.telefone ?? "—"} disabled />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-caption text-muted-foreground">E-mail</Label>
                    <Input value={selected.email ?? "—"} disabled />
                  </div>
                </div>
              </div>
            ) : (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-[1.15rem] h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Digite o nome do contato…"
                  className="pl-8"
                  autoFocus
                />
                {results.length > 0 && (
                  <div className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover shadow-md">
                    {results.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setSelected(c);
                          setContactId(c.id);
                          setResults([]);
                        }}
                        className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-accent"
                      >
                        <span className="text-body font-medium">{c.nome}</span>
                        <span className="text-caption text-muted-foreground">
                          {c.telefone ?? c.email ?? "sem telefone/email"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {query.trim().length >= 1 && results.length === 0 && (
                  <p className="mt-1 text-caption text-muted-foreground">Nenhum contato encontrado.</p>
                )}
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label>Etapa</Label>
            <Select value={stageId} onValueChange={setStageId}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione a etapa" />
              </SelectTrigger>
              <SelectContent>
                {stages.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Valor (R$)</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              placeholder="0,00"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button size="sm" onClick={submit} disabled={pending || !contactId}>
            {pending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Criar negócio
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
