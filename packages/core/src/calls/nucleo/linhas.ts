import { z } from "zod";
import type { LinhaDeLigacao as LinhaDoBanco, Prisma } from "@prisma/client";
import { db, tenantData, type TenantPrismaClient } from "@crmagro/db";
import { ForbiddenError, can, hasRole, requireCan, requireRole } from "../../auth/authz";
import { assertOwnedIfPresent } from "../../tenancy/assert-owned";
import { isUniqueViolation } from "../../contacts/errors";
import { mascararSegredo } from "../provedor/comum";
import { ChaveDeProvedorDeLigacaoSchema } from "../provedor/capacidades";
import { validarCredenciaisDeLigacao, visaoDasCredenciaisDeLigacao, type CampoPreenchidoDeLigacao } from "../provedor/descritor";
import { registroPadraoDeLigacao, type RegistroDeProvedoresDeLigacao } from "../provedor/registro";

/**
 * Linhas de ligação: por onde um vendedor, ou o time, liga.
 * Um ramal, um número de WhatsApp ou um aparelho, no CNPJ da empresa cliente. Cada pessoa pode ter uma
 * linha PADRÃO (no máximo uma, garantido pelo banco); a linha sem dono é do time inteiro.
 *
 * Regras que valem para tudo aqui:
 * - `db()` vem antes de qualquer `await` e o time nunca é parâmetro: sai do contexto (AGENTS.md §12).
 * - Escrever (criar, pausar, reativar, trocar a padrão) exige `calls.lines.manage` (administrador).
 * - Todo id que vira FK (`userId`, `integrationId`) passa por `assertOwned` antes de gravar.
 * - `credentials` (senha do ramal, token da pessoa) é cifrado pela extensão do `db()` e NUNCA volta à
 *   tela: a listagem mostra só `{ preenchido, ultimos4 }` dos campos secretos, e campo desconhecido é
 *   tratado como secreto. Só `linhaParaLigar` devolve as credenciais abertas, para uso do servidor.
 * - O que o serviço não faz: tela, provisionar no provedor, tetos da MP 1.396 (F2), mudar a Integration.
 * - A pausa por tempo (`pausadaAte`) só é gravada aqui. Quem reativa quando o prazo vence é o varredor
 *   da F2-20; para ligar, a linha precisa estar 'ativa'.
 */

export const TIPOS_DE_LINHA_DE_LIGACAO = ["ramal", "numero_whatsapp", "dispositivo"] as const;
export const TipoDeLinhaDeLigacaoSchema = z.enum(TIPOS_DE_LINHA_DE_LIGACAO);
export type TipoDeLinhaDeLigacao = z.infer<typeof TipoDeLinhaDeLigacaoSchema>;

export const ESTADOS_DE_LINHA_DE_LIGACAO = ["ativa", "pausada", "desativada"] as const;
export const EstadoDeLinhaDeLigacaoSchema = z.enum(ESTADOS_DE_LINHA_DE_LIGACAO);
export type EstadoDeLinhaDeLigacao = z.infer<typeof EstadoDeLinhaDeLigacaoSchema>;

// ---------------------------------------------------------------------------------------------------
// Erros nomeados (texto pela §15; nunca carregam valor de credencial)
// ---------------------------------------------------------------------------------------------------

export type ProblemaDeLinhaDeLigacao = { campo: string; mensagem: string };

/** Os dados da linha não passaram na validação. Os problemas dizem o campo e o que ajustar, sem repetir o valor. */
export class LinhaDeLigacaoInvalida extends Error {
  constructor(readonly problemas: readonly ProblemaDeLinhaDeLigacao[]) {
    super("Os dados da linha não são válidos.");
    this.name = "LinhaDeLigacaoInvalida";
  }
}

export class LinhaDeLigacaoNaoEncontrada extends Error {
  constructor() {
    super("Essa linha não existe neste time.");
    this.name = "LinhaDeLigacaoNaoEncontrada";
  }
}

/** A mesma linha do provedor já existe (neste time ou em outro: a resposta é a mesma, de propósito). */
export class LinhaDeLigacaoJaCadastrada extends Error {
  constructor() {
    super("Essa linha já está cadastrada.");
    this.name = "LinhaDeLigacaoJaCadastrada";
  }
}

/** Linha desativada fica como está: não pausa, não reativa e não vira padrão. */
export class LinhaDeLigacaoDesativada extends Error {
  constructor() {
    super("Essa linha foi desativada e não pode mais mudar.");
    this.name = "LinhaDeLigacaoDesativada";
  }
}

/** A linha padrão é de uma pessoa. A linha do time (sem dono) não tem padrão. */
export class LinhaDeLigacaoSemDono extends Error {
  constructor() {
    super("A linha padrão precisa ser de uma pessoa. Escolha uma linha que tenha dono.");
    this.name = "LinhaDeLigacaoSemDono";
  }
}

/** Duas trocas de padrão ao mesmo tempo: o banco deixou passar uma só. */
export class ConflitoNaLinhaPadrao extends Error {
  constructor() {
    super("A linha padrão mudou agora há pouco. Tente de novo.");
    this.name = "ConflitoNaLinhaPadrao";
  }
}

export const MOTIVOS_DE_SEM_LINHA = ["sem_linha", "varias_linhas_do_time", "linha_inativa", "linha_indisponivel"] as const;
export type MotivoDeSemLinha = (typeof MOTIVOS_DE_SEM_LINHA)[number];

const TEXTO_DE_SEM_LINHA: Readonly<Record<MotivoDeSemLinha, string>> = {
  sem_linha: "Você ainda não tem uma linha para ligar. Peça a um administrador para cadastrar a sua.",
  varias_linhas_do_time: "O time tem mais de uma linha compartilhada e você não tem linha padrão. Peça a um administrador para definir a sua.",
  linha_inativa: "A linha de ligação não está ativa agora. Fale com um administrador.",
  linha_indisponivel: "Essa linha não está disponível para você.",
};

/** Não há linha para esta pessoa ligar. O `motivo` é uma lista fechada; o texto é fixo. */
export class SemLinhaParaLigar extends Error {
  readonly motivo: MotivoDeSemLinha;
  constructor(motivo: MotivoDeSemLinha) {
    super(TEXTO_DE_SEM_LINHA[motivo]);
    this.name = "SemLinhaParaLigar";
    this.motivo = motivo;
  }
}

// ---------------------------------------------------------------------------------------------------
// Entrada (zod na borda)
// ---------------------------------------------------------------------------------------------------

const texto = (max: number) => z.string().trim().min(1).max(max);
const idDeRegistro = z.string().min(1).max(64);

export const CriarLinhaDeLigacaoSchema = z
  .object({
    /** Chave de um provedor registrado em `calls/provedor/registro.ts`. */
    provedor: ChaveDeProvedorDeLigacaoSchema,
    tipo: TipoDeLinhaDeLigacaoSchema,
    /** A conta no provedor (domínio da conta, WABA). */
    contaExterna: texto(120),
    /** A linha no provedor (ramal, phone_number_id). Com a conta e o provedor, é único no sistema todo. */
    idExterno: texto(120),
    integrationId: idDeRegistro.nullish(),
    /** Dono da linha. Nulo = linha do time. */
    userId: idDeRegistro.nullish(),
    padrao: z.boolean().default(false),
    rotulo: texto(80).nullish(),
    numeroExibido: texto(40).nullish(),
    /** O que é só desta linha, no formato do descritor do provedor (escopo "linha"). Validado e cifrado. */
    credenciais: z.record(z.string(), z.unknown()).nullish(),
    /** Ambiente da conta, para conferir os prefixos das chaves. */
    ambiente: z.enum(["teste", "producao"]).default("producao"),
  })
  .strict();
export type CriarLinhaDeLigacaoInput = z.input<typeof CriarLinhaDeLigacaoSchema>;

const PausarLinhaDeLigacaoSchema = z
  .object({
    motivo: texto(200),
    /** Até quando fica pausada. Sem data, só volta quando um administrador reativar. */
    ate: z.date().nullish(),
  })
  .strict();
export type PausarLinhaDeLigacaoInput = z.input<typeof PausarLinhaDeLigacaoSchema>;

/** Mensagem por tipo de problema. Nunca repete o valor digitado (pode ser segredo). */
function mensagemDoIssue(i: z.ZodIssue): string {
  switch (i.code) {
    case z.ZodIssueCode.too_small:
      return "Preencha este campo.";
    case z.ZodIssueCode.too_big:
      return "O valor é longo demais.";
    case z.ZodIssueCode.invalid_enum_value:
      return "Escolha uma das opções.";
    case z.ZodIssueCode.unrecognized_keys:
      return "Este campo não existe.";
    default:
      return "O valor não é válido.";
  }
}

/** Os erros do descritor vêm com o nome do campo da credencial; "credenciais" e "ambiente" já são campos da entrada. */
const campoDaCredencial = (campo: string): string => (campo === "credenciais" || campo === "ambiente" ? campo : `credenciais.${campo}`);

function validar<T extends z.ZodTypeAny>(schema: T, entrada: unknown): z.output<T> {
  const r = schema.safeParse(entrada);
  if (r.success) return r.data;
  throw new LinhaDeLigacaoInvalida(r.error.issues.map((i) => ({ campo: i.path.join(".") || "linha", mensagem: mensagemDoIssue(i) })));
}

// ---------------------------------------------------------------------------------------------------
// Saída (sem segredo)
// ---------------------------------------------------------------------------------------------------

export type LinhaDeLigacaoDTO = {
  id: string;
  provedor: string;
  tipo: string;
  contaExterna: string;
  idExterno: string;
  integrationId: string | null;
  userId: string | null;
  padrao: boolean;
  rotulo: string | null;
  numeroExibido: string | null;
  estado: EstadoDeLinhaDeLigacao;
  motivoPausa: string | null;
  pausadaAte: Date | null;
  webhookVersao: number;
  /** Os campos de credencial da linha, sem o valor dos segredos: só `{ preenchido, ultimos4 }`. */
  credenciais: CampoPreenchidoDeLigacao[];
  createdAt: Date;
  updatedAt: Date;
};

/** Estado desconhecido no banco nunca parece utilizável: vira 'desativada'. */
function estadoSeguro(estado: string): EstadoDeLinhaDeLigacao {
  return EstadoDeLinhaDeLigacaoSchema.catch("desativada").parse(estado);
}

/** O `credentials` guardado como mapa de texto. Valor que não é texto é descartado. */
function credenciaisComoTexto(valor: unknown): Record<string, string> {
  if (valor === null || typeof valor !== "object" || Array.isArray(valor)) return {};
  const saida: Record<string, string> = {};
  for (const [k, v] of Object.entries(valor as Record<string, unknown>)) if (typeof v === "string") saida[k] = v;
  return saida;
}

/**
 * A visão das credenciais da linha para a tela. Provedor conhecido: o descritor diz o que é secreto. Campo
 * guardado que o descritor não conhece, ou provedor que saiu do registro: tratado como secreto (fecha por padrão).
 */
function visaoDasCredenciais(linha: LinhaDoBanco, registro: RegistroDeProvedoresDeLigacao): CampoPreenchidoDeLigacao[] {
  const guardadas = credenciaisComoTexto(linha.credentials);
  const comoSecreto = (chave: string): CampoPreenchidoDeLigacao => ({ chave, escopo: "linha", secreto: true, ...mascararSegredo(guardadas[chave]) });
  if (!registro.tem(linha.provedor)) return Object.keys(guardadas).map(comoSecreto);
  const descritor = registro.obter(linha.provedor).descritor;
  const conhecidas = new Set(descritor.campos.filter((c) => c.escopo === "linha").map((c) => c.chave));
  const extras = Object.keys(guardadas).filter((k) => !conhecidas.has(k)).map(comoSecreto);
  return [...visaoDasCredenciaisDeLigacao(descritor, "linha", guardadas), ...extras];
}

function paraDTO(linha: LinhaDoBanco, registro: RegistroDeProvedoresDeLigacao): LinhaDeLigacaoDTO {
  return {
    id: linha.id,
    provedor: linha.provedor,
    tipo: linha.tipo,
    contaExterna: linha.contaExterna,
    idExterno: linha.idExterno,
    integrationId: linha.integrationId,
    userId: linha.userId,
    padrao: linha.padrao,
    rotulo: linha.rotulo,
    numeroExibido: linha.numeroExibido,
    estado: estadoSeguro(linha.estado),
    motivoPausa: linha.motivoPausa,
    pausadaAte: linha.pausadaAte,
    webhookVersao: linha.webhookVersao,
    credenciais: visaoDasCredenciais(linha, registro),
    createdAt: linha.createdAt,
    updatedAt: linha.updatedAt,
  };
}

export type OpcoesDeLinhaDeLigacao = {
  /** Os provedores conhecidos. Padrão: o registro do app. Os testes passam um registro próprio. */
  registro?: RegistroDeProvedoresDeLigacao;
};

type TxDoTime = Parameters<Parameters<TenantPrismaClient["$transaction"]>[0]>[0];

// ---------------------------------------------------------------------------------------------------
// Escrita (administrador)
// ---------------------------------------------------------------------------------------------------

/**
 * Passa a linha a ser a padrão da pessoa. Tira a anterior na MESMA transação (o índice único parcial do banco
 * recusa duas padrão: quem perde uma corrida leva P2002, e quem chama traduz). Para criar, a linha nasce sem
 * ser padrão e é promovida aqui, assim um P2002 desta troca nunca se confunde com o da chave única da linha.
 */
async function promoverAPadrao(tx: TxDoTime, userId: string, linhaId: string): Promise<LinhaDoBanco> {
  await tx.linhaDeLigacao.updateMany({ where: { userId, padrao: true, id: { not: linhaId } }, data: { padrao: false } });
  return tx.linhaDeLigacao.update({ where: { id: linhaId }, data: { padrao: true } });
}

/** Cadastra uma linha. Com `padrao`, ela passa a ser a padrão do dono na mesma transação. */
export async function criarLinha(entrada: CriarLinhaDeLigacaoInput, opcoes: OpcoesDeLinhaDeLigacao = {}): Promise<LinhaDeLigacaoDTO> {
  requireCan("calls.lines.manage");
  const prisma = db();
  const registro = opcoes.registro ?? registroPadraoDeLigacao;
  const dados = validar(CriarLinhaDeLigacaoSchema, entrada);
  const userId = dados.userId ?? null;
  if (dados.padrao && !userId) throw new LinhaDeLigacaoInvalida([{ campo: "padrao", mensagem: "A linha padrão precisa ser de uma pessoa." }]);

  // Lança ProvedorDeLigacaoNaoRegistrado se a chave não está no registro.
  const { descritor } = registro.obter(dados.provedor);
  // Valida SEMPRE, mesmo sem `credenciais`: campo obrigatório do escopo "linha" (ramal, senha) não pode faltar,
  // senão a linha nasceria ativa e só falharia na hora de ligar. Sem nada a guardar, `credentials` fica nulo.
  const validadas = validarCredenciaisDeLigacao(descritor, "linha", dados.credenciais ?? {}, dados.ambiente);
  if (!validadas.ok) throw new LinhaDeLigacaoInvalida(validadas.erros.map((e) => ({ campo: campoDaCredencial(e.campo), mensagem: e.mensagem })));
  const credentials: Record<string, string> | null = Object.keys(validadas.credenciais).length > 0 ? validadas.credenciais : null;

  // O id vem do cliente e vira FK: tem de ser deste time (a FK do banco é de coluna única).
  await assertOwnedIfPresent("user", userId);
  await assertOwnedIfPresent("integration", dados.integrationId);

  // A linha nasce 'ativa' sem prova de posse da conta no provedor: a F2 só a ativa depois do teste de conexão
  //. Hoje o registro de provedores do app está vazio.
  let criada: LinhaDoBanco;
  let promovendo = false;
  try {
    criada = await prisma.$transaction(async (tx) => {
      const nova = await tx.linhaDeLigacao.create({
        data: tenantData<Prisma.LinhaDeLigacaoUncheckedCreateInput>({
          provedor: dados.provedor,
          tipo: dados.tipo,
          contaExterna: dados.contaExterna,
          idExterno: dados.idExterno,
          integrationId: dados.integrationId ?? null,
          userId,
          rotulo: dados.rotulo ?? null,
          numeroExibido: dados.numeroExibido ?? null,
          ...(credentials ? { credentials } : {}),
        }),
      });
      if (!dados.padrao || !userId) return nova;
      promovendo = true;
      return promoverAPadrao(tx, userId, nova.id);
    });
  } catch (e) {
    // Sob RLS o `meta.target` do erro vem vazio: só o código decide, e a fase diz qual unique foi violado:
    // a criação bate na chave (provedor, conta, id); a promoção bate no índice da linha padrão.
    if (isUniqueViolation(e)) throw promovendo ? new ConflitoNaLinhaPadrao() : new LinhaDeLigacaoJaCadastrada();
    throw e;
  }
  return paraDTO(criada, registro);
}

async function carregar(prisma: TenantPrismaClient, linhaId: string): Promise<LinhaDoBanco> {
  const linha = await prisma.linhaDeLigacao.findFirst({ where: { id: linhaId } });
  if (!linha) throw new LinhaDeLigacaoNaoEncontrada();
  return linha;
}

/** Pausa a linha. Sem `ate`, só volta quando um administrador reativar. */
export async function pausarLinha(linhaId: string, entrada: PausarLinhaDeLigacaoInput, opcoes: OpcoesDeLinhaDeLigacao = {}): Promise<LinhaDeLigacaoDTO> {
  requireCan("calls.lines.manage");
  const prisma = db();
  const registro = opcoes.registro ?? registroPadraoDeLigacao;
  const { motivo, ate } = validar(PausarLinhaDeLigacaoSchema, entrada);
  if (ate && ate.getTime() <= Date.now()) throw new LinhaDeLigacaoInvalida([{ campo: "ate", mensagem: "A data de volta precisa ser no futuro." }]);
  const atual = await carregar(prisma, linhaId);
  if (estadoSeguro(atual.estado) === "desativada") throw new LinhaDeLigacaoDesativada();
  const nova = await prisma.linhaDeLigacao.update({ where: { id: linhaId }, data: { estado: "pausada", motivoPausa: motivo, pausadaAte: ate ?? null } });
  return paraDTO(nova, registro);
}

/** Volta a linha a 'ativa' e limpa o motivo e o prazo da pausa. */
export async function reativarLinha(linhaId: string, opcoes: OpcoesDeLinhaDeLigacao = {}): Promise<LinhaDeLigacaoDTO> {
  requireCan("calls.lines.manage");
  const prisma = db();
  const registro = opcoes.registro ?? registroPadraoDeLigacao;
  const atual = await carregar(prisma, linhaId);
  if (estadoSeguro(atual.estado) === "desativada") throw new LinhaDeLigacaoDesativada();
  const nova = await prisma.linhaDeLigacao.update({ where: { id: linhaId }, data: { estado: "ativa", motivoPausa: null, pausadaAte: null } });
  return paraDTO(nova, registro);
}

/** Faz desta a linha padrão do dono dela. A anterior deixa de ser, na mesma transação. */
export async function definirLinhaPadrao(linhaId: string, opcoes: OpcoesDeLinhaDeLigacao = {}): Promise<LinhaDeLigacaoDTO> {
  requireCan("calls.lines.manage");
  const prisma = db();
  const registro = opcoes.registro ?? registroPadraoDeLigacao;
  const atual = await carregar(prisma, linhaId);
  if (estadoSeguro(atual.estado) === "desativada") throw new LinhaDeLigacaoDesativada();
  if (!atual.userId) throw new LinhaDeLigacaoSemDono();
  const userId = atual.userId;
  try {
    await prisma.$transaction(async (tx) => promoverAPadrao(tx, userId, linhaId));
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflitoNaLinhaPadrao();
    throw e;
  }
  return paraDTO(await carregar(prisma, linhaId), registro);
}

// ---------------------------------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------------------------------

export type FiltroDeLinhasDeLigacao = {
  /** Só as linhas desta pessoa. */
  userId?: string;
  /** Inclui as desativadas (padrão: não). */
  incluirDesativadas?: boolean;
};

/**
 * Lista as linhas do time, sem segredo. Quem gerencia (administrador) vê todas; as outras pessoas veem só a
 * própria e as do time. Sem papel no contexto, nega.
 */
export async function listarLinhas(filtro: FiltroDeLinhasDeLigacao = {}, opcoes: OpcoesDeLinhaDeLigacao = {}): Promise<LinhaDeLigacaoDTO[]> {
  const ator = requireRole("viewer");
  const prisma = db();
  const registro = opcoes.registro ?? registroPadraoDeLigacao;
  const gerencia = can("calls.lines.manage");
  const linhas = await prisma.linhaDeLigacao.findMany({
    where: {
      AND: [
        filtro.incluirDesativadas ? {} : { estado: { not: "desativada" } },
        filtro.userId ? { userId: filtro.userId } : {},
        gerencia ? {} : { OR: [{ userId: ator.userId }, { userId: null }] },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return linhas.map((l) => paraDTO(l, registro));
}

/** A linha escolhida para ligar. As `credenciais` estão abertas: SÓ SERVIDOR, nunca para a tela, o log ou um job. */
export type LinhaParaLigar = {
  id: string;
  provedor: string;
  tipo: string;
  contaExterna: string;
  idExterno: string;
  integrationId: string | null;
  userId: string | null;
  numeroExibido: string | null;
  webhookVersao: number;
  credenciais: Record<string, string>;
};

function paraLigar(l: LinhaDoBanco): LinhaParaLigar {
  return {
    id: l.id,
    provedor: l.provedor,
    tipo: l.tipo,
    contaExterna: l.contaExterna,
    idExterno: l.idExterno,
    integrationId: l.integrationId,
    userId: l.userId,
    numeroExibido: l.numeroExibido,
    webhookVersao: l.webhookVersao,
    credenciais: credenciaisComoTexto(l.credentials),
  };
}

/**
 * Qual linha esta pessoa usa para ligar.
 * - Com `linhaId`: essa linha, se for da pessoa ou do time e estiver ativa.
 * - Sem `linhaId`: a padrão da pessoa; sem padrão, a ÚNICA linha ativa do time sem dono. Senão, `SemLinhaParaLigar`.
 *
 * Quem não é administrador (nem o sistema) só resolve a linha de si mesmo. Linha pausada ou desativada não liga,
 * e a padrão inativa NÃO cai para a do time (a pausa vale para quem a recebeu).
 */
export async function linhaParaLigar(userId: string, linhaId?: string): Promise<LinhaParaLigar> {
  const ator = requireCan("calls.write");
  const prisma = db();
  if (userId !== ator.userId && !ator.system && !hasRole("admin")) throw new ForbiddenError();

  if (linhaId) {
    const escolhida = await prisma.linhaDeLigacao.findFirst({ where: { id: linhaId } });
    // Linha de outra pessoa e linha que não existe (ou é de outro time) dão a mesma resposta.
    if (!escolhida || (escolhida.userId !== null && escolhida.userId !== userId)) throw new SemLinhaParaLigar("linha_indisponivel");
    if (escolhida.estado !== "ativa") throw new SemLinhaParaLigar("linha_inativa");
    return paraLigar(escolhida);
  }

  const padrao = await prisma.linhaDeLigacao.findFirst({ where: { userId, padrao: true } });
  if (padrao) {
    if (padrao.estado !== "ativa") throw new SemLinhaParaLigar("linha_inativa");
    return paraLigar(padrao);
  }

  const doTime = await prisma.linhaDeLigacao.findMany({ where: { userId: null, estado: "ativa" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 2 });
  if (doTime.length === 1) return paraLigar(doTime[0]!);
  throw new SemLinhaParaLigar(doTime.length === 0 ? "sem_linha" : "varias_linhas_do_time");
}
