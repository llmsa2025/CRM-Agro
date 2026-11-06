import type { CampaignStatus, RecipientStatus } from "@prisma/client";
import type { CampaignDTO } from "@crmagro/core";
import type { StatusTone } from "@/components/ui/status-dot";

/** Dicionário único de status da campanha (identidade v2: ponto + texto). */
export const STATUS_CAMPANHA: Record<CampaignStatus, { label: string; tone: StatusTone }> = {
  draft: { label: "Rascunho", tone: "attention" },
  scheduled: { label: "Agendada", tone: "info" },
  sending: { label: "Enviando", tone: "ok" },
  paused: { label: "Pausada", tone: "attention" },
  done: { label: "Concluída", tone: "done" },
  canceled: { label: "Cancelada", tone: "done" },
};

/** Classificação da resposta (IA, produto §A.5). */
export const CLASSIFICACAO: Record<string, { label: string; tone: StatusTone }> = {
  interessada: { label: "Interessada", tone: "ok" },
  pediu_depois: { label: "Pediu para depois", tone: "info" },
  duvida: { label: "Dúvida", tone: "attention" },
  saiu: { label: "Saiu da lista", tone: "error" },
  outro: { label: "Respondeu", tone: "ok" },
};

export const ETAPAS = ["Lista", "Mensagem", "Ritmo", "Revisar"] as const;

type Contagem = CampaignDTO["contagem"];
const n = (c: Contagem, k: RecipientStatus) => c[k] ?? 0;

/** Números derivados da contagem por status do destinatário. */
export function numeros(c: Contagem) {
  const naFila = n(c, "queued") + n(c, "sending");
  const responderam = n(c, "replied");
  const sairam = n(c, "opted_out");
  const lidas = n(c, "read") + responderam + sairam;
  const entregues = n(c, "delivered") + lidas;
  const enviadas = n(c, "sent") + entregues;
  const segurados = n(c, "held");
  const pulados = n(c, "skipped");
  const falhas = n(c, "failed");
  const total = naFila + enviadas + segurados + pulados + falhas;
  return { naFila, enviadas, entregues, lidas, responderam, sairam, segurados, pulados, falhas, total };
}

export function pct(parte: number, todo: number): number {
  return todo > 0 ? Math.round((parte / todo) * 100) : 0;
}

const DataCurta = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });
const Hora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
const DiaKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });

/** "qua, 30/09" · "hoje, 14:32" */
export function quando(d: Date | string | null | undefined, comHora = false): string {
  if (!d) return "—";
  const data = typeof d === "string" ? new Date(d) : d;
  const dia = DiaKey.format(data) === DiaKey.format(new Date()) ? "hoje" : DataCurta.format(data).replace(".", "");
  return comHora ? `${dia}, ${Hora.format(data)}` : dia;
}

export function hora(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return Hora.format(typeof d === "string" ? new Date(d) : d);
}

/** Origem da lista para o subtítulo: "310 contatos · planilha produtores-mt.xlsx". */
export function origemDaLista(c: CampaignDTO): string {
  const t = c.lista?.tipo;
  if (t === "planilha") return `planilha ${c.lista?.arquivo ?? ""}`.trim();
  if (t === "colados") return "números colados";
  if (t === "filtro") return "contatos escolhidos";
  return "sem lista";
}
