import {
  Send,
  Clock,
  PenLine,
  GitBranch,
  KanbanSquare,
  Tag,
  Bell,
  Webhook,
  Bot,
  CircleStop,
  SquarePlus,
  Split,
  PhoneCall,
  UserCheck,
  History,
  Database,
  Building2,
  UserSearch,
  Mail,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { FlowNodeType } from "@prisma/client";

/** Metadata visual por tipo de nó (segue crmagro-design: cor semântica). */
export const NODE_META: Record<
  FlowNodeType,
  { label: string; icon: LucideIcon; accent: string; badge?: string }
> = {
  // Fundos translúcidos sobre bg-card (theme-aware): brand-500/warning-500 são
  // sobrescritos no dark, então o tint adapta e o texto (foreground) mantém
  // contraste nos dois temas (crmagro-design §4/§7). bg-card garante a base.
  send_message: { label: "Enviar mensagem", icon: Send, accent: "border-brand-500/50 bg-card" },
  send_email: { label: "Enviar e-mail", icon: Mail, accent: "border-brand-500/50 bg-card" },
  send_social: { label: "Enviar DM (social)", icon: Send, accent: "border-brand-500/50 bg-card" },
  switch_flow: { label: "Mudar de fluxo", icon: Workflow, accent: "border-warning-500/50 bg-card" },
  wait: { label: "Esperar", icon: Clock, accent: "border-border bg-card" },
  typing: { label: "Digitando…", icon: PenLine, accent: "border-border bg-card" },
  condition: { label: "Condição", icon: GitBranch, accent: "border-warning-500/50 bg-card" },
  ab_split: { label: "Teste A/B", icon: Split, accent: "border-warning-500/50 bg-card" },
  update_stage: { label: "Mover etapa", icon: KanbanSquare, accent: "border-brand-500/50 bg-card" },
  create_deal: { label: "Criar card", icon: SquarePlus, accent: "border-brand-500/50 bg-card" },
  add_tag: { label: "Adicionar tag", icon: Tag, accent: "border-border bg-card" },
  notify_user: { label: "Notificar", icon: Bell, accent: "border-border bg-card" },
  http_request: { label: "HTTP", icon: Webhook, accent: "border-border bg-card" },
  ai_agent: { label: "Agente IA", icon: Bot, accent: "border-brand-500/50 bg-card", badge: "IA" },
  manual_call: { label: "Ligação manual", icon: PhoneCall, accent: "border-warning-500/50 bg-card", badge: "trava o passo" },
  sync_name: { label: "Atualizar nome (WhatsApp)", icon: UserCheck, accent: "border-brand-500/50 bg-card" },
  save_history: { label: "Registrar conversa no histórico", icon: History, accent: "border-brand-500/50 bg-card" },
  enrich_data: { label: "Enriquecer dados (antigo)", icon: Database, accent: "border-warning-500/50 bg-card", badge: "antigo" },
  enrich_company: { label: "Enriquecer empresa", icon: Building2, accent: "border-brand-500/50 bg-card" },
  enrich_person: { label: "Enriquecer pessoa", icon: UserSearch, accent: "border-brand-500/50 bg-card" },
  end: { label: "Fim", icon: CircleStop, accent: "border-border bg-card" },
};

export const NODE_TYPES: FlowNodeType[] = [
  "send_message",
  "send_email",
  "send_social",
  "switch_flow",
  "typing",
  "wait",
  "condition",
  "ab_split",
  "create_deal",
  "update_stage",
  "add_tag",
  "notify_user",
  "http_request",
  "manual_call",
  "sync_name",
  "save_history",
  "enrich_data",
  "enrich_company",
  "enrich_person",
  "ai_agent",
  "end",
];

/**
 * Passos que foram substituídos por outros e só continuam existindo para os fluxos que já os têm: seguem
 * renderizando e rodando, mas NÃO aparecem na paleta de novos passos. "Enriquecer dados" virou dois:
 * Enriquecer empresa e Enriquecer pessoa.
 */
export const NOS_ANTIGOS: ReadonlySet<string> = new Set(["enrich_data"]);

/** Rótulo legível do nó a partir do tipo (para o seletor de destino). */
export function nodeLabel(tipo: string, index: number): string {
  const meta = NODE_META[tipo as keyof typeof NODE_META];
  return `${index + 1}. ${meta?.label ?? tipo}`;
}
