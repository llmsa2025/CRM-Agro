import { randomUUID } from "node:crypto";
import type { Canal, Prisma } from "@prisma/client";
import { db, getCurrentTeamId, tenantData } from "@crmagro/db";
import { writeContact } from "../contacts/write";
import { ContatoJaCadastrado } from "../contacts/errors";
import { ondeIdentificadoresExatos, ondeIdentificadorExato, valorDe } from "../contacts/identificadores-cifra";
import { deOutroResponsavel, quemAge } from "../contacts/responsavel";
import { normalizeCnpj } from "@crmagro/captation";
import { normalizePhone } from "../contacts/phone";
import { requireCan } from "../auth/authz";
import { createCompanyForContact, type CompanyInput } from "../companies/service";
import { assertOwned } from "../tenancy/assert-owned";
import { geoHashDe, normalizarEndereco } from "../geo/endereco";
import { consultarCnpj, draftDoCnpj, motivoFalhaCnpj } from "./cnpj";
import { enqueueCapture } from "./queue";
import { novoStatusCaptura, salvarStatusCaptura } from "./status";
import { extrasDoRascunho, filtrosDeExtras, produtorDoRascunho, type ExtrasDoRascunho } from "./extras";
import type { ProdutorLabel } from "../produtor/classify";

import { donoPadrao } from "../tenancy/escopo";
import { chavesDoRascunho, vinculosDosRascunhos, type RascunhoDedup, type VinculoDoRascunho } from "./vinculo";
import { escopoRascunho } from "./escopo";
export type ProspectDraftDTO = {
  id: string;
  origem: string;
  lote: string;
  nome: string;
  empresa: string | null;
  cnpj: string | null;
  telefone: string | null;
  email: string | null;
  cidade: string | null;
  uf: string | null;
  cnae: string | null;
  temContato: boolean;
  jaExiste: boolean; // já existe um Contato com este telefone/e-mail/perfil/CNPJ — não importa
  /** Responsável pelo contato que já existe (regra do dono, 28/09): "já cadastrado · João". */
  jaExisteResponsavel: string | null;
  /** A que contato(s) a empresa está vinculada (só os que a pessoa vê); null quando não é "já cadastrado". */
  vinculo: VinculoDoRascunho | null;
  createdAt: string;
} & ExtrasDoRascunho; // temWhatsApp, produtorLabel/Score, avaliacao(oes), bio (produto §H.2–H.5)

function toDTO(r: {
  id: string; origem: string; lote: string; nome: string; empresa: string | null;
  cnpj: string | null; telefone: string | null; email: string | null; cidade: string | null;
  uf: string | null; cnae: string | null; extra: Prisma.JsonValue | null; createdAt: Date;
}): ProspectDraftDTO {
  return {
    id: r.id, origem: r.origem, lote: r.lote, nome: r.nome, empresa: r.empresa,
    cnpj: r.cnpj, telefone: r.telefone, email: r.email, cidade: r.cidade, uf: r.uf,
    cnae: r.cnae, temContato: Boolean(r.telefone || r.email), jaExiste: false, jaExisteResponsavel: null, vinculo: null, createdAt: r.createdAt.toISOString(),
    ...extrasDoRascunho(r.extra),
  };
}

/**
 * Descarta todos os rascunhos PENDENTES de uma origem — ação EXPLÍCITA "Limpar
 * fila" (com confirmação na tela). Item H.1: antes a tela chamava isto AO
 * CARREGAR e a captura que o worker acabara de trazer sumia ao trocar de aba.
 * Pendente esquecido expira sozinho em 30 dias (retencao/service.ts).
 */
export async function clearPendingDrafts(origem: string): Promise<void> {
  requireCan("captacao.run");
  // F3: limpa só a fila que a pessoa pode alterar (a dela; master/admin, a de todos).
  await db().prospectDraft.deleteMany({ where: { AND: [{ origem, status: "pendente" }, escopoRascunho({ escrita: true })] } });
}

/** Até este tamanho a lista roda na hora (cabe nas fichas do CNPJá); acima vai para a fila. */
export const CNPJ_SINCRONO_MAX = 5;
/** Teto de uma lista de CNPJ por vez. */
export const CNPJ_LOTE_MAX = 500;

export class LoteCnpjGrandeDemais extends Error {
  constructor(n: number) {
    super(`no máximo ${CNPJ_LOTE_MAX} CNPJs por vez (recebi ${n})`);
    this.name = "LoteCnpjGrandeDemais";
  }
}

/**
 * Captura por CNPJ. Cria rascunhos de staging — NÃO cria Contact.
 *
 * Item 3.2 (INT-13): a lista inteira rodava aqui, sequencial, segurando a
 * server action por minutos (timeout do proxy = lote perdido na tela). Agora:
 * - entrada deduplicada pelos DÍGITOS; inválidos voltam em `falhas` na hora;
 * - até `CNPJ_SINCRONO_MAX` válidos: consulta na hora (cache + fichas do CNPJá)
 *   e devolve os criados, como antes;
 * - acima disso: vai para a fila `capture` (origem `cnpj`) e devolve
 *   `enfileirados`; a tela acompanha pelo status do `lote`.
 */
export async function captureCnpjs(cnpjs: string[]): Promise<{
  lote: string;
  criados: number;
  falhas: { cnpj: string; motivo: string }[];
  enfileirados?: number;
}> {
  requireCan("captacao.run");
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("sem time no contexto");
  const lote = randomUUID();
  const falhas: { cnpj: string; motivo: string }[] = [];

  const vistos = new Set<string>();
  const validos: string[] = [];
  for (const raw of cnpjs.map((c) => c.trim()).filter(Boolean)) {
    const d = normalizeCnpj(raw);
    if (!d) {
      falhas.push({ cnpj: raw, motivo: "CNPJ inválido" });
      continue;
    }
    if (vistos.has(d)) continue;
    vistos.add(d);
    validos.push(d);
  }
  if (validos.length > CNPJ_LOTE_MAX) throw new LoteCnpjGrandeDemais(validos.length);

  if (validos.length > CNPJ_SINCRONO_MAX) {
    await enqueueCapture({ origem: "cnpj", teamId, lote, cnpjs: validos, ownerId: donoPadrao() });
    return { lote, criados: 0, falhas, enfileirados: validos.length };
  }

  let criados = 0;
  for (const d of validos) {
    try {
      const r = await consultarCnpj(d);
      criados += await insertDrafts("cnpj", lote, [draftDoCnpj(r)]);
    } catch (e) {
      falhas.push({ cnpj: d, motivo: motivoFalhaCnpj(e) });
    }
  }
  // Mesmo status do lote enfileirado: a tela pode tratar os dois caminhos igual.
  const st = novoStatusCaptura({ lote, origem: "cnpj", estado: criados > 0 ? "concluida" : "falhou", total: validos.length + falhas.length });
  st.processados = validos.length + falhas.length;
  st.criados = criados;
  st.falhas = falhas.length;
  st.falhasAmostra = falhas.slice(0, 20).map((f) => ({ item: f.cnpj, motivo: f.motivo }));
  if (!criados) {
    st.motivo = "erro";
    st.mensagem = `Nenhum CNPJ deu certo (${falhas.length} falha(s)).`;
  }
  await salvarStatusCaptura(teamId, st);
  return { lote, criados, falhas };
}

export type DraftInput = {
  nome: string;
  empresa?: string | null;
  cnpj?: string | null;
  telefone?: string | null;
  email?: string | null;
  cidade?: string | null;
  uf?: string | null;
  cnae?: string | null;
  extra?: unknown;
};

/**
 * Insere rascunhos de uma captura (usado pelo worker após o scraping). Origem
 * `cnpj`: classifica produtor rural pelos CNAEs/IEs e grava
 * `extra.produtorLabel`/`produtorScore` (produto §H.3).
 */
export async function insertDrafts(origem: string, lote: string, items: DraftInput[], ownerId?: string | null): Promise<number> {
  requireCan("captacao.run");
  // F3: fila por pessoa — o dono vem do job (worker) ou de quem age (web).
  const dono = ownerId ?? donoPadrao();
  const prisma = db();
  let n = 0;
  for (const it of items) {
    if (!it.nome?.trim()) continue;
    const produtor = origem === "cnpj" ? produtorDoRascunho(it.extra) : null;
    const extra = produtor ? { ...(it.extra as object), ...produtor } : it.extra;
    await prisma.prospectDraft.create({
      data: tenantData<Prisma.ProspectDraftUncheckedCreateInput>({
        origem,
        lote,
        ownerId: dono,
        nome: it.nome.trim(),
        empresa: it.empresa ?? null,
        cnpj: it.cnpj ?? null,
        telefone: it.telefone ?? null,
        email: it.email ?? null,
        cidade: it.cidade ?? null,
        uf: it.uf ?? null,
        cnae: it.cnae ?? null,
        ...(extra ? { extra: extra as Prisma.InputJsonValue } : {}),
      }),
    });
    n++;
  }
  return n;
}

export type ListDraftsInput = {
  origem?: string;
  lote?: string;
  soComContato?: boolean;
  search?: string;
  /** true = só com WhatsApp; false = só sem (produto §H.6). Omitido = todos. */
  temWhatsApp?: boolean;
  /** Um ou mais rótulos de produtor (origem `cnpj`). */
  produtorLabel?: ProdutorLabel | ProdutorLabel[];
};

/**
 * Rascunhos que JÁ são contato do time (por telefone, e-mail, perfil do
 * Instagram ou CNPJ): id do rascunho → contato + nome do responsável. Uma
 * consulta por tipo de chave (não uma por linha). Tudo pelo `db()` — a
 * extensão prende ao time do contexto.
 */
async function contatosJaCadastrados(rascunhos: readonly RascunhoDedup[]): Promise<Map<string, { contactId: string; responsavel: string | null }>> {
  const prisma = db();
  const porRascunho = new Map<string, string[]>();
  const idents: { canal: Canal; valor: string }[] = [];
  const cnpjs: string[] = [];
  for (const r of rascunhos) {
    const chaves = chavesDoRascunho(r);
    porRascunho.set(r.id, chaves);
    for (const k of chaves) {
      const i = k.indexOf(":");
      const canal = k.slice(0, i);
      const valor = k.slice(i + 1);
      if (canal === "cnpj") cnpjs.push(valor);
      else idents.push({ canal: canal as Canal, valor });
    }
  }
  const achados = new Map<string, { contactId: string; responsavel: string | null }>();
  if (!idents.length && !cnpjs.length) return achados;
  const dono = { select: { name: true } } as const;
  const [porIdent, porCnpj] = await Promise.all([
    idents.length
      ? prisma.channelIdentifier.findMany({
          where: ondeIdentificadoresExatos(getCurrentTeamId() ?? "", idents),
          select: { canal: true, valor: true, valorCifrado: true, contactId: true, contact: { select: { owner: dono } } },
        })
      : Promise.resolve([]),
    cnpjs.length
      ? prisma.contact.findMany({ where: { cnpj: { in: [...new Set(cnpjs)] } }, select: { id: true, cnpj: true, owner: dono } })
      : Promise.resolve([]),
  ]);
  const porChave = new Map<string, { contactId: string; responsavel: string | null }>();
  for (const i of porIdent) porChave.set(`${i.canal}:${valorDe(i)}`, { contactId: i.contactId, responsavel: i.contact?.owner?.name ?? null });
  for (const c of porCnpj) if (c.cnpj && !porChave.has(`cnpj:${c.cnpj}`)) porChave.set(`cnpj:${c.cnpj}`, { contactId: c.id, responsavel: c.owner?.name ?? null });
  for (const [id, chaves] of porRascunho) {
    const k = chaves.find((c) => porChave.has(c));
    if (k) achados.set(id, porChave.get(k)!);
  }
  return achados;
}

/** Lista os rascunhos pendentes de uma origem (staging/pré-recebimento). */
export async function listDrafts(input: ListDraftsInput): Promise<ProspectDraftDTO[]> {
  const prisma = db();
  const term = input.search?.trim().toLowerCase();
  const rows = await prisma.prospectDraft.findMany({
    where: {
      status: "pendente",
      ...(input.origem ? { origem: input.origem } : {}),
      ...(input.lote ? { lote: input.lote } : {}),
      ...(input.soComContato ? { OR: [{ telefone: { not: null } }, { email: { not: null } }] } : {}),
      AND: [...filtrosDeExtras(input), escopoRascunho()], // F3: a fila de quem capturou
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  let dtos = rows.map(toDTO);

  // Dedup: marca os rascunhos que já são Contato (telefone, e-mail, perfil ou
  // CNPJ) e quem é o responsável — a tela mostra "Já cadastrado · responsável
  // João" e não deixa selecionar (regra do dono, 28/09: a mesma pessoa não se
  // cadastra duas vezes). O nome do colega aparece; o contato dele, não.
  const existentes = await contatosJaCadastrados(rows);
  if (existentes.size) {
    // Vínculo em lote (uma rodada de consultas para a página toda): o nome do
    // contato só vai para quem pode ver aquele contato (escopo de Contatos).
    const vinculos = await vinculosDosRascunhos(rows.filter((r) => existentes.has(r.id)));
    dtos = dtos.map((d) => {
      const achado = existentes.get(d.id);
      return achado ? { ...d, jaExiste: true, jaExisteResponsavel: achado.responsavel, vinculo: vinculos.get(d.id) ?? null } : d;
    });
  }

  if (!term) return dtos;
  return dtos.filter((d) =>
    [d.nome, d.empresa, d.cnae, d.cidade, d.cnpj].filter(Boolean).some((v) => (v as string).toLowerCase().includes(term)),
  );
}

/**
 * A empresa que um rascunho de CNPJ vira. É a mesma ao importar (contato novo) e ao vincular
 * (contato que já existe): quem decide o que fazer com ela é quem chama.
 */
function empresaDoRascunho(d: {
  nome: string;
  empresa: string | null;
  cnpj: string | null;
  telefone: string | null;
  email: string | null;
  cidade: string | null;
  uf: string | null;
  extra: Prisma.JsonValue | null;
}): CompanyInput {
  const extra = (d.extra ?? {}) as { endereco?: string | null; site?: string | null; razaoSocial?: string | null };
  return {
    nome: extra.razaoSocial || d.empresa || d.nome,
    cnpj: d.cnpj ?? undefined,
    telefone: d.telefone ?? undefined,
    email: d.email ?? undefined,
    endereco: extra.endereco ?? undefined,
    cidade: d.cidade ?? undefined,
    estado: d.uf ?? undefined,
    site: extra.site ?? undefined,
  };
}

/**
 * "Vincular a um contato": a empresa do CNPJ fica ligada a um contato que JÁ existe e não vira
 * contato. Ela aparece na ficha desse contato (Empresas) e não entra na lista de Contatos. O
 * rascunho sai da fila como "importado". Várias de uma vez vão todas para o mesmo contato.
 * Reusa a empresa do time que já tem o mesmo CNPJ (não duplica) e não repete o vínculo.
 * Só rascunho de CNPJ: o de Maps e o de Instagram não têm empresa para ligar.
 */
export async function vincularDrafts(ids: string[], contactId: string): Promise<{ vinculados: number; pulados: number }> {
  requireCan("captacao.import");
  // O id do contato vem da tela e vira FK: confere que é do time e que a pessoa pode alterá-lo.
  await assertOwned("contact", contactId);
  const prisma = db();
  const drafts = await prisma.prospectDraft.findMany({
    where: { AND: [{ id: { in: ids }, status: "pendente", origem: "cnpj" }, escopoRascunho({ escrita: true })] },
  });
  let vinculados = 0;
  for (const d of drafts) {
    await createCompanyForContact(contactId, empresaDoRascunho(d), "socio", { manterPapel: true });
    await prisma.prospectDraft.update({ where: { id: d.id }, data: { status: "importado" } });
    vinculados++;
  }
  return { vinculados, pulados: ids.length - vinculados };
}

/** Importa rascunhos selecionados → cria Contact e marca "importado". */
export async function importDrafts(ids: string[]): Promise<{ importados: number; pulados: number }> {
  requireCan("captacao.import");
  const prisma = db();
  const drafts = await prisma.prospectDraft.findMany({ where: { AND: [{ id: { in: ids }, status: "pendente" }, escopoRascunho({ escrita: true })] } });
  let importados = 0;
  let pulados = 0;
  // Dedup (regra do dono, 28/09): o que já é contato do time — por e-mail,
  // telefone, perfil ou CNPJ, de QUALQUER responsável — não é importado de
  // novo: o rascunho sai da fila ("importado") e conta como pulado. A tela já
  // não deixa selecionar essas linhas; isto cobre a chamada direta. (Casa dos
  // Dados/Maps repetem o mesmo telefone entre estabelecimentos.)
  const jaCadastrados = await contatosJaCadastrados(drafts);
  const pular = async (id: string) => {
    await prisma.prospectDraft.update({ where: { id }, data: { status: "importado" } });
    pulados++;
  };
  for (const d of drafts) {
    if (jaCadastrados.has(d.id)) {
      await pular(d.id);
      continue;
    }
    const extra = (d.extra ?? {}) as {
      username?: string;
      endereco?: string | null;
      site?: string | null;
      razaoSocial?: string | null;
      cnaeDescricao?: string | null;
      /** Coordenada da ficha do Google Maps (lat/lng da URL do lugar). */
      lat?: number | null;
      lng?: number | null;
    };
    // CNPJ vira EMPRESA vinculada (o contato é a pessoa; CNPJ/site nunca são
    // coluna de pessoa). O `createCompanyForContact` denormaliza Contact.cnpj —
    // preservando o dedup por CNPJ do staging/listDrafts.
    const company = d.origem === "cnpj" ? [{ ...empresaDoRascunho(d), papel: "socio" as const }] : undefined;

    // Escrita canônica: dispara reconcile + contact_created + proveniência.
    // Modo "create": se no meio do lote a pessoa já virou contato (dois
    // rascunhos com o mesmo telefone, ou outro vendedor cadastrou agora), o
    // `writeContact` recusa com ContatoJaCadastrado — o rascunho é pulado.
    let escrito: Awaited<ReturnType<typeof writeContact>>;
    try {
      escrito = await writeContact({
        nome: d.nome,
        cidade: d.cidade ?? undefined,
        estado: d.uf ?? undefined,
        empresa: d.empresa ?? undefined,
        endereco: extra.endereco ?? undefined,
        origem: `captacao_${d.origem}`,
        identifiers: {
          whatsapp: d.telefone ?? undefined,
          email: d.email ?? undefined,
          instagram: d.origem === "instagram" ? extra.username : undefined,
        },
        companies: company,
        provenance: { source: `captacao_${d.origem}`, actor: "system" },
      // Responsável = quem capturou (o master importando a fila de um vendedor não a toma para si).
      }, { emLote: true, ...(d.ownerId ? { ownerId: d.ownerId } : {}) });
    } catch (e) {
      if (!(e instanceof ContatoJaCadastrado)) throw e;
      await pular(d.id);
      continue;
    }
    const { contactId } = escrito;
    // Ficha do Google Maps traz a coordenada exata: grava direto (fonte "maps"),
    // sem gastar Nominatim. Se o endereço mudar depois, o trigger zera o geoHash
    // e o backfill refaz. Pino manual nunca é sobrescrito.
    if (d.origem === "maps" && typeof extra.lat === "number" && typeof extra.lng === "number" && Number.isFinite(extra.lat) && Number.isFinite(extra.lng)) {
      const n = normalizarEndereco({ endereco: extra.endereco, cidade: d.cidade, estado: d.uf });
      await prisma.contact.updateMany({
        where: { id: contactId, OR: [{ geoPrecisao: null }, { geoPrecisao: { not: "manual" } }] },
        data: { latitude: extra.lat, longitude: extra.lng, geoPrecisao: "endereco", geoFonte: "maps", geoHash: geoHashDe(n.chave), geoAtualizadoEm: new Date() },
      });
    }

    await prisma.prospectDraft.update({ where: { id: d.id }, data: { status: "importado" } });
    importados++;
  }
  return { importados, pulados };
}

/** Descarta rascunhos selecionados (saem da lista sem virar Contact). */
export async function discardDrafts(ids: string[]): Promise<{ descartados: number }> {
  requireCan("captacao.run");
  const prisma = db();
  const res = await prisma.prospectDraft.updateMany({
    where: { AND: [{ id: { in: ids }, status: "pendente" }, escopoRascunho({ escrita: true })] },
    data: { status: "descartado" },
  });
  return { descartados: res.count };
}

/**
 * Importa uma planilha exportada da Casa dos Dados (colunas próprias:
 * razao_social, cnpj, municipio, uf, whatsapp, email, cnae_principal, …) direto
 * para Contatos: cria Contato (pessoa/empresa) + Empresa vinculada. Dedup por
 * CNPJ (Contact.cnpj) ou e-mail (ChannelIdentifier). Não passa pelo staging.
 */
export async function importCasaDosDados(
  rows: Record<string, string>[],
): Promise<{ criados: number; pulados: number }> {
  requireCan("contacts.import");
  const prisma = db();
  let criados = 0;
  let pulados = 0;
  const g = (r: Record<string, string>, k: string) => (r[k] ?? "").toString().trim();

  for (const r of rows) {
    const cnpj = normalizeCnpj(g(r, "cnpj"));
    const razao = g(r, "razao_social") || g(r, "nome") || g(r, "empresa");
    if (!razao && !cnpj) continue;
    const nome = razao || cnpj || "Empresa";
    const email = g(r, "email").toLowerCase() || undefined;
    // A coluna "whatsapp" da Casa dos Dados costuma ser um booleano (TRUE/FALSE),
    // não um número — então escolhemos a 1ª coluna que É um telefone VÁLIDO.
    const telefone =
      [g(r, "telefone"), g(r, "whatsapp"), g(r, "celular"), g(r, "fone")].find((c) => normalizePhone(c)) || undefined;
    const cidade = g(r, "municipio") || g(r, "cidade") || undefined;
    const uf = g(r, "uf") || g(r, "estado") || undefined;
    const endereco =
      [g(r, "logradouro"), g(r, "numero"), g(r, "complemento"), g(r, "bairro")].filter(Boolean).join(", ") || undefined;
    const site = g(r, "website") || g(r, "site") || undefined;

    // Dedup: já existe contato por CNPJ (coluna) ou e-mail (identifier)?
    let existingId: string | null = cnpj
      ? (await prisma.contact.findFirst({ where: { cnpj }, select: { id: true } }))?.id ?? null
      : null;
    if (!existingId && email) {
      existingId =
        (await prisma.channelIdentifier.findFirst({ where: ondeIdentificadorExato(getCurrentTeamId() ?? "", "email", [email]), select: { contactId: true } }))
          ?.contactId ?? null;
    }
    if (existingId) {
      // Contato de OUTRO responsável (regra do dono, 28/09): nem duplica nem
      // "completa" o contato do colega — a linha só conta como pulada.
      if ((await deOutroResponsavel([existingId], await quemAge())).size) {
        pulados++;
        continue;
      }
      // Não duplica — mas ENRIQUECE: se tem telefone e o contato não tem, adiciona.
      const norm = telefone ? normalizePhone(telefone) : null;
      if (norm) {
        const temTel = await prisma.channelIdentifier.findFirst({
          where: { contactId: existingId, canal: "whatsapp" },
          select: { id: true },
        });
        if (!temTel) {
          try {
            await prisma.channelIdentifier.create({
              data: tenantData<Prisma.ChannelIdentifierUncheckedCreateInput>({
                contactId: existingId,
                canal: "whatsapp",
                valor: norm,
                isPrimary: true,
              }),
            });
          } catch {
            /* número já usado por outro contato: ignora */
          }
        }
      }
      pulados++;
      continue;
    }

    // Telefone só entra se AINDA não existir como identifier (o mesmo número se
    // repete entre estabelecimentos na Casa dos Dados — evita violar o unique).
    const normTel = telefone ? normalizePhone(telefone) : null;
    const telLivre = normTel
      ? !(await prisma.channelIdentifier.findFirst({ where: { canal: "whatsapp", valor: normTel }, select: { id: true } }))
      : false;

    try {
      // Escrita canônica: pessoa + identifiers + EMPRESA (CNPJ/site via companies[],
      // que denormaliza Contact.cnpj p/ o dedup). Dispara reconcile + contact_created.
      await writeContact({
        nome,
        cidade: cidade ?? undefined,
        estado: uf ?? undefined,
        empresa: razao ?? undefined,
        endereco: endereco ?? undefined,
        origem: "casa_dos_dados",
        identifiers: {
          email: email ?? undefined,
          whatsapp: telLivre && telefone ? telefone : undefined,
        },
        companies: [
          {
            nome: razao || nome,
            cnpj: cnpj ?? undefined,
            telefone: telefone ?? undefined,
            email: email ?? undefined,
            endereco: endereco ?? undefined,
            cidade: cidade ?? undefined,
            estado: uf ?? undefined,
            site: site ?? undefined,
            papel: "socio" as const,
          },
        ],
        provenance: { source: "casa_dos_dados", actor: "system" },
      }, { emLote: true });
      criados++;
    } catch {
      // Uma linha problemática (identifier duplicado, dado inválido) não derruba
      // o lote inteiro — apenas conta como pulada.
      pulados++;
    }
  }
  return { criados, pulados };
}
