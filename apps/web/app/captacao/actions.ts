"use server";

import { mensagemParaTela } from "@/lib/erros";
import { acaoDaTela } from "@/lib/tenant";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  captureCnpjs,
  captureCnpjsPorFiltro,
  continuarBuscaPorFiltro,
  municipiosDaUf,
  captureEmpresasDeSocio,
  sociosDaEmpresa,
  buscaDeSocioSchema,
  estimarBuscaPorNome,
  buscarCandidatosPorNome,
  podeUsarFontePaga,
  listarFontesPagas,
  MOTIVOS_DE_BUSCA_DE_PESSOA,
  FonteDesligada,
  CustoAcimaDoTeto,
  CustoNaoConfirmado,
  CotaDaFonteEsgotada,
  ContadorIndisponivel,
  PedidoDePessoaInvalido,
  FonteSemAcesso,
  FonteSemCredito,
  FonteFalhou,
  CnpjInvalid,
  CnpjNotFound,
  type EstimativaDeBusca,
  type SociosDaEmpresa,
  type PaginaDeCandidatos,
  filtrosDaTelaSchema,
  FiltroInvalido,
  BuscaSemContinuacao,
  listDrafts,
  pararBuscaPorFiltro,
  importDrafts,
  vincularDrafts,
  list as listContacts,
  primaryTelefone,
  discardDrafts,
  clearPendingDrafts,
  enqueueCapture,
  iniciarCapturaInstagramPelaExtensao,
  capturaAtualDaPessoa,
  statusDaCapturaAtual,
  CapturaEmAndamento,
  ContaInstagramNaoConectada,
  ExtensaoIndisponivel,
  ForbiddenError,
  PerfilInstagramInvalido,
  logger,
  PRODUTOR_LABELS,
  type CapturaAtual,
  type OrigemCaptura,
  type ProspectDraftDTO,
  type StatusCaptura,
} from "@crmagro/core";
import { requireRoleAction } from "@/lib/tenant";
import { randomUUID } from "node:crypto";
import { LIMITE_INSTAGRAM_PADRAO, limiteDeCaptura } from "@/lib/captacao-limite";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "captacao". */
const runAsUserAction = acaoDaTela("captacao");
/**
 * Captura por CNPJ. Até 5 válidos: roda na hora e devolve `criados` (como
 * antes). Acima: vai para a fila (item 3.2) e devolve `enfileirados` — a tela
 * acompanha pelo `captureStatusAction(lote)`.
 */
export async function captureCnpjsAction(cnpjs: string[]): Promise<{
  lote?: string;
  criados?: number;
  falhas?: { cnpj: string; motivo: string }[];
  enfileirados?: number;
  error?: string;
}> {
  if (!cnpjs.length) return { error: "informe ao menos um CNPJ" };
  try {
    const r = await runAsUserAction(async () => captureCnpjs(cnpjs));
    revalidatePath("/captacao/cnpj");
    return r;
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/**
 * Busca de empresas por FILTRO (aba "Por filtros"): CNAE, estado, cidade, porte, capital social,
 * situação e data de abertura. Vai sempre para a fila `capture` (leva minutos); devolve o `lote`
 * e a tela acompanha pelo estado da busca. Os resultados caem na fila de revisão, nunca em Contatos.
 */
export async function captureCnpjsPorFiltroAction(
  input: z.input<typeof filtrosDaTelaSchema>,
): Promise<{ lote?: string; error?: string }> {
  try {
    const r = await runAsUserAction(async () => captureCnpjsPorFiltro(input));
    revalidatePath("/captacao/cnpj");
    return { lote: r.lote };
  } catch (e) {
    if (e instanceof FiltroInvalido) return { error: e.message };
    if (e instanceof ForbiddenError) return { error: "Você não tem permissão para buscar empresas." };
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "[captura] falha ao iniciar a busca por filtro");
    return { error: "Não deu para iniciar a busca agora. Tente de novo em instantes." };
  }
}

/** "Parar" a busca por filtro em andamento (a da própria pessoa). */
export async function pararBuscaPorFiltroAction(): Promise<{ parada?: boolean; error?: string }> {
  try {
    return await runAsUserAction(async () => pararBuscaPorFiltro());
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "Você não tem permissão para buscar empresas." };
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "[captura] falha ao parar a busca por filtro");
    return { error: "Não deu para parar a busca agora. Tente de novo." };
  }
}

/** "Buscar mais": continua a busca por filtro anterior de onde ela parou (mesmos filtros). */
export async function continuarBuscaPorFiltroAction(lote: string, limite: number): Promise<{ lote?: string; error?: string }> {
  try {
    const r = await runAsUserAction(async () =>
      continuarBuscaPorFiltro(z.string().uuid().parse(lote), z.number().int().min(1).max(500).parse(limite)),
    );
    revalidatePath("/captacao/cnpj");
    return { lote: r.lote };
  } catch (e) {
    if (e instanceof BuscaSemContinuacao) return { error: e.message };
    if (e instanceof ForbiddenError) return { error: "Você não tem permissão para buscar empresas." };
    if (e instanceof z.ZodError) return { error: "Pedido inválido." };
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "[captura] falha ao continuar a busca por filtro");
    return { error: "Não deu para continuar a busca agora. Tente de novo em instantes." };
  }
}

/**
 * "Por sócios": pede a busca das empresas de uma pessoa (por CPF ou por um sócio já listado). O CPF
 * digitado só serve para tirar a máscara: não é guardado, nem registrado, nem devolvido.
 */
export async function captureEmpresasDeSocioAction(input: z.input<typeof buscaDeSocioSchema>): Promise<{ lote?: string; error?: string }> {
  try {
    const r = await runAsUserAction(async () => captureEmpresasDeSocio(input));
    revalidatePath("/captacao/cnpj");
    return { lote: r.lote };
  } catch (e) {
    if (e instanceof FiltroInvalido) return { error: e.message };
    if (e instanceof ForbiddenError) return { error: "Você não tem permissão para buscar empresas." };
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "[captura] falha ao iniciar a busca por sócio");
    return { error: "Não deu para iniciar a busca agora. Tente de novo em instantes." };
  }
}

/** "Por sócios": os sócios de uma empresa (nome, qualificação e CPF mascarado). Não cria nada. */
export async function sociosDaEmpresaAction(cnpj: string): Promise<{ dados?: SociosDaEmpresa; error?: string }> {
  try {
    return { dados: await runAsUserAction(async () => sociosDaEmpresa(z.string().max(30).parse(cnpj))) };
  } catch (e) {
    if (e instanceof CnpjInvalid) return { error: "CNPJ inválido." };
    if (e instanceof CnpjNotFound) return { error: "CNPJ não encontrado." };
    if (e instanceof ForbiddenError) return { error: "Você não tem permissão para buscar empresas." };
    return { error: "Não deu para consultar este CNPJ agora. Tente de novo em instantes." };
  }
}

/** Mensagem pronta para cada recusa da fonte paga (a tela mostra como está). */
function erroDaFontePaga(e: unknown): string {
  if (e instanceof ForbiddenError) return "Só administradores usam fontes pagas.";
  if (
    e instanceof FonteDesligada ||
    e instanceof CustoAcimaDoTeto ||
    e instanceof CustoNaoConfirmado ||
    e instanceof CotaDaFonteEsgotada ||
    e instanceof ContadorIndisponivel ||
    e instanceof PedidoDePessoaInvalido
  ) {
    return e.message;
  }
  if (e instanceof FonteSemAcesso) return "A fonte não aceitou a chave. Confira em Integrações, Fontes de dados.";
  if (e instanceof FonteSemCredito) return "A fonte está sem créditos ou no limite por minuto. Tente de novo mais tarde.";
  if (e instanceof FonteFalhou) return "A fonte não respondeu. Tente de novo em instantes.";
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "[fonte-paga] falha inesperada");
  return "Não deu para consultar agora. Tente de novo em instantes.";
}

/** A pessoa pode usar a busca por nome (fonte paga) e a fonte está ligada? Esconde a opção quando não. */
export async function fontePagaDisponivelAction(): Promise<{ pode: boolean; ligada: boolean }> {
  try {
    return await runAsUserAction(async () => {
      if (!podeUsarFontePaga()) return { pode: false, ligada: false };
      return { pode: true, ligada: (await listarFontesPagas()).some((f) => f.ligada) };
    });
  } catch {
    return { pode: false, ligada: false };
  }
}

/** Quanto custaria a busca por nome, SEM consultar. Mostrado antes de pedir a confirmação. */
export async function estimarBuscaPorNomeAction(input: { nome: string; limite?: number }): Promise<{ estimativa?: EstimativaDeBusca; error?: string }> {
  try {
    return { estimativa: await runAsUserAction(async () => estimarBuscaPorNome(z.object({ nome: z.string().max(120), limite: z.number().int().optional() }).parse(input))) };
  } catch (e) {
    return { error: erroDaFontePaga(e) };
  }
}

/** Busca pessoas por nome na fonte paga (admin). Exige a confirmação do custo mostrado. */
export async function buscarCandidatosPorNomeAction(input: {
  nome: string;
  limite?: number;
  motivo: (typeof MOTIVOS_DE_BUSCA_DE_PESSOA)[number];
  creditosConfirmados: number;
}): Promise<{ pagina?: PaginaDeCandidatos; error?: string }> {
  try {
    const p = z
      .object({ nome: z.string().max(120), limite: z.number().int().optional(), motivo: z.enum(MOTIVOS_DE_BUSCA_DE_PESSOA), creditosConfirmados: z.number().int().min(0).max(1000) })
      .parse(input);
    return { pagina: await runAsUserAction(async () => buscarCandidatosPorNome(p)) };
  } catch (e) {
    if (e instanceof z.ZodError) return { error: "Confira os campos da busca." };
    return { error: erroDaFontePaga(e) };
  }
}

/** Cidades de um estado para a caixa de escolha (dado público, igual para todos). */
export async function municipiosDaUfAction(uf: string): Promise<string[]> {
  const u = z.string().length(2).parse(uf);
  return runAsUserAction(async () => (await municipiosDaUf(u)).map((m) => m.nome));
}

/** Dispara a captura do Google Maps (assíncrona no worker, como sempre). Devolve o `lote` para o status. */
export async function startMapsCaptureAction(
  termo: string,
  limite = 40,
): Promise<{ ok?: boolean; lote?: string; error?: string }> {
  const t = termo.trim();
  if (!t) return { error: "informe o termo de busca" };
  try {
    // RBAC (S7): o job roda no worker como sistema — o portão é aqui, antes de enfileirar.
    const { teamId, id: ownerId } = await requireRoleAction("member");
    const lote = randomUUID();
    await enqueueCapture({ origem: "maps", teamId, lote, termo: t, limite: Math.min(limite, 120), ownerId });
    return { ok: true, lote };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Resultado de "Buscar seguidores": o `codigo` deixa a tela reagir (mostrar andamento, ou o que fazer). */
export type ResultadoBuscaInstagram = {
  ok?: boolean;
  lote?: string;
  error?: string;
  codigo?: "em_andamento" | "extensao_offline" | "conta_ausente" | "sem_conta" | "perfil_invalido" | "sem_permissao" | "erro";
};

/**
 * Dispara a leitura de seguidores do Instagram PELA EXTENSÃO do CRM Agro, no Chrome de quem pediu
 * (IP residencial e sessão dele). Não usa o worker: sem extensão online devolve um erro que diz o
 * que fazer, e nunca cai no IP do servidor. Recusa uma segunda busca enquanto há uma andando
 * (aqui no servidor, não só na tela). Devolve o `lote` para a tela acompanhar o status.
 */
export async function startInstagramCaptureAction(
  perfil: string,
  limite: number = LIMITE_INSTAGRAM_PADRAO,
): Promise<ResultadoBuscaInstagram> {
  const p = perfil.trim();
  if (!p) return { error: "Informe o @ do perfil.", codigo: "perfil_invalido" };
  try {
    // RBAC (S7): o portão é aqui, antes de entregar a tarefa; o core confere de novo (`captacao.run`).
    await requireRoleAction("member");
    const { lote } = await runAsUserAction(async () =>
      iniciarCapturaInstagramPelaExtensao({ perfil: p, limite: limiteDeCaptura(limite) }),
    );
    return { ok: true, lote };
  } catch (e) {
    if (e instanceof CapturaEmAndamento) return { error: e.message, codigo: "em_andamento" };
    if (e instanceof ExtensaoIndisponivel) return { error: e.message, codigo: e.causa === "offline" ? "extensao_offline" : "conta_ausente" };
    if (e instanceof ContaInstagramNaoConectada) return { error: e.message, codigo: "sem_conta" };
    if (e instanceof PerfilInstagramInvalido) return { error: e.message, codigo: "perfil_invalido" };
    if (e instanceof ForbiddenError) return { error: "Você não tem permissão para buscar seguidores.", codigo: "sem_permissao" };
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "[captura] falha ao iniciar a busca do Instagram");
    return { error: "Não deu para iniciar a busca agora. Tente de novo em instantes.", codigo: "erro" };
  }
}

/**
 * Status de um lote de captação (item 3.2): na fila, rodando (com progresso),
 * concluída, vazia, parcial, interrompida ou falhou, com a mensagem pronta para a tela.
 * O time vem da sessão; lote de outro time → null. Uma busca do Instagram que venceu
 * (ninguém pegou, ou a extensão sumiu) já vem fechada como interrompida.
 */
export async function captureStatusAction(lote: string): Promise<StatusCaptura | null> {
  return runAsUserAction(async () => statusDaCapturaAtual(lote));
}

const origemSchema = z.enum(["maps", "instagram", "cnpj"]);

/**
 * A busca mais recente DESTA pessoa no tipo (`origem`) e se ainda está andando. A tela lê ao abrir,
 * ao recarregar e a cada poucos segundos: o botão "Buscar" fica desativado por este estado (que vem
 * do servidor, então vale também numa segunda aba). Null = ainda não buscou.
 */
export async function capturaAtualAction(origem: OrigemCaptura): Promise<CapturaAtual | null> {
  const o = origemSchema.parse(origem);
  return runAsUserAction(async () => capturaAtualDaPessoa(o));
}

const listDraftsSchema = z.object({
  origem: z.string().max(40).optional(),
  soComContato: z.boolean().optional(),
  search: z.string().max(200).optional(),
  // Filtros da fila (produto §H.6).
  temWhatsApp: z.boolean().optional(),
  produtorLabel: z
    .union([z.enum(PRODUTOR_LABELS), z.array(z.enum(PRODUTOR_LABELS)).max(3)])
    .optional(),
});

export async function listDraftsAction(input: z.input<typeof listDraftsSchema>): Promise<ProspectDraftDTO[]> {
  const filtros = listDraftsSchema.parse(input);
  return runAsUserAction(async () => listDrafts(filtros));
}

export async function importDraftsAction(ids: string[]): Promise<{ importados?: number; pulados?: number; error?: string }> {
  if (!ids.length) return { error: "selecione ao menos um" };
  try {
    const r = await runAsUserAction(async () => importDrafts(ids));
    revalidatePath("/captacao/cnpj");
    revalidatePath("/contatos");
    return r;
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/**
 * "Vincular a um contato": a empresa do CNPJ vai para a ficha de um contato que já existe, sem virar
 * contato (não entra na lista de Contatos). Os selecionados vão todos para o mesmo contato.
 */
export async function vincularDraftsAction(
  ids: string[],
  contactId: string,
): Promise<{ vinculados?: number; pulados?: number; error?: string }> {
  if (!ids.length) return { error: "selecione ao menos um" };
  if (!contactId) return { error: "escolha o contato" };
  try {
    const r = await runAsUserAction(async () => vincularDrafts(ids, contactId));
    revalidatePath("/captacao/cnpj");
    revalidatePath(`/contatos/${contactId}`);
    return r;
  } catch (e) {
    if (e instanceof Error && e.name === "OwnedNotFound") return { error: "Não encontrei esse contato. Atualize a tela e escolha de novo." };
    return { error: mensagemParaTela(e) };
  }
}

export type ContatoParaVinculo = { id: string; nome: string; empresa: string | null; telefone: string | null };

/** Contatos para escolher no "Vincular": só os que a pessoa pode ver, busca por nome, empresa ou número. */
export async function buscarContatosParaVinculoAction(search?: string): Promise<ContatoParaVinculo[]> {
  return runAsUserAction(async () => {
    const { items } = await listContacts({ search, limit: 30 });
    return items.map((c) => ({ id: c.id, nome: c.nome, empresa: c.empresa ?? null, telefone: primaryTelefone(c.identifiers) }));
  });
}

/**
 * "Limpar fila" — descarta os rascunhos pendentes de uma origem. Item H.1: é
 * ação EXPLÍCITA do usuário (com confirmação); NÃO chamar ao carregar a tela —
 * a fila agora persiste (a captura do worker não some ao trocar de aba).
 */
export async function clearPendingDraftsAction(origem: string): Promise<{ ok?: boolean; error?: string }> {
  try {
    await runAsUserAction(async () => clearPendingDrafts(origem));
    revalidatePath("/captacao");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function discardDraftsAction(ids: string[]): Promise<{ descartados?: number; error?: string }> {
  if (!ids.length) return { error: "selecione ao menos um" };
  try {
    const r = await runAsUserAction(async () => discardDrafts(ids));
    revalidatePath("/captacao/cnpj");
    return r;
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}
