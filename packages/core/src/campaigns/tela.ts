import type { RecipientStatus } from "@prisma/client";
import { db } from "@crmagro/db";
import { lerPlanilha, sugerirMapeamento } from "../importacao/planilha";
import { codificarCursor, decodificarCursor } from "../shared/cursor-keyset";
import { MAX_LINHAS_DA_LISTA, ListaGrandeDemais, CampaignNotFound } from "./service";
import { escopoCampanha } from "./escopo";

/**
 * Leituras e conversões que só a TELA das Campanhas usa (produto §A.6): a
 * planilha enviada vira as linhas da lista, e as listas "segurados",
 * "respostas", "próximos envios" são páginas de destinatários com o contato.
 */

/** Linha da lista vinda de planilha (o que a campanha usa do contato). */
export type LinhaDaPlanilha = { telefone: string; nome?: string; empresa?: string; cidade?: string };

/** Planilha sem coluna de telefone/WhatsApp reconhecível. */
export class PlanilhaSemTelefone extends Error {
  constructor() {
    super("PlanilhaSemTelefone: a planilha não tem coluna de telefone/WhatsApp.");
    this.name = "PlanilhaSemTelefone";
  }
}

/**
 * Texto CSV (a borda já converteu o .xlsx) → linhas da lista. Usa o MESMO
 * leitor e a mesma sugestão de colunas da importação (produto §C): telefone =
 * a coluna "whatsapp"; nome, empresa e cidade quando houver.
 */
export function linhasDaPlanilha(texto: string): LinhaDaPlanilha[] {
  const planilha = lerPlanilha(texto);
  const mapa = sugerirMapeamento(planilha.colunas);
  const col = (campo: string) => mapa.findIndex((c) => c === campo);
  const tel = col("whatsapp");
  if (tel < 0) throw new PlanilhaSemTelefone();
  const [nome, empresa, cidade] = [col("nome"), col("empresa"), col("cidade")];
  const valor = (celulas: string[], i: number) => (i >= 0 ? (celulas[i] ?? "").trim().slice(0, 120) : "");
  const out: LinhaDaPlanilha[] = [];
  for (const { celulas } of planilha.linhas) {
    const telefone = valor(celulas, tel).slice(0, 40);
    if (!telefone) continue;
    const n = valor(celulas, nome);
    const e = valor(celulas, empresa);
    const c = valor(celulas, cidade).slice(0, 80);
    out.push({ telefone, ...(n ? { nome: n } : {}), ...(e ? { empresa: e } : {}), ...(c ? { cidade: c } : {}) });
  }
  if (out.length > MAX_LINHAS_DA_LISTA) throw new ListaGrandeDemais(out.length);
  return out;
}

export type DestinatarioDTO = {
  id: string;
  contactId: string;
  nome: string;
  telefone: string | null;
  status: RecipientStatus;
  motivo: string | null;
  classificacao: string | null;
  scheduledAt: Date | null;
  sentAt: Date | null;
  repliedAt: Date | null;
};

export type PaginaDeDestinatarios = { items: DestinatarioDTO[]; nextCursor: string | null };

/**
 * Destinatários de uma campanha, por status (ex.: `held` para "segurados",
 * `replied` para "respostas", `queued` para "próximos envios"), com o nome do
 * contato. Keyset por (createdAt, id); roda no contexto do time.
 */
export async function listarDestinatarios(
  campaignId: string,
  opts: { status?: RecipientStatus[]; cursor?: string; take?: number } = {},
): Promise<PaginaDeDestinatarios> {
  const prisma = db();
  const existe = await prisma.campaign.count({ where: { AND: [{ id: campaignId }, escopoCampanha()] } });
  if (!existe) throw new CampaignNotFound(campaignId);
  const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
  const depois = opts.cursor ? decodificarCursor(opts.cursor) : null;
  const linhas = await prisma.campaignRecipient.findMany({
    where: {
      campaignId,
      ...(opts.status?.length ? { status: { in: opts.status } } : {}),
      ...(depois?.em
        ? { OR: [{ createdAt: { gt: depois.em } }, { createdAt: depois.em, id: { gt: depois.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: take + 1,
    select: {
      id: true,
      contactId: true,
      telefone: true,
      status: true,
      motivo: true,
      classificacao: true,
      scheduledAt: true,
      sentAt: true,
      repliedAt: true,
      createdAt: true,
      contact: { select: { nome: true } },
    },
  });
  const temMais = linhas.length > take;
  const pagina = temMais ? linhas.slice(0, take) : linhas;
  const ultima = pagina[pagina.length - 1];
  return {
    items: pagina.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      nome: r.contact.nome,
      telefone: r.telefone,
      status: r.status,
      motivo: r.motivo,
      classificacao: r.classificacao,
      scheduledAt: r.scheduledAt,
      sentAt: r.sentAt,
      repliedAt: r.repliedAt,
    })),
    nextCursor: temMais && ultima ? codificarCursor({ em: ultima.createdAt, id: ultima.id }) : null,
  };
}
