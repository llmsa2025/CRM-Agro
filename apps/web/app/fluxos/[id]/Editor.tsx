"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeProps,
  type Connection,
  type NodeChange,
  type ReactFlowInstance,
  applyNodeChanges,
  Handle,
  Position,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Copy, Loader2, Play, Plus, Redo2, Save, Trash2, TriangleAlert, Undo2, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { copiarTexto } from "@/lib/copiar";
import { formatDate } from "@/lib/format";
import { NODE_META, NODE_TYPES, NOS_ANTIGOS } from "./node-types";
import { ConfigPanel } from "./ConfigPanel";
import { SeletorDeTag } from "./SeletorDeTag";
import { type BuilderNode, type NodeData, defaultNodeData, fromFlowNodes, toSnapshotNodes, deriveEdges } from "./serialize";
import { adicionarDestino, removerDestino, todosDestinos } from "./destinos";
import { activateFlowAction, enrollTestContactAction, pauseFlowAction, regenerateWebhookTokenAction, updateFlowAction } from "../actions";
import type { JanelaEnvio } from "@crmagro/core";
import { HorarioDoFluxo } from "../HorarioDoFluxo";
import { erroDoHorario, rotuloCurtoDoHorario } from "../horario";
import { avisoDaUrlLegada, avisoDaUrlNova, estadoDaUrl, fraseDaUrlGerada, urlDoWebhook } from "./webhook-url";

type FlowDTO = {
  id: string;
  nome: string;
  triggerType: string;
  // As chaves que o editor mexe, mais o resto (reentrada, exclusivo, etapa do funil...), que ele devolve como veio.
  triggerConfig: ({ tagId?: string; startNodeId?: string; jitterMin?: number; jitterMax?: number } & Record<string, unknown>) | null;
  /**
   * URL do webhook. O servidor guarda só o hash do token: a URL completa só existe na tela no momento em que é
   * gerada. `tokenLegado` vem só de fluxo antigo (texto ainda no banco) e só para quem pode editar.
   */
  webhook: { temUrl: boolean; geradaEm: string | null; tokenLegado: string | null; soHash: boolean };
  /** Horário de envio do fluxo já lido do `triggerConfig` (sem nada salvo = segue a empresa). */
  janelaEnvio: JanelaEnvio;
  status: string;
  nodes: Array<{ id: string; tipo: import("@prisma/client").FlowNodeType; config: unknown; nextNodeId: string | null; branches: unknown; posX: number | null; posY: number | null }>;
};

type TagLite = { id: string; nome: string; cor: string | null };
const TRIGGER_NODE_ID = "__trigger__";
// Chaves do `triggerConfig` que o editor monta a cada salvamento. As outras são preservadas como vieram.
const CHAVES_DO_GATILHO_NO_EDITOR = new Set(["tagId", "startNodeId", "jitterMin", "jitterMax", "webhookToken", "janelaEnvio"]);
// Início do gatilho DESCONECTADO de propósito (o usuário apagou a conexão). Sem
// aresta no canvas; o motor cai na topologia como rede de segurança. Distinto de
// `undefined` (automático, que MOSTRA a aresta derivada).
const START_DETACHED = "__detached__";

const STATUS_LABEL: Record<string, string> = {
  draft: "Rascunho",
  active: "Ativo",
  paused: "Pausado",
  archived: "Arquivado",
};

type FunnelDTO = { id: string; nome: string; stages: { id: string; nome: string }[] };
type AccountDTO = { id: string; label: string };
type ContactDTO = { id: string; nome: string };

const TRIGGER_LABEL: Record<string, string> = {
  contact_created: "Contato criado",
  stage_changed: "Mudança de etapa",
  tag_added: "Tag adicionada",
  message_received: "Mensagem recebida",
  manual: "Manual",
  schedule: "Agendado",
  webhook: "Webhook (recebimento HTTP)",
  contacts_selected: "Contatos selecionados",
};

function newNode(tipo: import("@prisma/client").FlowNodeType, at: { x: number; y: number }): BuilderNode {
  return { id: `n_${Math.random().toString(36).slice(2, 10)}`, type: tipo, position: at, data: defaultNodeData(tipo) };
}

/** Rótulo curto de tempo (wait/typing), usado no corpo do nó. */
function tempoLabel(d: NodeData): string {
  const u = d.unit === "sec" ? "s" : d.unit === "min" ? "min" : d.unit === "hour" ? "h" : "d";
  if (d.tipo === "wait" && d.durationMax != null && d.durationMax > (d.duration ?? 0)) {
    return `${d.duration} a ${d.durationMax} ${u}`;
  }
  return `${d.duration} ${u}`;
}

/**
 * Nó customizado do React Flow — ícone + label + resumo + PONTOS DE CONEXÃO.
 *
 * Os `<Handle>` são obrigatórios: sem eles o React Flow não tem onde iniciar ou
 * terminar um arrasto, e o canvas fica sem nenhuma ligação possível (era o caso
 * até aqui — `onConnect` existia mas nunca podia disparar).
 *
 * Nó `condition` expõe uma saída por branch + a saída "senão", empilhadas à
 * direita; os demais expõem uma saída única.
 */
function FlowNodeView({ data, selected }: NodeProps) {
  const d = data as NodeData;
  const meta = NODE_META[d.tipo];
  const Icon = meta.icon;
  const isCondition = d.tipo === "condition";
  const isAbSplit = d.tipo === "ab_split";
  const isEnd = d.tipo === "end";
  const multiOut = isCondition || isAbSplit;
  const saidas = isEnd
    ? [] // nó terminal — não tem saída
    : isCondition
      ? [...(d.branches ?? []).map((b) => ({ id: b.id, label: b.label })), { id: "default", label: "senão" }]
      : isAbSplit
        ? (d.variants ?? []).map((v) => ({ id: v.id, label: v.label }))
        : [{ id: "out", label: "" }];

  return (
    <div
      className={`relative w-[160px] rounded-md border px-2.5 py-1.5 shadow-sm ${meta.accent} ${selected ? "ring-2 ring-brand-500" : ""}`}
      style={multiOut ? { paddingBottom: 8 + saidas.length * 16 } : undefined}
    >
      {/* Entrada — todo nó pode ser destino. */}
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-background !bg-foreground" />

      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-foreground/70" />
        <span className="text-sm font-medium">{d.label}</span>
        {meta.badge ? <Badge variant="outline-muted" className="ml-auto text-[10px]">{meta.badge}</Badge> : null}
      </div>
      {d.tipo === "send_message" && d.text ? <p className="mt-1 truncate text-xs text-muted-foreground">{d.text}</p> : null}
      {d.tipo === "wait" || d.tipo === "typing" ? <p className="mt-1 text-xs text-muted-foreground">{tempoLabel(d)}</p> : null}
      {d.tipo === "add_tag" ? (
        <p className={`mt-1 truncate text-xs ${d.tag ? "text-muted-foreground" : "text-warning-600"}`}>{d.tag || "⚠ escolha a tag"}</p>
      ) : null}

      {/* Saídas */}
      {saidas.map((s, i) => {
        const top = multiOut ? `calc(100% - ${(saidas.length - i) * 16}px)` : "50%";
        return (
          <div key={s.id}>
            {multiOut ? (
              <span
                className="pointer-events-none absolute right-3 text-[10px] text-muted-foreground"
                style={{ top, transform: "translateY(-50%)" }}
              >
                {s.label}
              </span>
            ) : null}
            <Handle
              id={s.id}
              type="source"
              position={Position.Right}
              style={{ top }}
              className="!h-2.5 !w-2.5 !border-2 !border-background !bg-brand-500"
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Nó do GATILHO — o início do fluxo, agora visível e editável no canvas (antes
 * era só um texto no cabeçalho). Não é um FlowNode persistido: é derivado do
 * `triggerType`/`triggerConfig` do fluxo. Só tem saída (aponta pro 1º passo).
 */
function TriggerNodeView({ data, selected }: NodeProps) {
  const d = data as { label: string; sub?: string; horario?: string; warn?: boolean };
  // Superfície theme-aware (bg-card) + acento semântico. Gatilho = entrada/foco
  // → brand (azul); estado sem-tag → warning (âmbar). Conteúdo em foreground/
  // muted-foreground pra contraste garantido nos dois temas (crmagro-design §4/§7).
  const accent = d.warn ? "text-warning-600" : "text-brand-500";
  return (
    <div
      className={`relative w-[168px] rounded-md border-2 bg-card px-2.5 py-1.5 shadow-sm ${
        d.warn ? "border-warning-500" : "border-brand-500"
      } ${selected ? "ring-2 ring-ring/60" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        <Zap className={`h-4 w-4 ${accent}`} />
        <span className={`text-caption font-semibold uppercase tracking-wide ${accent}`}>Gatilho</span>
      </div>
      <p className="mt-0.5 text-sm font-medium text-foreground">{d.label}</p>
      {d.sub ? <p className="truncate text-caption text-muted-foreground">{d.sub}</p> : null}
      {d.horario ? <p className="truncate text-caption text-muted-foreground">{d.horario}</p> : null}
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-background !bg-brand-500" />
    </div>
  );
}

// TODOS os tipos usam FlowNodeView (handles: target à ESQUERDA, source à
// DIREITA). Gerado de NODE_TYPES para nenhum tipo cair no nó DEFAULT do React
// Flow — que renderiza handles em cima/embaixo e faz a conexão sumir
// (send_email, send_social, switch_flow, manual_call, sync_name estavam assim).
const nodeTypes = {
  trigger: TriggerNodeView,
  ...Object.fromEntries(NODE_TYPES.map((t) => [t, FlowNodeView])),
} as Record<string, typeof FlowNodeView>;

/** Menu de contexto (botão direito) do canvas — excluir bloco ou conexão. */
function ContextMenu({
  menu,
  onClose,
  onDelete,
  onDuplicate,
}: {
  menu: { x: number; y: number; kind: "node" | "edge"; label: string };
  onClose: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  // Fecha ao clicar fora ou apertar Esc.
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed z-50 min-w-[172px] overflow-hidden rounded-md border bg-popover p-1 text-body text-popover-foreground shadow-md"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
      role="menu"
    >
      <div className="px-2 py-1 text-caption text-muted-foreground">
        {menu.kind === "node" ? menu.label : "Conexão"}
      </div>
      {menu.kind === "node" && (
        <button
          type="button"
          onClick={onDuplicate}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
          role="menuitem"
        >
          <Copy className="h-4 w-4" />
          Duplicar
        </button>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-danger-700 outline-none transition-colors hover:bg-danger-100 focus-visible:bg-danger-100"
        role="menuitem"
      >
        <Trash2 className="h-4 w-4" />
        {menu.kind === "node" ? "Excluir bloco" : "Excluir conexão"}
      </button>
    </div>
  );
}

export function Editor({
  flow,
  funnels,
  accounts,
  metodologias,
  contacts,
  tags,
  resumoEmpresa,
  tipo,
}: {
  flow: FlowDTO;
  funnels: FunnelDTO[];
  accounts: AccountDTO[];
  /** Metodologias do agente (a padrão da empresa vem marcada). */
  metodologias: Array<{ id: string; nome: string; padrao: boolean }>;
  contacts: ContactDTO[];
  tags: TagLite[];
  /** O que "seguir a empresa" significa hoje, para o painel do gatilho. */
  resumoEmpresa: string;
  /** Tipo do fluxo e o que ele aceita (a página monta a partir das regras do core, `flows/tipos.ts`). */
  tipo: { nome: string; nos: string[]; gatilhos: string[] };
}) {
  const router = useRouter();
  // Gatilho editável (nó de início). tag_added guarda a tag em triggerConfig.
  const [triggerType, setTriggerType] = useState(flow.triggerType);
  const [triggerTagId, setTriggerTagId] = useState<string | undefined>(flow.triggerConfig?.tagId);
  // Tags que o seletor trouxe depois da página abrir (a página só conhece as que existiam ao abrir): o cartão do
  // gatilho precisa do nome da que foi criada agora.
  const [tagsCriadas, setTagsCriadas] = useState<TagLite[]>([]);
  // Início EXPLÍCITO: a qual passo o gatilho liga. Vazio = automático (topologia).
  // O usuário controla arrastando a bolinha do gatilho para um nó, ou apagando a
  // aresta (volta ao automático).
  const [startNodeId, setStartNodeId] = useState<string | undefined>(flow.triggerConfig?.startNodeId);
  // Jitter inicial (controle de ritmo): espalha o início entre mín e máx minutos por
  // inscrição, para inscrições em lote não dispararem numa rajada.
  const [jitterMin, setJitterMin] = useState<number>(flow.triggerConfig?.jitterMin ?? 0);
  const [jitterMax, setJitterMax] = useState<number>(flow.triggerConfig?.jitterMax ?? 0);
  // Horário em que os passos deste fluxo podem falar com o contato. Muda a qualquer hora, também com o fluxo ativo.
  const [janela, setJanela] = useState<JanelaEnvio>(flow.janelaEnvio);
  // Gatilho de webhook: o token secreto vive no servidor (só o hash). A URL completa aparece aqui UMA vez,
  // quando é gerada (`urlNova`); fluxo antigo ainda mostra a dele (`tokenLegado`) até o texto ser apagado.
  const [webhookTem, setWebhookTem] = useState(flow.webhook.temUrl);
  const [webhookGeradaEm, setWebhookGeradaEm] = useState<string | null>(flow.webhook.geradaEm);
  const [tokenLegado, setTokenLegado] = useState<string | null>(flow.webhook.tokenLegado);
  const [urlNova, setUrlNova] = useState<string | null>(null);
  const [gerandoUrl, setGerandoUrl] = useState(false);
  // Gatilho que está SALVO no servidor: só dá para gerar a URL de um fluxo cujo gatilho salvo já é Webhook.
  const [gatilhoSalvo, setGatilhoSalvo] = useState(flow.triggerType);
  const estadoUrl = estadoDaUrl({ urlNova, tokenLegado, webhookTem });
  // Tema do React Flow (MiniMap/Controls/Background) segue o tema do app — sem
  // isto, o MiniMap e os controles renderizam claros (bloco branco) no escuro.
  const { resolvedTheme } = useTheme();
  // O next-themes só sabe o tema no cliente (no servidor `resolvedTheme` é indefinido). Usar o valor já no 1º render
  // faz o HTML do servidor ("dark") divergir do cliente e o React não corrige o atributo: o mapa ficava escuro até
  // alguém trocar o tema. Por isso o 1º render é sempre claro e o tema real entra logo depois de montar.
  const [montado, setMontado] = useState(false);
  useEffect(() => setMontado(true), []);
  const modoDoMapa = montado && resolvedTheme === "dark" ? "dark" : "light";
  const [nodes, setNodes] = useState<BuilderNode[]>(() => fromFlowNodes(flow.nodes));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Paleta de passos = painel flutuante colapsável sobre o canvas (não coluna
  // fixa). Fica fechada por padrão para o mapa nascer com o máximo de espaço.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Ativar e Pausar levam alguns segundos num fluxo grande: sem isto o botão não mostra nada e a pessoa clica de novo.
  const [agindo, setAgindo] = useState<"ativando" | "pausando" | null>(null);
  const [dirty, setDirty] = useState(false);
  const [testContact, setTestContact] = useState("");

  // Marca alterações não salvas. É chamado nas mutações REAIS (arrastar, ligar,
  // adicionar, excluir, editar config, undo/redo, mudar gatilho) — NÃO num efeito
  // sobre [nodes], porque o React Flow dispara mudanças automáticas (medir
  // dimensão, seleção) logo após carregar, o que marcava "não salvo" sem o
  // usuário ter mexido em nada (e reaparecia até depois de salvar).
  const markDirty = useCallback(() => setDirty(true), []);
  // Mudar o gatilho (evento, tag, horário, espalhar início, URL do webhook) também deixa o fluxo "não salvo" e liga o Salvar.
  const aoMudarEvento = (v: string) => {
    markDirty();
    setTriggerType(v);
  };
  const aoMudarTag = (t: { id: string; nome: string } | null) => {
    markDirty();
    if (t) {
      setTagsCriadas((atual) =>
        tags.some((x) => x.id === t.id) || atual.some((x) => x.id === t.id) ? atual : [...atual, { id: t.id, nome: t.nome, cor: null }],
      );
    }
    setTriggerTagId(t?.id);
  };
  const aoMudarJanela = (v: JanelaEnvio) => {
    markDirty();
    setJanela(v);
  };
  const aoMudarEspalhar = (campo: "min" | "max", v: number) => {
    markDirty();
    if (campo === "min") setJitterMin(v);
    else setJitterMax(v);
  };
  // Instância do React Flow — para converter coordenadas de tela → canvas no drop.
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  // Contêiner do canvas — para calcular o CENTRO do viewport ao adicionar passo.
  const canvasRef = useRef<HTMLDivElement | null>(null);

  // Histórico de undo/redo. Snapshot dos nós com debounce (não polui com cada
  // tick de arraste). `applyingHistory` evita re-empilhar ao aplicar um undo.
  const historyRef = useRef<BuilderNode[][]>([fromFlowNodes(flow.nodes)]);
  const idxRef = useRef(0);
  const applyingHistory = useRef(false);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, bumpHist] = useState(0);

  useEffect(() => {
    if (applyingHistory.current) {
      applyingHistory.current = false;
      return;
    }
    if (pushTimer.current) clearTimeout(pushTimer.current);
    const snap = nodes;
    pushTimer.current = setTimeout(() => {
      const h = historyRef.current.slice(0, idxRef.current + 1);
      h.push(snap);
      const capped = h.slice(-50); // teto de 50 passos
      historyRef.current = capped;
      idxRef.current = capped.length - 1;
      bumpHist((t) => t + 1);
    }, 400);
  }, [nodes]);

  const undo = useCallback(() => {
    if (idxRef.current <= 0) return;
    idxRef.current -= 1;
    applyingHistory.current = true;
    setNodes(historyRef.current[idxRef.current]!);
    bumpHist((t) => t + 1);
    setDirty(true);
  }, []);

  const redo = useCallback(() => {
    if (idxRef.current >= historyRef.current.length - 1) return;
    idxRef.current += 1;
    applyingHistory.current = true;
    setNodes(historyRef.current[idxRef.current]!);
    bumpHist((t) => t + 1);
    setDirty(true);
  }, []);

  const canUndo = idxRef.current > 0;
  const canRedo = idxRef.current < historyRef.current.length - 1;

  // Atalhos: Ctrl/Cmd+Z (undo), Ctrl/Cmd+Shift+Z ou Ctrl+Y (redo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Avisa ao fechar/atualizar a aba com alterações pendentes.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  // Menu de contexto (botão direito): posição na tela + o que excluir.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; kind: "node" | "edge"; id: string; label: string } | null>(null);

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  /** Zera qualquer destino que aponte para um nó que deixou de existir. */
  function limparReferencias(nds: BuilderNode[], removidos: Set<string>): BuilderNode[] {
    if (removidos.size === 0) return nds;
    return nds.map((n) => {
      const d = n.data;
      if (d.tipo === "condition") {
        return {
          ...n,
          data: {
            ...d,
            branches: (d.branches ?? []).map((b) => {
              const resto = todosDestinos(b.nextNodeId, b.maisDestinos).filter((x) => !removidos.has(x));
              return { ...b, nextNodeId: resto[0] ?? null, maisDestinos: resto.slice(1) };
            }),
            ...(() => {
              const resto = todosDestinos(d.defaultNext, d.defaultMais).filter((x) => !removidos.has(x));
              return { defaultNext: resto[0] ?? null, defaultMais: resto.slice(1) };
            })(),
          },
        };
      }
      return d.nextNodeId && removidos.has(d.nextNodeId) ? { ...n, data: { ...d, nextNodeId: null } } : n;
    });
  }

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const removidos = new Set(changes.filter((c) => c.type === "remove").map((c) => c.id));
    // Só é "alteração do usuário" mover (position) ou remover — NÃO medir dimensão
    // nem selecionar (o React Flow dispara essas sozinho ao carregar).
    if (changes.some((c) => c.type === "position" || c.type === "remove")) markDirty();
    setNodes((nds) => {
      const próximos = applyNodeChanges(changes, nds as Node[]) as unknown as BuilderNode[];
      // Sem isso, apagar um nó deixaria os outros apontando pro vazio — o motor
      // trata destino inexistente marcando o enrollment como done (silencioso).
      return limparReferencias(próximos, removidos);
    });
  }, [markDirty]);

  /** Exclui um nó (usado pelo menu de contexto) + limpa quem apontava pra ele. */
  const deleteNode = useCallback((id: string) => {
    markDirty();
    setNodes((nds) => limparReferencias(nds.filter((n) => n.id !== id), new Set([id])));
    setSelectedId((sel) => (sel === id ? null : sel));
  }, [markDirty]);

  /** Remove uma ligação pelo id da edge derivada, zerando o destino de origem. */
  const deleteEdgeById = useCallback((edgeId: string) => {
    markDirty();
    setNodes((nds) =>
      nds.map((n) => {
        const d = n.data;
        if (d.tipo === "condition") {
          // ids: e_<node>_<branchId> | e_<node>_default, e com `~<destino>` quando é um dos destinos extras da saída
          if (!edgeId.startsWith(`e_${n.id}_`)) return n;
          const [handle = "", alvoExtra] = edgeId.slice(`e_${n.id}_`.length).split("~");
          const sem = (principal: string | null | undefined, mais: string[] | undefined) => removerDestino(principal, mais, alvoExtra ?? principal ?? "");
          return {
            ...n,
            data: {
              ...d,
              branches: (d.branches ?? []).map((b) => {
                if (b.id !== handle) return b;
                const r = sem(b.nextNodeId, b.maisDestinos);
                return { ...b, nextNodeId: r.principal, maisDestinos: r.mais };
              }),
              ...(handle === "default" ? (() => { const r = sem(d.defaultNext, d.defaultMais); return { defaultNext: r.principal, defaultMais: r.mais }; })() : {}),
            },
          };
        }
        if (d.tipo === "ab_split") {
          // ids: e_<node>_<variantId>
          if (!edgeId.startsWith(`e_${n.id}_`)) return n;
          const handle = edgeId.slice(`e_${n.id}_`.length);
          return {
            ...n,
            data: {
              ...d,
              variants: (d.variants ?? []).map((v) => (v.id === handle ? { ...v, nextNodeId: null } : v)),
            },
          };
        }
        // linear: id = e_<node>
        return edgeId === `e_${n.id}` ? { ...n, data: { ...d, nextNodeId: null } } : n;
      }),
    );
  }, [markDirty]);

  /** Liga source -> target, respeitando de qual saída o arrasto partiu. */
  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    markDirty();
    // Arrastar da bolinha do GATILHO para um passo = definir o início explícito.
    if (conn.source === TRIGGER_NODE_ID) {
      setStartNodeId(conn.target);
      return;
    }
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== conn.source) return n;
        if (n.data.tipo === "condition") {
          // A saída pode ter VÁRIOS destinos: ligar de novo acrescenta (rodam um depois do outro, de cima para baixo).
          const handle = conn.sourceHandle;
          if (!handle || handle === "default") {
            const r = adicionarDestino(n.data.defaultNext, n.data.defaultMais, conn.target!);
            return { ...n, data: { ...n.data, defaultNext: r.principal, defaultMais: r.mais } };
          }
          return {
            ...n,
            data: {
              ...n.data,
              branches: (n.data.branches ?? []).map((b) => {
                if (b.id !== handle) return b;
                const r = adicionarDestino(b.nextNodeId, b.maisDestinos, conn.target!);
                return { ...b, nextNodeId: r.principal, maisDestinos: r.mais };
              }),
            },
          };
        }
        if (n.data.tipo === "ab_split") {
          return {
            ...n,
            data: {
              ...n.data,
              variants: (n.data.variants ?? []).map((v) =>
                v.id === conn.sourceHandle ? { ...v, nextNodeId: conn.target } : v,
              ),
            },
          };
        }
        return { ...n, data: { ...n.data, nextNodeId: conn.target } };
      }),
    );
  }, [markDirty]);

  /**
   * Apagar edge = limpar o destino lógico correspondente (as edges são derivadas
   * do dado, então não existe "remover a edge" isolado). Selecionar e apertar
   * Delete/Backspace passa por aqui.
   */
  const onEdgesDelete = useCallback((apagadas: Edge[]) => {
    markDirty();
    // Apagar a aresta do gatilho a DESCONECTA (não religa sozinha no próximo).
    // Para religar, arraste a bolinha do gatilho para um passo.
    if (apagadas.some((e) => e.id === "e_trigger")) setStartNodeId(START_DETACHED);
    setNodes((nds) =>
      nds.map((n) => {
        const alvo = apagadas.filter((e) => e.source === n.id);
        if (alvo.length === 0) return n;
        const d = n.data;
        if (d.tipo === "condition") {
          // Cada seta apagada tira só o destino dela da saída (as outras setas da mesma saída continuam).
          let branches = d.branches ?? [];
          let defaultNext = d.defaultNext;
          let defaultMais = d.defaultMais;
          for (const e of alvo) {
            const h = e.sourceHandle ?? "default";
            if (h === "default") {
              const r = removerDestino(defaultNext, defaultMais, e.target);
              defaultNext = r.principal;
              defaultMais = r.mais;
            } else {
              branches = branches.map((b) => {
                if (b.id !== h) return b;
                const r = removerDestino(b.nextNodeId, b.maisDestinos, e.target);
                return { ...b, nextNodeId: r.principal, maisDestinos: r.mais };
              });
            }
          }
          return { ...n, data: { ...d, branches, defaultNext, defaultMais } };
        }
        if (d.tipo === "ab_split") {
          const handles = new Set(alvo.map((e) => e.sourceHandle ?? ""));
          return {
            ...n,
            data: {
              ...d,
              variants: (d.variants ?? []).map((v) => (handles.has(v.id) ? { ...v, nextNodeId: null } : v)),
            },
          };
        }
        return { ...n, data: { ...d, nextNodeId: null } };
      }),
    );
  }, [markDirty]);

  const edges: Edge[] = useMemo(() => {
    return deriveEdges(nodes).map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      label: e.label,
      animated: e.animated,
      markerEnd: { type: MarkerType.ArrowClosed },
    }));
  }, [nodes]);

  // Início DERIVADO da topologia (o que ninguém aponta) — usado quando não há
  // início explícito definido pelo usuário.
  const startNodeIdDerived = useMemo(() => {
    const referenced = new Set<string>();
    for (const n of nodes) {
      const d = n.data;
      if (d.tipo === "condition") {
        for (const b of d.branches ?? []) for (const alvo of todosDestinos(b.nextNodeId, b.maisDestinos)) referenced.add(alvo);
        for (const alvo of todosDestinos(d.defaultNext, d.defaultMais)) referenced.add(alvo);
      } else if (d.nextNodeId) {
        referenced.add(d.nextNodeId);
      }
    }
    return nodes.find((n) => !referenced.has(n.id))?.id ?? nodes[0]?.id ?? null;
  }, [nodes]);

  const tagDoGatilho = useMemo(
    () => (triggerTagId ? [...tags, ...tagsCriadas].find((t) => t.id === triggerTagId) : undefined),
    [triggerTagId, tags, tagsCriadas],
  );

  // Nó sintético do gatilho + edge para o início (só visualização; não é salvo).
  const triggerNode: Node = useMemo(() => {
    const tag = tagDoGatilho;
    const isTag = triggerType === "tag_added";
    const sub = isTag ? (tag ? `Tag: ${tag.nome}` : "⚠ selecione uma tag") : undefined;
    return {
      id: TRIGGER_NODE_ID,
      type: "trigger",
      position: { x: -230, y: 30 },
      data: { label: TRIGGER_LABEL[triggerType] ?? triggerType, sub, horario: rotuloCurtoDoHorario(janela), warn: isTag && !triggerTagId },
      draggable: false,
      deletable: false,
    } as Node;
  }, [triggerType, triggerTagId, tagDoGatilho, janela]);

  const displayNodes = useMemo(() => [triggerNode, ...(nodes as unknown as Node[])], [triggerNode, nodes]);
  const displayEdges = useMemo(() => {
    // Desconectado de propósito → nenhuma aresta do gatilho.
    if (startNodeId === START_DETACHED) return edges;
    // Alvo da aresta do gatilho: o início EXPLÍCITO (se o nó ainda existe), senão
    // o derivado da topologia. Redireciona arrastando a bolinha; apagar desconecta.
    const target = startNodeId && nodes.some((n) => n.id === startNodeId) ? startNodeId : startNodeIdDerived;
    if (!target) return edges;
    return [
      {
        id: "e_trigger",
        source: TRIGGER_NODE_ID,
        target,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed },
      } as Edge,
      ...edges,
    ];
  }, [edges, startNodeId, startNodeIdDerived, nodes]);

  /**
   * Onde nasce um passo novo: à DIREITA do passo selecionado (se houver), senão
   * no CENTRO do viewport atual — nunca mais lá no começo, perto do gatilho, o
   * que obrigava a arrastar toda vez (item 1). Fallback aleatório sem instância.
   */
  function newNodePosition(): { x: number; y: number } {
    const jitter = () => (Math.random() - 0.5) * 40;
    const sel = nodes.find((n) => n.id === selectedId);
    if (sel) return { x: sel.position.x + 220 + jitter(), y: sel.position.y + jitter() };
    const inst = rfInstance.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (inst && rect) {
      return inst.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }
    return { x: 80 + Math.random() * 120, y: 80 + Math.random() * 120 };
  }

  function addNode(tipo: import("@prisma/client").FlowNodeType) {
    markDirty();
    const n = newNode(tipo, newNodePosition());
    setNodes((nds) => [...nds, n]);
    setSelectedId(n.id);
  }

  /** Duplica um passo COM as configurações (item 5). O clone nasce SEM conexões
   * de saída (o usuário religa) para não sobrepor arestas ao mesmo alvo; ids de
   * ramos/variantes são regerados. */
  const duplicateNode = useCallback((id: string) => {
    markDirty();
    const newId = `n_${Math.random().toString(36).slice(2, 10)}`;
    const gid = () => `b_${Math.random().toString(36).slice(2, 8)}`;
    setNodes((nds) => {
      const src = nds.find((n) => n.id === id);
      if (!src) return nds;
      const data = JSON.parse(JSON.stringify(src.data)) as NodeData;
      data.nextNodeId = null;
      data.defaultNext = null;
      data.defaultMais = [];
      if (data.branches) data.branches = data.branches.map((b) => ({ ...b, id: gid(), nextNodeId: null, maisDestinos: [] }));
      if (data.variants) data.variants = data.variants.map((v) => ({ ...v, id: gid(), nextNodeId: null }));
      const dup: BuilderNode = {
        id: newId,
        type: src.type,
        position: { x: src.position.x + 40, y: src.position.y + 60 },
        data,
      };
      return [...nds, dup];
    });
    setSelectedId(newId);
  }, [markDirty]);

  /** Solta um passo arrastado da palette na posição do canvas onde caiu. */
  function onDropNode(e: React.DragEvent) {
    e.preventDefault();
    const tipoDoNo = e.dataTransfer.getData("application/crmagro-flow-node") as
      | import("@prisma/client").FlowNodeType
      | "";
    if (!tipoDoNo || !NODE_TYPES.includes(tipoDoNo as never) || !tipo.nos.includes(tipoDoNo)) return;
    const inst = rfInstance.current;
    const position = inst
      ? inst.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      : { x: 80 + Math.random() * 120, y: 80 + Math.random() * 120 };
    markDirty();
    const n = newNode(tipoDoNo, position);
    setNodes((nds) => [...nds, n]);
    setSelectedId(n.id);
  }

  function updateData(next: NodeData) {
    markDirty();
    setNodes((nds) => nds.map((n) => (n.id === selectedId ? { ...n, data: next } : n)));
  }

  /** Mapa nodeId → posição atual no canvas (persistido para não "desordenar"). */
  function currentPositions(): Record<string, { x: number; y: number }> {
    return Object.fromEntries(nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
  }

  async function save(): Promise<boolean> {
    const erroDeHorario = erroDoHorario(janela);
    if (erroDeHorario) {
      setSelectedId(TRIGGER_NODE_ID);
      toast.error("Ajuste o horário de envio", { description: erroDeHorario });
      return false;
    }
    setSaving(true);
    // O que o editor não mexe (reentrada, exclusivo, etapa do funil...) volta como estava: salvar daqui não pode apagar.
    const triggerConfig: Record<string, unknown> = Object.fromEntries(
      Object.entries(flow.triggerConfig ?? {}).filter(([chave]) => !CHAVES_DO_GATILHO_NO_EDITOR.has(chave)),
    );
    triggerConfig.janelaEnvio = janela;
    if (triggerType === "tag_added" && triggerTagId) triggerConfig.tagId = triggerTagId;
    if (startNodeId === START_DETACHED) triggerConfig.startNodeId = START_DETACHED;
    else if (startNodeId && nodes.some((n) => n.id === startNodeId)) triggerConfig.startNodeId = startNodeId;
    if (jitterMin > 0 || jitterMax > 0) {
      triggerConfig.jitterMin = jitterMin;
      triggerConfig.jitterMax = jitterMax;
    }
    const res = await updateFlowAction(flow.id, {
      nome: flow.nome,
      triggerType,
      triggerConfig,
      nodes: toSnapshotNodes(nodes),
      positions: currentPositions(),
    });
    setSaving(false);
    if (res.ok) {
      setDirty(false);
      setGatilhoSalvo(triggerType);
      // Fluxo ativo: o que foi salvo já vale para quem entrar daqui em diante (quem já está nele segue na versão de quando entrou).
      const entraram = res.inscritas ?? 0;
      toast.success("Fluxo salvo", {
        description:
          entraram > 0
            ? `${entraram} ${entraram === 1 ? "contato com a tag entrou" : "contatos com a tag entraram"} no fluxo. Quem já rodou não repete.`
            : flow.status === "active"
              ? "O fluxo está ativo: vale já para quem entrar a partir de agora. Quem já está nele segue como estava."
              : undefined,
      });
      return true;
    }
    toast.error("Falha ao salvar", { description: res.error });
    return false;
  }

  /**
   * Gera a URL do webhook (a primeira) ou troca por uma nova. A URL é do gatilho SALVO: se o Webhook ainda não foi
   * salvo, salva antes. A nova invalida a anterior na hora, por isso pede confirmação quando já existe uma.
   */
  async function gerarUrlDoWebhook() {
    if (gerandoUrl || saving || agindo) return;
    if (webhookTem && !confirm("Gerar uma nova URL? A atual para de funcionar na hora, e quem usa ela precisa trocar.")) return;
    setGerandoUrl(true);
    try {
      if (gatilhoSalvo !== "webhook" && !(await save())) return;
      const res = await regenerateWebhookTokenAction(flow.id);
      if (res.ok && res.webhookToken) {
        setUrlNova(res.webhookToken);
        setWebhookTem(true);
        setWebhookGeradaEm(res.geradoEm ?? new Date().toISOString());
        setTokenLegado(null);
      } else toast.error("Não consegui gerar a URL", { description: res.error });
    } finally {
      setGerandoUrl(false);
    }
  }

  async function copiarUrlDoWebhook(token: string) {
    // `copiarTexto` cai no plano B (página sem HTTPS) e devolve false, sem lançar, se falhar.
    const ok = await copiarTexto(urlDoWebhook(window.location.origin, token));
    if (ok) toast.success("URL copiada");
    else toast.error("Não consegui copiar. Selecione a URL e copie manualmente.");
  }

  async function activate() {
    if (agindo) return;
    setAgindo("ativando");
    try {
      // Só salva se mudou alguma coisa; se o salvamento falhar, não ativa (valeria a versão antiga).
      if (dirty && !(await save())) return;
      const res = await activateFlowAction(flow.id);
      if (res.ok) {
        const n = res.retomadas ?? 0;
        const entraram = res.inscritas ?? 0;
        const partes = [
          n > 0 ? `${n} ${n === 1 ? "inscrição continuou" : "inscrições continuaram"} de onde parou.` : null,
          entraram > 0 ? `${entraram} ${entraram === 1 ? "contato com a tag entrou" : "contatos com a tag entraram"} no fluxo.` : null,
        ].filter(Boolean);
        toast.success("Fluxo ativado", { description: partes.length ? partes.join(" ") : undefined });
        router.refresh();
      } else toast.error("Falha ao ativar", { description: res.error });
    } finally {
      setAgindo(null);
    }
  }

  async function pause() {
    if (agindo) return;
    setAgindo("pausando");
    try {
      const res = await pauseFlowAction(flow.id);
      if (res.ok) {
        const n = res.seguradas ?? 0;
        toast.success("Fluxo pausado", {
          description: n > 0 ? `${n} ${n === 1 ? "inscrição parou" : "inscrições pararam"} onde estavam e continuam de lá quando você ativar.` : undefined,
        });
        router.refresh();
      } else toast.error("Falha ao pausar", { description: res.error });
    } finally {
      setAgindo(null);
    }
  }

  async function testEnroll() {
    if (!testContact) {
      toast.error("Selecione um contato");
      return;
    }
    // O teste (e o fluxo ativo) rodam a ÚLTIMA VERSÃO SALVA: o que está mudado aqui e não salvo não entra.
    if (dirty) toast.warning("Testando a versão salva", { description: "As mudanças que você ainda não salvou não entram no teste. Clique em Salvar para elas valerem." });
    const res = await enrollTestContactAction(flow.id, testContact);
    if (res.ok) toast.success("Contato inscrito. Acompanhe em Atividades");
    else toast.error("Falha", { description: res.error });
  }

  const targets = nodes.map((n) => ({ id: n.id, label: n.data.label }));
  // Inspector aberto = algum nó (ou o gatilho) selecionado. Quando aberto, o
  // minimapa é empurrado para a esquerda do painel para não ficar coberto.
  const inspectorOpen = selectedId === TRIGGER_NODE_ID || !!selected;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Sem seta de voltar aqui — já existe o "← Voltar" no topo da página (breadcrumb). */}
        <div>
          <h1 className="text-h1 font-semibold tracking-tight">
            {flow.nome}
            {dirty ? <span className="ml-2 align-middle text-caption font-normal text-warning-600">• não salvo</span> : null}
          </h1>
          {/* `div`, não `p`: o Badge é um `div`, e `div` dentro de `p` quebra a hidratação do editor. */}
          <div className="text-caption text-muted-foreground">
            Tipo: {tipo.nome} · Gatilho: {TRIGGER_LABEL[triggerType] ?? triggerType} · Status:{" "}
            <Badge variant={flow.status === "active" ? "info" : "outline-muted"}>
              {STATUS_LABEL[flow.status] ?? flow.status}
            </Badge>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-md border">
            <Button variant="ghost-subtle" size="icon-sm" onClick={undo} disabled={!canUndo} aria-label="Desfazer (Ctrl+Z)">
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button variant="ghost-subtle" size="icon-sm" onClick={redo} disabled={!canRedo} aria-label="Refazer (Ctrl+Shift+Z)">
              <Redo2 className="h-4 w-4" />
            </Button>
          </div>
          <Select value={testContact} onValueChange={setTestContact}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Contato p/ teste" />
            </SelectTrigger>
            <SelectContent>
              {contacts.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.nome}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={testEnroll} disabled={flow.status !== "active"}>
            <Play className="mr-1.5 h-4 w-4" />
            Testar
          </Button>
          {flow.status === "active" ? (
            <Button variant="outline" size="sm" onClick={pause} disabled={agindo !== null}>
              {agindo === "pausando" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {agindo === "pausando" ? "Pausando" : "Pausar"}
            </Button>
          ) : (
            <Button size="sm" onClick={activate} disabled={agindo !== null}>
              {agindo === "ativando" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {agindo === "ativando" ? "Ativando" : "Ativar"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={save} disabled={saving || !dirty}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
            Salvar
          </Button>
        </div>
      </div>

      {/* Área do mapa — canvas full-bleed; paleta e inspector são painéis
          flutuantes SOBRE o canvas, nunca colunas fixas que roubam largura e
          estouram a altura. A altura acompanha a viewport (com piso mínimo). */}
      <div
        ref={canvasRef}
        className="relative w-full h-[calc(100dvh-16.5rem)] min-h-[420px] overflow-hidden rounded-lg border bg-background"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={onDropNode}
      >
          <ReactFlow
            colorMode={modoDoMapa}
            onInit={(inst) => (rfInstance.current = inst)}
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            onNodeClick={(_, n) => {
              setSelectedId(n.id);
              setCtxMenu(null);
            }}
            onNodeContextMenu={(e, n) => {
              e.preventDefault();
              if (n.id === TRIGGER_NODE_ID) return; // gatilho não tem menu de excluir
              const nd = nodes.find((x) => x.id === n.id);
              setCtxMenu({ x: e.clientX, y: e.clientY, kind: "node", id: n.id, label: nd?.data.label ?? "bloco" });
            }}
            onEdgeContextMenu={(e, ed) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, kind: "edge", id: ed.id, label: "conexão" });
            }}
            onPaneClick={() => {
              setSelectedId(null);
              setCtxMenu(null);
              // Item 4: clicar no mapa recolhe a paleta "Adicionar passo" (igual
              // ao popup de config), tirando-a do caminho sem fechar na mão.
              setPaletteOpen(false);
            }}
            deleteKeyCode={["Delete", "Backspace"]}
            fitView
            // Sem isto, com poucos nós o fitView amplia até o zoom máximo e os
            // blocos ficam enormes. Limita o zoom inicial (mas mantém o bloco bem
            // visível/destacado) e dá respiro nas bordas.
            fitViewOptions={{ maxZoom: 1.1, padding: 0.35 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable style={inspectorOpen ? { marginRight: "21rem" } : undefined} />
          </ReactFlow>

          {ctxMenu && (
            <ContextMenu
              menu={ctxMenu}
              onClose={() => setCtxMenu(null)}
              onDuplicate={() => {
                if (ctxMenu.kind === "node") duplicateNode(ctxMenu.id);
                setCtxMenu(null);
              }}
              onDelete={() => {
                if (ctxMenu.kind === "node") deleteNode(ctxMenu.id);
                else deleteEdgeById(ctxMenu.id);
                setCtxMenu(null);
              }}
            />
          )}

          {/* Paleta de passos — painel flutuante colapsável SOBRE o canvas.
              Fechada por padrão (mapa com espaço máximo); a lista rola no
              próprio contêiner (min-h-0 + overflow-y-auto) e nunca empurra o
              layout. Mantém clicar-para-adicionar e arrastar-para-o-canvas. */}
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-h-[calc(100%-1.5rem)] w-56 flex-col">
            <Button
              type="button"
              size="sm"
              variant={paletteOpen ? "default" : "outline"}
              onClick={() => setPaletteOpen((o) => !o)}
              aria-expanded={paletteOpen}
              className="pointer-events-auto shrink-0 self-start shadow-sm"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Adicionar passo
            </Button>
            {paletteOpen && (
              <div className="pointer-events-auto mt-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card shadow-md">
                <p className="shrink-0 border-b px-3 py-2 text-caption text-muted-foreground">
                  Clique para adicionar ou arraste para o mapa. Arraste das bolinhas dos blocos para ligar (uma saída da condição pode ir para vários passos: todos começam ao mesmo tempo); clique direito num bloco ou conexão para excluir.
                </p>
                <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                  {NODE_TYPES.filter((t) => tipo.nos.includes(t) && !NOS_ANTIGOS.has(t)).map((t) => {
                    const meta = NODE_META[t];
                    const Icon = meta.icon;
                    return (
                      <button
                        key={t}
                        onClick={() => addNode(t)}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("application/crmagro-flow-node", t);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        className="flex w-full cursor-grab items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                        title="Clique para adicionar ou arraste para o canvas"
                      >
                        <Icon className="h-4 w-4 text-foreground/70" />
                        <span className="truncate">{meta.label}</span>
                        <Plus className="ml-auto h-3 w-3 text-muted-foreground" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Inspector — config do nó (ou do gatilho) num painel flutuante à
              direita, SOBRE o canvas. Rola internamente (min-h-0 +
              overflow-y-auto); preserva toda a funcionalidade do ConfigPanel. */}
          {inspectorOpen && (
            <div className="absolute bottom-3 right-3 top-3 z-10 flex w-80 flex-col overflow-hidden rounded-lg border bg-card shadow-md">
              <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
                <span className="text-caption font-medium text-muted-foreground">
                  {selectedId === TRIGGER_NODE_ID ? "Gatilho (início do fluxo)" : "Editar passo"}
                </span>
                <Button
                  variant="ghost-subtle"
                  size="icon-sm"
                  aria-label="Fechar painel"
                  onClick={() => setSelectedId(null)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {selectedId === TRIGGER_NODE_ID ? (
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground/70">Quando este evento acontece, o contato entra no fluxo.</p>
                    <p className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
                Início:{" "}
                {startNodeId === START_DETACHED ? (
                  <span className="font-medium text-warning-600">desconectado</span>
                ) : startNodeId && nodes.some((n) => n.id === startNodeId) ? (
                  <span className="font-medium text-foreground">{nodes.find((n) => n.id === startNodeId)?.data.label}</span>
                ) : (
                  "automático (1º passo pela topologia)"
                )}
                . Arraste a bolinha do gatilho para um passo para definir/mudar o início; apague a conexão para desconectar (não religa sozinha).
              </p>
              <div className="space-y-1">
                <Label>Evento</Label>
                <Select value={triggerType} onValueChange={aoMudarEvento}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(TRIGGER_LABEL)
                      .filter(([v]) => tipo.gatilhos.includes(v) || v === triggerType)
                      .map(([v, label]) => (
                      <SelectItem key={v} value={v}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {triggerType === "webhook" && (
                <div className="space-y-1">
                  <Label>URL do webhook (recebimento)</Label>
                  <p className="text-xs text-muted-foreground/70">
                    Chame esta URL (POST) quando um lead levantar a mão. Por exemplo, sua campanha manda
                    <code className="px-1">{"{ nome, telefone, email }"}</code> e o contato entra no fluxo. Gere a URL e ative o fluxo para valer.
                  </p>
                  {estadoUrl === "nova" && urlNova ? (
                    // URL recém-gerada: aparece só agora. O servidor guarda apenas o hash e não consegue mostrar de novo.
                    <div className="rounded-md border border-warning-300 bg-warning-50 p-2 dark:bg-warning-950/30">
                      <p className="flex items-center gap-1.5 text-xs font-medium text-warning-700 dark:text-warning-400">
                        <TriangleAlert className="h-3.5 w-3.5" /> {avisoDaUrlNova(flow.webhook.soHash)}
                      </p>
                      <div className="mt-1.5 flex items-center gap-1">
                        <Input
                          readOnly
                          value={urlDoWebhook(typeof window !== "undefined" ? window.location.origin : "", urlNova)}
                          className="h-8 bg-background font-mono text-xs"
                          onFocus={(e) => e.currentTarget.select()}
                        />
                        <Button type="button" variant="outline" size="icon-sm" aria-label="Copiar URL" onClick={() => copiarUrlDoWebhook(urlNova)}>
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ) : estadoUrl === "legado" && tokenLegado ? (
                    // Fluxo antigo (ou chave desligada): o texto ainda está guardado, então a URL aparece de novo.
                    <>
                      <div className="flex items-center gap-1">
                        <Input
                          readOnly
                          value={urlDoWebhook(typeof window !== "undefined" ? window.location.origin : "", tokenLegado)}
                          className="h-8 font-mono text-xs"
                          onFocus={(e) => e.currentTarget.select()}
                        />
                        <Button type="button" variant="outline" size="icon-sm" aria-label="Copiar URL" onClick={() => copiarUrlDoWebhook(tokenLegado)}>
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground/70">
                        {avisoDaUrlLegada(flow.webhook.soHash)}
                      </p>
                    </>
                  ) : estadoUrl === "gerada" ? (
                    <p className="text-xs text-muted-foreground">{fraseDaUrlGerada(webhookGeradaEm ? formatDate(webhookGeradaEm) : null)}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">Nenhuma URL gerada ainda.</p>
                  )}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-60"
                    disabled={gerandoUrl || saving}
                    onClick={gerarUrlDoWebhook}
                  >
                    {gerandoUrl ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    {webhookTem ? "Gerar nova URL (invalida a anterior)" : "Gerar URL do webhook"}
                  </button>
                </div>
              )}
              {triggerType === "tag_added" && (
                <div className="space-y-1">
                  <Label htmlFor="tag-do-gatilho">Tag (lista do fluxo)</Label>
                  <SeletorDeTag id="tag-do-gatilho" value={tagDoGatilho?.nome ?? ""} onChange={aoMudarTag} />
                  {!triggerTagId && (
                    <p className="text-xs text-warning-600">O fluxo não pode ser ativado sem uma tag.</p>
                  )}
                </div>
              )}
              {triggerType === "contacts_selected" && (
                <p className="text-xs text-muted-foreground">
                  Este fluxo não roda sozinho. Em Contatos, selecione as pessoas e use Rodar fluxo.
                </p>
              )}
              <div className="border-t pt-3">
                <HorarioDoFluxo value={janela} onChange={aoMudarJanela} resumoEmpresa={resumoEmpresa} />
              </div>
              <div className="space-y-1 border-t pt-3">
                <Label className="text-caption text-muted-foreground">Espalhar o início</Label>
                <p className="text-xs text-muted-foreground/70">
                  Cada contato espera um tempo aleatório entre mín e máx antes do 1º passo, para que uma inscrição em lote não dispare tudo de uma vez. 0 = sem espalhamento.
                </p>
                <div className="flex items-center gap-2">
                  <div className="flex-1 space-y-1">
                    <Label className="text-caption">Mín (min)</Label>
                    <Input
                      type="number"
                      min={0}
                      value={jitterMin}
                      onChange={(e) => aoMudarEspalhar("min", Math.max(0, Number(e.target.value) || 0))}
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <Label className="text-caption">Máx (min)</Label>
                    <Input
                      type="number"
                      min={jitterMin}
                      value={jitterMax}
                      onChange={(e) => aoMudarEspalhar("max", Math.max(0, Number(e.target.value) || 0))}
                    />
                  </div>
                </div>
              </div>
            </div>
                ) : selected ? (
                  <ConfigPanel
                    data={selected.data}
                    onChange={updateData}
                    targets={targets.filter((t) => t.id !== selected.id)}
                    funnels={funnels}
                    accounts={accounts}
                    metodologias={metodologias}
                  />
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
  );
}
