import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db, getCurrentTeamId, tenantData } from "@crmagro/db";
import { SiteIndisponivel, lerSiteDaEmpresa, type CnpjResult, type SiteLido } from "@crmagro/captation";
import { requireCan, getActor } from "../auth/authz";
import { consultarCnpjDetalhado, motivoFalhaCnpj } from "../captacao/cnpj";
import { escopoDoContato } from "../contacts/escopo";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";

/**
 * ENRIQUECER EMPRESA, a partir do CNPJ (e do site, se houver): razão social, nome fantasia, e-mails,
 * telefones, inscrição estadual, endereço, CNAE, natureza jurídica, sócios e outros dados públicos.
 *
 * Regras (pedido do dono):
 *  - cada dado vem com a FONTE e a DATA em que foi consultado, e a confiança;
 *  - NADA é gravado antes do OK: `propostaDaEmpresa` só lê e monta a lista; `aplicarProposta` grava só
 *    o que a pessoa marcou. Campo que já tem valor só é trocado se a pessoa marcar a troca
 *    ("trocar"); campo vazio é "preencher";
 *  - o servidor guarda a proposta (Redis, 30 min, por time e por pessoa) e o `aplicar` usa ESSA
 *    cópia: a tela só diz quais itens aceitou, nunca manda valores (não dá para gravar o que a fonte
 *    não disse);
 *  - o que vem do site da empresa é sugestão de confiança média ou baixa; no modo automático (fluxos)
 *    só entra o que veio do cadastro do CNPJ e preenche campo vazio.
 */

export type FonteDoDado = "cnpja" | "opencnpj" | "brasilapi" | "minhareceita" | "site";
export const ROTULO_DA_FONTE: Record<FonteDoDado, string> = {
  cnpja: "CNPJá (Receita Federal)",
  opencnpj: "OpenCNPJ (Receita Federal)",
  brasilapi: "BrasilAPI (Receita Federal)",
  minhareceita: "Minha Receita (Receita Federal)",
  site: "Site da empresa",
};
export type Confianca = "alta" | "media" | "baixa";

/** Colunas da empresa que o enriquecimento sabe preencher. */
export type CampoDaEmpresa = "email" | "telefone" | "ie" | "endereco" | "cidade" | "estado" | "cnae" | "naturezaJuridica" | "instagram" | "linkedin";
const ROTULO_DO_CAMPO: Record<CampoDaEmpresa, string> = {
  email: "E-mail",
  telefone: "Telefone",
  ie: "Inscrição estadual",
  endereco: "Endereço",
  cidade: "Cidade",
  estado: "UF",
  cnae: "CNAE",
  naturezaJuridica: "Natureza jurídica",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};
const CAMPOS = Object.keys(ROTULO_DO_CAMPO) as CampoDaEmpresa[];
const NUMERO_DA_CONFIANCA: Record<Confianca, number> = { alta: 0.9, media: 0.6, baixa: 0.3 };

export type ItemDaProposta = {
  id: string;
  campo: CampoDaEmpresa;
  rotulo: string;
  /** Valor que está na empresa agora (null = vazio). */
  atual: string | null;
  valor: string;
  /** preencher = campo vazio; trocar = já tem outro valor (só grava se a pessoa marcar); igual = já é esse valor. */
  acao: "preencher" | "trocar" | "igual";
  fontes: FonteDoDado[];
  fonteRotulo: string;
  /** Endereço da página do site de onde veio (só fonte "site"). */
  fonteUrl: string | null;
  consultadoEm: string;
  confianca: Confianca;
  observacao: string | null;
};

export type DadoPublico = { rotulo: string; valor: string; fonte: FonteDoDado; fonteRotulo: string; consultadoEm: string };
export type SocioPublico = { nome: string; qualificacao: string | null; cpfExibicao: string | null; faixaEtaria: string | null };

export type PropostaDaEmpresa = {
  id: string;
  companyId: string;
  companyNome: string;
  criadaEm: string;
  itens: ItemDaProposta[];
  /** Dados informativos da Receita: viram "Dados públicos" na ficha só se a pessoa aplicar. */
  dadosPublicos: DadoPublico[];
  socios: SocioPublico[];
  /** O que não deu para consultar, em frase pronta para a tela. */
  avisos: string[];
};

export class EmpresaSemFonte extends Error {
  constructor() {
    super("Informe o CNPJ ou o site da empresa para enriquecer.");
    this.name = "EmpresaSemFonte";
  }
}
export class PropostaExpirada extends Error {
  constructor() {
    super("Essa consulta expirou. Faça de novo.");
    this.name = "PropostaExpirada";
  }
}

// ---------------------------------------------------------------------------
// Montagem da proposta (pura)
// ---------------------------------------------------------------------------

type EmpresaAtual = Partial<Record<CampoDaEmpresa, string | null>>;

const soDigitos = (v: string) => v.replace(/\D/g, "");
/** Forma de comparar "é o mesmo valor": e-mail em minúscula, telefone sem 55 nem pontuação, IE só dígitos. */
export function chaveDeComparacao(campo: CampoDaEmpresa, valor: string): string {
  const v = valor.trim().toLowerCase();
  if (campo === "telefone") {
    const d = soDigitos(v);
    return d.length > 11 && d.startsWith("55") ? d.slice(2) : d;
  }
  if (campo === "ie") return soDigitos(v);
  if (campo === "instagram" || campo === "linkedin") return v.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  return v.replace(/\s+/g, " ");
}

function fmtTelefoneBr(d: string): string {
  const n = d.startsWith("55") && d.length > 11 ? d.slice(2) : d;
  return n.length === 11 ? `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}` : n.length === 10 ? `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}` : n;
}

type Candidato = Omit<ItemDaProposta, "id" | "atual" | "acao" | "rotulo" | "fonteRotulo">;

/**
 * Candidatos de cada fonte → itens da proposta: junta o mesmo valor vindo de duas fontes (a confiança
 * sobe), marca preencher, trocar ou igual, e ordena por confiança dentro de cada campo.
 */
export function montarItens(atual: EmpresaAtual, cnpj: CnpjResult | null, site: SiteLido | null, agora: string): ItemDaProposta[] {
  const cands: Candidato[] = [];
  const add = (c: Omit<Candidato, "consultadoEm" | "fonteUrl" | "observacao" | "fontes"> & { fonte: FonteDoDado; consultadoEm?: string; fonteUrl?: string | null; observacao?: string | null }) =>
    cands.push({ campo: c.campo, valor: c.valor, fontes: [c.fonte], fonteUrl: c.fonteUrl ?? null, consultadoEm: c.consultadoEm ?? agora, confianca: c.confianca, observacao: c.observacao ?? null });

  if (cnpj) {
    const fonte = cnpj.fonte as FonteDoDado;
    const em = cnpj.consultadoEm ?? agora;
    const emails = cnpj.emails?.length ? cnpj.emails : cnpj.email ? [{ valor: cnpj.email, tipo: "desconhecido" as const }] : [];
    for (const e of emails) {
      add({
        campo: "email",
        valor: e.valor,
        fonte,
        consultadoEm: em,
        confianca: e.tipo === "contador" ? "baixa" : e.tipo === "empresa" ? "alta" : "media",
        observacao: e.tipo === "contador" ? "E-mail do escritório de contabilidade" : e.tipo === "desconhecido" ? "E-mail do cadastro da Receita, pode ser do contador" : null,
      });
    }
    const telefones = cnpj.telefones?.length ? cnpj.telefones : cnpj.telefone ? [cnpj.telefone] : [];
    for (const t of telefones) add({ campo: "telefone", valor: t, fonte, consultadoEm: em, confianca: "alta" });
    if (cnpj.ie) add({ campo: "ie", valor: cnpj.ie, fonte, consultadoEm: em, confianca: "alta" });
    if (cnpj.endereco) add({ campo: "endereco", valor: cnpj.endereco, fonte, consultadoEm: em, confianca: "alta" });
    if (cnpj.cidade) add({ campo: "cidade", valor: cnpj.cidade, fonte, consultadoEm: em, confianca: "alta" });
    if (cnpj.uf) add({ campo: "estado", valor: cnpj.uf, fonte, consultadoEm: em, confianca: "alta" });
    if (cnpj.cnae) add({ campo: "cnae", valor: cnpj.cnae, fonte, consultadoEm: em, confianca: "alta", observacao: cnpj.cnaeDescricao });
    if (cnpj.naturezaJuridica) add({ campo: "naturezaJuridica", valor: cnpj.naturezaJuridica, fonte, consultadoEm: em, confianca: "alta" });
  }
  if (site) {
    const em = site.lidoEm;
    const url = site.url;
    for (const e of site.contatos.emails) {
      add({
        campo: "email",
        valor: e.valor,
        fonte: "site",
        consultadoEm: em,
        fonteUrl: url,
        confianca: e.doDominioDoSite && !e.generico ? "media" : "baixa",
        observacao: e.generico ? "E-mail de provedor gratuito, pode ser pessoal" : null,
      });
    }
    for (const t of site.contatos.telefones) {
      add({ campo: "telefone", valor: fmtTelefoneBr(t.valor), fonte: "site", consultadoEm: em, fonteUrl: url, confianca: "media", observacao: t.whatsapp ? "Tem link de WhatsApp no site" : null });
    }
    if (site.contatos.instagram) add({ campo: "instagram", valor: site.contatos.instagram, fonte: "site", consultadoEm: em, fonteUrl: url, confianca: "media" });
    if (site.contatos.linkedin) add({ campo: "linkedin", valor: site.contatos.linkedin, fonte: "site", consultadoEm: em, fonteUrl: url, confianca: "media" });
  }

  // Junta o mesmo valor de fontes diferentes: a confiança sobe um degrau e as duas fontes aparecem.
  const juntos = new Map<string, Candidato>();
  for (const c of cands) {
    const k = `${c.campo}|${chaveDeComparacao(c.campo, c.valor)}`;
    const ja = juntos.get(k);
    if (!ja) {
      juntos.set(k, c);
      continue;
    }
    if (!ja.fontes.includes(c.fontes[0]!)) ja.fontes.push(c.fontes[0]!);
    if (ja.fontes.length > 1) ja.confianca = ja.confianca === "baixa" ? "media" : "alta";
    ja.observacao = ja.observacao && c.observacao && ja.observacao !== c.observacao ? ja.observacao : (ja.observacao ?? c.observacao);
  }

  const ordem: Record<Confianca, number> = { alta: 0, media: 1, baixa: 2 };
  const itens: ItemDaProposta[] = [];
  let n = 0;
  for (const c of [...juntos.values()].sort((a, b) => ordem[a.confianca] - ordem[b.confianca])) {
    const cur = (atual[c.campo] ?? "").toString().trim() || null;
    const acao = cur === null ? "preencher" : chaveDeComparacao(c.campo, cur) === chaveDeComparacao(c.campo, c.valor) ? "igual" : "trocar";
    itens.push({
      id: `${c.campo}-${++n}`,
      campo: c.campo,
      rotulo: ROTULO_DO_CAMPO[c.campo],
      atual: cur,
      valor: c.valor,
      acao,
      fontes: c.fontes,
      fonteRotulo: c.fontes.map((f) => ROTULO_DA_FONTE[f]).join(" e "),
      fonteUrl: c.fonteUrl,
      consultadoEm: c.consultadoEm,
      confianca: c.confianca,
      observacao: c.observacao,
    });
  }
  // Por campo, quem vem primeiro é o de maior confiança; a ordem entre campos segue a da tela.
  return itens.sort((a, b) => CAMPOS.indexOf(a.campo) - CAMPOS.indexOf(b.campo) || ordem[a.confianca] - ordem[b.confianca]);
}

/** Dados informativos da Receita (não são colunas da empresa): razão social, fantasia, situação, abertura, porte, capital. */
export function dadosPublicosDoCnpj(r: CnpjResult, agora: string): DadoPublico[] {
  const fonte = r.fonte as FonteDoDado;
  const em = r.consultadoEm ?? agora;
  const d: DadoPublico[] = [];
  const add = (rotulo: string, valor: string | number | null | undefined) => {
    if (valor !== null && valor !== undefined && String(valor).trim() !== "") d.push({ rotulo, valor: String(valor), fonte, fonteRotulo: ROTULO_DA_FONTE[fonte], consultadoEm: em });
  };
  add("Razão social", r.razaoSocial);
  add("Nome fantasia", r.nomeFantasia);
  add("Situação cadastral", r.situacao);
  add("Abertura", r.dataAbertura);
  add("Porte", r.porte);
  add("Capital social", r.capitalSocial !== null ? r.capitalSocial.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : null);
  add("Atividade principal", r.cnaeDescricao);
  return d;
}

function maquinaDoCnpj(r: CnpjResult | null): DadosDeMaquina {
  return { cnaesSecundarios: (r?.cnaesSecundarios ?? []).map((c) => c.codigo), iesTipos: r?.ies ?? [] };
}

// ---------------------------------------------------------------------------
// Proposta e aplicação (serviço)
// ---------------------------------------------------------------------------

const TTL_PROPOSTA_S = 30 * 60;
const chaveProposta = (teamId: string, id: string) => `enriq:empresa:${teamId}:${id}`;

/** Campos de máquina (insumo do classificador de produtor): entram só se a empresa ainda não os tem. */
type DadosDeMaquina = { cnaesSecundarios: string[]; iesTipos: unknown[] };
type PropostaGuardada = { proposta: PropostaDaEmpresa; contactId: string; userId: string; cnpj: string | null; maquina: DadosDeMaquina };

type Deps = {
  consultarCnpj?: typeof consultarCnpjDetalhado;
  lerSite?: typeof lerSiteDaEmpresa;
  agora?: () => Date;
};

async function carregarEmpresa(contactId: string, companyId: string) {
  const prisma = db();
  const contact = await prisma.contact.findFirst({ where: { AND: [{ id: contactId }, escopoDoContato({ escrita: true })] }, select: { id: true } });
  if (!contact) throw new Error("contato não encontrado no time");
  const link = await prisma.contactCompany.findFirst({ where: { contactId, companyId }, include: { company: true } });
  if (!link) throw new Error("empresa não encontrada neste contato");
  return link.company;
}

/** Consulta as fontes e monta a proposta. NÃO grava nada na empresa. */
export async function propostaDaEmpresa(contactId: string, companyId: string, deps: Deps = {}): Promise<PropostaDaEmpresa> {
  requireCan("contacts.write");
  const teamId = getCurrentTeamId();
  const actor = getActor();
  if (!teamId || !actor) throw new Error("sem time no contexto");
  const company = await carregarEmpresa(contactId, companyId);
  if (!company.cnpj && !company.site) throw new EmpresaSemFonte();

  const agora = (deps.agora?.() ?? new Date()).toISOString();
  const avisos: string[] = [];
  let cnpj: CnpjResult | null = null;
  if (company.cnpj) {
    try {
      cnpj = (await (deps.consultarCnpj ?? consultarCnpjDetalhado)(company.cnpj)).resultado;
    } catch (e) {
      avisos.push(`Não deu para consultar o CNPJ: ${motivoFalhaCnpj(e)}.`);
    }
  }
  let site: SiteLido | null = null;
  if (company.site) {
    try {
      site = await (deps.lerSite ?? lerSiteDaEmpresa)(company.site);
    } catch (e) {
      avisos.push(e instanceof SiteIndisponivel ? e.message : "Não deu para ler o site da empresa.");
    }
  }

  const proposta: PropostaDaEmpresa = {
    id: randomUUID(),
    companyId,
    companyNome: company.nome,
    criadaEm: agora,
    itens: montarItens(company as unknown as EmpresaAtual, cnpj, site, agora),
    dadosPublicos: cnpj ? dadosPublicosDoCnpj(cnpj, agora) : [],
    socios: (cnpj?.socios ?? []).map((s) => ({ nome: s.nome, qualificacao: s.qualificacao, cpfExibicao: s.cpfMascarado ? `***.${s.cpfMascarado.slice(3, 6)}.${s.cpfMascarado.slice(6, 9)}-**` : null, faixaEtaria: s.faixaEtaria ?? null })),
    avisos,
  };
  try {
    const g: PropostaGuardada = { proposta, contactId, userId: actor.userId, cnpj: company.cnpj, maquina: maquinaDoCnpj(cnpj) };
    await redisEstado().set(chaveProposta(teamId, proposta.id), JSON.stringify(g), "EX", TTL_PROPOSTA_S);
  } catch {
    throw new Error("Não deu para guardar a consulta agora. Tente de novo em instantes.");
  }
  return proposta;
}

export type ResultadoDaAplicacao = { aplicados: string[]; ignorados: string[] };

/**
 * Grava SÓ os itens que a pessoa marcou (`aceitos`, ids da proposta). Troca de valor existente só
 * acontece para item de ação "trocar" marcado; item "preencher" cujo campo foi preenchido nesse meio
 * tempo é ignorado (nunca pisa em algo novo). Cada campo gravado leva a fonte e a data em
 * `Company.enrichment.campos` e vira um `EnrichmentFact` (histórico).
 */
export async function aplicarProposta(propostaId: string, aceitos: string[], opts: { incluirDadosPublicos?: boolean } = {}): Promise<ResultadoDaAplicacao> {
  requireCan("contacts.write");
  const teamId = getCurrentTeamId();
  const actor = getActor();
  if (!teamId || !actor) throw new Error("sem time no contexto");
  if (!/^[0-9a-f-]{36}$/i.test(propostaId)) throw new PropostaExpirada();
  const bruto = await redisEstado().get(chaveProposta(teamId, propostaId)).catch(() => null);
  if (!bruto) throw new PropostaExpirada();
  const g = JSON.parse(bruto) as PropostaGuardada;
  // A proposta é de quem a pediu (outra pessoa do time não aplica a consulta alheia).
  if (g.userId !== actor.userId) throw new PropostaExpirada();

  const company = await carregarEmpresa(g.contactId, g.proposta.companyId); // confere o escopo de novo
  const escolhidos = g.proposta.itens.filter((i) => aceitos.includes(i.id) && i.acao !== "igual");
  const r = await gravarItens(company, escolhidos, {
    por: actor.userId,
    publico: opts.incluirDadosPublicos ? { dados: g.proposta.dadosPublicos, socios: g.proposta.socios } : null,
    maquina: g.maquina,
  });
  await redisEstado().del(chaveProposta(teamId, propostaId)).catch(() => undefined);
  return r;
}

/**
 * Grava os itens escolhidos na empresa, com a fonte e a data de cada campo. Um valor por coluna (o de
 * maior confiança). Item "preencher" cujo campo já foi preenchido é ignorado; "trocar" só chega aqui
 * porque a pessoa marcou. Todo campo gravado vira um `EnrichmentFact`.
 */
async function gravarItens(
  company: NonNullable<Awaited<ReturnType<typeof carregarEmpresa>>>,
  itens: ItemDaProposta[],
  opts: { por: string; publico: { dados: DadoPublico[]; socios: SocioPublico[] } | null; maquina: DadosDeMaquina },
): Promise<ResultadoDaAplicacao> {
  const prisma = db();
  const porCampo = new Map<CampoDaEmpresa, ItemDaProposta>();
  for (const i of itens) if (!porCampo.has(i.campo)) porCampo.set(i.campo, i);

  const aplicados: string[] = [];
  const ignorados: string[] = [];
  const dados: Record<string, unknown> = {};
  const campos: Record<string, unknown> = {};
  const agora = new Date();
  const atual = company as unknown as Record<string, unknown>;
  for (const item of porCampo.values()) {
    const cur = typeof atual[item.campo] === "string" ? (atual[item.campo] as string).trim() : "";
    if (item.acao === "preencher" && cur) {
      ignorados.push(item.campo); // alguém preencheu nesse meio tempo: nunca pisa
      continue;
    }
    dados[item.campo] = item.valor;
    campos[item.campo] = {
      valor: item.valor,
      fonte: item.fontes[0],
      fontes: item.fontes,
      fonteRotulo: item.fonteRotulo,
      fonteUrl: item.fonteUrl,
      consultadoEm: item.consultadoEm,
      confianca: item.confianca,
      aplicadoEm: agora.toISOString(),
      aplicadoPor: opts.por,
    };
    aplicados.push(item.campo);
  }
  // Campos de máquina (classificador de produtor): só entram em empresa que ainda não os tem.
  if (aplicados.length || opts.publico) {
    if ((!company.cnaesSecundarios || company.cnaesSecundarios.length === 0) && opts.maquina.cnaesSecundarios.length) dados.cnaesSecundarios = opts.maquina.cnaesSecundarios;
    if (company.iesTipos == null && opts.maquina.iesTipos.length) dados.iesTipos = opts.maquina.iesTipos;
  }
  if (!aplicados.length && !opts.publico && !Object.keys(dados).length) return { aplicados, ignorados };

  const enrichmentAtual = (company.enrichment ?? {}) as Record<string, unknown>;
  const enrichment: Record<string, unknown> = {
    ...enrichmentAtual,
    campos: { ...((enrichmentAtual.campos as object) ?? {}), ...campos },
    atualizadoEm: agora.toISOString(),
  };
  if (opts.publico) {
    enrichment.publico = opts.publico.dados;
    // O modo automático não traz sócios: não apaga os que a pessoa já guardou pelo botão.
    if (opts.publico.socios.length) enrichment.socios = opts.publico.socios;
  }
  await prisma.company.update({ where: { id: company.id }, data: { ...(dados as Prisma.CompanyUpdateInput), enrichment: enrichment as Prisma.InputJsonValue } });
  for (const item of porCampo.values()) {
    if (!aplicados.includes(item.campo)) continue;
    await prisma.enrichmentFact.create({
      data: tenantData<Prisma.EnrichmentFactUncheckedCreateInput>({
        targetType: "company",
        targetId: company.id,
        field: item.campo,
        value: item.valor as Prisma.InputJsonValue,
        enricherKey: "empresa",
        enricherVersion: "empresa@1",
        source: item.fontes[0]!,
        confidence: NUMERO_DA_CONFIANCA[item.confianca],
        evidences: { fontes: item.fontes, url: item.fonteUrl, observacao: item.observacao } as Prisma.InputJsonValue,
        producedAt: new Date(item.consultadoEm),
        appliedAt: agora,
      }),
    });
  }
  logger.info({ companyId: company.id, campos: aplicados }, "[enriquecer-empresa] aplicado");
  return { aplicados, ignorados };
}

export type ResultadoAutomatico = { empresas: number; campos: string[]; avisos: string[] };

/**
 * Modo AUTOMÁTICO (passo "Enriquecer empresa" dos fluxos): consulta só o CNPJ (não lê site), preenche
 * apenas campo VAZIO e só com dado de confiança alta ou média. Nunca troca valor existente e não
 * guarda o e-mail do contador (confiança baixa). Cada campo leva a fonte e a data.
 */
export async function enriquecerEmpresasDoContatoAutomatico(contactId: string, deps: Pick<Deps, "consultarCnpj" | "agora"> = {}): Promise<ResultadoAutomatico> {
  requireCan("contacts.write");
  const prisma = db();
  const links = await prisma.contactCompany.findMany({ where: { contactId }, orderBy: { createdAt: "asc" }, include: { company: true } });
  const out: ResultadoAutomatico = { empresas: 0, campos: [], avisos: [] };
  for (const { company } of links) {
    if (!company.cnpj) continue;
    let r: CnpjResult;
    try {
      r = (await (deps.consultarCnpj ?? consultarCnpjDetalhado)(company.cnpj)).resultado;
    } catch (e) {
      out.avisos.push(`${company.nome}: ${motivoFalhaCnpj(e)}`);
      continue;
    }
    const agora = (deps.agora?.() ?? new Date()).toISOString();
    const itens = montarItens(company as unknown as EmpresaAtual, r, null, agora).filter((i) => i.acao === "preencher" && i.confianca !== "baixa");
    const empresa = await carregarEmpresa(contactId, company.id);
    const res = await gravarItens(empresa, itens, { por: "automacao", publico: { dados: dadosPublicosDoCnpj(r, agora), socios: [] }, maquina: maquinaDoCnpj(r) });
    if (res.aplicados.length) out.empresas++;
    out.campos.push(...res.aplicados.map((c) => `${company.nome}: ${ROTULO_DO_CAMPO[c as CampoDaEmpresa] ?? c}`));
  }
  return out;
}
