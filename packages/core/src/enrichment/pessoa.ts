import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db, getCurrentTeamId, impressaoDeTexto, nomeBuscaLugar, tenantData } from "@crmagro/db";
import {
  buscarPaginaMinhaReceita,
  consultarIeProdutorCnpja,
  cpfParaExibir,
  cpfValido,
  ehPessoaFisica,
  mascaraDeBusca,
  palavrasDoNome,
  registroAtivo,
  resultadoDoRegistro,
  socioDoRegistro,
  telefoneValido,
  CNPJA_CREDITOS_POR_CONSULTA_CCC,
  type IeDoProdutor,
  type RegistroMinhaReceita,
} from "@crmagro/captation";
import { getActor, requireCan } from "../auth/authz";
import { consultarCnpjDetalhado } from "../captacao/cnpj";
import { UFS } from "../captacao/busca-filtros";
import { MOTIVOS_DE_BUSCA_DE_PESSOA, estimarCreditos, executarConsultaPaga, type EstimativaDeBusca, type MotivoDeBuscaDePessoa } from "../captacao/fontes-pagas";
import { createCompanyForContact, type Papel } from "../companies/service";
import { registrarSituacaoDaEmpresa, situacaoEhAtiva } from "../companies/situacao";
import { adicionarIdentificadorSeNovo, completarEnderecoDoContato } from "../contacts/complemento";
import { completarCpfSeVazio, lerCpf } from "../contacts/cpf";
import { escopoDoContato } from "../contacts/escopo";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import type { Confianca } from "./empresa";
import { runEnrichmentForContact } from "./registry";

/**
 * ENRIQUECER PESSOA: a partir do CPF, do nome e sobrenome, da cidade e do estado, do e-mail e do
 * telefone, acha as empresas em que a pessoa é sócia ou dona (fonte gratuita, Minha Receita) e, só com
 * fonte paga ligada, as inscrições estaduais de produtor rural dela (CNPJá, CPF + UF).
 *
 * Mesma regra do enriquecer empresa: cada dado vem com FONTE, DATA e CONFIANÇA; nada é gravado antes do
 * OK; o servidor guarda a proposta e a tela só diz quais itens aceitou.
 *
 * Só entram as empresas ATIVAS na Receita (as baixadas, inaptas e suspensas ficam de fora, com a contagem
 * avisada na tela e um botão para incluí-las). Das ativas que o CRM Agro tem confiança de serem da pessoa,
 * ele também sugere telefone celular, e-mail e endereço que a Receita guarda NA EMPRESA. Não existe fonte
 * gratuita de telefone, e-mail ou endereço da PESSOA a partir do CPF: o que sai daqui é dado da empresa, com o
 * nome dela à vista, e só vale como dado da pessoa quando a empresa é de empresário individual ou MEI.
 *
 * LGPD (decisões do plano de 29/09, mantidas):
 *  - o CPF vem da tela (ou do cadastro, cifrado) e só serve para a consulta: não vai para o Redis, o
 *    log nem a proposta; a tela mostra sempre mascarado;
 *  - a máscara de CPF serve a ~1.000 pessoas: toda empresa achada é conferida pelo NOME e leva a
 *    confiança, e a pessoa decide;
 *  - dado de pessoa consultado por um time nunca aparece para outro (a proposta é por time e por
 *    pessoa; o registro da consulta paga é por time);
 *  - consulta paga: só administrador, fonte ligada em Integrações, motivo, custo confirmado, teto e
 *    registro. O fornecedor recebe o CPF inteiro (a consulta exige).
 */


export type EntradaDaPessoa = {
  cpf?: string | null;
  nome?: string | null;
  uf?: string | null;
  cidade?: string | null;
  email?: string | null;
  telefone?: string | null;
  /** Também traz as empresas baixadas, inaptas e suspensas (por padrão ficam de fora). */
  incluirInativas?: boolean;
};

export type EmpresaDaPessoa = {
  id: string;
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  cidade: string | null;
  uf: string | null;
  situacao: string | null;
  /** Situação cadastral ATIVA na Receita. */
  ativa: boolean;
  cnae: string | null;
  cnaeDescricao: string | null;
  qualificacao: string | null;
  confianca: Confianca;
  observacao: string | null;
  fonte: "minhareceita";
  fonteRotulo: string;
  consultadoEm: string;
  /** Já é empresa deste contato (não dá para vincular de novo). */
  jaVinculada: boolean;
};

export type IeDaPessoa = {
  id: string;
  numero: string;
  uf: string;
  habilitada: boolean;
  situacao: string | null;
  tipo: string | null;
  fonte: "cnpja";
  fonteRotulo: string;
  consultadoEm: string;
  confianca: Confianca;
};

/**
 * Telefone, e-mail ou endereço que a Receita guarda na empresa da pessoa e que o CRM Agro sugere acrescentar ao contato.
 * `provavelPessoal`: a empresa é de empresário individual ou MEI, em que o dado costuma ser da própria pessoa.
 */
export type DadoDeContatoDaPessoa = {
  id: string;
  tipo: "telefone" | "email" | "endereco";
  /** O que vai para o cadastro (telefone só com dígitos, e-mail em minúsculas, endereço sem cidade e estado). */
  valor: string;
  /** Como aparece na tela. */
  exibicao: string;
  /** Só no endereço: cidade e estado, que vão junto. */
  cidade: string | null;
  uf: string | null;
  empresa: string;
  provavelPessoal: boolean;
  /** O contato já tem esse dado (ou, no endereço, já tem um endereço): não dá para marcar. */
  jaNoCadastro: boolean;
  fonteRotulo: string;
  consultadoEm: string;
};

export type PropostaDaPessoa = {
  id: string;
  contactId: string;
  criadaEm: string;
  buscou: { porCpf: boolean; cpfExibicao: string | null; nome: string | null; uf: string | null; cidade: string | null; incluiuInativas: boolean };
  empresas: EmpresaDaPessoa[];
  /** Quantas empresas da pessoa estão inativas na Receita e ficaram de fora desta lista. */
  inativasOcultas: number;
  contatos: DadoDeContatoDaPessoa[];
  ies: IeDaPessoa[];
  avisos: string[];
};

export class PessoaSemDadoParaBuscar extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PessoaSemDadoParaBuscar";
  }
}
export class PropostaDaPessoaExpirada extends Error {
  constructor() {
    super("Essa consulta expirou. Faça de novo.");
    this.name = "PropostaDaPessoaExpirada";
  }
}

const TTL_S = 30 * 60;
export const PESSOA_MAX_PAGINAS = 5;
export const PESSOA_MAX_EMPRESAS = 30;
const chaveProposta = (teamId: string, id: string) => `enriq:pessoa:${teamId}:${id}`;
const ROTULO_MR = "Minha Receita (Receita Federal)";
const ROTULO_CNPJA = "CNPJá (Cadastro de Contribuintes)";

type Guardada = { proposta: PropostaDaPessoa; userId: string; mascara: string | null; nome: string | null; uf: string | null };

const digitos = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
const semDdi = (d: string) => (d.length > 11 && d.startsWith("55") ? d.slice(2) : d);
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function carregarContato(contactId: string) {
  const prisma = db();
  const c = await prisma.contact.findFirst({
    where: { AND: [{ id: contactId }, escopoDoContato({ escrita: true })] },
    select: { id: true, nome: true, sobrenome: true, cidade: true, estado: true, endereco: true, cpfCifrado: true },
  });
  if (!c) throw new Error("contato não encontrado no time");
  const idents = await prisma.channelIdentifier.findMany({ where: { contactId }, select: { canal: true, valor: true } });
  return { ...c, idents };
}

type Deps = {
  buscarPagina?: typeof buscarPaginaMinhaReceita;
  agora?: () => Date;
  pausaMs?: number;
  /** Consulta de CNPJ (e-mails das empresas). Só a busca com sugestão de contato usa. */
  consultarCnpj?: typeof consultarCnpjDetalhado;
};

type Busca = {
  proposta: PropostaDaPessoa;
  mascara: string | null;
  nome: string | null;
  uf: string | null;
  /** Registro da Receita de cada empresa da proposta (por CNPJ), para montar os dados de contato. */
  registros: Map<string, RegistroMinhaReceita>;
  /** Telefones (sem DDI) e e-mails que o contato já tem. */
  jaTem: { fones: Set<string>; emails: Set<string>; endereco: boolean };
};

/** Busca gratuita das empresas da pessoa e guarda a proposta no servidor. Não grava nada no cadastro; o CPF não é guardado. */
export async function propostaDaPessoa(contactId: string, entrada: EntradaDaPessoa, deps: Deps = {}): Promise<PropostaDaPessoa> {
  requireCan("contacts.write");
  const teamId = getCurrentTeamId();
  const actor = getActor();
  if (!teamId || !actor) throw new Error("sem time no contexto");
  const busca = await buscarEmpresasDaPessoa(contactId, entrada, deps);
  busca.proposta.contatos = await dadosDeContatoDasEmpresas(busca, deps);
  const { proposta, mascara, nome, uf } = busca;
  await guardar(teamId, { proposta, userId: actor.userId, mascara, nome, uf });
  return proposta;
}

/**
 * A busca em si (fonte gratuita), sem guardar nada. Também é usada pelo passo de fluxo "Enriquecer pessoa"
 * (modo automático). Lança `PessoaSemDadoParaBuscar` para entrada que não dá para buscar.
 */
export async function buscarEmpresasDaPessoa(
  contactId: string,
  entrada: EntradaDaPessoa,
  deps: Deps = {},
): Promise<Busca> {
  const c = await carregarContato(contactId);

  const cpf = entrada.cpf?.trim() || lerCpf(c.cpfCifrado);
  const nome = entrada.nome?.trim() || [c.nome, c.sobrenome].filter(Boolean).join(" ").trim() || null;
  const uf = (entrada.uf?.trim() || "").toUpperCase() || null;
  if (uf && !(UFS as readonly string[]).includes(uf)) throw new PessoaSemDadoParaBuscar(`Estado "${entrada.uf}" inválido.`);
  const cidade = entrada.cidade?.trim() || null;
  const avisos: string[] = [];
  const agora = (deps.agora?.() ?? new Date()).toISOString();

  let mascara: string | null = null;
  if (cpf) {
    if (!cpfValido(cpf)) throw new PessoaSemDadoParaBuscar("CPF inválido. Confira os 11 dígitos.");
    mascara = mascaraDeBusca(cpf);
  }
  if (nome && palavrasDoNome(nome).length < 2) avisos.push("Informe nome e sobrenome para o CRM Agro conferir quem é o sócio.");
  if (!mascara) avisos.push("Sem o CPF não dá para achar as empresas de graça. Informe o CPF ou, com a fonte paga ligada, procure a pessoa pelo nome na aba Por sócios da Captação.");

  const empresas: EmpresaDaPessoa[] = [];
  const registros = new Map<string, RegistroMinhaReceita>();
  let inativasOcultas = 0;
  const emailsDele = new Set([entrada.email, ...c.idents.filter((i) => i.canal === "email").map((i) => i.valor)].filter(Boolean).map((e) => String(e).trim().toLowerCase()));
  const fonesDele = new Set([entrada.telefone, ...c.idents.filter((i) => i.canal === "whatsapp").map((i) => i.valor)].map((t) => semDdi(digitos(t))).filter((d) => d.length >= 10));
  if (mascara) {
    const vinculados = new Set(
      (await db().contactCompany.findMany({ where: { contactId }, select: { company: { select: { cnpj: true } } } })).map((l) => l.company.cnpj).filter((x): x is string => Boolean(x)),
    );
    const cidadeBusca = cidade ? nomeBuscaLugar(cidade) : null;
    const buscar = deps.buscarPagina ?? buscarPaginaMinhaReceita;
    const alvo = { mascara, nome: palavrasDoNome(nome).length >= 2 ? nome : null };
    let cursor: string | null = null;
    paginas: for (let p = 0; p < PESSOA_MAX_PAGINAS; p++) {
      let pagina: Awaited<ReturnType<typeof buscarPaginaMinhaReceita>>;
      try {
        pagina = await buscar({ cnaes: [], ufs: uf ? [uf] : [], municipios: [], cnpf: [mascara] }, cursor);
      } catch (e) {
        avisos.push(`A busca na Receita parou: ${e instanceof Error ? e.message : "erro"}. ${empresas.length ? "O que já veio está abaixo." : "Tente de novo em instantes."}`);
        break;
      }
      for (const reg of pagina.registros as RegistroMinhaReceita[]) {
        const achado = socioDoRegistro(reg, alvo);
        if (!achado || !reg.cnpj) continue;
        if (cidadeBusca && nomeBuscaLugar(reg.municipio) !== cidadeBusca) continue;
        const ativa = registroAtivo(reg);
        if (!ativa && !entrada.incluirInativas) {
          inativasOcultas++;
          continue;
        }
        const bate = [emailsDele.has((reg.email ?? "").toLowerCase()) && reg.email ? "e-mail" : null, [reg.ddd_telefone_1, reg.ddd_telefone_2].some((t) => fonesDele.has(semDdi(digitos(t))) && digitos(t)) ? "telefone" : null].filter(Boolean) as string[];
        const confianca: Confianca = bate.length && achado.confianca !== "alta" ? (achado.confianca === "baixa" ? "media" : "alta") : achado.confianca;
        const cnpj = String(reg.cnpj).replace(/\D/g, "");
        empresas.push({
          id: `emp-${empresas.length + 1}`,
          cnpj,
          razaoSocial: reg.razao_social ?? null,
          nomeFantasia: reg.nome_fantasia || null,
          cidade: reg.municipio ?? null,
          uf: reg.uf ?? null,
          situacao: reg.descricao_situacao_cadastral ?? null,
          ativa,
          cnae: reg.cnae_fiscal != null ? String(reg.cnae_fiscal).padStart(7, "0") : null,
          cnaeDescricao: reg.cnae_fiscal_descricao ?? null,
          qualificacao: achado.qualificacao,
          confianca,
          observacao: bate.length ? `${bate.join(" e ")} igual ao do contato` : achado.confianca === "baixa" ? "Só o CPF bate: pode ser outra pessoa" : null,
          fonte: "minhareceita",
          fonteRotulo: ROTULO_MR,
          consultadoEm: agora,
          jaVinculada: vinculados.has(cnpj),
        });
        registros.set(cnpj, reg);
        if (empresas.length >= PESSOA_MAX_EMPRESAS) break paginas;
      }
      cursor = pagina.cursor;
      if (!cursor) break;
      await esperar(deps.pausaMs ?? 800);
    }
    if (!empresas.length && !avisos.length) {
      avisos.push(inativasOcultas ? `Nenhuma empresa ativa achada. ${inativasOcultas} ${inativasOcultas === 1 ? "inativa ficou" : "inativas ficaram"} de fora.` : "Nenhuma empresa achada com esse CPF e esse nome.");
    }
    const ordem: Record<Confianca, number> = { alta: 0, media: 1, baixa: 2 };
    empresas.sort((a, b) => Number(b.ativa) - Number(a.ativa) || ordem[a.confianca] - ordem[b.confianca]);
    empresas.forEach((e, i) => (e.id = `emp-${i + 1}`));
  }

  const proposta: PropostaDaPessoa = {
    id: randomUUID(),
    contactId,
    criadaEm: agora,
    buscou: { porCpf: Boolean(mascara), cpfExibicao: cpf ? cpfParaExibir(cpf) : null, nome, uf, cidade, incluiuInativas: entrada.incluirInativas === true },
    empresas,
    inativasOcultas,
    contatos: [],
    ies: [],
    avisos,
  };
  return { proposta, mascara, nome, uf, registros, jaTem: { fones: fonesDele, emails: emailsDele, endereco: Boolean(c.endereco?.trim()) } };
}

const MAX_EMPRESAS_PARA_CONTATO = 6;
const MAX_DADOS_DE_CONTATO = 12;

/** Celular com DDD: 11 dígitos, o 3º é o 9. Telefone fixo não serve de WhatsApp e fica só na empresa. */
const ehCelular = (d: string) => d.length === 11 && d[2] === "9";
const fmtCelular = (d: string) => `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;

/**
 * Telefone celular, e-mail e endereço que a Receita guarda nas empresas ATIVAS da pessoa (só as de confiança
 * alta ou média: "só o CPF bate" pode ser outra pessoa). O e-mail não vem na busca por filtro; vem da consulta
 * de CNPJ (cache de 30 dias), no máximo para 6 empresas, e o e-mail do contador fica de fora. Nada aqui é gravado.
 */
async function dadosDeContatoDasEmpresas(busca: Busca, deps: Deps): Promise<DadoDeContatoDaPessoa[]> {
  const { proposta, registros, jaTem } = busca;
  const consultar = deps.consultarCnpj ?? consultarCnpjDetalhado;
  const candidatas = proposta.empresas.filter((e) => e.ativa && e.confianca !== "baixa").slice(0, MAX_EMPRESAS_PARA_CONTATO);
  const out: DadoDeContatoDaPessoa[] = [];
  const vistos = new Set<string>();
  const acrescentar = (d: Omit<DadoDeContatoDaPessoa, "id">) => {
    const chave = `${d.tipo}:${d.valor}`;
    if (vistos.has(chave) || out.length >= MAX_DADOS_DE_CONTATO) return;
    vistos.add(chave);
    out.push({ ...d, id: `ct-${out.length + 1}` });
  };

  for (const e of candidatas) {
    const reg = registros.get(e.cnpj);
    if (!reg) continue;
    const base = { empresa: e.razaoSocial ?? e.nomeFantasia ?? e.cnpj, provavelPessoal: ehPessoaFisica(reg), fonteRotulo: e.fonteRotulo, consultadoEm: e.consultadoEm };

    for (const t of [reg.ddd_telefone_1, reg.ddd_telefone_2]) {
      const d = digitos(t);
      if (!telefoneValido(d) || !ehCelular(d)) continue;
      acrescentar({ ...base, tipo: "telefone", valor: d, exibicao: fmtCelular(d), cidade: null, uf: null, jaNoCadastro: jaTem.fones.has(d) });
    }

    const emails = new Set<string>();
    if (reg.email?.trim()) emails.add(reg.email.trim().toLowerCase());
    try {
      const det = (await consultar(e.cnpj)).resultado;
      for (const m of det.emails ?? []) if (m.tipo !== "contador") emails.add(m.valor.trim().toLowerCase());
      if (det.email && !(det.emails ?? []).length) emails.add(det.email.trim().toLowerCase());
    } catch {
      /* sem a consulta de CNPJ fica o que a busca trouxe */
    }
    for (const m of emails) acrescentar({ ...base, tipo: "email", valor: m, exibicao: m, cidade: null, uf: null, jaNoCadastro: jaTem.emails.has(m) });

    const endereco = resultadoDoRegistro(reg)?.endereco;
    if (endereco) {
      acrescentar({ ...base, tipo: "endereco", valor: endereco, exibicao: [endereco, [reg.municipio, reg.uf].filter(Boolean).join("/")].filter(Boolean).join(", "), cidade: reg.municipio?.trim() || null, uf: reg.uf?.trim() || null, jaNoCadastro: jaTem.endereco });
    }
  }
  return out;
}

async function guardar(teamId: string, g: Guardada): Promise<void> {
  try {
    await redisEstado().set(chaveProposta(teamId, g.proposta.id), JSON.stringify(g), "EX", TTL_S);
  } catch {
    throw new Error("Não deu para guardar a consulta agora. Tente de novo em instantes.");
  }
}

async function lerGuardada(propostaId: string): Promise<{ teamId: string; g: Guardada }> {
  const teamId = getCurrentTeamId();
  const actor = getActor();
  if (!teamId || !actor) throw new Error("sem time no contexto");
  if (!/^[0-9a-f-]{36}$/i.test(propostaId)) throw new PropostaDaPessoaExpirada();
  const bruto = await redisEstado().get(chaveProposta(teamId, propostaId)).catch(() => null);
  if (!bruto) throw new PropostaDaPessoaExpirada();
  const g = JSON.parse(bruto) as Guardada;
  if (g.userId !== actor.userId) throw new PropostaDaPessoaExpirada(); // consulta de outra pessoa
  return { teamId, g };
}

// ---------------------------------------------------------------------------
// IE de produtor rural (fonte paga)
// ---------------------------------------------------------------------------

/** Quanto custa uma consulta de IE (1 crédito por estado), SEM consultar nada. A tela mostra antes de pedir a confirmação. */
export async function estimarConsultaDeIe(): Promise<EstimativaDeBusca> {
  return estimarCreditos(CNPJA_CREDITOS_POR_CONSULTA_CCC);
}

export class CpfDaConsultaInvalido extends Error {
  constructor() {
    super("Informe um CPF válido para consultar a inscrição de produtor.");
    this.name = "CpfDaConsultaInvalido";
  }
}

/**
 * Busca as IEs de produtor rural do CPF numa UF (CNPJá `/ccc`) e acrescenta à proposta. É consulta PAGA:
 * `executarConsultaPaga` confere papel, fonte ligada, teto, confirmação do custo e cota do mês, e a
 * consulta fica registrada (impressão do CPF por time, mascarado, motivo, custo; nunca o CPF).
 */
export async function consultarIeDaPessoa(
  propostaId: string,
  p: { cpf: string; uf: string; motivo: MotivoDeBuscaDePessoa; creditosConfirmados: number },
): Promise<PropostaDaPessoa> {
  requireCan("captacao.fonte_paga");
  const { teamId, g } = await lerGuardada(propostaId);
  if (!MOTIVOS_DE_BUSCA_DE_PESSOA.includes(p.motivo)) throw new CpfDaConsultaInvalido();
  const uf = p.uf.trim().toUpperCase();
  if (!(UFS as readonly string[]).includes(uf)) throw new PessoaSemDadoParaBuscar("Escolha o estado em que a pessoa tem inscrição.");
  if (!cpfValido(p.cpf)) throw new CpfDaConsultaInvalido();
  const cpf = digitos(p.cpf);
  // Se a proposta foi montada com um CPF, é o MESMO CPF (não dá para usar a proposta de uma pessoa para consultar outra).
  if (g.mascara && mascaraDeBusca(cpf) !== g.mascara) throw new CpfDaConsultaInvalido();

  const r = await executarConsultaPaga("cnpja", {
    creditos: CNPJA_CREDITOS_POR_CONSULTA_CCC,
    creditosConfirmados: p.creditosConfirmados,
    consultar: (chave) => consultarIeProdutorCnpja({ chave, cpf, uf }),
    registro: { tipo: "cpf", hmac: impressaoDeTexto(cpf, teamId, "ConsultaDocumento.cpf"), mascarado: cpfParaExibir(cpf), uf, motivo: p.motivo, contactId: g.proposta.contactId },
    tolera: (e) => e instanceof Error && e.name === "ProdutorSemInscricao",
  });
  const agora = new Date().toISOString();
  const novas: IeDaPessoa[] = (r.resultado?.ies ?? []).map((i: IeDoProdutor, n: number) => ({
    id: `ie-${g.proposta.ies.length + n + 1}`,
    numero: i.numero,
    uf: i.uf,
    habilitada: i.habilitada,
    situacao: i.situacao,
    tipo: i.tipo,
    fonte: "cnpja",
    fonteRotulo: ROTULO_CNPJA,
    consultadoEm: agora,
    confianca: "alta", // CPF completo consultado direto no cadastro de contribuintes
  }));
  const jaTem = new Set(g.proposta.ies.map((i) => `${i.uf}:${i.numero}`));
  g.proposta.ies.push(...novas.filter((i) => !jaTem.has(`${i.uf}:${i.numero}`)));
  if (!r.resultado) g.proposta.avisos.push(`Nenhuma inscrição de produtor rural em ${uf}.`);
  await guardar(teamId, g);
  return g.proposta;
}

// ---------------------------------------------------------------------------
// Aplicação
// ---------------------------------------------------------------------------

export type ResultadoDaPessoa = { empresasVinculadas: number; iesGravadas: number; contatosAdicionados: number; cpfGuardado: boolean; produtorLabel: string | null };

const CAMPO_DO_DADO: Record<DadoDeContatoDaPessoa["tipo"], string> = { telefone: "telefone_da_empresa", email: "email_da_empresa", endereco: "endereco_da_empresa" };

/**
 * Acrescenta ao contato os telefones, e-mails e o endereço marcados. Só acrescenta: o que o contato já tem fica
 * como está (o endereço só entra onde está vazio). Cada um grava um `EnrichmentFact` dizendo de qual empresa veio.
 * Devolve quantos entraram de fato.
 */
async function acrescentarDadosDeContato(contactId: string, dados: DadoDeContatoDaPessoa[], por: string | null): Promise<number> {
  const prisma = db();
  let n = 0;
  for (const d of dados) {
    if (d.jaNoCadastro) continue;
    let entrou: boolean;
    if (d.tipo === "endereco") entrou = await completarEnderecoDoContato(contactId, { endereco: d.valor, cidade: d.cidade, estado: d.uf });
    else entrou = (await adicionarIdentificadorSeNovo(contactId, d.tipo === "telefone" ? "whatsapp" : "email", d.valor)) === "adicionado";
    if (!entrou) continue;
    n++;
    await prisma.enrichmentFact.create({
      data: tenantData<Prisma.EnrichmentFactUncheckedCreateInput>({
        targetType: "contact",
        targetId: contactId,
        field: CAMPO_DO_DADO[d.tipo],
        value: { exibicao: d.exibicao, empresa: d.empresa } as Prisma.InputJsonValue,
        enricherKey: "pessoa",
        enricherVersion: "pessoa@1",
        source: "minhareceita",
        confidence: d.provavelPessoal ? 0.6 : 0.3,
        evidences: { observacao: d.provavelPessoal ? "Empresário individual ou MEI" : "Dado da empresa, não da pessoa", por } as Prisma.InputJsonValue,
        producedAt: new Date(d.consultadoEm),
        appliedAt: new Date(),
      }),
    });
  }
  return n;
}

/** Empresário individual ou produtor rural: a pessoa é dona. Sociedade: sócia. */
function papelDe(natureza: string | null): Papel {
  return /empres[aá]rio|individual|produtor/i.test(natureza ?? "") ? "dono" : "socio";
}

/**
 * Vincula ao contato as empresas e as IEs escolhidas: reusa a empresa do time pelo CNPJ, cria a empresa de
 * produtor rural (sem CNPJ, com IE) e grava um `EnrichmentFact` com fonte, data e confiança de cada um.
 * Quem chama já conferiu papel, escopo e a origem dos itens (proposta do servidor).
 */
export async function vincularAchados(
  contato: { id: string; nome: string; sobrenome: string | null },
  achados: { empresas: EmpresaDaPessoa[]; ies: IeDaPessoa[] },
  deps: { consultarCnpj?: typeof consultarCnpjDetalhado; por?: string } = {},
): Promise<{ empresasVinculadas: number; iesGravadas: number }> {
  const prisma = db();
  const agora = new Date();
  const nomeDele = [contato.nome, contato.sobrenome].filter(Boolean).join(" ");
  let empresasVinculadas = 0;
  let iesGravadas = 0;

  for (const e of achados.empresas.filter((x) => !x.jaVinculada)) {
    let detalhe: Awaited<ReturnType<typeof consultarCnpjDetalhado>>["resultado"] | null = null;
    try {
      detalhe = (await (deps.consultarCnpj ?? consultarCnpjDetalhado)(e.cnpj)).resultado;
    } catch {
      /* sem o detalhe, vale o que a busca trouxe */
    }
    const feita = await createCompanyForContact(
      contato.id,
      {
        nome: detalhe?.razaoSocial ?? e.razaoSocial ?? e.nomeFantasia ?? e.cnpj,
        cnpj: e.cnpj,
        telefone: detalhe?.telefone ?? null,
        email: detalhe?.email ?? null,
        endereco: detalhe?.endereco ?? null,
        cidade: detalhe?.cidade ?? e.cidade,
        estado: detalhe?.uf ?? e.uf,
        naturezaJuridica: detalhe?.naturezaJuridica ?? null,
      },
      papelDe(detalhe?.naturezaJuridica ?? null),
    );
    // A situação (ativa ou não) fica na empresa, para o card mostrar "Ativa" / "Inativa".
    await registrarSituacaoDaEmpresa(feita.id, {
      ativa: situacaoEhAtiva(detalhe?.situacao) ?? e.ativa,
      descricao: detalhe?.situacao ?? e.situacao,
      consultadoEm: e.consultadoEm,
      fonteRotulo: e.fonteRotulo,
    });
    await prisma.enrichmentFact.create({
      data: tenantData<Prisma.EnrichmentFactUncheckedCreateInput>({
        targetType: "contact",
        targetId: contato.id,
        field: "empresa_vinculada",
        value: { cnpj: e.cnpj, companyId: feita.id, qualificacao: e.qualificacao, confianca: e.confianca } as Prisma.InputJsonValue,
        enricherKey: "pessoa",
        enricherVersion: "pessoa@1",
        source: e.fonte,
        confidence: e.confianca === "alta" ? 0.9 : e.confianca === "media" ? 0.6 : 0.3,
        evidences: { observacao: e.observacao, por: deps.por ?? null } as Prisma.InputJsonValue,
        producedAt: new Date(e.consultadoEm),
        appliedAt: agora,
      }),
    });
    empresasVinculadas++;
  }

  for (const ie of achados.ies) {
    const feita = await createCompanyForContact(
      contato.id,
      { nome: `Produtor rural ${nomeDele}`.trim(), ie: ie.numero, estado: ie.uf, naturezaJuridica: "Produtor rural (pessoa física)" },
      "dono",
    );
    await prisma.company.update({
      where: { id: feita.id },
      data: { iesTipos: [{ numero: ie.numero, tipo: ie.tipo, uf: ie.uf, habilitada: ie.habilitada }] as Prisma.InputJsonValue },
    });
    await prisma.enrichmentFact.create({
      data: tenantData<Prisma.EnrichmentFactUncheckedCreateInput>({
        targetType: "contact",
        targetId: contato.id,
        field: "ie_produtor",
        value: { numero: ie.numero, uf: ie.uf, situacao: ie.situacao, tipo: ie.tipo, companyId: feita.id } as Prisma.InputJsonValue,
        enricherKey: "pessoa",
        enricherVersion: "pessoa@1",
        source: ie.fonte,
        confidence: 0.9,
        producedAt: new Date(ie.consultadoEm),
        appliedAt: agora,
      }),
    });
    iesGravadas++;
  }
  return { empresasVinculadas, iesGravadas };
}

/**
 * Grava só o que a pessoa marcou (ids da proposta guardada no servidor): vincula empresas, cria a empresa de
 * produtor rural e, se pedido, guarda o CPF no contato (cifrado). Depois reclassifica o produtor.
 */
export async function aplicarPropostaDaPessoa(
  propostaId: string,
  aceitos: { empresas: string[]; ies: string[]; contatos?: string[]; guardarCpf?: string | null },
  deps: { consultarCnpj?: typeof consultarCnpjDetalhado } = {},
): Promise<ResultadoDaPessoa> {
  requireCan("contacts.write");
  const { teamId, g } = await lerGuardada(propostaId);
  const contato = await carregarContato(g.proposta.contactId); // confere o escopo de novo
  const actor = getActor();
  const out: ResultadoDaPessoa = { empresasVinculadas: 0, iesGravadas: 0, contatosAdicionados: 0, cpfGuardado: false, produtorLabel: null };

  const r = await vincularAchados(
    contato,
    { empresas: g.proposta.empresas.filter((x) => aceitos.empresas.includes(x.id)), ies: g.proposta.ies.filter((x) => aceitos.ies.includes(x.id)) },
    { ...deps, por: actor?.userId },
  );
  out.empresasVinculadas = r.empresasVinculadas;
  out.iesGravadas = r.iesGravadas;
  out.contatosAdicionados = await acrescentarDadosDeContato(contato.id, (g.proposta.contatos ?? []).filter((x) => (aceitos.contatos ?? []).includes(x.id)), actor?.userId ?? null);

  if (aceitos.guardarCpf && cpfValido(aceitos.guardarCpf)) {
    // O CPF só entra se bater com a máscara buscada (não grava um CPF qualquer no contato).
    if (!g.mascara || mascaraDeBusca(aceitos.guardarCpf) === g.mascara) {
      await completarCpfSeVazio([{ contactId: contato.id, cpf: aceitos.guardarCpf }]);
      out.cpfGuardado = true;
    }
  }

  if (out.empresasVinculadas || out.iesGravadas) out.produtorLabel = await reclassificar(contato.id);
  await redisEstado().del(chaveProposta(teamId, propostaId)).catch(() => undefined);
  logger.info({ contactId: contato.id, empresas: out.empresasVinculadas, ies: out.iesGravadas, contatos: out.contatosAdicionados }, "[enriquecer-pessoa] aplicado");
  return out;
}

async function reclassificar(contactId: string): Promise<string | null> {
  try {
    return (await runEnrichmentForContact(contactId)).produtorLabel;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[enriquecer-pessoa] não reclassifiquei o produtor");
    return null;
  }
}

export type ResultadoAutomaticoDaPessoa = { vinculadas: number; motivo: string; skipped: boolean };

/**
 * Modo AUTOMÁTICO (passo "Enriquecer pessoa" dos fluxos): usa o CPF guardado (cifrado) e o nome do contato,
 * busca as empresas na fonte GRATUITA e vincula só as de confiança alta (e as médias, se o passo permitir).
 * Nunca consulta fonte paga, nunca lê CPF de fora do cadastro e nunca vincula "só o CPF bate".
 */
export async function enriquecerPessoaAutomatico(
  contactId: string,
  opts: { incluirConfiancaMedia?: boolean } = {},
  deps: Deps & { consultarCnpj?: typeof consultarCnpjDetalhado } = {},
): Promise<ResultadoAutomaticoDaPessoa> {
  requireCan("contacts.write");
  const contato = await carregarContato(contactId);
  if (!contato.cpfCifrado || !lerCpf(contato.cpfCifrado)) return { vinculadas: 0, skipped: true, motivo: "Sem CPF no cadastro do contato: não há como buscar as empresas dele" };
  if (palavrasDoNome([contato.nome, contato.sobrenome].filter(Boolean).join(" ")).length < 2) return { vinculadas: 0, skipped: true, motivo: "O contato precisa de nome e sobrenome para o CRM Agro conferir quem é o sócio" };
  let busca: Awaited<ReturnType<typeof buscarEmpresasDaPessoa>>;
  try {
    busca = await buscarEmpresasDaPessoa(contactId, {}, deps);
  } catch (e) {
    if (e instanceof PessoaSemDadoParaBuscar) return { vinculadas: 0, skipped: true, motivo: e.message };
    throw e;
  }
  const aceitas = busca.proposta.empresas.filter((e) => !e.jaVinculada && (e.confianca === "alta" || (opts.incluirConfiancaMedia === true && e.confianca === "media")));
  if (busca.proposta.avisos.some((a) => /A busca na Receita parou/.test(a)) && !busca.proposta.empresas.length) {
    return { vinculadas: 0, skipped: true, motivo: "A consulta na Receita não respondeu agora" };
  }
  if (!aceitas.length) return { vinculadas: 0, skipped: false, motivo: busca.proposta.empresas.length ? "Achou empresas, mas nenhuma com confiança suficiente para vincular sozinho" : "Nenhuma empresa achada com esse CPF e esse nome" };
  const r = await vincularAchados(contato, { empresas: aceitas, ies: [] }, { consultarCnpj: deps.consultarCnpj, por: "automacao" });
  if (r.empresasVinculadas) await reclassificar(contato.id);
  return { vinculadas: r.empresasVinculadas, skipped: false, motivo: `Vinculou ${r.empresasVinculadas} ${r.empresasVinculadas === 1 ? "empresa" : "empresas"} (confiança ${opts.incluirConfiancaMedia ? "alta ou média" : "alta"})` };
}
