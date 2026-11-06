"use server";

import { acaoDaTela } from "@/lib/tenant";
import { mensagemDaRegra, mensagemParaTela } from "@/lib/erros";
import { tagsDoCampo } from "@/lib/tags-input";
import { revalidatePath } from "next/cache";

import {
  addNote,
  assignTagBulk,
  addContactTag,
  removeContactTag,
  addTagBulk,
  removeTagBulk,
  contactCreateSchema,
  contactUpdateSchema,
  create,
  createContactWithCompany,
  createCompanyForContact,
  enrichCompany,
  runEnrichmentForContact,
  propostaDaEmpresa,
  aplicarProposta,
  propostaDaPessoa,
  aplicarPropostaDaPessoa,
  consultarIeDaPessoa,
  estimarConsultaDeIe,
  podeUsarFontePaga,
  listarFontesPagas,
  MOTIVOS_DE_BUSCA_DE_PESSOA,
  PessoaSemDadoParaBuscar,
  PropostaDaPessoaExpirada,
  CpfDaConsultaInvalido,
  FonteDesligada,
  CustoAcimaDoTeto,
  CustoNaoConfirmado,
  CotaDaFonteEsgotada,
  ContadorIndisponivel,
  FonteSemAcesso,
  FonteSemCredito,
  FonteFalhou,
  type PropostaDaPessoa,
  type ResultadoDaPessoa,
  type ResultadoDaConferencia,
  conferirSituacaoDasEmpresas,
  verificarContatoAgro,
  ajustarAgroManual,
  iniciarVerificacaoAgro,
  cancelarVerificacaoAgro,
  andamentoDaVerificacaoAgro,
  type AndamentoAgro,
  type ResultadoDaVerificacaoAgro,
  type AgroTipo,
  type EstimativaDeBusca,
  EmpresaSemFonte,
  PropostaExpirada,
  ForbiddenError,
  logger,
  type PropostaDaEmpresa,
  unlinkCompany,
  type PersonInput,
  type CompanyInput,
  type Papel,
  createDeal,
  garantirTagPorNome,
  findDuplicateContacts,
  importCsv,
  importCasaDosDados,
  inscreverContatosSelecionados,
  listContactIds,
  listTags,
  marcarOptOut,
  mergeContacts,
  remove,
  removeMany,
  setContactTag,
  setRelacionamentoStatus,
  setRelacionamentoStatusBulk,
  update,
  transferirContatos,
  definirCompartilhado,
  opcoesDeResponsavel,
  ContatoJaCadastrado,
  type DuplicateGroup,
} from "@crmagro/core";
import { z } from "zod";
import type { Interesse, RelacionamentoStatus } from "@prisma/client";
import { redirect } from "next/navigation";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "contatos". */
const runAsUserAction = acaoDaTela("contatos");
/** "Rodar fluxo" mexe em fluxo: quem não tem a tela Fluxos não roda (o botão também some). */
const runAsUserActionFluxos = acaoDaTela("fluxos");
export type ActionState = { error?: string; ok?: boolean; summary?: string };

/** Tags do formulário; `undefined` quando ele não tem o campo (não mexe nas tags). Regra e testes: `lib/tags-input.ts`. */
function tagsFromForm(formData: FormData): string[] | undefined {
  return tagsDoCampo(formData.get("tags"));
}

function val(formData: FormData, key: string): string | undefined {
  const v = formData.get(key);
  const s = v ? String(v) : "";
  return s === "" ? undefined : s;
}

/**
 * Campo numérico opcional da edição: ausente no formulário = não mexe
 * (undefined); presente e vazio = limpa (""); o schema converte "1.250".
 */
function numeroDoForm(formData: FormData, key: string): string | undefined {
  if (!formData.has(key)) return undefined;
  return String(formData.get(key) ?? "").trim();
}

/**
 * Cria um contato (pessoa) + opcionalmente vincula uma empresa (com papel).
 * Contato que já existe é recusado (regra do dono, 28/09): `existenteId` vem
 * quando a pessoa pode abrir o existente; senão a mensagem diz o responsável.
 */
export async function createContactFullAction(input: {
  person: PersonInput;
  company?: CompanyInput | null;
  papel?: Papel;
  /** Responsável: o gestor escolhe; o vendedor só pode ser ele mesmo (o core confere). */
  responsavelId?: string | null;
  /** Status já no cadastro (Cliente, Contatado ou Nunca contatado). */
  relacionamentoStatus?: "novo" | "ja_conversou" | "cliente";
}): Promise<ActionState & { id?: string; existenteId?: string }> {
  if (!input.person?.nome?.trim()) return { error: "nome obrigatório" };
  try {
    const { contactId } = await runAsUserAction(async () => createContactWithCompany(input));
    revalidatePath("/contatos");
    return { ok: true, id: contactId };
  } catch (e) {
    const regra = mensagemDaRegra(e);
    if (e instanceof ContatoJaCadastrado) return { error: regra ?? e.message, ...(e.contactId ? { existenteId: e.contactId } : {}) };
    return { error: regra ?? mensagemParaTela(e) };
  }
}

/** Para o campo "Responsável" do cadastro: a equipe ativa (gestor escolhe) ou só a pessoa. */
export async function responsaveisAction(): Promise<{ pessoas: { id: string; nome: string }[]; eu: string | null; podeEscolher: boolean }> {
  return runAsUserAction(async () => opcoesDeResponsavel());
}

/** Adiciona (vincula) uma empresa a um contato existente (form de edição). */
export async function addCompanyAction(
  contactId: string,
  company: CompanyInput,
  papel: Papel,
): Promise<ActionState> {
  if (!company?.nome?.trim()) return { error: "nome da empresa obrigatório" };
  try {
    await runAsUserAction(async () => createCompanyForContact(contactId, company, papel));
    revalidatePath(`/contatos/${contactId}`);
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Atualiza os campos de uma empresa vinculada. */
export async function updateCompanyAction(
  contactId: string,
  companyId: string,
  company: CompanyInput,
): Promise<ActionState> {
  try {
    await runAsUserAction(async () => enrichCompany(companyId, company));
    revalidatePath(`/contatos/${contactId}`);
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/**
 * "Enriquecer empresa": consulta o CNPJ (e o site, se a empresa tem) e devolve o que achou, com a fonte e
 * a data de cada dado. NADA é gravado aqui: a pessoa vê, marca e só então `aplicarPropostaAction` grava.
 */
export async function propostaDaEmpresaAction(contactId: string, companyId: string): Promise<{ proposta?: PropostaDaEmpresa; error?: string }> {
  try {
    return { proposta: await runAsUserAction(async () => propostaDaEmpresa(contactId, companyId)) };
  } catch (e) {
    if (e instanceof EmpresaSemFonte) return { error: e.message };
    if (e instanceof ForbiddenError) return { error: "Você não tem permissão para enriquecer esta empresa." };
    if (e instanceof Error && /não encontrad/.test(e.message)) return { error: "Empresa ou contato não encontrado." };
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "[enriquecer-empresa] falha ao consultar");
    return { error: "Não deu para consultar agora. Tente de novo em instantes." };
  }
}

/** Grava SÓ os itens que a pessoa marcou (ids da proposta guardada no servidor; a tela nunca manda valores). */
export async function aplicarPropostaAction(
  contactId: string,
  propostaId: string,
  aceitos: string[],
  incluirDadosPublicos: boolean,
): Promise<{ ok?: boolean; aplicados?: string[]; ignorados?: string[]; error?: string }> {
  try {
    const ids = aceitos.filter((a) => typeof a === "string" && a.length < 60).slice(0, 100);
    const r = await runAsUserAction(async () => {
      const res = await aplicarProposta(propostaId, ids, { incluirDadosPublicos });
      // IE, CNAE e tipos de IE são o insumo do classificador de produtor: reclassifica depois de gravar.
      try {
        await runEnrichmentForContact(contactId);
      } catch {
        /* o rótulo se corrige na próxima rodada; não desfaz o que foi aplicado */
      }
      return res;
    });
    revalidatePath(`/contatos/${contactId}`);
    return { ok: true, aplicados: r.aplicados, ignorados: r.ignorados };
  } catch (e) {
    if (e instanceof PropostaExpirada) return { error: e.message };
    if (e instanceof ForbiddenError) return { error: "Você não tem permissão para alterar esta empresa." };
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "[enriquecer-empresa] falha ao aplicar");
    return { error: "Não deu para aplicar agora. Tente de novo em instantes." };
  }
}

// ---------------------------------------------------------------------------
// Enriquecer pessoa
// ---------------------------------------------------------------------------

const entradaDaPessoaSchema = z.object({
  cpf: z.string().max(20).optional(),
  nome: z.string().max(120).optional(),
  uf: z.string().length(2).optional(),
  cidade: z.string().max(80).optional(),
  email: z.string().max(200).optional(),
  telefone: z.string().max(40).optional(),
  incluirInativas: z.boolean().optional(),
});

/** Mensagem pronta para cada recusa (a tela mostra como está). */
function erroDaPessoa(e: unknown): string {
  if (e instanceof ForbiddenError) return "Você não tem permissão para esta consulta.";
  if (
    e instanceof PessoaSemDadoParaBuscar ||
    e instanceof PropostaDaPessoaExpirada ||
    e instanceof CpfDaConsultaInvalido ||
    e instanceof FonteDesligada ||
    e instanceof CustoAcimaDoTeto ||
    e instanceof CustoNaoConfirmado ||
    e instanceof CotaDaFonteEsgotada ||
    e instanceof ContadorIndisponivel
  ) {
    return e.message;
  }
  if (e instanceof FonteSemAcesso) return "A fonte não aceitou a chave. Confira em Integrações, Fontes de dados.";
  if (e instanceof FonteSemCredito) return "A fonte está sem créditos ou no limite por minuto. Tente de novo mais tarde.";
  if (e instanceof FonteFalhou) return "A fonte não respondeu. Tente de novo em instantes.";
  if (e instanceof Error && /não encontrad/.test(e.message)) return "Contato não encontrado.";
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "[enriquecer-pessoa] falha inesperada");
  return "Não deu para consultar agora. Tente de novo em instantes.";
}

/** "Enriquecer pessoa": acha as empresas da pessoa na fonte gratuita. NADA é gravado; o CPF digitado não é guardado. */
export async function propostaDaPessoaAction(contactId: string, entrada: z.input<typeof entradaDaPessoaSchema>): Promise<{ proposta?: PropostaDaPessoa; error?: string }> {
  try {
    const e = entradaDaPessoaSchema.parse(entrada);
    return { proposta: await runAsUserAction(async () => propostaDaPessoa(contactId, e)) };
  } catch (e) {
    if (e instanceof z.ZodError) return { error: "Confira os campos." };
    return { error: erroDaPessoa(e) };
  }
}

/** A pessoa pode usar a consulta paga de IE e a fonte está ligada? Esconde a opção quando não. */
export async function fontePagaDisponivelParaPessoaAction(): Promise<{ pode: boolean; ligada: boolean }> {
  try {
    return await runAsUserAction(async () => {
      if (!podeUsarFontePaga()) return { pode: false, ligada: false };
      return { pode: true, ligada: (await listarFontesPagas()).some((f) => f.ligada) };
    });
  } catch {
    return { pode: false, ligada: false };
  }
}

/** Quanto custa a consulta de IE, SEM consultar. */
export async function estimarIeDaPessoaAction(): Promise<{ estimativa?: EstimativaDeBusca; error?: string }> {
  try {
    return { estimativa: await runAsUserAction(async () => estimarConsultaDeIe()) };
  } catch (e) {
    return { error: erroDaPessoa(e) };
  }
}

/** IE de produtor rural (fonte PAGA, administrador): exige a confirmação do custo mostrado. O fornecedor recebe o CPF. */
export async function consultarIeDaPessoaAction(
  propostaId: string,
  p: { cpf: string; uf: string; motivo: (typeof MOTIVOS_DE_BUSCA_DE_PESSOA)[number]; creditosConfirmados: number },
): Promise<{ proposta?: PropostaDaPessoa; error?: string }> {
  try {
    const v = z
      .object({ cpf: z.string().max(20), uf: z.string().length(2), motivo: z.enum(MOTIVOS_DE_BUSCA_DE_PESSOA), creditosConfirmados: z.number().int().min(0).max(1000) })
      .parse(p);
    return { proposta: await runAsUserAction(async () => consultarIeDaPessoa(z.string().uuid().parse(propostaId), v)) };
  } catch (e) {
    if (e instanceof z.ZodError) return { error: "Confira os campos." };
    return { error: erroDaPessoa(e) };
  }
}

/** Vincula só o que a pessoa marcou (ids da proposta guardada no servidor; a tela nunca manda valores). */
export async function aplicarPropostaDaPessoaAction(
  contactId: string,
  propostaId: string,
  aceitos: { empresas: string[]; ies: string[]; contatos?: string[]; guardarCpf?: string | null },
): Promise<{ resultado?: ResultadoDaPessoa; error?: string }> {
  try {
    const a = {
      empresas: aceitos.empresas.filter((x) => typeof x === "string" && x.length < 40).slice(0, 100),
      ies: aceitos.ies.filter((x) => typeof x === "string" && x.length < 40).slice(0, 100),
      contatos: (aceitos.contatos ?? []).filter((x) => typeof x === "string" && x.length < 40).slice(0, 100),
      guardarCpf: typeof aceitos.guardarCpf === "string" ? aceitos.guardarCpf.slice(0, 20) : null,
    };
    const resultado = await runAsUserAction(async () => aplicarPropostaDaPessoa(z.string().uuid().parse(propostaId), a));
    revalidatePath(`/contatos/${contactId}`);
    return { resultado };
  } catch (e) {
    if (e instanceof z.ZodError) return { error: "Confira os campos." };
    return { error: erroDaPessoa(e) };
  }
}

/** Confere na Receita se cada empresa do contato está ativa e guarda (para empresas vinculadas antes de o CRM Agro guardar isso). */
export async function conferirSituacaoDasEmpresasAction(contactId: string): Promise<{ resultado?: ResultadoDaConferencia; error?: string }> {
  try {
    const resultado = await runAsUserAction(async () => conferirSituacaoDasEmpresas(z.string().uuid().parse(contactId)));
    revalidatePath(`/contatos/${contactId}`);
    return { resultado };
  } catch (e) {
    if (e instanceof z.ZodError) return { error: "Confira os campos." };
    return { error: mensagemParaTela(e) };
  }
}

function erroDoAgro(e: unknown): string {
  if (e instanceof ForbiddenError) return "Você não tem permissão para verificar este contato.";
  if (e instanceof Error && e.name === "ContactNotFound") return "Contato não encontrado.";
  return mensagemParaTela(e);
}

/**
 * Botão "Verificar agro": lê o nome, as empresas (CNAE e sócios) e a foto do WhatsApp e grava o que o contato é no agro
 * (produtor, fazenda, armazém, algodoeira). O que não precisa de IA sai na hora; a foto fica na fila para o Claude.
 * `refazerFoto` confere a foto de novo; `forcar` verifica também o contato que foi ajustado à mão.
 */
export async function verificarAgroAction(contactId: string, opts: { refazerFoto?: boolean; forcar?: boolean } = {}): Promise<{ resultado?: ResultadoDaVerificacaoAgro; error?: string }> {
  try {
    const id = z.string().uuid().parse(contactId);
    const o = z.object({ refazerFoto: z.boolean().optional(), forcar: z.boolean().optional() }).parse(opts);
    const resultado = await runAsUserAction(async () => verificarContatoAgro(id, o));
    revalidatePath(`/contatos/${id}`);
    return { resultado };
  } catch (e) {
    if (e instanceof z.ZodError) return { error: "Confira os campos." };
    return { error: erroDoAgro(e) };
  }
}

/** Troca à mão o que o contato é no agro. A verificação automática não mexe até a pessoa pedir (`forcar`). */
export async function ajustarAgroAction(contactId: string, tipos: AgroTipo[]): Promise<{ tipos?: AgroTipo[]; error?: string }> {
  try {
    const id = z.string().uuid().parse(contactId);
    const r = await runAsUserAction(async () => ajustarAgroManual(id, tipos));
    revalidatePath(`/contatos/${id}`);
    return { tipos: r.tipos };
  } catch (e) {
    if (e instanceof z.ZodError) return { error: "Confira os campos." };
    return { error: erroDoAgro(e) };
  }
}

/**
 * "Selecionar todos do filtro" + Verificar agro: a verificação roda em segundo plano, pelo worker, para a base inteira
 * do filtro (só os contatos que a pessoa pode alterar). Um lote por empresa por vez.
 */
export async function verificarAgroDoFiltroAction(input: { filter: ContactFilter }): Promise<{ ok?: true; total?: number; error?: string }> {
  try {
    const r = await runAsUserAction(async () => iniciarVerificacaoAgro(await resolveIds({ filter: input.filter })));
    revalidatePath("/contatos");
    return { ok: true, total: r.total };
  } catch (e) {
    return { error: mensagemParaTela(e, { semPrefixo: true }) };
  }
}

/** Andamento da verificação do agro em segundo plano (a tela consulta enquanto ela anda). */
export async function andamentoAgroAction(): Promise<AndamentoAgro | null> {
  try {
    return await runAsUserAction(async () => andamentoDaVerificacaoAgro());
  } catch {
    return null;
  }
}

/** Cancela a verificação em segundo plano. O que já foi verificado fica. */
export async function cancelarAgroAction(): Promise<{ ok?: true; error?: string }> {
  try {
    await runAsUserAction(async () => cancelarVerificacaoAgro());
    revalidatePath("/contatos");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e, { semPrefixo: true }) };
  }
}

/** Desvincula (não apaga) uma empresa do contato. */
export async function unlinkCompanyAction(contactId: string, companyId: string): Promise<ActionState> {
  try {
    await runAsUserAction(async () => unlinkCompany(contactId, companyId));
    revalidatePath(`/contatos/${contactId}`);
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/**
 * "Pediu para sair" marcado pelo vendedor (ou confirmando a sugestão da IA):
 * opt-out, tag, inscrições encerradas e campanhas puladas (N12). Papel member.
 */
export async function marcarOptOutAction(contactId: string): Promise<ActionState> {
  try {
    const r = await runAsUserAction(async () => marcarOptOut(contactId));
    revalidatePath(`/contatos/${contactId}`);
    revalidatePath("/contatos");
    return {
      ok: true,
      summary: r.novo ? "Contato marcado: pediu para sair." : "O contato já tinha pedido para sair.",
    };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function createContactAction(_prev: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const parsed = contactCreateSchema.safeParse({
    nome: formData.get("nome"),
    sobrenome: val(formData, "sobrenome"),
    email: val(formData, "email"),
    telefone: val(formData, "telefone"),
    cidade: val(formData, "cidade"),
    empresa: val(formData, "empresa"),
    cargo: val(formData, "cargo"),
    origem: val(formData, "origem") ?? "manual",
    tags: tagsFromForm(formData),
    areaHa: val(formData, "areaHa"),
    faturamentoAnual: val(formData, "faturamentoAnual"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  try {
    await runAsUserAction(async () => await create(parsed.data));
  } catch (e) {
    // Já cadastrado (regra do dono, 28/09): diz com quem está, em vez de estourar.
    const regra = mensagemDaRegra(e);
    if (regra) return { error: regra };
    throw e;
  }
  revalidatePath("/contatos");
  redirect("/contatos");
}

export async function updateContactAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id"));
  const parsed = contactUpdateSchema.safeParse({
    nome: val(formData, "nome"),
    sobrenome: val(formData, "sobrenome"),
    email: val(formData, "email"),
    telefone: val(formData, "telefone"),
    cidade: val(formData, "cidade"),
    estado: val(formData, "estado"),
    empresa: val(formData, "empresa"),
    cargo: val(formData, "cargo"),
    origem: val(formData, "origem"),
    tags: tagsFromForm(formData),
    // A lista que a pessoa via ao abrir: com ela, só o que ela pôs ou tirou é gravado (ver `update`, no core).
    tagsIniciais: tagsDoCampo(formData.get("tagsIniciais")),
    areaHa: numeroDoForm(formData, "areaHa"),
    faturamentoAnual: numeroDoForm(formData, "faturamentoAnual"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  await runAsUserAction(async () => await update(id, parsed.data));
  revalidatePath(`/contatos/${id}`);
  revalidatePath("/contatos");
  return { ok: true };
}

export async function deleteContactAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id"));
  await runAsUserAction(async () => await remove(id));
  revalidatePath("/contatos");
  redirect("/contatos");
}

export async function addNoteAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  const contactId = String(formData.get("contactId"));
  const conteudo = String(formData.get("conteudo") ?? "");
  if (!conteudo.trim()) return { error: "nota vazia" };
  await runAsUserAction(async () => await addNote(contactId, conteudo));
  revalidatePath(`/contatos/${contactId}`);
  return { ok: true };
}

/** Cria um Deal (card) para o contato num funil/etapa escolhidos. */
export async function addToFunnelAction(input: {
  contactId: string;
  funnelId: string;
  stageId: string;
  valor?: number;
}): Promise<ActionState> {
  if (!input.contactId || !input.funnelId || !input.stageId) {
    return { error: "escolha funil e etapa" };
  }
  try {
    await runAsUserAction(async () =>
      createDeal({
        funnelId: input.funnelId,
        stageId: input.stageId,
        contactId: input.contactId,
        valor: input.valor ?? 0,
      }),
    );
  } catch (e) {
    return { error: String(e) };
  }
  revalidatePath(`/contatos/${input.contactId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tags + ações em massa (Fase 1)
// ---------------------------------------------------------------------------

/** Filtros da listagem — usados quando a seleção é "todos os N do filtro". */
export type ContactFilter = {
  search?: string;
  status?: RelacionamentoStatus;
  interesse?: Interesse;
  origem?: string;
  tag?: string;
  /** rótulo de produtor rural: produtor | provavel_produtor | nao_produtor. */
  produtor?: string;
  /** O que o contato é no agro: um tipo ou "nenhum" (sem classificação). */
  agro?: string;
  /** "Por vendedor" (F3d): dono do contato (só vale para quem vê o time todo). */
  dono?: string;
};

/** Resolve os ids alvo: os explícitos, ou todos os que casam com o filtro. */
async function resolveIds(input: { ids?: string[]; filter?: ContactFilter }): Promise<string[]> {
  if (input.ids && input.ids.length) return input.ids;
  // "Todos os N do filtro" é o que a tela mostra, e a busca da tela procura também no histórico.
  if (input.filter) return listContactIds({ ...input.filter, historico: true });
  return [];
}

/**
 * "Nova tag" dos menus de Contatos. Passa pelo mesmo caminho do campo "Tags" e do seletor dos fluxos: um nome que já
 * existe (sem olhar acento nem maiúscula) devolve a tag que existe, em vez de nascer uma repetida no catálogo.
 * `criada` diz se a tag é nova.
 */
export async function createTagAction(input: {
  nome: string;
}): Promise<ActionState & { tagId?: string; criada?: boolean }> {
  const nome = input.nome?.trim();
  if (!nome) return { error: "nome da tag obrigatório" };
  try {
    const tag = await runAsUserAction(async () => garantirTagPorNome(nome));
    revalidatePath("/contatos");
    return { ok: true, tagId: tag.id, criada: tag.criada };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Tags do time para o autocomplete do campo "Tags" (nome, cor e quantos contatos têm cada uma). */
export async function tagsDoTimeAction(): Promise<{ id: string; nome: string; cor: string | null; count: number }[]> {
  return runAsUserAction(async () => listTags());
}

/** Define/troca a tag de UM contato (tagId null remove). */
export async function setContactTagAction(input: {
  contactId: string;
  tagId: string | null;
}): Promise<ActionState> {
  if (!input.contactId) return { error: "contato inválido" };
  try {
    await runAsUserAction(async () => setContactTag(input.contactId, input.tagId));
    revalidatePath("/contatos");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Move os contatos selecionados (ou todos do filtro) para uma tag (ou remove). */
export async function assignTagBulkAction(input: {
  ids?: string[];
  filter?: ContactFilter;
  tagId: string | null;
}): Promise<ActionState & { updated?: number }> {
  try {
    const res = await runAsUserAction(async () => {
      const ids = await resolveIds(input);
      return assignTagBulk(ids, input.tagId);
    });
    revalidatePath("/contatos");
    return { ok: true, updated: res.updated };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Põe ou tira UMA tag de um contato, sem mexer nas outras (menu da linha). */
export async function toggleContactTagAction(input: {
  contactId: string;
  tagId: string;
  acao: "adicionar" | "tirar";
}): Promise<ActionState> {
  if (!input.contactId || !input.tagId) return { error: "contato ou tag inválido" };
  try {
    await runAsUserAction(async () =>
      input.acao === "adicionar" ? addContactTag(input.contactId, input.tagId) : removeContactTag(input.contactId, input.tagId),
    );
    revalidatePath("/contatos");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Adiciona ou tira uma tag dos selecionados (ou de todos do filtro), sem mexer nas outras tags deles. */
export async function tagEmMassaAction(input: {
  ids?: string[];
  filter?: ContactFilter;
  tagId: string;
  acao: "adicionar" | "tirar";
}): Promise<ActionState & { updated?: number; jaTinham?: number }> {
  if (!input.tagId) return { error: "escolha uma tag" };
  try {
    const res = await runAsUserAction(async () => {
      const ids = await resolveIds(input);
      if (input.acao === "adicionar") return addTagBulk(ids, input.tagId);
      return { ...(await removeTagBulk(ids, input.tagId)), jaTinham: 0 };
    });
    revalidatePath("/contatos");
    return { ok: true, updated: res.updated, jaTinham: res.jaTinham };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/**
 * "Rodar fluxo" na barra de seleção: inscreve os contatos escolhidos (ou todos do filtro) num fluxo de gatilho
 * "Contatos selecionados". O core confere o fluxo e cada contato; `ignorados` = quem já estava no fluxo, pediu para sair
 * ou foi barrado por reentrada.
 */
export async function rodarFluxoNosSelecionadosAction(input: {
  flowId: string;
  ids?: string[];
  filter?: ContactFilter;
}): Promise<ActionState & { inscritas?: number; ignorados?: number }> {
  try {
    const r = await runAsUserActionFluxos(async () => inscreverContatosSelecionados(input.flowId, await resolveIds(input)));
    revalidatePath("/contatos");
    revalidatePath(`/fluxos/${input.flowId}`);
    return { ok: true, inscritas: r.inscritas, ignorados: r.ignorados };
  } catch (e) {
    return { error: mensagemParaTela(e, { semPrefixo: true }) };
  }
}

/** Marca o status de UM contato (na ficha): Nunca contatado, Contatado ou Cliente. */
export async function setStatusAction(
  contactId: string,
  status: "novo" | "ja_conversou" | "cliente",
): Promise<ActionState> {
  try {
    await runAsUserAction(async () => setRelacionamentoStatus(contactId, status));
    revalidatePath("/contatos");
    revalidatePath(`/contatos/${contactId}`);
    return { ok: true };
  } catch (e) {
    return { error: mensagemDaRegra(e) ?? (e instanceof Error ? e.message.replace(/^[A-Za-z]+: /, "") : String(e)) };
  }
}

/**
 * Marca o status dos contatos selecionados (ou de todos do filtro): Nunca contatado, Contatado ou Cliente.
 * Quem pediu para sair não muda (vem na contagem de `pulados`).
 */
export async function setStatusBulkAction(input: {
  ids?: string[];
  filter?: ContactFilter;
  status: "novo" | "ja_conversou" | "cliente";
}): Promise<ActionState & { atualizados?: number; jaEstavam?: number; pulados?: number }> {
  try {
    const res = await runAsUserAction(async () => setRelacionamentoStatusBulk(await resolveIds(input), input.status));
    revalidatePath("/contatos");
    return { ok: true, ...res };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/**
 * Transfere os contatos selecionados (ou todos do filtro) para outra pessoa,
 * com os negócios deles (F3d). Só o administrador (o core confere).
 */
export async function transferirContatosAction(input: {
  ids?: string[];
  filter?: ContactFilter;
  para: string;
}): Promise<ActionState & { contatos?: number; negocios?: number }> {
  try {
    const res = await runAsUserAction(async () => {
      const ids = await resolveIds(input);
      if (ids.length === 0) return { contatos: 0, negocios: 0 };
      return transferirContatos(ids, input.para);
    });
    revalidatePath("/contatos");
    return { ok: true, ...res };
  } catch (e) {
    return { error: mensagemDeDono(e) };
  }
}

/** "Compartilhar com o time" / "Só eu" de um contato (F4): o dono ou o administrador. */
export async function compartilharContatoAction(contactId: string, compartilhado: boolean): Promise<ActionState> {
  try {
    await runAsUserAction(() => definirCompartilhado("contact", contactId, compartilhado));
    revalidatePath(`/contatos/${contactId}`);
    revalidatePath("/contatos");
    return { ok: true };
  } catch (e) {
    return { error: mensagemDeDono(e) };
  }
}

/** Mensagem legível para os erros de dono/compartilhamento. */
function mensagemDeDono(e: unknown): string {
  const nome = e instanceof Error ? e.name : "";
  if (nome === "ForbiddenError") return "Só o gestor (administrador) muda o responsável.";
  if (nome === "DestinoDaTransferenciaInvalido") return "Escolha uma pessoa ativa da equipe como responsável.";
  if (nome === "SoODonoCompartilha") return "Só o dono do contato (ou o administrador) muda o compartilhamento.";
  if (nome === "OwnedNotFound") return "Contato não encontrado.";
  return mensagemParaTela(e);
}

/** Exclui os contatos selecionados (ou todos do filtro). */
export async function deleteContactsBulkAction(input: {
  ids?: string[];
  filter?: ContactFilter;
}): Promise<ActionState & { deleted?: number }> {
  try {
    const res = await runAsUserAction(async () => {
      const ids = await resolveIds(input);
      return removeMany(ids);
    });
    revalidatePath("/contatos");
    return { ok: true, deleted: res.deleted };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function importCsvAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "nenhum arquivo enviado" };
  const text = await file.text();
  const result = await runAsUserAction(async () => await importCsv(text));
  revalidatePath("/contatos");
  return {
    ok: true,
    summary: `criados: ${result.created} | duplicados ignorados: ${result.skipped} | erros: ${result.errors.length}`,
  };
}

/** Importa contatos de um Excel (.xlsx) — converte a 1ª planilha em CSV e reusa o importCsv. */
export async function importExcelAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "nenhum arquivo enviado" };
  try {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.worksheets[0];
    if (!ws) return { error: "planilha vazia" };
    const linhas: string[] = [];
    ws.eachRow((row) => {
      const vals = ((row.values as unknown[]) ?? []).slice(1).map((v) => {
        const s = v == null ? "" : typeof v === "object" && (v as { text?: string }).text ? (v as { text: string }).text : String(v);
        return `"${s.replace(/"/g, '""')}"`;
      });
      linhas.push(vals.join(","));
    });
    const text = linhas.join("\n");
    const result = await runAsUserAction(async () => await importCsv(text));
    revalidatePath("/contatos");
    return {
      ok: true,
      summary: `criados: ${result.created} | duplicados ignorados: ${result.skipped} | erros: ${result.errors.length}`,
    };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Grupos de contatos duplicados (nome/telefone/email). */
export async function findDuplicatesAction(): Promise<DuplicateGroup[]> {
  return runAsUserAction(async () => findDuplicateContacts());
}

/** Unifica: mantém `keepId`, move tudo dos outros e os apaga. */
export async function mergeContactsAction(keepId: string, dropIds: string[]): Promise<ActionState> {
  if (!keepId || dropIds.length === 0) return { error: "selecione o contato a manter e ao menos um duplicado" };
  try {
    await runAsUserAction(async () => mergeContacts(keepId, dropIds));
    revalidatePath("/contatos/duplicados");
    revalidatePath("/contatos");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Lê um arquivo (CSV ou Excel) e devolve linhas como objetos (header → valor, minúsculo). */
async function planilhaParaLinhas(file: File): Promise<Record<string, string>[]> {
  const nome = file.name.toLowerCase();
  if (nome.endsWith(".csv")) {
    const Papa = (await import("papaparse")).default;
    const res = Papa.parse<Record<string, string>>(await file.text(), { header: true, skipEmptyLines: true });
    return (res.data ?? []).map((r) => {
      const o: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) o[k.trim().toLowerCase()] = (v ?? "").toString();
      return o;
    });
  }
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers: string[] = [];
  const linhas: Record<string, string>[] = [];
  ws.eachRow((row, idx) => {
    const vals = ((row.values as unknown[]) ?? []).slice(1);
    if (idx === 1) {
      vals.forEach((v, i) => (headers[i] = String(v ?? "").trim().toLowerCase()));
      return;
    }
    const o: Record<string, string> = {};
    vals.forEach((v, i) => {
      const s = v == null ? "" : typeof v === "object" && (v as { text?: string }).text ? (v as { text: string }).text : String(v);
      o[headers[i] ?? `col${i}`] = s;
    });
    linhas.push(o);
  });
  return linhas;
}

/** Importa a planilha exportada da Casa dos Dados (colunas próprias) → Contato + Empresa. */
export async function importCasaDosDadosAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "nenhum arquivo enviado" };
  try {
    const rows = await planilhaParaLinhas(file);
    if (!rows.length) return { error: "planilha vazia ou sem linhas" };
    const r = await runAsUserAction(async () => await importCasaDosDados(rows));
    revalidatePath("/contatos");
    return { ok: true, summary: `criados: ${r.criados} | já existiam (pulados): ${r.pulados}` };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}
