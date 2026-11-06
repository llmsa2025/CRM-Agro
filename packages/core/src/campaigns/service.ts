import { createHash, randomUUID } from "node:crypto";
import type { Campaign, Prisma, RecipientStatus } from "@prisma/client";
import { db, getCurrentTeamId, tenantData } from "@crmagro/db";
import { ondeIdentificadorExato, valorDe } from "../contacts/identificadores-cifra";
import { env } from "@crmagro/config";
import { hasWhatsAppHistory, normalizePhone, phoneVariants } from "@crmagro/channels";
import { requireCan } from "../auth/authz";
import { assertOwned, assertOwnedMany } from "../tenancy/assert-owned";
import { renderTemplate, type ContactVars } from "../flows/executor";
import { writeContact } from "../contacts/write";
import { logger } from "../logger/index";
import {
  etapaListaSchema,
  campanhaDaRegra,
  etapaMensagemSchema,
  etapaRitmoSchema,
  nomeCampanhaSchema,
  origemListaSchema,
  type OrigemLista,
  type RegraJaConversou,
} from "./schema";
import { temWhatsApp } from "./tem-whatsapp";
import { agendarMontagemDaLista } from "./queue";
import { carregarVariaveis } from "./variaveis";
import { escopoCampanha } from "./escopo";
import type { UsoDoEscopo } from "../tenancy/escopo";
import { deOutroResponsavel, quemAge } from "../contacts/responsavel";
import { ContatoJaCadastrado } from "../contacts/errors";

/**
 * Campanhas — core (produto §A.2). Campanha = UMA mensagem para uma LISTA, com
 * RITMO. Aqui: rascunho por etapas, montagem e classificação da lista, prévia
 * da mensagem e os segurados. O envio (ticks) é do worker (A.3); o
 * início/pausa/retomada e a resposta, do A.2b.
 *
 * Tudo no contexto do time (`db()`); ids vindos da tela passam por
 * `assertOwned` antes de virar FK (§12g).
 */

// ─── Erros nomeados ─────────────────────────────────────────────────────────

export class CampaignNotFound extends Error {
  constructor(readonly campaignId: string) {
    super(`CampaignNotFound: campanha ${campaignId} não encontrada neste time.`);
    this.name = "CampaignNotFound";
  }
}

/** A etapa não pode mudar no estado atual (ex.: lista de campanha já iniciada). */
export class CampaignNaoEditavel extends Error {
  constructor(readonly status: string, oQue: string) {
    super(`CampaignNaoEditavel: ${oQue} não pode mudar com a campanha "${status}".`);
    this.name = "CampaignNaoEditavel";
  }
}

// ─── Rascunho ───────────────────────────────────────────────────────────────

export async function createCampaign(nome: string): Promise<Campaign> {
  const ator = requireCan("campaigns.write");
  return db().campaign.create({
    data: tenantData<Prisma.CampaignUncheckedCreateInput>({
      nome: nomeCampanhaSchema.parse(nome),
      createdById: ator.system ? null : ator.userId,
    }),
  });
}

async function campanhaDoTime(id: string, uso: UsoDoEscopo = {}): Promise<Campaign> {
  // F3: e do escopo de quem pede (as dele + as compartilhadas; o sistema vê todas).
  const c = await db().campaign.findFirst({ where: { AND: [{ id }, escopoCampanha()] } });
  if (!c) throw new CampaignNotFound(id);
  // Escrita: com "Ver de todos" em Campanhas, lê a do colega mas não altera.
  if (uso.escrita) await assertOwned("campaign", id);
  return c;
}

/** Lista só muda no rascunho; mensagem e ritmo, também com a campanha pausada/agendada. */
const EDITAVEL_LISTA = new Set(["draft"]);
const EDITAVEL = new Set(["draft", "scheduled", "paused"]);

export type EtapaCampanha = 1 | 2 | 3;

/**
 * Salva uma etapa do rascunho (1 lista · 2 mensagem · 3 ritmo). `dados` vem da
 * tela e é validado aqui. Avança o `etapa` (a tela abre na próxima).
 */
export async function saveStep(id: string, etapa: EtapaCampanha, dados: unknown): Promise<Campaign> {
  requireCan("campaigns.write");
  const prisma = db();
  const c = await campanhaDoTime(id, { escrita: true });
  let data: Prisma.CampaignUncheckedUpdateInput;
  if (etapa === 1) {
    if (!EDITAVEL_LISTA.has(c.status)) throw new CampaignNaoEditavel(c.status, "a lista");
    const d = etapaListaSchema.parse(dados);
    // Regra por campanha: o id vem da tela, então confere o time e o escopo (§12g). Não vale a própria campanha.
    const origem = d.regraJaConversou ? campanhaDaRegra(d.regraJaConversou) : null;
    if (origem) {
      if (origem === id) throw new CampaignNaoEditavel(c.status, "a regra (escolha outra campanha)");
      await assertOwned("campaign", origem, { leitura: true });
    }
    data = d;
  } else if (etapa === 2) {
    if (!EDITAVEL.has(c.status)) throw new CampaignNaoEditavel(c.status, "a mensagem");
    const d = etapaMensagemSchema.parse(dados);
    data = { mensagem: d.mensagem, variacoes: d.variacoes ?? [], textoRetomada: d.textoRetomada ?? null };
  } else {
    if (!EDITAVEL.has(c.status)) throw new CampaignNaoEditavel(c.status, "o ritmo");
    const d = etapaRitmoSchema.parse(dados);
    // FKs vindas da tela: conta e fluxo precisam ser do time (§12g).
    await assertOwned("channelAccount", d.channelAccountId);
    if (d.flowId) await assertOwned("flow", d.flowId);
    const conta = await prisma.channelAccount.findUnique({ where: { id: d.channelAccountId }, select: { canal: true } });
    if (conta?.canal !== "whatsapp") throw new CampaignNaoEditavel(c.status, "o número (a conta não é de WhatsApp)");
    data = { ...d, flowId: d.flowId ?? null };
  }
  const atualizada = await prisma.campaign.update({
    where: { id },
    data: { ...data, etapa: Math.max(c.etapa, Math.min(4, etapa + 1)) },
  });
  // Mudou a regra de quem já conversou com a lista pronta: reaplica nos que
  // foram classificados assim (sem remontar a lista).
  if (etapa === 1 && atualizada.regraJaConversou !== c.regraJaConversou) {
    await reaplicarRegraJaConversou(id, atualizada.regraJaConversou as RegraJaConversou);
  }
  return atualizada;
}

// ─── Leitura ────────────────────────────────────────────────────────────────

export type ContagemPorStatus = Partial<Record<RecipientStatus, number>>;

async function contagens(campaignIds: string[]): Promise<Map<string, ContagemPorStatus>> {
  const out = new Map<string, ContagemPorStatus>();
  if (campaignIds.length === 0) return out;
  const grupos = await db().campaignRecipient.groupBy({
    by: ["campaignId", "status"],
    where: { campaignId: { in: campaignIds } },
    _count: { _all: true },
  });
  for (const g of grupos) {
    const c = out.get(g.campaignId) ?? {};
    c[g.status] = g._count._all;
    out.set(g.campaignId, c);
  }
  return out;
}

/**
 * Campanha para a tela: sem a lista BRUTA (`listaOrigem` pode ter milhares de
 * telefones) nem o `tickToken` (estado interno do worker) — o `lista` resumido
 * cobre a tela.
 */
export type CampaignDTO = Omit<Campaign, "listaOrigem" | "tickToken"> & {
  contagem: ContagemPorStatus;
  lista: EstadoDaLista | null;
};

function comContagem(c: Campaign, contagem: ContagemPorStatus | undefined): CampaignDTO {
  const resto: Omit<Campaign, "listaOrigem" | "tickToken"> & Partial<Pick<Campaign, "listaOrigem" | "tickToken">> = { ...c };
  delete resto.listaOrigem;
  delete resto.tickToken;
  return { ...resto, contagem: contagem ?? {}, lista: lerEstadoDaLista(c.listaOrigem) };
}

export async function getCampaign(id: string): Promise<CampaignDTO> {
  const c = await campanhaDoTime(id);
  return comContagem(c, (await contagens([c.id])).get(c.id));
}

/** Campanhas do time (mais novas primeiro) com os contadores por status — 2 consultas. */
export async function listCampaigns(opts: { take?: number } = {}): Promise<CampaignDTO[]> {
  const lista = await db().campaign.findMany({
    where: escopoCampanha(), // F3
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(opts.take ?? 100, 1), 200),
  });
  const cont = await contagens(lista.map((c) => c.id));
  return lista.map((c) => comContagem(c, cont.get(c.id)));
}

// ─── Lista ──────────────────────────────────────────────────────────────────

export type ResumoDaLista = {
  linhas: number;
  invalidos: number;
  duplicados: number;
  semWhatsApp: number;
  contatosNovos: number;
  fila: number;
  segurados: number;
  pulados: number;
  porMotivo: Record<string, number>;
};

/**
 * Estado da montagem da lista, guardado em `listaOrigem` (Json): a origem, a
 * `versao` (job antigo sai sem mexer) e, quando pronta, o resumo.
 */
export type EstadoDaLista = {
  tipo: OrigemLista["tipo"];
  arquivo?: string;
  versao: string;
  estado: "processando" | "pronta" | "erro";
  resumo?: ResumoDaLista;
  erro?: string;
  /** Conta cujo WhatsApp checou o histórico (o iniciar confere que é a da campanha). */
  contaDaChecagem?: string | null;
};

export function lerEstadoDaLista(v: unknown): EstadoDaLista | null {
  const o = v as Partial<EstadoDaLista> | null;
  if (!o || typeof o !== "object" || !o.versao || !o.estado || !o.tipo) return null;
  const { tipo, arquivo, versao, estado, resumo, erro, contaDaChecagem } = o;
  return {
    tipo,
    versao,
    estado,
    ...(arquivo ? { arquivo } : {}),
    ...(resumo ? { resumo } : {}),
    ...(erro ? { erro } : {}),
    ...(contaDaChecagem !== undefined ? { contaDaChecagem } : {}),
  };
}

/** Lista colada com mais linhas que o teto (o mesmo da planilha e do filtro). */
export class ListaGrandeDemais extends Error {
  constructor(readonly linhas: number) {
    super(`ListaGrandeDemais: ${linhas} linhas (no máximo ${MAX_LINHAS_DA_LISTA} por campanha).`);
    this.name = "ListaGrandeDemais";
  }
}

/**
 * Recebe a lista da tela (colados, planilha já lida ou filtro de contatos),
 * valida e manda montar em SEGUNDO PLANO (fila `campaign`): a checagem de
 * WhatsApp, o histórico fora da plataforma e a criação dos contatos novos levam
 * minutos numa lista de milhares — não cabem numa requisição.
 */
export async function prepararLista(id: string, origem: unknown): Promise<{ versao: string }> {
  requireCan("campaigns.write");
  const prisma = db();
  const c = await campanhaDoTime(id, { escrita: true });
  if (!EDITAVEL_LISTA.has(c.status)) throw new CampaignNaoEditavel(c.status, "a lista");
  const o = origemListaSchema.parse(origem);
  if (o.tipo === "filtro") await assertOwnedMany("contact", o.contactIds);
  if (o.tipo === "colados") {
    const n = lerColados(o.texto).length;
    if (n > MAX_LINHAS_DA_LISTA) throw new ListaGrandeDemais(n);
  }
  const versao = randomUUID();
  await prisma.campaign.update({
    where: { id },
    data: {
      listaOrigem: { ...o, versao, estado: "processando" } as Prisma.InputJsonValue,
      etapa: Math.max(c.etapa, 2),
    },
  });
  try {
    await agendarMontagemDaLista({ teamId: c.teamId, campaignId: id, versao });
  } catch (e) {
    // Fila fora: não deixa a lista presa em "processando".
    await prisma.campaign.updateMany({
      where: { id, listaOrigem: { path: ["versao"], equals: versao } },
      data: { listaOrigem: { ...o, versao, estado: "erro", erro: "fila indisponível, tente de novo" } as Prisma.InputJsonValue },
    });
    throw e;
  }
  return { versao };
}

type Linha = { telefone: string; nome?: string; empresa?: string; cidade?: string };

/** "Nome; telefone" ou só o telefone, um por linha (vírgula/tab também separam). */
export function lerColados(texto: string): Linha[] {
  const out: Linha[] = [];
  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha) continue;
    const partes = linha.split(/[;\t,]/).map((p) => p.trim()).filter(Boolean);
    const telefone = partes.find((p) => /\d{8,}/.test(p.replace(/\D/g, ""))) ?? partes[0] ?? "";
    const nome = partes.find((p) => p !== telefone && /[a-zà-ú]/i.test(p));
    out.push({ telefone, ...(nome ? { nome } : {}) });
  }
  return out;
}

/** Dias inteiros entre duas datas (para o motivo "campanha há N dias"). */
const diasEntre = (a: Date, b: Date) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000));

const LOTE_BANCO = 1000;
/** Teto de linhas de uma lista (colados, planilha e filtro). */
export const MAX_LINHAS_DA_LISTA = 5000;
/** Consultas simultâneas de histórico na Evolution (é local, mas não martela). */
const HISTORICO_EM_PARALELO = 4;

/**
 * Conta de WhatsApp para as checagens: a da campanha, senão uma conectada do
 * time. `instancia: null` = não dá para checar o histórico no celular agora
 * (quem seria checado é SEGURADO — nunca vai para a fila sem a checagem).
 */
async function contaParaChecagem(c: Campaign): Promise<{ id: string | null; instancia: string | null }> {
  const prisma = db();
  const conta = c.channelAccountId
    ? await prisma.channelAccount.findUnique({ where: { id: c.channelAccountId }, select: { id: true, externalId: true, status: true } })
    : await prisma.channelAccount.findFirst({
        where: { canal: "whatsapp", provider: "evolution", status: "connected" },
        orderBy: { createdAt: "asc" },
        select: { id: true, externalId: true, status: true },
      });
  if (!conta) return { id: null, instancia: null };
  return { id: conta.id, instancia: conta.status === "connected" ? conta.externalId : null };
}

/**
 * Quais destes números (E.164) o time marcou como ERRADOS numa ligação
 * (`ChannelIdentifier.invalido`, produto §D). A extensão filtra pelo time.
 */
async function numerosDadosComoErrados(numeros: string[]): Promise<Set<string>> {
  const prisma = db();
  const out = new Set<string>();
  for (let i = 0; i < numeros.length; i += LOTE_BANCO) {
    const idents = await prisma.channelIdentifier.findMany({
      where: { ...ondeIdentificadorExato(getCurrentTeamId() ?? "", "whatsapp", numeros.slice(i, i + LOTE_BANCO)), invalido: true },
      select: { valor: true, valorCifrado: true },
    });
    for (const idt of idents) {
      const valor = valorDe(idt);
      if (valor) out.add(valor);
    }
  }
  return out;
}

type Classificacao = { status: RecipientStatus; motivo: string | null };

/**
 * Motivo de quem já conversou e vai na fila pela regra "enviar". Diferente de
 * "já conversou" para a troca de regra não pegar o segurado que a pessoa já
 * liberou à mão (ele fica na fila com "já conversou").
 */
const MOTIVO_JA_CONVERSOU_ENVIAR = "já conversou, mensagem normal";
/** Pulado pela regra "recebeu mensagem na campanha X". */
const MOTIVO_OUTRA_CAMPANHA = "recebeu em outra campanha";

/**
 * Quem RECEBEU mensagem da campanha `origemId`: tem `sentAt`, tenha a mensagem
 * chegado, sido lida ou respondida ou não. Quem ficou na fila, segurado ou
 * falhou sem enviar não conta (esses o dono ainda pode querer nesta campanha).
 */
async function contatosQueReceberam(origemId: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += LOTE_BANCO) {
    const linhas = await db().campaignRecipient.findMany({
      where: { campaignId: origemId, contactId: { in: ids.slice(i, i + LOTE_BANCO) }, sentAt: { not: null } },
      select: { contactId: true },
    });
    for (const l of linhas) out.add(l.contactId);
  }
  return out;
}

/** Onde vai quem já conversou, pela regra da campanha. */
function porRegra(regra: RegraJaConversou): Classificacao {
  if (regra === "skip") return { status: "skipped", motivo: "já conversou" };
  if (regra === "retomada") return { status: "queued", motivo: "retomada" };
  // "Nenhuma" e "pular quem recebeu a campanha X": quem só conversou (sem ter recebido X) segue na fila.
  if (regra === "enviar" || campanhaDaRegra(regra)) return { status: "queued", motivo: MOTIVO_JA_CONVERSOU_ENVIAR };
  return { status: "held", motivo: "já conversou" };
}

/** Também chamado ao iniciar (controle.ts): a fila sempre segue a regra gravada na campanha. */
export async function reaplicarRegraJaConversou(campaignId: string, regra: RegraJaConversou): Promise<void> {
  const alvo = porRegra(regra);
  await db().campaignRecipient.updateMany({
    where: {
      campaignId,
      OR: [
        { motivo: "já conversou", status: { in: ["held", "skipped"] } },
        { motivo: "retomada", status: "queued" },
        { motivo: MOTIVO_JA_CONVERSOU_ENVIAR, status: "queued" },
        { motivo: MOTIVO_OUTRA_CAMPANHA, status: "skipped" },
      ],
    },
    data: { status: alvo.status, motivo: alvo.motivo },
  });
  const origem = campanhaDaRegra(regra);
  if (!origem) return;
  // Regra por campanha: quem já recebeu a campanha escolhida sai da fila/segurados.
  const destinos = await db().campaignRecipient.findMany({
    where: { campaignId, status: { in: ["queued", "held"] } },
    select: { id: true, contactId: true },
  });
  const receberam = await contatosQueReceberam(origem, destinos.map((d) => d.contactId));
  const pular = destinos.filter((d) => receberam.has(d.contactId)).map((d) => d.id);
  if (pular.length) {
    await db().campaignRecipient.updateMany({ where: { id: { in: pular } }, data: { status: "skipped", motivo: MOTIVO_OUTRA_CAMPANHA } });
  }
}

/**
 * Monta e CLASSIFICA a lista (roda no worker, contexto do time como sistema).
 * `versao` diferente da gravada = job antigo (a lista foi trocada): sai.
 *
 * Por contato, na ordem: pediu para sair → pula; recebeu campanha há menos de
 * `diasSemCampanha` → pula; já conversou (status do contato, conversa na
 * plataforma ou histórico no WhatsApp da instância) → regra da campanha
 * (segurar/pular/retomada/enviar); histórico indisponível → segura; senão → fila.
 * Linhas inválidas, repetidas e sem WhatsApp só entram no resumo (não viram
 * contato nem destinatário). Refazer com a mesma versão dá o mesmo resultado.
 */
export async function montarLista(
  campaignId: string,
  versao: string,
  opts: { agora?: Date; historico?: typeof hasWhatsAppHistory } = {},
): Promise<ResumoDaLista | null> {
  // Escreve contatos e destinatários: exige papel (o worker roda como sistema).
  requireCan("campaigns.write");
  const prisma = db();
  const agora = opts.agora ?? new Date();
  const c = await prisma.campaign.findUnique({ where: { id: campaignId } });
  const estado = lerEstadoDaLista(c?.listaOrigem);
  if (!c || !estado || estado.versao !== versao || c.status !== "draft") return null;
  // Já montada (retry do job depois de gravar): o resultado é o gravado.
  if (estado.estado === "pronta" && estado.resumo) return estado.resumo;
  const origem = origemListaSchema.parse(c.listaOrigem);

  try {
    return await classificar(c, origem, versao, agora, opts.historico ?? hasWhatsAppHistory);
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    logger.error({ campaignId, err: erro }, "[campanha] falha ao montar a lista");
    await prisma.campaign.updateMany({
      where: { id: campaignId, listaOrigem: { path: ["versao"], equals: versao } },
      data: { listaOrigem: { ...origem, versao, estado: "erro", erro: "falha ao montar a lista" } as Prisma.InputJsonValue },
    });
    throw e;
  }
}

async function classificar(
  c: Campaign,
  origem: OrigemLista,
  versao: string,
  agora: Date,
  historico: typeof hasWhatsAppHistory,
): Promise<ResumoDaLista | null> {
  const prisma = db();
  const porMotivo: Record<string, number> = {};
  const contar = (m: string) => (porMotivo[m] = (porMotivo[m] ?? 0) + 1);
  let invalidos = 0;
  let duplicados = 0;
  let semWhatsApp = 0;
  let contatosNovos = 0;
  let deOutro = 0; // contatos de outro responsável (regra do dono, 28/09)
  const MOTIVO_OUTRO_RESPONSAVEL = "já cadastrado com outro responsável";
  const checagem = await contaParaChecagem(c);
  const instancia = checagem.instancia;

  // 1) Linhas → contatos (com o número de envio de cada um).
  const escolhidos = new Map<string, string | null>(); // contactId → E.164
  let linhas: number;
  if (origem.tipo === "filtro") {
    linhas = origem.contactIds.length;
    const ids = [...new Set(origem.contactIds)];
    duplicados += linhas - ids.length;
    // Número dado como errado numa ligação (produto §D) não serve para envio.
    const soNumeroErrado = new Set<string>();
    for (let i = 0; i < ids.length; i += LOTE_BANCO) {
      const idents = await prisma.channelIdentifier.findMany({
        where: { contactId: { in: ids.slice(i, i + LOTE_BANCO) }, canal: "whatsapp" },
        select: { contactId: true, valor: true, valorCifrado: true, isPrimary: true, invalido: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      });
      for (const idt of idents) {
        if (idt.invalido) soNumeroErrado.add(idt.contactId);
        else if (!escolhidos.has(idt.contactId)) escolhidos.set(idt.contactId, valorDe(idt));
      }
    }
    for (const id of ids) {
      if (escolhidos.has(id)) continue;
      if (soNumeroErrado.has(id)) {
        semWhatsApp++;
        continue;
      }
      invalidos++;
      contar("sem número de WhatsApp");
    }
    // O MESMO celular em dois contatos (com e sem o nono dígito — o WhatsApp
    // entrega números antigos sem o 9): um só recebe (auditoria do #108).
    const vistos = new Set<string>();
    for (const id of ids) {
      const numero = escolhidos.get(id);
      if (!numero) continue;
      if (phoneVariants(numero).some((v) => vistos.has(v))) {
        escolhidos.delete(id);
        duplicados++;
        continue;
      }
      for (const v of phoneVariants(numero)) vistos.add(v);
    }
    // Tem WhatsApp? (A.4): número sabidamente sem WhatsApp não entra.
    const tem = await temWhatsApp([...escolhidos.values()].filter((n): n is string => !!n), { channelAccountId: checagem.id });
    for (const [id, numero] of escolhidos) {
      if (numero && tem.get(numero)?.existe === false) {
        escolhidos.delete(id);
        semWhatsApp++;
      }
    }
  } else {
    const brutas: Linha[] = origem.tipo === "colados" ? lerColados(origem.texto) : origem.linhas;
    linhas = brutas.length;
    const vistos = new Set<string>();
    const validas: Array<Linha & { e164: string }> = [];
    for (const l of brutas) {
      const e164 = normalizePhone(l.telefone);
      if (!e164) {
        invalidos++;
        continue;
      }
      // Mesmo celular com e sem o nono dígito = repetido.
      if (phoneVariants(e164).some((v) => vistos.has(v))) {
        duplicados++;
        continue;
      }
      for (const v of phoneVariants(e164)) vistos.add(v);
      validas.push({ ...l, e164 });
    }

    // Número dado como errado numa ligação (produto §D): "sem WhatsApp", sem
    // gastar consulta na Evolution.
    const errados = await numerosDadosComoErrados(validas.flatMap((v) => phoneVariants(v.e164)));
    const naoErrados = validas.filter((v) => {
      if (phoneVariants(v.e164).some((x) => errados.has(x))) {
        semWhatsApp++;
        return false;
      }
      return true;
    });

    // Tem WhatsApp? (A.4). `null` = não sei → segue (o envio descobre).
    // Pela conta da checagem (a da campanha, senão uma conectada do time);
    // desconectada → só o cache global, e o resto fica "não sei".
    const tem = await temWhatsApp(
      naoErrados.map((v) => v.e164),
      { channelAccountId: checagem.id },
    );
    const comWhats = naoErrados.filter((v) => {
      if (tem.get(v.e164)?.existe === false) {
        semWhatsApp++;
        return false;
      }
      return true;
    });

    // Contatos que já existem (casa com e sem o nono dígito).
    const donoDoNumero = new Map<string, string>();
    const todasVariantes = comWhats.flatMap((v) => phoneVariants(v.e164));
    for (let i = 0; i < todasVariantes.length; i += LOTE_BANCO) {
      const idents = await prisma.channelIdentifier.findMany({
        where: ondeIdentificadorExato(getCurrentTeamId() ?? "", "whatsapp", todasVariantes.slice(i, i + LOTE_BANCO)),
        select: { contactId: true, valor: true, valorCifrado: true },
      });
      for (const idt of idents) {
        const valor = valorDe(idt);
        if (valor) donoDoNumero.set(valor, idt.contactId);
      }
    }
    for (const v of comWhats) {
      let contactId = phoneVariants(v.e164).map((x) => donoDoNumero.get(x)).find(Boolean) ?? null;
      if (!contactId) {
        // Contato novo pela escrita canônica, SEM o gatilho `contact_created`: a
        // campanha já é o primeiro contato — um fluxo de boas-vindas mandaria
        // uma segunda mensagem para o mesmo lead.
        const nomeWhats = tem.get(v.e164)?.nome ?? null;
        let r: Awaited<ReturnType<typeof writeContact>>;
        try {
          r = await writeContact(
            {
              nome: v.nome?.trim() || nomeWhats || v.e164,
              ...(v.empresa ? { empresa: v.empresa } : {}),
              ...(v.cidade ? { cidade: v.cidade } : {}),
              origem: "campanha",
              identifiers: { whatsapp: v.e164 },
              provenance: { source: "campanha", actor: "human" },
            },
            // Roda no worker (sistema) — o responsável é quem criou a campanha.
            { mode: "upsert", gatilho: false, ownerId: c.createdById },
          );
        } catch (e) {
          // Cadastrado por outro vendedor no meio da montagem: não entra.
          if (!(e instanceof ContatoJaCadastrado)) throw e;
          deOutro++;
          contar(MOTIVO_OUTRO_RESPONSAVEL);
          continue;
        }
        contactId = r.contactId;
        if (r.created) contatosNovos++;
      }
      if (escolhidos.has(contactId)) {
        duplicados++;
        continue;
      }
      escolhidos.set(contactId, v.e164);
    }
  }

  // Regra do responsável (dono, 28/09): contato de OUTRO responsável não entra
  // na campanha de quem não vê o time — nem como "pulado" (o nome do contato
  // apareceria na lista de destinatários de quem não pode vê-lo).
  const fora = await deOutroResponsavel([...escolhidos.keys()], await quemAge(c.createdById));
  for (const id of fora.keys()) {
    escolhidos.delete(id);
    deOutro++;
    contar(MOTIVO_OUTRO_RESPONSAVEL);
  }

  // 2) Classificação dos contatos.
  const ids = [...escolhidos.keys()];
  const classe = new Map<string, Classificacao>();
  const jaConversou = new Set<string>();
  const recente = new Map<string, Date>();
  const optOut = new Set<string>();
  const outraCampanha = new Set<string>();
  const campanhaDaRegraId = campanhaDaRegra(c.regraJaConversou);
  const desde = new Date(agora.getTime() - c.diasSemCampanha * 86_400_000);
  for (let i = 0; i < ids.length; i += LOTE_BANCO) {
    const lote = ids.slice(i, i + LOTE_BANCO);
    const contatos = await prisma.contact.findMany({
      where: { id: { in: lote } },
      select: { id: true, relacionamentoStatus: true },
    });
    for (const k of contatos) {
      if (k.relacionamentoStatus === "opt_out") optOut.add(k.id);
      else if (k.relacionamentoStatus !== "novo") jaConversou.add(k.id);
    }
    // Conversa na plataforma com qualquer mensagem (inclusive só nossa).
    const convs = await prisma.conversation.findMany({
      where: { contactId: { in: lote }, lastMessageAt: { not: null } },
      select: { contactId: true },
    });
    for (const cv of convs) if (cv.contactId) jaConversou.add(cv.contactId);
    if (campanhaDaRegraId) for (const id of await contatosQueReceberam(campanhaDaRegraId, lote)) outraCampanha.add(id);
    if (c.diasSemCampanha > 0) {
      const enviados = await prisma.campaignRecipient.findMany({
        where: { contactId: { in: lote }, campaignId: { not: c.id }, sentAt: { gte: desde } },
        select: { contactId: true, sentAt: true },
      });
      for (const e of enviados) {
        const antes = recente.get(e.contactId);
        if (e.sentAt && (!antes || e.sentAt > antes)) recente.set(e.contactId, e.sentAt);
      }
    }
  }

  // Histórico FORA da plataforma (celular) só para quem parece novo. `null` =
  // Evolution não respondeu: segura (mesma regra do nó send_message, item 1.2).
  const semHistoricoInterno = ids.filter((id) => !optOut.has(id) && !recente.has(id) && !outraCampanha.has(id) && !jaConversou.has(id));
  const historicoIndisponivel = new Set<string>();
  if (!instancia) {
    // Sem WhatsApp conectado para checar (auditoria do #108): segura todos que
    // seriam checados — quem já conversa pelo celular não recebe a mensagem fria.
    for (const id of semHistoricoInterno) historicoIndisponivel.add(id);
  } else {
    for (let i = 0; i < semHistoricoInterno.length; i += HISTORICO_EM_PARALELO) {
      await Promise.all(
        semHistoricoInterno.slice(i, i + HISTORICO_EM_PARALELO).map(async (id) => {
          const numero = escolhidos.get(id);
          if (!numero) return;
          const h = await historico({ apiUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY, instance: instancia, number: numero });
          if (h === true) jaConversou.add(id);
          else if (h === null) historicoIndisponivel.add(id);
        }),
      );
    }
  }

  const regra = c.regraJaConversou as RegraJaConversou;
  for (const id of ids) {
    let k: Classificacao;
    if (optOut.has(id)) k = { status: "skipped", motivo: "pediu para sair" };
    else if (outraCampanha.has(id)) k = { status: "skipped", motivo: MOTIVO_OUTRA_CAMPANHA }; // a campanha escolhida explica melhor que a genérica
    else if (recente.has(id)) k = { status: "skipped", motivo: `campanha há ${diasEntre(recente.get(id)!, agora)} dias` };
    else if (jaConversou.has(id)) k = porRegra(regra);
    else if (historicoIndisponivel.has(id)) k = { status: "held", motivo: "histórico do WhatsApp indisponível" };
    else k = { status: "queued", motivo: null };
    classe.set(id, k);
    if (k.motivo) contar(k.motivo.startsWith("campanha há") ? "campanha recente" : k.motivo);
  }

  const status = [...classe.values()].map((k) => k.status);
  const resumo: ResumoDaLista = {
    linhas,
    invalidos,
    duplicados,
    semWhatsApp,
    contatosNovos,
    fila: status.filter((s) => s === "queued").length,
    segurados: status.filter((s) => s === "held").length,
    pulados: status.filter((s) => s === "skipped").length + deOutro,
    porMotivo,
  };

  // 3) Grava: troca os destinatários do rascunho pelos novos, na MESMA transação
  // da troca CONDICIONAL do estado (auditoria do #108). O UPDATE trava a linha
  // da campanha: se a lista foi trocada (outra versão) ou a campanha saiu do
  // rascunho no meio da montagem, esta não grava nada — antes apagava os
  // destinatários da lista NOVA e gravava os da velha. A origem bruta
  // (telefones/nomes colados) sai do banco aqui: só fica o resumo (LGPD).
  const gravou = await prisma.$transaction(
    async (tx) => {
    const { count } = await tx.campaign.updateMany({
      where: { id: c.id, status: "draft", listaOrigem: { path: ["versao"], equals: versao } },
      data: {
        listaOrigem: {
          tipo: origem.tipo,
          ...(origem.tipo === "planilha" && origem.arquivo ? { arquivo: origem.arquivo } : {}),
          versao,
          estado: "pronta",
          resumo,
          contaDaChecagem: checagem.id,
        } as Prisma.InputJsonValue,
      },
    });
    if (count === 0) return false;
    await tx.campaignRecipient.deleteMany({ where: { campaignId: c.id } });
    // `createdAt` crescente na ordem da LISTA: o worker envia por (createdAt,
    // id), e o createMany daria o mesmo instante a todos (o desempate pelo id
    // aleatório embaralhava a ordem da planilha).
    const base = Date.now();
    const rows = ids.map((id, i) => ({
      campaignId: c.id,
      contactId: id,
      telefone: escolhidos.get(id) ?? null,
      status: classe.get(id)!.status,
      motivo: classe.get(id)!.motivo,
      createdAt: new Date(base + i),
    }));
    for (let i = 0; i < rows.length; i += LOTE_BANCO) {
      await tx.campaignRecipient.createMany({
        data: rows.slice(i, i + LOTE_BANCO).map((r) => tenantData<Prisma.CampaignRecipientCreateManyInput>(r)),
        skipDuplicates: true,
      });
    }
    return true;
    },
    { timeout: 60_000 },
  );
  return gravou ? resumo : null;
}

// ─── Segurados ──────────────────────────────────────────────────────────────

/**
 * Libera segurados para a fila (os "61 segurados" do mockup). Libera ENVIO →
 * mesmo papel de iniciar a campanha. `ids` vem da tela: só destinatários
 * desta campanha, do time (o filtro do `db()` + `campaignId`) e em `held`.
 */
export async function liberarSegurados(campaignId: string, ids: string[] | "todos"): Promise<{ liberados: number }> {
  requireCan("campaigns.start");
  await campanhaDoTime(campaignId, { escrita: true });
  const { count } = await db().campaignRecipient.updateMany({
    where: { campaignId, status: "held", ...(ids === "todos" ? {} : { id: { in: ids } }) },
    // Liberar é a decisão humana: entra na fila como envio normal (a retomada
    // segue com o texto de retomada).
    data: { status: "queued", scheduledAt: null },
  });
  return { liberados: count };
}

// ─── Mensagem ───────────────────────────────────────────────────────────────

/**
 * Variação do contato: 0 = mensagem principal, 1..n = `variacoes[n-1]`.
 * DETERMINÍSTICA pelo contato (a prévia mostra o que ele vai receber, e um
 * reenvio nunca troca o texto).
 */
export function escolherVariacao(contactId: string, totalDeVariacoes: number): number {
  if (totalDeVariacoes <= 0) return 0;
  const h = createHash("sha1").update(contactId).digest().readUInt32BE(0);
  return h % (totalDeVariacoes + 1);
}

function variacoesDe(c: Pick<Campaign, "variacoes">): string[] {
  return Array.isArray(c.variacoes) ? c.variacoes.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Texto final para um contato: retomada (quem já conversou, regra "retomada")
 * ou a variação sorteada, com as variáveis do contato. Usado pela prévia e
 * pelo worker — os dois mostram/mandam o mesmo texto.
 */
export function textoParaContato(
  c: Pick<Campaign, "mensagem" | "variacoes" | "textoRetomada">,
  destinatario: { contactId: string; motivo: string | null },
  vars: ContactVars,
  agora = new Date(),
): { texto: string; variacao: number } | null {
  if (destinatario.motivo === "retomada") {
    // Sem texto de retomada NÃO cai na mensagem fria: quem já conversou não
    // recebe a abordagem de primeiro contato (null = segura).
    if (!c.textoRetomada) return null;
    return { texto: renderTemplate(c.textoRetomada, { ...vars, now: agora }), variacao: 0 };
  }
  if (!c.mensagem) return null;
  const vs = variacoesDe(c);
  const variacao = escolherVariacao(destinatario.contactId, vs.length);
  const base = variacao === 0 ? c.mensagem : vs[variacao - 1]!;
  return { texto: renderTemplate(base, { ...vars, now: agora }), variacao };
}

/** Prévia da mensagem para um contato real (com fallback das variáveis vazias). */
export async function previewMessage(
  campaignId: string,
  contactId: string,
): Promise<{ texto: string; variacao: number } | null> {
  const c = await campanhaDoTime(campaignId);
  await assertOwned("contact", contactId, { leitura: true }); // prévia: só lê o contato
  const r = await db().campaignRecipient.findUnique({
    where: { campaignId_contactId: { campaignId, contactId } },
    select: { motivo: true },
  });
  const vars = (await carregarVariaveis([contactId])).get(contactId);
  if (!vars) return null;
  return textoParaContato(c, { contactId, motivo: r?.motivo ?? null }, vars);
}
