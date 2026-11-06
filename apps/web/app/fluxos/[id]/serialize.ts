import type { FlowNodeType } from "@prisma/client";
import { ordenarPorPosicao, todosDestinos } from "./destinos";

/**
 * Serialização entre o grafo do React Flow e o shape `SnapshotNode` (zod) que o
 * serviço de fluxo aceita. Pure — sem imports server/client-only.
 *
 * O motor usa `nextNodeId` (nós lineares) ou `branches` (nó condition). No
 * builder, o destino é escolhido via Select no painel de config — as edges do
 * React Flow são só visualização (derivadas do destino lógico).
 */

export type ConditionType = "responded" | "tag_present" | "stage_is";

export type BranchDef = {
  id: string;
  label: string;
  condition:
    | { type: "responded"; janelaMin?: number; canal?: "whatsapp" | "email" | "instagram" | "linkedin" }
    | { type: "tag_present"; tag: string }
    | { type: "stage_is"; stageId: string }
    | { type: "has_name" }
    | { type: "whatsapp_name" }
    // `modo` ausente = "No cadastro" (o padrão NÃO é gravado, para o fluxo que já existe manter o mesmo grafo).
    | { type: "has_whatsapp"; modo?: "cadastro" | "verificar" }
    | { type: "has_email" }
    | { type: "channel_history"; canal: "whatsapp" | "email" | "instagram" }
    | { type: "has_reply" }
    | { type: "reply_class"; classe: "sem_interesse" | "interesse" | "outro" }
    | { type: "reply_text"; texto: string; modo: "contem" | "exato" };
  nextNodeId: string | null;
  /** Outros destinos da mesma saída (rodam depois, na ordem). */
  maisDestinos?: string[];
};

/** Rótulo padrão do ramo derivado do CRITÉRIO — usado para o rótulo dinâmico do
 * ramo de condição (item 9). O usuário pode sobrescrever; enquanto o rótulo casar
 * com o padrão de OUTRO critério, ele re-sincroniza ao trocar o critério. */
export function criterioLabel(cond: BranchDef["condition"]): string {
  switch (cond.type) {
    case "responded": {
      const c = cond.canal;
      const canal = c === "email" ? " (e-mail)" : c === "instagram" ? " (Instagram)" : c === "linkedin" ? " (LinkedIn)" : c === "whatsapp" ? " (WhatsApp)" : "";
      return `Respondeu${canal}`;
    }
    case "tag_present":
      return "Tem tag";
    case "stage_is":
      return "Está na etapa";
    case "has_name":
      return "Tem nome";
    case "whatsapp_name":
      return "Tem nome no WhatsApp";
    case "has_whatsapp":
      return cond.modo === "verificar" ? "Tem WhatsApp (conferido no WhatsApp)" : "Tem WhatsApp";
    case "has_email":
      return "Tem e-mail";
    case "channel_history":
      return cond.canal === "email" ? "Já tem histórico (e-mail)" : cond.canal === "instagram" ? "Já tem histórico (Instagram)" : "Já tem histórico (WhatsApp)";
    case "has_reply":
      return "Já respondeu";
    case "reply_class":
      return cond.classe === "sem_interesse" ? "Sem interesse" : cond.classe === "interesse" ? "Tenho interesse" : "Outra resposta";
    case "reply_text":
      return cond.modo === "exato" ? "Resposta é a palavra" : "Resposta tem a palavra";
  }
}

/** Conjunto de todos os rótulos que o `criterioLabel` pode gerar — para saber se
 * um rótulo atual foi auto-gerado (pode re-sincronizar) ou customizado pelo
 * usuário (preservar). */
export const CRITERIO_LABELS = new Set<string>([
  "Respondeu", "Respondeu (WhatsApp)", "Respondeu (e-mail)", "Respondeu (Instagram)", "Respondeu (LinkedIn)",
  "Tem tag", "Está na etapa", "Tem nome", "Tem nome no WhatsApp", "Tem WhatsApp", "Tem WhatsApp (conferido no WhatsApp)", "Tem e-mail", "Já respondeu",
  "Já tem histórico (WhatsApp)", "Já tem histórico (e-mail)", "Já tem histórico (Instagram)",
  "Sem interesse", "Tenho interesse", "Outra resposta", "Resposta tem a palavra", "Resposta é a palavra",
  // rótulo legado que nascia sempre "RESPONDEU"/"Ramo"
  "RESPONDEU", "Ramo",
]);

/** Variante do teste A/B: rótulo + peso relativo + destino. */
export type VariantDef = {
  id: string;
  label: string;
  weight: number;
  nextNodeId: string | null;
};

/** Dados editáveis de um nó no builder. Campos opcionais por tipo. */
export type NodeData = {
  tipo: FlowNodeType;
  label: string;
  // send_message
  text?: string;
  channelAccountId?: string;
  skipIfHistory?: boolean;
  onHistory?: "skip" | "hold";
  // send_email
  subject?: string;
  skipIfNoEmail?: boolean;
  emailSignatureId?: string;
  // send_social (instagram/linkedin)
  socialCanal?: "instagram" | "linkedin";
  onNoHandle?: "skip" | "hold";
  aiPersonalize?: boolean;
  aiInstrucao?: string;
  // switch_flow
  switchFlowId?: string;
  // manual_call
  roteiro?: string;
  // sync_name
  overwrite?: boolean;
  // enrich_person: vincular também as empresas de nome parecido (confiança média)
  incluirConfiancaMedia?: boolean;
  // wait + typing
  duration?: number;
  unit?: "sec" | "min" | "hour" | "day";
  // wait: modo intercalar (aleatório entre duration e durationMax)
  durationMax?: number | null;
  // update_stage
  funnelId?: string;
  stageId?: string;
  // add_tag
  tag?: string;
  // notify_user
  userId?: string;
  message?: string;
  // http_request
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  // ai_agent — "conversa" (conversa com o contato) ou "mensagem" (uma mensagem personalizada)
  aiModo?: "mensagem" | "conversa";
  orientacao?: string;
  maxRespostas?: number;
  silencioHoras?: number;
  avisarVendedor?: boolean;
  /** Metodologia do agente: ausente = a padrão da empresa; "nenhuma" = sem metodologia; ou o id de uma. */
  metodologiaId?: string;
  objetivo?: string;
  tom?: string;
  aiFallbackText?: string;
  aiMaxChars?: number;
  provider?: "anthropic" | "glm";
  model?: string;
  temperature?: number;
  // condition
  branches?: BranchDef[];
  defaultNext?: string | null;
  defaultMais?: string[];
  // ab_split (teste A/B)
  variants?: VariantDef[];
  // linear (todos exceto condition)
  nextNodeId?: string | null;
};

export type BuilderNode = { id: string; type: string; position: { x: number; y: number }; data: NodeData };

/** Default data ao criar um nó novo de cada tipo. */
export function defaultNodeData(tipo: FlowNodeType): NodeData {
  switch (tipo) {
    case "send_message":
      return { tipo, label: "Enviar mensagem", text: "", skipIfHistory: false };
    case "send_email":
      return { tipo, label: "Enviar e-mail", subject: "", text: "", skipIfNoEmail: true };
    case "send_social":
      return { tipo, label: "Enviar DM (social)", socialCanal: "instagram", text: "", onNoHandle: "skip" };
    case "switch_flow":
      return { tipo, label: "Mudar de fluxo", switchFlowId: "" };
    case "wait":
      return { tipo, label: "Esperar", duration: 1, unit: "hour", durationMax: null };
    case "typing":
      return { tipo, label: "Digitando…", duration: 30, unit: "sec", durationMax: null };
    case "condition":
      return {
        tipo,
        label: "Condição",
        // janelaMin default: sem janela a condição mede no instante do envio e
        // nunca dá "respondeu". 60min é um padrão seguro para primeiro contato.
        branches: [{ id: cryptoId(), label: "Respondeu", condition: { type: "responded", janelaMin: 60 }, nextNodeId: null }],
        defaultNext: null,
      };
    case "ab_split":
      return {
        tipo,
        label: "Teste A/B",
        variants: [
          { id: cryptoId(), label: "A", weight: 50, nextNodeId: null },
          { id: cryptoId(), label: "B", weight: 50, nextNodeId: null },
        ],
      };
    case "update_stage":
      return { tipo, label: "Mover etapa" };
    case "create_deal":
      return { tipo, label: "Criar card" };
    case "add_tag":
      return { tipo, label: "Adicionar tag", tag: "" };
    case "notify_user":
      return { tipo, label: "Notificar", message: "" };
    case "http_request":
      return { tipo, label: "HTTP", method: "POST", url: "" };
    case "ai_agent":
      // Nó novo nasce conversando (o que se espera de um agente). Fluxo antigo, sem `modo`, lê como "mensagem".
      return { tipo, label: "Agente IA", aiModo: "conversa", orientacao: "", objetivo: "", tom: "", aiFallbackText: "", skipIfHistory: false };
    case "manual_call":
      return { tipo, label: "Ligação manual", roteiro: "" };
    case "sync_name":
      return { tipo, label: "Atualizar nome (WhatsApp)", overwrite: false };
    case "save_history":
      return { tipo, label: "Registrar conversa no histórico" };
    case "enrich_data":
      return { tipo, label: "Enriquecer dados (antigo)" };
    case "enrich_company":
      return { tipo, label: "Enriquecer empresa" };
    case "enrich_person":
      return { tipo, label: "Enriquecer pessoa", incluirConfiancaMedia: false };
    case "end":
      return { tipo, label: "Fim" };
  }
}

function cryptoId(): string {
  return `n_${Math.random().toString(36).slice(2, 10)}`;
}

/** Serializa os nós do builder no shape aceito pelo serviço (zod snapshotNodeSchema). */
export function toSnapshotNodes(nodes: BuilderNode[]): unknown[] {
  const posicoes = new Map(nodes.map((n) => [n.id, n.position] as const));
  return nodes.map((n) => {
    const d = n.data;
    switch (d.tipo) {
      case "send_message":
        return {
          id: n.id,
          tipo: "send_message",
          config: {
            text: d.text ?? "",
            channelAccountId: d.channelAccountId,
            skipIfHistory: d.skipIfHistory,
            ...(d.skipIfHistory && d.onHistory ? { onHistory: d.onHistory } : {}),
          },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "send_email":
        return {
          id: n.id,
          tipo: "send_email",
          config: {
            ...(d.channelAccountId ? { channelAccountId: d.channelAccountId } : {}),
            subject: d.subject ?? "",
            body: d.text ?? "",
            ...(d.emailSignatureId ? { signatureId: d.emailSignatureId } : {}),
            skipIfNoEmail: d.skipIfNoEmail ?? true,
          },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "switch_flow":
        return {
          id: n.id,
          tipo: "switch_flow",
          config: { flowId: d.switchFlowId ?? "" },
          nextNodeId: null,
        };
      case "send_social":
        return {
          id: n.id,
          tipo: "send_social",
          config: {
            canal: d.socialCanal ?? "instagram",
            ...(d.channelAccountId ? { channelAccountId: d.channelAccountId } : {}),
            template: d.text ?? "",
            onNoHandle: d.onNoHandle ?? "skip",
            ...(d.aiPersonalize ? { aiPersonalize: true } : {}),
            ...(d.aiInstrucao?.trim() ? { aiInstrucao: d.aiInstrucao.trim() } : {}),
          },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "wait":
        return {
          id: n.id,
          tipo: "wait",
          config: {
            duration: d.duration ?? 1,
            unit: d.unit ?? "hour",
            // só serializa durationMax quando o modo intercalar está ativo
            ...(d.durationMax != null && d.durationMax > (d.duration ?? 1)
              ? { durationMax: d.durationMax }
              : {}),
          },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "typing":
        return {
          id: n.id,
          tipo: "typing",
          config: {
            duration: d.duration ?? 30,
            unit: d.unit === "min" ? "min" : "sec",
            ...(d.durationMax != null && d.durationMax > (d.duration ?? 30)
              ? { durationMax: d.durationMax }
              : {}),
          },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "condition":
        return {
          id: n.id,
          tipo: "condition",
          branches: {
            branches: (d.branches ?? []).map((b) => {
              // Vários destinos na mesma saída: a ordem de execução é a do mapa, de cima para baixo.
              const [primeiro, ...resto] = ordenarPorPosicao(todosDestinos(b.nextNodeId, b.maisDestinos), posicoes);
              return { id: b.id, label: b.label, condition: b.condition, nextNodeId: primeiro ?? "", ...(resto.length ? { maisDestinos: resto } : {}) };
            }),
            ...(() => {
              const [primeiro, ...resto] = ordenarPorPosicao(todosDestinos(d.defaultNext, d.defaultMais), posicoes);
              return { default: primeiro ?? null, ...(resto.length ? { defaultMais: resto } : {}) };
            })(),
          },
        };
      case "ab_split":
        return {
          id: n.id,
          tipo: "ab_split",
          branches: {
            variants: (d.variants ?? []).map((v) => ({
              id: v.id,
              label: v.label,
              weight: Math.max(0, Math.round(v.weight)),
              nextNodeId: v.nextNodeId ?? "",
            })),
          },
        };
      case "update_stage":
        return {
          id: n.id,
          tipo: "update_stage",
          config: { funnelId: d.funnelId ?? "", stageId: d.stageId ?? "" },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "create_deal":
        return {
          id: n.id,
          tipo: "create_deal",
          config: { funnelId: d.funnelId ?? "", stageId: d.stageId ?? "" },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "add_tag":
        return { id: n.id, tipo: "add_tag", config: { tag: d.tag ?? "" }, nextNodeId: d.nextNodeId ?? null };
      case "notify_user":
        return {
          id: n.id,
          tipo: "notify_user",
          config: { userId: d.userId, message: d.message ?? "" },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "http_request":
        return {
          id: n.id,
          tipo: "http_request",
          config: {
            method: d.method ?? "POST",
            url: d.url ?? "",
            headers: d.headers,
            body: d.body,
            timeoutMs: d.timeoutMs,
          },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "ai_agent":
        return {
          id: n.id,
          tipo: "ai_agent",
          config: {
            canal: "whatsapp",
            // Os dois grupos de campos ficam salvos: trocar o modo e voltar não apaga o que a pessoa escreveu.
            modo: d.aiModo ?? "mensagem",
            ...(d.orientacao ? { orientacao: d.orientacao } : {}),
            ...(d.maxRespostas != null ? { maxRespostas: d.maxRespostas } : {}),
            ...(d.silencioHoras != null ? { silencioHoras: d.silencioHoras } : {}),
            ...(d.avisarVendedor === false ? { avisarVendedor: false } : {}),
            ...(d.metodologiaId ? { metodologiaId: d.metodologiaId } : {}),
            ...(d.objetivo ? { objetivo: d.objetivo } : {}),
            ...(d.tom ? { tom: d.tom } : {}),
            ...(d.aiFallbackText ? { fallbackText: d.aiFallbackText } : {}),
            ...(d.aiMaxChars != null ? { maxChars: d.aiMaxChars } : {}),
            ...(d.channelAccountId ? { channelAccountId: d.channelAccountId } : {}),
            ...(d.skipIfHistory ? { skipIfHistory: true } : {}),
            ...(d.skipIfHistory && d.onHistory ? { onHistory: d.onHistory } : {}),
            ...(d.provider ? { provider: d.provider } : {}),
            ...(d.model ? { model: d.model } : {}),
            ...(d.temperature != null ? { temperature: d.temperature } : {}),
          },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "manual_call":
        return {
          id: n.id,
          tipo: "manual_call",
          config: { ...(d.roteiro ? { roteiro: d.roteiro } : {}) },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "sync_name":
        return {
          id: n.id,
          tipo: "sync_name",
          config: { ...(d.overwrite ? { overwrite: true } : {}) },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "save_history":
        return {
          id: n.id,
          tipo: "save_history",
          config: { ...(d.channelAccountId ? { channelAccountId: d.channelAccountId } : {}) },
          nextNodeId: d.nextNodeId ?? null,
        };
      case "enrich_data":
        return { id: n.id, tipo: "enrich_data", config: {}, nextNodeId: d.nextNodeId ?? null };
      case "enrich_company":
        return { id: n.id, tipo: "enrich_company", config: {}, nextNodeId: d.nextNodeId ?? null };
      case "enrich_person":
        return { id: n.id, tipo: "enrich_person", config: { ...(d.incluirConfiancaMedia ? { incluirConfiancaMedia: true } : {}) }, nextNodeId: d.nextNodeId ?? null };
      case "end":
        return { id: n.id, tipo: "end", config: null, nextNodeId: null };
    }
  });
}

/** Carrega nós do flow (vindos do DB) no shape do builder, com layout inicial. */
export function fromFlowNodes(
  nodes: Array<{
    id: string;
    tipo: FlowNodeType;
    config: unknown;
    nextNodeId: string | null;
    branches: unknown;
    posX?: number | null;
    posY?: number | null;
  }>,
): BuilderNode[] {
  return nodes.map((n, i) => {
    // Usa a posição PERSISTIDA. Só cai na grade por índice quando o nó ainda não
    // tem posição salva (rows legadas) — antes, ignorar a posição salva era o que
    // "desordenava tudo" a cada salvar/recarregar.
    const position =
      n.posX != null && n.posY != null
        ? { x: n.posX, y: n.posY }
        : { x: 40 + (i % 3) * 300, y: 40 + Math.floor(i / 3) * 160 };
    const base: BuilderNode = {
      id: n.id,
      type: n.tipo,
      position,
      data: defaultNodeData(n.tipo),
    };
    const cfg = (n.config ?? {}) as Record<string, unknown>;
    const d = base.data;
    switch (n.tipo) {
      case "send_message":
        d.text = (cfg.text as string) ?? "";
        d.channelAccountId = cfg.channelAccountId as string | undefined;
        d.skipIfHistory = (cfg.skipIfHistory as boolean) ?? false;
        d.onHistory = (cfg.onHistory as NodeData["onHistory"]) ?? "skip";
        d.nextNodeId = n.nextNodeId;
        break;
      case "send_email":
        d.channelAccountId = cfg.channelAccountId as string | undefined;
        d.subject = (cfg.subject as string) ?? "";
        d.text = (cfg.body as string) ?? "";
        d.emailSignatureId = (cfg.signatureId as string | undefined) ?? undefined;
        d.skipIfNoEmail = (cfg.skipIfNoEmail as boolean) ?? true;
        d.nextNodeId = n.nextNodeId;
        break;
      case "switch_flow":
        d.switchFlowId = (cfg.flowId as string) ?? "";
        d.nextNodeId = null;
        break;
      case "send_social":
        d.socialCanal = (cfg.canal as NodeData["socialCanal"]) ?? "instagram";
        d.channelAccountId = cfg.channelAccountId as string | undefined;
        d.text = (cfg.template as string) ?? "";
        d.onNoHandle = (cfg.onNoHandle as NodeData["onNoHandle"]) ?? "skip";
        d.aiPersonalize = Boolean(cfg.aiPersonalize);
        d.aiInstrucao = (cfg.aiInstrucao as string | undefined) ?? "";
        d.nextNodeId = n.nextNodeId;
        break;
      case "wait":
        d.duration = (cfg.duration as number) ?? 1;
        d.unit = (cfg.unit as NodeData["unit"]) ?? "hour";
        d.durationMax = (cfg.durationMax as number | undefined) ?? null;
        d.nextNodeId = n.nextNodeId;
        break;
      case "typing":
        d.duration = (cfg.duration as number) ?? 30;
        d.unit = (cfg.unit as NodeData["unit"]) ?? "sec";
        d.durationMax = (cfg.durationMax as number | undefined) ?? null;
        d.nextNodeId = n.nextNodeId;
        break;
      case "condition": {
        const br = (n.branches ?? { branches: [], default: null }) as {
          branches?: Array<{ id: string; label: string; condition: BranchDef["condition"]; nextNodeId: string; maisDestinos?: string[] }>;
          default?: string | null;
          defaultMais?: string[];
        };
        d.branches = (br.branches ?? []).map((b) => ({ ...b, nextNodeId: b.nextNodeId || null }));
        d.defaultNext = br.default ?? null;
        d.defaultMais = br.defaultMais ?? [];
        break;
      }
      case "ab_split": {
        const br = (n.branches ?? { variants: [] }) as {
          variants?: Array<{ id: string; label: string; weight: number; nextNodeId: string }>;
        };
        d.variants = (br.variants ?? []).map((v) => ({ ...v, nextNodeId: v.nextNodeId || null }));
        break;
      }
      case "update_stage":
      case "create_deal":
        d.funnelId = cfg.funnelId as string | undefined;
        d.stageId = cfg.stageId as string | undefined;
        d.nextNodeId = n.nextNodeId;
        break;
      case "add_tag":
        d.tag = (cfg.tag as string) ?? "";
        d.nextNodeId = n.nextNodeId;
        break;
      case "notify_user":
        d.userId = cfg.userId as string | undefined;
        d.message = (cfg.message as string) ?? "";
        d.nextNodeId = n.nextNodeId;
        break;
      case "http_request":
        d.method = (cfg.method as NodeData["method"]) ?? "POST";
        d.url = (cfg.url as string) ?? "";
        d.headers = cfg.headers as Record<string, string> | undefined;
        d.body = cfg.body as string | undefined;
        d.timeoutMs = cfg.timeoutMs as number | undefined;
        d.nextNodeId = n.nextNodeId;
        break;
      case "ai_agent":
        d.aiModo = (cfg.modo as NodeData["aiModo"]) ?? "mensagem";
        d.orientacao = (cfg.orientacao as string) ?? "";
        d.maxRespostas = cfg.maxRespostas as number | undefined;
        d.silencioHoras = cfg.silencioHoras as number | undefined;
        d.avisarVendedor = (cfg.avisarVendedor as boolean) ?? true;
        d.metodologiaId = cfg.metodologiaId as string | undefined;
        d.objetivo = (cfg.objetivo as string) ?? "";
        d.tom = (cfg.tom as string) ?? "";
        d.aiFallbackText = (cfg.fallbackText as string) ?? "";
        d.aiMaxChars = cfg.maxChars as number | undefined;
        d.channelAccountId = cfg.channelAccountId as string | undefined;
        d.skipIfHistory = (cfg.skipIfHistory as boolean) ?? false;
        d.onHistory = cfg.onHistory as NodeData["onHistory"];
        d.provider = (cfg.provider as NodeData["provider"]) ?? undefined;
        d.model = (cfg.model as string) ?? "";
        d.temperature = cfg.temperature as number | undefined;
        d.nextNodeId = n.nextNodeId;
        break;
      case "manual_call":
        d.roteiro = (cfg.roteiro as string) ?? "";
        d.nextNodeId = n.nextNodeId;
        break;
      case "sync_name":
        d.overwrite = (cfg.overwrite as boolean) ?? false;
        d.nextNodeId = n.nextNodeId;
        break;
      case "save_history":
        d.channelAccountId = cfg.channelAccountId as string | undefined;
        d.nextNodeId = n.nextNodeId;
        break;
      case "enrich_data":
      case "enrich_company":
        d.nextNodeId = n.nextNodeId;
        break;
      case "enrich_person":
        d.incluirConfiancaMedia = (cfg.incluirConfiancaMedia as boolean) ?? false;
        d.nextNodeId = n.nextNodeId;
        break;
      case "end":
        d.nextNodeId = null;
        break;
    }
    return base;
  });
}

export type DerivedEdge = {
  id: string;
  source: string;
  target: string;
  /** Qual saída do nó originou a ligação: id do branch, "default", ou "out". */
  sourceHandle: string;
  label?: string;
  animated?: boolean;
};

/**
 * Computa edges de visualização a partir dos destinos lógicos.
 *
 * `sourceHandle` é o que permite o caminho inverso: ao apagar uma edge no
 * canvas, o editor sabe QUAL destino limpar (o branch X, o "senão", ou o
 * nextNodeId linear). Sem isso não dá pra desfazer ligação de nó condition,
 * que tem várias saídas para o mesmo alvo possível.
 */
export function deriveEdges(nodes: BuilderNode[]): DerivedEdge[] {
  const edges: DerivedEdge[] = [];
  for (const n of nodes) {
    const d = n.data;
    if (d.tipo === "condition") {
      // Cada destino da saída vira uma seta. A do principal tem o id de sempre; as outras levam `~<destino>`.
      for (const b of d.branches ?? []) {
        todosDestinos(b.nextNodeId, b.maisDestinos).forEach((alvo, i) =>
          edges.push({ id: i === 0 ? `e_${n.id}_${b.id}` : `e_${n.id}_${b.id}~${alvo}`, source: n.id, target: alvo, sourceHandle: b.id, label: b.label }),
        );
      }
      todosDestinos(d.defaultNext, d.defaultMais).forEach((alvo, i) =>
        edges.push({ id: i === 0 ? `e_${n.id}_default` : `e_${n.id}_default~${alvo}`, source: n.id, target: alvo, sourceHandle: "default", label: "senão", animated: true }),
      );
    } else if (d.tipo === "ab_split") {
      const total = (d.variants ?? []).reduce((s, v) => s + Math.max(0, v.weight), 0) || 1;
      for (const v of d.variants ?? []) {
        if (v.nextNodeId)
          edges.push({
            id: `e_${n.id}_${v.id}`,
            source: n.id,
            target: v.nextNodeId,
            sourceHandle: v.id,
            label: `${v.label} ${Math.round((Math.max(0, v.weight) / total) * 100)}%`,
          });
      }
    } else if (d.nextNodeId) {
      edges.push({ id: `e_${n.id}`, source: n.id, target: d.nextNodeId, sourceHandle: "out" });
    }
  }
  return edges;
}
