import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { env } from "@crmagro/config";
import { basePrisma, db, decryptCredentials, encryptCredentials, tenantData } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { escopoCanal } from "../conversations/escopo";
import { logger } from "../logger/index";
import { OwnedNotFound } from "../tenancy/assert-owned";
import { hashDoToken } from "./entrada-assinatura";

/**
 * Endereço de encaminhamento de uma caixa de e-mail (Gmail → Cloudflare → CRM Agro).
 * Cada caixa ganha um endereço só dela, `r+<32 hex>@<domínio>`. O código só existe
 * cifrado no banco (e o hash serve para achar a caixa); o endereço pode ser mostrado
 * de novo porque o cifrado é decifrável. Gerar de novo troca o código: o endereço
 * antigo deixa de valer.
 */

/** A entrada de e-mail por encaminhamento está desligada (faltam o domínio e o segredo no `.env`). */
export class EntradaDeEmailDesligada extends Error {
  constructor() {
    super("A entrada de e-mail por encaminhamento está desligada neste ambiente.");
    this.name = "EntradaDeEmailDesligada";
  }
}

/** Um e-mail encaminhado sem chegada por mais que isso passa a "sem e-mail recente". */
const DIAS_SEM_EMAIL = 3;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * O domínio e o segredo da entrada, ou `null` se a entrada não está ligada: falta
 * um dos dois, o domínio não parece um domínio ou o segredo tem menos de 32
 * caracteres. Quem chama na tela só usa `!== null`: o segredo nunca vai para o cliente.
 * Lê o `env` a cada chamada (fail-soft: nunca derruba o boot).
 */
export function entradaDeEmailLigada(): { dominio: string; segredo: string } | null {
  const dominio = (env.EMAIL_ENTRADA_DOMINIO ?? "").trim().toLowerCase();
  const segredo = (env.EMAIL_ENTRADA_SEGREDO ?? "").trim();
  if (!dominio || !segredo) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dominio)) return null;
  if (segredo.length < 32) return null;
  return { dominio, segredo };
}

export function enderecoDoToken(token: string, dominio: string): string {
  return `r+${token}@${dominio}`;
}

export type EstadoEncaminhamento = "aguardando_confirmacao" | "confirmar" | "funcionando" | "sem_email_recente";

export type EncaminhamentoDTO = {
  /** `null` = não deu para decifrar (chave trocada sem a rotação): a tela pede para gerar um novo. */
  endereco: string | null;
  estado: EstadoEncaminhamento;
  /** Link de confirmação do Google (quando o e-mail de confirmação chegou). */
  linkConfirmacao: string | null;
  confirmadoEm: string | null;
  ultimoRecebidoEm: string | null;
  /** Quantos e-mails chegaram sem vir da caixa (envelope estranho). */
  recusados: number;
};

type BaseDoEstado = {
  confirmadoEm: Date | null;
  /** Tem o link de confirmação do Google guardado (e legível). */
  temLink: boolean;
  ultimoRecebidoEm: Date | null;
};

/**
 * Em que pé está o encaminhamento:
 * - sem 1º e-mail válido e sem link → `aguardando_confirmacao` (o Google ainda não mandou o e-mail de confirmação);
 * - sem 1º e-mail válido e com link → `confirmar` (o link chegou, falta a pessoa confirmar no Gmail);
 * - com 1º e-mail válido e o último há mais de 3 dias → `sem_email_recente`;
 * - senão → `funcionando`.
 */
export function estadoDoEncaminhamento(r: BaseDoEstado, agora: Date = new Date()): EstadoEncaminhamento {
  if (!r.confirmadoEm) return r.temLink ? "confirmar" : "aguardando_confirmacao";
  const referencia = r.ultimoRecebidoEm ?? r.confirmadoEm;
  if (agora.getTime() - referencia.getTime() > DIAS_SEM_EMAIL * MS_POR_DIA) return "sem_email_recente";
  return "funcionando";
}

/**
 * Decifra um campo (`token` ou `link`) de uma coluna cifrada. Não lança: se a chave
 * mudou sem a rotação, devolve `null` e registra só o id da linha.
 */
function decifrarCampo(valor: unknown, campo: "token" | "link", encaminhamentoId: string): string | null {
  if (valor == null) return null;
  try {
    const obj = decryptCredentials(valor) as Record<string, unknown> | null;
    const texto = obj?.[campo];
    return typeof texto === "string" && texto ? texto : null;
  } catch {
    logger.warn({ encaminhamentoId, campo }, "[email] encaminhamento: não deu para decifrar");
    return null;
  }
}

type LinhaDoEncaminhamento = {
  id: string;
  tokenCifrado: unknown;
  confirmacaoLink: unknown;
  confirmadoEm: Date | null;
  ultimoRecebidoEm: Date | null;
  recusados: number;
};

function paraDTO(linha: LinhaDoEncaminhamento, dominio: string): EncaminhamentoDTO {
  const token = decifrarCampo(linha.tokenCifrado, "token", linha.id);
  const link = decifrarCampo(linha.confirmacaoLink, "link", linha.id);
  return {
    endereco: token ? enderecoDoToken(token, dominio) : null,
    estado: estadoDoEncaminhamento({ confirmadoEm: linha.confirmadoEm, temLink: link !== null, ultimoRecebidoEm: linha.ultimoRecebidoEm }),
    linkConfirmacao: link,
    confirmadoEm: linha.confirmadoEm?.toISOString() ?? null,
    ultimoRecebidoEm: linha.ultimoRecebidoEm?.toISOString() ?? null,
    recusados: linha.recusados,
  };
}

type ClienteDoTime = ReturnType<typeof db>;

/**
 * Quem pode gerar ou desligar o endereço de uma caixa: só o dono dela ou o
 * administrador (decisão D8). Quem não vê a caixa recebe `OwnedNotFound` (não revela
 * que ela existe). Recebe o client já pronto: o `db()` é lido pelo chamador, antes
 * de qualquer `await`.
 */
async function exigirGestaoDaCaixa(prisma: ClienteDoTime, channelAccountId: string): Promise<{ id: string; ownerId: string | null }> {
  const ator = requireCan("messages.send"); // viewer não passa
  const caixa = await prisma.channelAccount.findFirst({
    where: { AND: [{ id: channelAccountId, canal: "email" }, escopoCanal({ escrita: true })] },
    select: { id: true, ownerId: true },
  });
  if (!caixa) throw new OwnedNotFound("channelAccount", [channelAccountId]);
  if (caixa.ownerId !== ator.userId) requireCan("integrations.manage");
  return caixa;
}

/**
 * O endereço de encaminhamento da caixa, ou `null` se a entrada está desligada, a
 * caixa não está no escopo de quem pede ou ainda não tem endereço. Nunca lança por
 * falha de decifragem (`endereco: null` no DTO).
 */
export async function obterEncaminhamento(channelAccountId: string): Promise<EncaminhamentoDTO | null> {
  const ligada = entradaDeEmailLigada();
  if (!ligada) return null;
  const prisma = db();
  const caixa = await prisma.channelAccount.findFirst({
    where: { AND: [{ id: channelAccountId, canal: "email" }, escopoCanal({ escrita: true })] },
    select: { id: true },
  });
  if (!caixa) return null;
  const linha = await prisma.emailEncaminhamento.findUnique({ where: { channelAccountId: caixa.id } });
  return linha ? paraDTO(linha, ligada.dominio) : null;
}

/** Os campos de um endereço novo: o código só existe cifrado (e o hash serve para achar a caixa). */
function camposDeEnderecoNovo() {
  const token = randomBytes(16).toString("hex");
  return {
    tokenHash: hashDoToken(token),
    tokenCifrado: encryptCredentials({ token }) as unknown as Prisma.InputJsonValue,
    confirmacaoLink: Prisma.DbNull,
    confirmacaoEm: null,
    confirmadoEm: null,
    ultimoRecebidoEm: null,
    recusados: 0,
    ultimoRecusadoEm: null,
  };
}

/**
 * Gera (ou troca) o endereço da caixa. Gerar de novo = endereço novo e o antigo
 * morre; o estado volta a "aguardando confirmação". Para só garantir que existe um
 * (sem nunca trocar o que já está em uso), use `garantirEncaminhamento`.
 */
export async function gerarEncaminhamento(channelAccountId: string): Promise<EncaminhamentoDTO> {
  const ligada = entradaDeEmailLigada();
  if (!ligada) throw new EntradaDeEmailDesligada();
  const prisma = db();
  const caixa = await exigirGestaoDaCaixa(prisma, channelAccountId);

  const campos = camposDeEnderecoNovo();
  const linha = await prisma.emailEncaminhamento.upsert({
    where: { channelAccountId: caixa.id },
    create: tenantData<Prisma.EmailEncaminhamentoUncheckedCreateInput>({ channelAccountId: caixa.id, ...campos }),
    update: campos,
  });
  return paraDTO(linha, ligada.dominio);
}

/**
 * Garante que a caixa tem um endereço: devolve o que já existe e só cria quando não há. NUNCA troca o
 * código de um endereço que já existe (quem copiou ou já colou no Gmail não perde nada). É o que o
 * assistente "Receber e-mails sem senha" chama ao abrir: duas telas abertas ao mesmo tempo, ou o
 * mesmo pedido repetido, terminam com o MESMO endereço (o índice único por caixa decide quem cria).
 */
export async function garantirEncaminhamento(channelAccountId: string): Promise<EncaminhamentoDTO> {
  const ligada = entradaDeEmailLigada();
  if (!ligada) throw new EntradaDeEmailDesligada();
  const prisma = db();
  const caixa = await exigirGestaoDaCaixa(prisma, channelAccountId);

  const existente = await prisma.emailEncaminhamento.findUnique({ where: { channelAccountId: caixa.id } });
  if (existente) return paraDTO(existente, ligada.dominio);
  try {
    const nova = await prisma.emailEncaminhamento.create({
      data: tenantData<Prisma.EmailEncaminhamentoUncheckedCreateInput>({ channelAccountId: caixa.id, ...camposDeEnderecoNovo() }),
    });
    return paraDTO(nova, ligada.dominio);
  } catch (e) {
    // Outra abertura criou no mesmo instante (índice único por caixa): fica com a dela, sem trocar.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const deOutra = await prisma.emailEncaminhamento.findUnique({ where: { channelAccountId: caixa.id } });
      if (deOutra) return paraDTO(deOutra, ligada.dominio);
    }
    throw e;
  }
}

/** Desliga o encaminhamento da caixa: o endereço deixa de valer. */
export async function desligarEncaminhamento(channelAccountId: string): Promise<void> {
  const prisma = db();
  const caixa = await exigirGestaoDaCaixa(prisma, channelAccountId);
  await prisma.emailEncaminhamento.deleteMany({ where: { channelAccountId: caixa.id } });
}

/**
 * Acha a linha pelo código do endereço. Só ids saem daqui.
 *
 * `basePrisma` de propósito: é o webhook de entrada (E4), sem sessão e sem time no
 * contexto. O código longo (128 bits, só o hash fica no banco) É a autoridade, como
 * o nome da instância no webhook do WhatsApp. Quem chama passa a agir no time devolvido
 * (`runAsSystem(teamId, …)`).
 */
export async function acharEncaminhamentoPeloToken(
  token: string,
): Promise<{ id: string; teamId: string; channelAccountId: string } | null> {
  return basePrisma.emailEncaminhamento.findUnique({
    where: { tokenHash: hashDoToken(token) },
    select: { id: true, teamId: true, channelAccountId: true },
  });
}
