import type { Prisma } from "@prisma/client";
import { db, tenantData } from "@crmagro/db";
import { consultarCnpj } from "../captacao/cnpj";
import { writeContact } from "../contacts/write";
import { logger } from "../logger/index";
import { requireCan } from "../auth/authz";

import { escopoDoContato } from "../contacts/escopo";
import { assertOwned } from "../tenancy/assert-owned";
import { responsavelEscolhido } from "../contacts/responsavel";
import { vincularTagsDoCadastro } from "../tags/do-contato";
/**
 * Empresas (multi-empresa). O contato é a PESSOA; uma pessoa pode ser dono/sócio
 * de várias empresas (ContactCompany com papel). Tudo tenant-scoped (db() eager).
 */

export type CompanyInput = {
  nome: string;
  cnpj?: string | null;
  ie?: string | null;
  site?: string | null;
  email?: string | null;
  telefone?: string | null;
  endereco?: string | null;
  cidade?: string | null;
  estado?: string | null;
  instagram?: string | null;
  linkedin?: string | null;
  naturezaJuridica?: string | null;
};

export type Papel = "dono" | "socio" | "funcionario" | "outro";

const onlyDigits = (v?: string | null) => (v ? v.replace(/\D/g, "") : null);

/** Campos preenchíveis (ignora vazios) para create/enrich. */
function fieldsFrom(input: Partial<CompanyInput>): Prisma.CompanyUpdateInput {
  const d: Prisma.CompanyUpdateInput = {};
  const set = (k: keyof CompanyInput, v: string | null | undefined) => {
    const t = (v ?? "").toString().trim();
    if (t) (d as Record<string, unknown>)[k] = k === "cnpj" ? onlyDigits(t) : t;
  };
  set("nome", input.nome);
  set("cnpj", input.cnpj);
  set("ie", input.ie);
  set("site", input.site);
  set("email", input.email);
  set("telefone", input.telefone);
  set("endereco", input.endereco);
  set("cidade", input.cidade);
  set("estado", input.estado);
  set("instagram", input.instagram);
  set("linkedin", input.linkedin);
  set("naturezaJuridica", input.naturezaJuridica);
  return d;
}

/**
 * Cria (ou reusa por CNPJ) uma empresa e a vincula ao contato com um papel.
 * Dedup: se já existe empresa do time com o mesmo CNPJ, reusa e preenche campos
 * vazios. Não duplica o vínculo (unique contactId+companyId).
 */
export async function createCompanyForContact(
  contactId: string,
  input: CompanyInput,
  papel: Papel = "socio",
  /** `manterPapel`: se o vínculo já existe, o papel que está lá fica (a captação não rebaixa "dono" a "sócio"). */
  opcoes: { manterPapel?: boolean } = {},
): Promise<{ id: string; nome: string; created: boolean }> {
  requireCan("contacts.write");
  const prisma = db();
  const nome = input.nome?.trim();
  if (!nome) throw new Error("nome da empresa obrigatório");
  const contact = await prisma.contact.findFirst({ where: { AND: [{ id: contactId }, escopoDoContato({ escrita: true })] }, select: { id: true } });
  if (!contact) throw new Error("contato não encontrado no time");

  const cnpj = onlyDigits(input.cnpj);
  let company = cnpj ? await prisma.company.findFirst({ where: { cnpj } }) : null;
  // Sem CNPJ (ex.: produtor rural pessoa física), a mesma IE no mesmo estado é a mesma empresa.
  const ie = input.ie?.trim();
  if (!company && !cnpj && ie) {
    const uf = input.estado?.trim().toUpperCase();
    const iguais = await prisma.company.findMany({ where: { ie, cnpj: null }, take: 10 });
    company = iguais.find((c) => !uf || !c.estado || c.estado.toUpperCase() === uf) ?? null;
  }
  let created = false;
  if (company) {
    // Preenche só os campos ainda vazios (não sobrescreve o que já existe).
    const patch = fieldsFrom(input);
    const clean: Prisma.CompanyUpdateInput = {};
    for (const [k, v] of Object.entries(patch)) {
      if ((company as Record<string, unknown>)[k] == null || (company as Record<string, unknown>)[k] === "") {
        (clean as Record<string, unknown>)[k] = v;
      }
    }
    if (Object.keys(clean).length) await prisma.company.update({ where: { id: company.id }, data: clean });
  } else {
    company = await prisma.company.create({
      // fieldsFrom já inclui nome (validado) e cnpj (normalizado p/ dígitos).
      data: tenantData<Prisma.CompanyUncheckedCreateInput>(
        fieldsFrom(input) as Prisma.CompanyUncheckedCreateInput,
      ),
    });
    created = true;
  }

  const link = await prisma.contactCompany.findFirst({ where: { contactId, companyId: company.id } });
  if (!link) {
    await prisma.contactCompany.create({
      data: tenantData<Prisma.ContactCompanyUncheckedCreateInput>({ contactId, companyId: company.id, papel }),
    });
  } else if (papel && !opcoes.manterPapel && link.papel !== papel) {
    await prisma.contactCompany.update({ where: { id: link.id }, data: { papel } });
  }

  // Denormaliza a empresa PRINCIPAL no contato (campos legado empresa/cnpj) — só
  // quando vazios — para que card do funil, lista, discador e a variável {empresa}
  // de fluxo continuem mostrando a empresa mesmo com o novo modelo multi-empresa.
  const cRow = await prisma.contact.findFirst({ where: { AND: [{ id: contactId }, escopoDoContato({ escrita: true })] }, select: { empresa: true, cnpj: true } });
  const patch: Prisma.ContactUpdateInput = {};
  if (!cRow?.empresa) patch.empresa = company.nome;
  if (!cRow?.cnpj && company.cnpj) patch.cnpj = company.cnpj;
  if (Object.keys(patch).length) await prisma.contact.update({ where: { id: contactId }, data: patch });

  return { id: company.id, nome: company.nome, created };
}

/** Empresas vinculadas a um contato (com o papel). */
export async function listCompaniesForContact(contactId: string) {
  const prisma = db();
  const links = await prisma.contactCompany.findMany({
    where: { contactId },
    orderBy: { createdAt: "asc" },
    include: { company: true },
  });
  return links.map((l) => ({ papel: l.papel, linkId: l.id, ...l.company }));
}

/** Atualiza campos de uma empresa (enriquecimento). */
export async function enrichCompany(companyId: string, input: Partial<CompanyInput>): Promise<void> {
  requireCan("contacts.write");
  const prisma = db();
  const exists = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!exists) throw new Error("empresa não encontrada no time");
  const data = fieldsFrom(input);
  if (Object.keys(data).length) await prisma.company.update({ where: { id: companyId }, data });
}

export type EnrichContactResult = {
  companiesUpdated: number;
  /** Empresas com CNPJ cuja consulta não respondeu. */
  falhas: number;
  fieldsFilled: string[]; // rótulos legíveis do que foi preenchido
};

/**
 * Enriquecimento por CNPJ: para cada empresa vinculada ao contato que tenha CNPJ,
 * consulta a fonte (CNPJá→BrasilAPI) e preenche SÓ os campos VAZIOS da empresa
 * (não sobrescreve nada que o usuário já tenha digitado) — incluindo a inscrição
 * estadual (IE) e demais dados que faltam. Também preenche cidade/UF do CONTATO
 * quando ele não tem (dado regional; o endereço/telefone da empresa NÃO viram
 * dados pessoais do contato). Best-effort: falha numa empresa não derruba as
 * outras. Ver [[crmagro-ia-sdr-grafo-aprendizado]] (pré-requisito da camada de IA).
 *
 * LEGADO: hoje só o passo antigo `enrich_data` dos fluxos (`flows/enriquecer-dados.ts`) chama esta função. A tela
 * de Contatos usa "Enriquecer empresa" e "Enriquecer pessoa" (`enrichment/empresa.ts` e `enrichment/pessoa.ts`),
 * que guardam a fonte e a data de cada dado. Pode sair quando nenhum fluxo ativo usar mais o passo `enrich_data`.
 */
export async function enrichContactFromCnpj(contactId: string): Promise<EnrichContactResult> {
  requireCan("contacts.write");
  const prisma = db();
  const contact = await prisma.contact.findFirst({
    where: { AND: [{ id: contactId }, escopoDoContato({ escrita: true })] },
    select: { id: true, cidade: true, estado: true },
  });
  if (!contact) throw new Error("contato não encontrado no time");

  const links = await prisma.contactCompany.findMany({
    where: { contactId },
    orderBy: { createdAt: "asc" },
    include: { company: true },
  });

  const filled: string[] = [];
  let companiesUpdated = 0;
  let falhas = 0;
  let contactCidade = contact.cidade;
  let contactEstado = contact.estado;

  for (const link of links) {
    const co = link.company;
    if (!co?.cnpj) continue;
    let r;
    try {
      // Cache compartilhado + fichas do CNPJá (item 3.2, INT-13).
      r = await consultarCnpj(co.cnpj);
    } catch (e) {
      logger.warn({ companyId: co.id, err: e instanceof Error ? e.message : String(e) }, "[enrich] CNPJ falhou");
      falhas++;
      continue;
    }

    // Fill-only: só o que está vazio na empresa.
    const candidate: Partial<CompanyInput> = {
      ie: r.ie,
      email: r.email,
      telefone: r.telefone,
      endereco: r.endereco,
      cidade: r.cidade,
      estado: r.uf,
      naturezaJuridica: r.nomeFantasia && !co.nome ? r.nomeFantasia : undefined,
    };
    const patch: Prisma.CompanyUpdateInput = {};
    for (const [k, v] of Object.entries(fieldsFrom(candidate))) {
      const cur = (co as Record<string, unknown>)[k];
      if ((cur == null || cur === "") && v) {
        (patch as Record<string, unknown>)[k] = v;
        filled.push(`${co.nome}: ${fieldLabel(k)}`);
      }
    }
    // CNAE (código) + secundários + tipos de IE — antes descartados. Fill-only, e
    // são o insumo do classificador de produtor (roda logo após, no action).
    if ((co.cnae == null || co.cnae === "") && r.cnae) {
      patch.cnae = r.cnae;
      filled.push(`${co.nome}: CNAE`);
    }
    if ((!co.cnaesSecundarios || co.cnaesSecundarios.length === 0) && r.cnaesSecundarios.length) {
      patch.cnaesSecundarios = r.cnaesSecundarios.map((c) => c.codigo);
    }
    if (co.iesTipos == null && r.ies.length) {
      patch.iesTipos = r.ies as unknown as Prisma.InputJsonValue;
    }
    if (Object.keys(patch).length) {
      await prisma.company.update({ where: { id: co.id }, data: patch });
      companiesUpdated++;
    }

    // Cidade/UF do contato (regional) — só a partir da 1ª empresa que tiver.
    if (!contactCidade && r.cidade) contactCidade = r.cidade;
    if (!contactEstado && r.uf) contactEstado = r.uf;
  }

  const contactPatch: Prisma.ContactUpdateInput = {};
  if (!contact.cidade && contactCidade) {
    contactPatch.cidade = contactCidade;
    filled.push(`Contato: cidade`);
  }
  if (!contact.estado && contactEstado) {
    contactPatch.estado = contactEstado;
    filled.push(`Contato: UF`);
  }
  if (Object.keys(contactPatch).length) {
    await prisma.contact.update({ where: { id: contactId }, data: contactPatch });
  }

  return { companiesUpdated, falhas, fieldsFilled: filled };
}

function fieldLabel(k: string): string {
  const map: Record<string, string> = {
    ie: "IE",
    email: "e-mail",
    telefone: "telefone",
    endereco: "endereço",
    cidade: "cidade",
    estado: "UF",
    naturezaJuridica: "natureza jurídica",
    site: "site",
  };
  return map[k] ?? k;
}

/** Remove o vínculo de uma empresa com o contato (não apaga a empresa). */
export async function unlinkCompany(contactId: string, companyId: string): Promise<void> {
  requireCan("contacts.write");
  const prisma = db();
  await assertOwned("contact", contactId); // F3: só no contato do escopo
  await prisma.contactCompany.deleteMany({ where: { contactId, companyId } });
}

export type PersonInput = {
  nome: string;
  sobrenome?: string | null;
  telefone?: string | null;
  email?: string | null;
  cpf?: string | null;
  cargo?: string | null; // profissão
  endereco?: string | null;
  cidade?: string | null;
  estado?: string | null;
  instagram?: string | null;
  linkedin?: string | null;
  origem?: string | null;
  tags?: string[];
  /** Área (ha) e faturamento anual (R$): número ou texto do formulário ("1.250"). */
  areaHa?: number | string | null;
  faturamentoAnual?: number | string | null;
};

/**
 * Cria um contato (PESSOA) com todos os campos + opcionalmente vincula UMA
 * empresa (com papel). Casca fina sobre `writeContact` (o caminho canônico §2):
 * pessoa+extras (sobrenome/cpf/endereço) + identifiers multicanal (ig/linkedin) +
 * companies[] vão de uma vez, sem a reimplementação por fora que existia antes.
 */
export async function createContactWithCompany(input: {
  person: PersonInput;
  company?: CompanyInput | null;
  papel?: Papel;
  /** Responsável (regra do dono, 28/09): o gestor escolhe; o vendedor é ele mesmo. */
  responsavelId?: string | null;
  /** Status de relacionamento já no cadastro (ex.: "cliente" para quem já é cliente). Ausente = nunca contatado. */
  relacionamentoStatus?: "novo" | "ja_conversou" | "cliente";
}): Promise<{ contactId: string }> {
  requireCan("contacts.write");
  // Gestor escolhe qualquer pessoa ativa; o vendedor só a si mesmo (senão recusa).
  const escolhido = await responsavelEscolhido(input.responsavelId);
  const p = input.person;
  const clean = (v?: string | null) => (v && v.trim() ? v.trim() : undefined);
  const company = input.company && input.company.nome?.trim() ? input.company : null;
  const { contactId } = await writeContact({
    nome: p.nome.trim(),
    sobrenome: clean(p.sobrenome),
    cpf: clean(p.cpf),
    endereco: clean(p.endereco),
    cidade: clean(p.cidade),
    estado: clean(p.estado),
    cargo: clean(p.cargo),
    origem: clean(p.origem) ?? "manual",
    tags: p.tags ?? [],
    // Vazio = sem valor; o schema canônico converte "1.250" e valida o teto.
    areaHa: p.areaHa === "" ? undefined : (p.areaHa ?? undefined),
    faturamentoAnual: p.faturamentoAnual === "" ? undefined : (p.faturamentoAnual ?? undefined),
    identifiers: {
      whatsapp: clean(p.telefone),
      email: clean(p.email),
      instagram: clean(p.instagram),
      linkedin: clean(p.linkedin),
    },
    companies: company ? [{ ...company, papel: input.papel ?? "socio" }] : undefined,
    provenance: { source: clean(p.origem) ?? "manual", actor: "human" },
  }, escolhido ? { ownerId: escolhido } : {});
  // O cadastro nasce "novo" (ou "contatado", se já havia conversa com o número). Só sobe para o que foi escolhido.
  if (input.relacionamentoStatus && input.relacionamentoStatus !== "novo") {
    await db().contact.update({ where: { id: contactId }, data: { relacionamentoStatus: input.relacionamentoStatus } });
  }
  // As tags digitadas também entram no catálogo (barra de filtro e autocomplete leem de lá). Não derruba o cadastro.
  await vincularTagsDoCadastro(contactId, p.tags ?? []);
  return { contactId };
}
