"use server";

import { mensagemParaTela } from "@/lib/erros";
import { ZodError } from "zod";
import { revalidatePath } from "next/cache";
import { requireRoleAction, acaoDaTela } from "@/lib/tenant";
import { planilhaParaCsv } from "@/lib/planilha";
import {
  cancelCampaign,
  CampaignNaoPodeIniciar,
  createCampaign,
  estimate,
  getCampaign,
  liberarSegurados,
  linhasDaPlanilha,
  listarDestinatarios,
  listCampaigns,
  pauseCampaign,
  prepararLista,
  previewMessage,
  resumeCampaign,
  saveStep,
  startCampaign,
  type CampaignDTO,
  type EtapaCampanha,
  type PaginaDeDestinatarios,
  type Previsao,
  list as listarContatosDoPicker,
  count as contarContatosDoPicker,
  listContactIds,
  listTags,
  primaryTelefone,
  definirCompartilhado,
} from "@crmagro/core";
import type { RecipientStatus } from "@prisma/client";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "campanhas". */
const runAsUserAction = acaoDaTela("campanhas");
/**
 * Campanhas (produto §A.6). As actions só autenticam, convertem a borda
 * (arquivo → linhas) e chamam o core — as regras, o papel (`campaigns.write`
 * e `campaigns.start`, os dois member — decisão do dono) e o isolamento por time ficam lá. Nada aqui
 * envia mensagem: iniciar só liga a corrente de ticks do worker (A.3).
 */

type Erro = { ok: false; error: string; motivos?: string[] };
export type CampaignState = { ok: true; campaign: CampaignDTO } | Erro;

/** Mensagem de erro para a tela (erros nomeados do core e da borda). */
function erro(e: unknown): Erro {
  if (e instanceof CampaignNaoPodeIniciar) return { ok: false, error: "a campanha ainda não pode começar", motivos: e.motivos };
  if (e instanceof ZodError) return { ok: false, error: e.issues.map((i) => i.message).join("; ") };
  if (e instanceof SyntaxError) return { ok: false, error: "dados inválidos" };
  return { ok: false, error: mensagemParaTela(e, { semPrefixo: true }) };
}

async function comCampanha(fn: () => Promise<CampaignDTO>): Promise<CampaignState> {
  try {
    const campaign = await runAsUserAction(fn);
    revalidatePath("/campanhas");
    return { ok: true, campaign };
  } catch (e) {
    return erro(e);
  }
}

export async function listCampaignsAction(): Promise<CampaignDTO[]> {
  return runAsUserAction(async () => listCampaigns());
}

export async function getCampaignAction(id: string): Promise<CampaignState> {
  try {
    return { ok: true, campaign: await runAsUserAction(async () => getCampaign(id)) };
  } catch (e) {
    return erro(e);
  }
}

export async function createCampaignAction(nome: string): Promise<CampaignState> {
  return comCampanha(async () => {
    const c = await createCampaign(nome);
    return getCampaign(c.id);
  });
}

/** Salva uma etapa (1 lista · 2 mensagem · 3 ritmo). `dados` é validado no core. */
export async function saveStepAction(id: string, etapa: EtapaCampanha, dados: unknown): Promise<CampaignState> {
  return comCampanha(async () => {
    await saveStep(id, etapa, dados);
    return getCampaign(id);
  });
}

/**
 * Lista da campanha. `formData`: `campaignId` e UM destes — `file` (planilha
 * .xlsx/.csv), `texto` (números colados, um por linha, "nome; telefone") ou
 * `contactIds` (JSON, contatos escolhidos na tela de Contatos). A montagem
 * roda em segundo plano: a tela acompanha `campaign.lista.estado`.
 */
export async function uploadListAction(formData: FormData): Promise<CampaignState> {
  const id = String(formData.get("campaignId") ?? "");
  if (!id) return { ok: false, error: "campaignId obrigatório" };
  const file = formData.get("file");
  const texto = formData.get("texto");
  const ids = formData.get("contactIds");
  try {
    // Papel e TELA antes de ler a planilha (auditorias do #126 e do #150):
    // converter até 20 MB para depois recusar era trabalho de graça.
    await requireRoleAction("member");
    await runAsUserAction(async () => undefined);
    let origem: unknown;
    if (file instanceof File && file.size > 0) {
      const linhas = linhasDaPlanilha(await planilhaParaCsv(file));
      origem = { tipo: "planilha", arquivo: file.name.slice(0, 200), linhas };
    } else if (typeof texto === "string" && texto.trim()) {
      origem = { tipo: "colados", texto };
    } else if (typeof ids === "string" && ids) {
      origem = { tipo: "filtro", contactIds: JSON.parse(ids) as unknown };
    } else {
      return { ok: false, error: "envie uma planilha, cole os números ou escolha os contatos" };
    }
    return comCampanha(async () => {
      await prepararLista(id, origem);
      return getCampaign(id);
    });
  } catch (e) {
    return erro(e);
  }
}

export type PreviaState = { ok: true; texto: string | null; variacao: number | null } | Erro;

/** Prévia da mensagem para um contato real (null = segura: retomada sem texto). */
export async function previewMessageAction(campaignId: string, contactId: string): Promise<PreviaState> {
  try {
    const p = await runAsUserAction(async () => previewMessage(campaignId, contactId));
    return { ok: true, texto: p?.texto ?? null, variacao: p?.variacao ?? null };
  } catch (e) {
    return erro(e);
  }
}

export type PrevisaoState = { ok: true; previsao: Previsao } | Erro;

export async function estimateAction(campaignId: string): Promise<PrevisaoState> {
  try {
    return { ok: true, previsao: await runAsUserAction(async () => estimate(campaignId)) };
  } catch (e) {
    return erro(e);
  }
}

/** Iniciar (member ou acima). Erro de pré-requisito volta com `motivos` para a tela listar. */
export async function startCampaignAction(id: string): Promise<CampaignState> {
  return comCampanha(async () => startCampaign(id));
}

export async function pauseCampaignAction(id: string): Promise<CampaignState> {
  return comCampanha(async () => pauseCampaign(id, "pausada pela equipe"));
}

export async function resumeCampaignAction(id: string): Promise<CampaignState> {
  return comCampanha(async () => resumeCampaign(id));
}

export async function cancelCampaignAction(id: string): Promise<CampaignState> {
  return comCampanha(async () => cancelCampaign(id));
}

export type LiberarState = { ok: true; liberados: number } | Erro;

/** Libera segurados (member ou acima): `ids` da tela ou "todos". */
export async function liberarSeguradosAction(campaignId: string, ids: string[] | "todos"): Promise<LiberarState> {
  try {
    const r = await runAsUserAction(async () => liberarSegurados(campaignId, ids));
    revalidatePath("/campanhas");
    return { ok: true, ...r };
  } catch (e) {
    return erro(e);
  }
}

export type DestinatariosState = { ok: true; pagina: PaginaDeDestinatarios } | Erro;

/** Destinatários por status (segurados, respostas, próximos envios…), paginados. */
export async function listarDestinatariosAction(
  campaignId: string,
  opts: { status?: RecipientStatus[]; cursor?: string } = {},
): Promise<DestinatariosState> {
  try {
    return { ok: true, pagina: await runAsUserAction(async () => listarDestinatarios(campaignId, opts)) };
  } catch (e) {
    return erro(e);
  }
}

export type ContatoDoPicker = { id: string; nome: string; telefone: string | null };

/** Filtro do seletor de contatos da campanha: busca por texto e/ou uma tag. */
export type FiltroDoPicker = { search?: string; tag?: string };

/** Contatos carregados por vez no seletor ("Carregar mais" traz a próxima página). */
const PAGINA_DO_PICKER = 100;
/** Mesmo teto da lista da campanha (`origemListaSchema`). */
const MAXIMO_DA_LISTA = 5000;

function filtroDoPicker(f: FiltroDoPicker) {
  return { search: f.search?.trim() || undefined, tag: f.tag || undefined };
}

/**
 * Contatos para a lista manual da campanha (o assistente de campanha). Antes
 * vinha de `conversas/actions` — e o arquivo inteiro de Conversas ficava
 * chamável a partir de /campanhas (revisão do #150). Agora é desta tela.
 * Paginado por `offset`, com o total do filtro para o "Selecionar todos".
 */
export async function listContatosParaCampanhaAction(
  filtro: FiltroDoPicker = {},
  offset = 0,
): Promise<{ items: ContatoDoPicker[]; total: number; temMais: boolean }> {
  return runAsUserAction(async () => {
    const f = filtroDoPicker(filtro);
    const [pagina, total] = await Promise.all([listarContatosDoPicker({ ...f, limit: PAGINA_DO_PICKER, offset }), contarContatosDoPicker(f)]);
    return {
      items: pagina.items.map((c) => ({ id: c.id, nome: c.nome, telefone: primaryTelefone(c.identifiers) })),
      total,
      temMais: pagina.hasMore,
    };
  });
}

export type IdsDoPickerState = { ok: true; ids: string[] } | Erro;

/** Todos os contatos do filtro, para "Selecionar todos" (até o teto da lista). */
export async function idsParaCampanhaAction(filtro: FiltroDoPicker = {}): Promise<IdsDoPickerState> {
  try {
    const ids = await runAsUserAction(async () => listContactIds(filtroDoPicker(filtro)));
    if (ids.length > MAXIMO_DA_LISTA) {
      return { ok: false, error: `são ${ids.length} contatos e a campanha aceita até ${MAXIMO_DA_LISTA}. Filtre por tag ou busca.` };
    }
    return { ok: true, ids };
  } catch (e) {
    if (e instanceof Error && e.name === "BuscaGrandeDemais") return { ok: false, error: "a busca achou contatos demais. Refine o texto." };
    return erro(e);
  }
}

/** Tags do time, para o filtro do seletor. */
export async function tagsParaCampanhaAction(): Promise<{ id: string; nome: string; count: number }[]> {
  return runAsUserAction(async () => (await listTags()).map((t) => ({ id: t.id, nome: t.nome, count: t.count })));
}

/** "Compartilhar com o time" / "Só o dono" de uma campanha (F4): o dono ou o administrador. */
export async function compartilharCampanhaAction(id: string, compartilhado: boolean): Promise<{ ok?: boolean; error?: string }> {
  try {
    await runAsUserAction(() => definirCompartilhado("campaign", id, compartilhado));
    revalidatePath("/campanhas");
    return { ok: true };
  } catch (e) {
    const n = e instanceof Error ? e.name : "";
    if (n === "SoODonoCompartilha") return { error: "Só quem criou (ou o administrador) muda o compartilhamento." };
    if (n === "ForbiddenError") return { error: "Acesso negado" };
    return { error: mensagemParaTela(e) };
  }
}
