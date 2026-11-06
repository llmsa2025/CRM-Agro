import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "@crmagro/config";
import { db } from "@crmagro/db";
import { baixarFotoDePerfil, fetchEvolutionProfilePictureUrl, type FotoBaixada } from "@crmagro/channels";
import { requireCan } from "../auth/authz";
import { ContactNotFound } from "../contacts/errors";
import { escopoDoContato } from "../contacts/escopo";
import { valorDe } from "../contacts/identificadores-cifra";
import { nomeCompleto, nomeDePessoaValido } from "../conversations/nome";
import { logger } from "../logger/index";
import { AGRO_REGRA_VERSAO, atividadeDoCnae, verificarAgro, type EmpresaParaAgro } from "./regras";
import {
  agroTipoSchema,
  agroTiposValidos,
  leituraDaFotoSchema,
  lerAgroDetalhe,
  type AgroDetalhe,
  type AgroTipo,
  type EstadoDaFoto,
  type LeituraDaFoto,
} from "./schema";

/**
 * Verificador do agro: serviço. O botão "Verificar agro" (Contatos) chama `verificarContatoAgro`; o Claude, pelo MCP
 * crmagro-agro, usa `listarPedidosDeFoto`, `baixarFotoDoPedido` e `registrarLeituraDaFoto`.
 *
 * O que o Claude vê (e só isso): nome do cadastro, nome no WhatsApp e na agenda, nome e atividade das empresas
 * vinculadas, nomes dos sócios e a imagem. NUNCA telefone, e-mail, CPF, CNPJ nem o endereço da foto: o número só
 * serve aqui dentro, para o servidor buscar a foto na Evolution.
 *
 * Quem decide os tipos é sempre `verificarAgro` (regras puras). O Claude só entrega a leitura da foto, que o
 * servidor valida (zod) e soma às outras evidências. A imagem nunca é gravada.
 */

export class AgroSemPedidoDeFoto extends Error {
  constructor() {
    super("AgroSemPedidoDeFoto: este contato não está na fila de leitura de foto.");
    this.name = "AgroSemPedidoDeFoto";
  }
}

export class AgroLeituraInvalida extends Error {
  constructor(detalhe: string) {
    super(`AgroLeituraInvalida: ${detalhe}`);
    this.name = "AgroLeituraInvalida";
  }
}

type Banco = ReturnType<typeof db>;

const sociosSchema = z.object({ socios: z.array(z.object({ nome: z.string() }).passthrough()).optional() }).passthrough();
const iesTiposSchema = z.array(z.object({ tipo: z.string().nullish() }).passthrough());

/** Tudo o que as regras precisam de um contato, mais o que o servidor usa para achar a foto (nunca sai daqui). */
type Contexto = {
  id: string;
  agroTipos: AgroTipo[];
  detalhe: AgroDetalhe | null;
  entrada: Omit<Parameters<typeof verificarAgro>[0], "foto">;
  empresas: { nome: string; cnae: string | null; socios: string[] }[];
  nomeWhatsapp: string | null;
  nomeAgenda: string | null;
  /** Telefone do WhatsApp. Só para buscar a foto. */
  numero: string | null;
  contaPreferida: string | null;
};

async function carregar(prisma: Banco, contactId: string, escrita: boolean): Promise<Contexto> {
  const c = await prisma.contact.findFirst({
    where: { AND: [{ id: contactId }, escopoDoContato({ escrita })] },
    select: {
      id: true,
      nome: true,
      sobrenome: true,
      empresa: true,
      agroTipos: true,
      agroDetalhe: true,
      companies: { select: { company: { select: { nome: true, cnae: true, cnaesSecundarios: true, iesTipos: true, enrichment: true } } } },
      identifiers: { where: { canal: "whatsapp" }, select: { valor: true, valorCifrado: true }, orderBy: { isPrimary: "desc" }, take: 5 },
    },
  });
  if (!c) throw new ContactNotFound(contactId);

  const conversas = await prisma.conversation.findMany({
    where: { contactId, canal: "whatsapp" },
    select: { externalName: true, nomeAgenda: true, channelAccountId: true },
    orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
    take: 5,
  });
  const nomeWhatsapp = conversas.map((v) => nomeDePessoaValido(v.externalName)).find(Boolean) ?? null;
  const nomeAgenda = conversas.map((v) => nomeDePessoaValido(v.nomeAgenda)).find(Boolean) ?? null;

  const empresas: EmpresaParaAgro[] = c.companies.map(({ company: e }) => {
    const socios = sociosSchema.safeParse(e.enrichment);
    const ies = iesTiposSchema.safeParse(e.iesTipos);
    return {
      nome: e.nome,
      cnae: e.cnae,
      cnaesSecundarios: e.cnaesSecundarios,
      iesTipos: ies.success ? ies.data.map((i) => i.tipo) : [],
      socios: socios.success ? (socios.data.socios ?? []).map((s) => s.nome).filter(Boolean) : [],
    };
  });

  return {
    id: c.id,
    agroTipos: agroTiposValidos(c.agroTipos),
    detalhe: lerAgroDetalhe(c.agroDetalhe),
    entrada: {
      nome: nomeCompleto(c.nome, c.sobrenome),
      nomeWhatsapp,
      nomeAgenda,
      empresaTexto: c.empresa,
      empresas,
    },
    empresas: empresas.map((e) => ({ nome: e.nome, cnae: e.cnae, socios: e.socios })),
    nomeWhatsapp,
    nomeAgenda,
    numero: c.identifiers.map((i) => valorDe(i)).find(Boolean) ?? null,
    contaPreferida: conversas.find((v) => v.channelAccountId)?.channelAccountId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Foto do WhatsApp (Evolution)
// ---------------------------------------------------------------------------

type FotoNoWhatsapp = { estado: "ha_foto"; url: string } | { estado: "sem_foto" } | { estado: "indisponivel"; motivo: string };

/** Pergunta à Evolution pela foto do contato, pela conta que já conversa com ele (ou outra conectada). */
async function procurarFoto(prisma: Banco, ctx: Pick<Contexto, "numero" | "contaPreferida">): Promise<FotoNoWhatsapp> {
  if (!ctx.numero) return { estado: "indisponivel", motivo: "O contato não tem WhatsApp cadastrado." };
  const contas = await prisma.channelAccount.findMany({
    where: { canal: "whatsapp", provider: "evolution", status: "connected", externalId: { not: null } },
    select: { id: true, externalId: true },
    orderBy: { createdAt: "asc" },
    take: 10,
  });
  const conta = contas.find((c) => c.id === ctx.contaPreferida) ?? contas[0];
  if (!conta?.externalId) return { estado: "indisponivel", motivo: "Nenhum WhatsApp conectado." };
  try {
    const url = await fetchEvolutionProfilePictureUrl({
      apiUrl: env.EVOLUTION_API_URL,
      apiKey: env.EVOLUTION_API_KEY,
      instance: conta.externalId,
      numero: ctx.numero,
    });
    return url ? { estado: "ha_foto", url } : { estado: "sem_foto" };
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[agro] não deu para consultar a foto na Evolution");
    return { estado: "indisponivel", motivo: "O WhatsApp não respondeu agora." };
  }
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------

export type ResultadoDoContato = {
  tipos: AgroTipo[];
  /** Os tipos mudaram em relação ao que estava gravado. */
  mudou: boolean;
  /** O contato foi ajustado à mão e a verificação automática respeitou: nada foi alterado. */
  ajusteManualMantido: boolean;
  foto: EstadoDaFoto["estado"] | null;
  /** Falou com a Evolution nesta chamada (o lote em segundo plano usa para dar um respiro entre uma consulta e outra). */
  consultouWhatsapp?: boolean;
};

const mesmos = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

async function gravar(prisma: Banco, ctx: Contexto, foto: EstadoDaFoto | null, opts: { manterTipos?: boolean } = {}): Promise<ResultadoDoContato> {
  const leitura = foto?.estado === "lida" ? foto.leitura : null;
  const r = verificarAgro({ ...ctx.entrada, foto: leitura });
  const tipos = opts.manterTipos ? ctx.agroTipos : r.tipos;
  const detalhe: AgroDetalhe = {
    versao: AGRO_REGRA_VERSAO,
    origem: opts.manterTipos ? "manual" : "automatica",
    verificadoEm: new Date().toISOString(),
    evidencias: r.evidencias,
    foto,
  };
  await prisma.contact.update({ where: { id: ctx.id }, data: { agroTipos: tipos, agroDetalhe: detalhe as Prisma.InputJsonValue } });
  logger.info({ contactId: ctx.id, tipos, foto: foto?.estado ?? null }, "[agro] contato verificado");
  return { tipos, mudou: !mesmos(tipos, ctx.agroTipos), ajusteManualMantido: false, foto: foto?.estado ?? null };
}

/**
 * Botão "Verificar agro". Lê nome, empresas (CNAE e sócios) e a foto do WhatsApp e grava os tipos.
 * O que não precisa de IA sai na hora; a foto, quando existe, fica na fila para o Claude ler (`foto: "na_fila"`).
 *
 * - `refazerFoto`: joga fora a leitura anterior e confere a foto de novo (a pessoa pode ter trocado).
 * - `forcar`: verifica mesmo o contato ajustado à mão (troca o ajuste pelo resultado automático).
 * - `semFoto`: só nome e empresas (sem rede). A foto fica como estava. É a primeira rodada do lote em segundo plano.
 * - `apenasFotoNova`: só procura a foto de quem nunca teve a foto olhada (ou seja, `foto` vazio no detalhe). Quem já tem
 *   qualquer estado (lida, na fila, sem foto, indisponível) não é consultado de novo. É a segunda rodada do lote.
 */
export async function verificarContatoAgro(
  contactId: string,
  opts: { refazerFoto?: boolean; forcar?: boolean; semFoto?: boolean; apenasFotoNova?: boolean } = {},
): Promise<ResultadoDoContato> {
  requireCan("contacts.write");
  const prisma = db(); // antes de qualquer await (AGENTS.md §12)
  const ctx = await carregar(prisma, contactId, true);

  if (ctx.detalhe?.origem === "manual" && !opts.forcar) {
    return { tipos: ctx.agroTipos, mudou: false, ajusteManualMantido: true, foto: ctx.detalhe.foto?.estado ?? null };
  }

  const agora = new Date().toISOString();
  const anterior = ctx.detalhe?.foto ?? null;
  if (opts.apenasFotoNova && anterior) return { tipos: ctx.agroTipos, mudou: false, ajusteManualMantido: false, foto: anterior.estado };
  let foto: EstadoDaFoto | null;
  if (opts.semFoto) {
    foto = anterior; // sem rede: a foto fica como estava (pode ser nenhuma)
  } else if (!opts.refazerFoto && (anterior?.estado === "lida" || anterior?.estado === "na_fila")) {
    foto = anterior; // já lida, ou já na fila: não pergunta de novo
  } else {
    const achada = await procurarFoto(prisma, ctx);
    foto =
      achada.estado === "ha_foto"
        ? { estado: "na_fila", em: agora }
        : achada.estado === "sem_foto"
          ? { estado: "sem_foto", em: agora }
          : { estado: "indisponivel", em: agora, motivo: achada.motivo };
  }
  const r = await gravar(prisma, ctx, foto);
  return opts.semFoto ? r : { ...r, consultouWhatsapp: foto !== anterior };
}

/** Troca à mão. Vale até a pessoa pedir a verificação automática de novo (`forcar`). Tira o contato da fila de fotos. */
export async function ajustarAgroManual(contactId: string, tipos: unknown): Promise<{ tipos: AgroTipo[] }> {
  requireCan("contacts.write");
  const prisma = db();
  const escolhidos = agroTiposValidos(z.array(agroTipoSchema).max(8).parse(tipos));
  const ctx = await carregar(prisma, contactId, true);
  const foto = ctx.detalhe?.foto?.estado === "na_fila" ? null : (ctx.detalhe?.foto ?? null);
  const detalhe: AgroDetalhe = {
    versao: AGRO_REGRA_VERSAO,
    origem: "manual",
    verificadoEm: new Date().toISOString(),
    evidencias: ctx.detalhe?.evidencias ?? [],
    foto,
  };
  await prisma.contact.update({ where: { id: contactId }, data: { agroTipos: escolhidos, agroDetalhe: detalhe as Prisma.InputJsonValue } });
  return { tipos: escolhidos };
}

// ---------------------------------------------------------------------------
// Fila de fotos para o Claude (MCP crmagro-agro)
// ---------------------------------------------------------------------------

/** O que o Claude recebe de cada contato. Sem telefone, e-mail, CPF, CNPJ nem endereço da foto. */
export type PedidoDeFoto = {
  contatoId: string;
  nome: string;
  nomeNoWhatsapp: string | null;
  nomeNaAgenda: string | null;
  empresas: { nome: string; atividade: string | null; socios: string[] }[];
  pedidoEm: string;
};

/**
 * Texto de terceiros (nome do WhatsApp, razão social, sócio) que vai para a IA: uma linha só, sem caractere de
 * controle, invisível ou de direção, com teto. Quem escolhe o nome no WhatsApp é a pessoa do outro lado, e um
 * nome pode tentar dar ordens ao Claude; o que sobra aqui é só texto curto que o MCP entrega como DADO.
 */
export function textoParaIa(t: string | null | undefined, max = 80): string | null {
  const s = (t ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, max) : null;
}

const naFila = (): Prisma.ContactWhereInput => ({ agroDetalhe: { path: ["foto", "estado"], equals: "na_fila" } });

/** Quantos contatos esperam a leitura da foto. */
export async function contarPedidosDeFoto(): Promise<number> {
  requireCan("contacts.write");
  const prisma = db();
  return prisma.contact.count({ where: { AND: [escopoDoContato({ escrita: true }), naFila()] } });
}

/** Contatos com a foto esperando leitura, do mais antigo para o mais novo. */
export async function listarPedidosDeFoto(limite = 5): Promise<PedidoDeFoto[]> {
  requireCan("contacts.write");
  const prisma = db();
  const linhas = await prisma.contact.findMany({
    where: { AND: [escopoDoContato({ escrita: true }), naFila()] },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: Math.min(Math.max(Math.trunc(limite), 1), 20),
  });
  const out: PedidoDeFoto[] = [];
  for (const l of linhas) {
    const ctx = await carregar(prisma, l.id, true);
    if (ctx.detalhe?.foto?.estado !== "na_fila") continue;
    out.push({
      contatoId: ctx.id,
      nome: textoParaIa(ctx.entrada.nome) ?? "",
      nomeNoWhatsapp: textoParaIa(ctx.nomeWhatsapp),
      nomeNaAgenda: textoParaIa(ctx.nomeAgenda),
      empresas: ctx.empresas.map((e) => ({
        nome: textoParaIa(e.nome, 120) ?? "",
        atividade: atividadeDoCnae(e.cnae),
        socios: e.socios.slice(0, 10).flatMap((s) => textoParaIa(s) ?? []),
      })),
      pedidoEm: ctx.detalhe.foto.em,
    });
  }
  return out;
}

/**
 * Baixa a foto de um contato da fila, só na hora de entregar ao Claude (o endereço da foto expira e a imagem não
 * é guardada). Sem foto disponível, tira o contato da fila marcando "sem foto". Só funciona para quem está na fila.
 */
export async function baixarFotoDoPedido(
  contactId: string,
): Promise<{ ok: true; foto: FotoBaixada } | { ok: false; motivo: string; /** false = problema passageiro, o contato segue na fila. */ saiuDaFila: boolean }> {
  requireCan("contacts.write");
  const prisma = db();
  const ctx = await carregar(prisma, contactId, true);
  if (ctx.detalhe?.foto?.estado !== "na_fila") throw new AgroSemPedidoDeFoto();

  const achada = await procurarFoto(prisma, ctx);
  if (achada.estado === "ha_foto") {
    try {
      const foto = await baixarFotoDePerfil(achada.url);
      if (foto) return { ok: true, foto };
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[agro] não deu para baixar a foto");
      return { ok: false, motivo: "Não deu para baixar a foto agora. Tente de novo.", saiuDaFila: false };
    }
  } else if (achada.estado === "indisponivel") {
    return { ok: false, motivo: achada.motivo, saiuDaFila: false };
  }
  // Sem foto (ela some quando a pessoa a esconde ou apaga): sai da fila.
  await gravar(prisma, ctx, { estado: "sem_foto", em: new Date().toISOString() }, { manterTipos: ctx.detalhe?.origem === "manual" });
  return { ok: false, motivo: "O contato não tem foto de perfil no WhatsApp.", saiuDaFila: true };
}

/** O Claude entrega a leitura da foto. O servidor valida, soma às outras evidências e decide os tipos. */
export async function registrarLeituraDaFoto(contactId: string, leitura: unknown): Promise<ResultadoDoContato> {
  requireCan("contacts.write");
  const prisma = db();
  const p = leituraDaFotoSchema.safeParse(leitura);
  if (!p.success) throw new AgroLeituraInvalida(p.error.issues.map((i) => `${i.path.join(".") || "leitura"}: ${i.message}`).join("; "));
  const ctx = await carregar(prisma, contactId, true);
  if (ctx.detalhe?.foto?.estado !== "na_fila") throw new AgroSemPedidoDeFoto();
  const lida: LeituraDaFoto = p.data;
  // Contato ajustado à mão enquanto a foto esperava: guarda a leitura como evidência, mas não troca os tipos.
  return gravar(prisma, ctx, { estado: "lida", em: new Date().toISOString(), leitura: lida }, { manterTipos: ctx.detalhe?.origem === "manual" });
}
