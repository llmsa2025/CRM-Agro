import { randomUUID } from "node:crypto";
import type { Canal, Prisma } from "@prisma/client";
import { db, getCurrentTeamId, tenantData } from "@crmagro/db";
import { normalizeIdentifier } from "./identifiers";
import { safeEnrollByTrigger, safeEnrollManyByTrigger } from "../flows/triggers";
import { isUniqueViolation } from "./errors";
import { contactUpsertSchema, type ContactUpsertInput, type ContactUpsertParsed } from "./schema";
import { requireCan } from "../auth/authz";
import { vincularConversaAoContato } from "../conversations/vinculo";

import { donoPadrao } from "../tenancy/escopo";
import { deOutroResponsavel, quemAge, recusarJaCadastrado, recusarSeDeOutro, responsavelObrigatorio } from "./responsavel";
import { cifrarCpf, hashDoCpfDoTime } from "./cpf";
import { numeroDe, ondeConversaPorNumero, ondeIdentificadoresExatos, ondeIdentificadorExato, valorDe } from "./identificadores-cifra";
/**
 * writeContact — o ÚNICO caminho canônico de ESCRITA de contato.
 *
 * §2. Toda borda (form,
 * IA, captação, import CSV, webhook) escreve por aqui. Unifica o que antes eram 9
 * caminhos divergentes com 3 reimplementações do bloco "pessoa+extras+identifiers
 * +empresa":
 *   1. valida com o schema canônico (zod, .strict — rejeita CNPJ/site na pessoa);
 *   2. normaliza os identifiers (whatsapp→E.164, email→lower, ig/linkedin→handle);
 *   3. dedup canônico por identifier (unifica findOrCreateContact/createOneContact);
 *   4. transação (contact + identifiers + extras sobrenome/cpf/endereço);
 *   5. vincula companies[] (dedup por CNPJ) — a PESSOA nunca recebe coluna de empresa;
 *   6. SEMPRE emite `contact_created` + reconcile de histórico (fecha o furo do CSV);
 *   7. grava proveniência (quem/como escreveu) em `enrichment.provenance`.
 *
 * O teamId nunca é passado manualmente — `db()` lê o ALS de forma eager no início.
 */

type WriteMode = "create" | "upsert";

export type WriteContactResult = {
  contactId: string;
  /** true quando um contato NOVO foi criado; false quando o upsert reusou um existente. */
  created: boolean;
};

/** Identifiers normalizados do input canônico (descarta os inválidos). */
function normalizedIdentifiers(input: ContactUpsertParsed): { canal: Canal; valor: string }[] {
  const rows: { canal: Canal; valor: string }[] = [];
  const push = (canal: Canal, raw?: string) => {
    if (!raw) return;
    const v = normalizeIdentifier(canal, raw);
    if (v) rows.push({ canal, valor: v });
  };
  push("whatsapp", input.identifiers.whatsapp);
  push("email", input.identifiers.email);
  push("instagram", input.identifiers.instagram);
  push("linkedin", input.identifiers.linkedin);
  return rows;
}

/** Colunas primitivas de PESSOA (nunca campos de empresa). */
function personColumns(input: ContactUpsertParsed) {
  return {
    nome: input.nome,
    sobrenome: input.sobrenome || undefined,
    cidade: input.cidade || undefined,
    estado: input.estado || undefined,
    endereco: input.endereco || undefined,
    cargo: input.cargo || undefined,
    // CPF cifrado no banco (contacts/cpf.ts): a coluna nunca recebe texto puro.
    cpfCifrado: cifrarCpf(input.cpf) ?? undefined,
    cpfHash: hashDoCpfDoTime(input.cpf) ?? undefined,
    empresa: input.empresa || undefined,
    origem: input.origem || undefined,
    tags: input.tags,
    // undefined = não mexe; null = limpa (só faz diferença na atualização).
    areaHa: input.areaHa,
    faturamentoAnual: input.faturamentoAnual,
  };
}

/**
 * Reconciliação de histórico no cadastro. Procura Conversations do time ainda SEM
 * contato (`contactId: null`) cujo `externalNumber` bata com um identifier do novo
 * contato. Achando: vincula as conversas e marca `relacionamentoStatus =
 * ja_conversou`. Best-effort — nunca derruba a criação do contato.
 */
export async function reconcileHistoryOnCreate(contactId: string, valores: string[]): Promise<void> {
  if (valores.length === 0) return;
  const prisma = db();
  try {
    const convos = await prisma.conversation.findMany({
      where: { contactId: null, ...ondeConversaPorNumero(exigirTime(), valores) },
      select: { id: true },
    });
    if (convos.length === 0) return;
    // Uma por uma: se o contato já tem conversa naquela conta, mescla (índice
    // único conta+contato — item 0.8) em vez de falhar o lote inteiro.
    for (const c of convos) await vincularConversaAoContato(c.id, contactId);
    await prisma.contact.update({
      where: { id: contactId },
      data: { relacionamentoStatus: "ja_conversou" },
    });
  } catch {
    // reconciliação é conveniência; nunca deve falhar a criação do contato.
  }
}

/** Valores de `externalNumber` por consulta na reconciliação em lote. */
const RECONCILIAR_LOTE = 1000;

/**
 * `reconcileHistoryOnCreate` para muitos contatos recém-criados (importação —
 * DP-16/MF-13). Uma consulta por bloco de 1.000 números acha as conversas sem
 * contato; só os contatos que BATEM passam pela reconciliação unitária (vincular
 * + "já conversou"). Antes era 1 consulta por contato, mesmo sem conversa nenhuma.
 */
export async function reconcileHistoryOnCreateMany(
  itens: readonly { contactId: string; valores: readonly string[] }[],
): Promise<void> {
  const prisma = db();
  const teamId = exigirTime();
  const donoDoValor = new Map<string, string>();
  for (const it of itens) for (const v of it.valores) if (!donoDoValor.has(v)) donoDoValor.set(v, it.contactId);
  const valores = [...donoDoValor.keys()];
  const achados = new Set<string>();
  try {
    for (let i = 0; i < valores.length; i += RECONCILIAR_LOTE) {
      const convos = await prisma.conversation.findMany({
        where: { contactId: null, ...ondeConversaPorNumero(teamId, valores.slice(i, i + RECONCILIAR_LOTE)) },
        select: { externalNumber: true, externalNumberCifrado: true },
      });
      for (const c of convos) {
        const numero = numeroDe(c, "externalNumber", "conversation");
        if (numero) achados.add(numero);
      }
    }
  } catch {
    return; // conveniência: nunca derruba a importação.
  }
  for (const it of itens) {
    if (it.valores.some((v) => achados.has(v))) await reconcileHistoryOnCreate(it.contactId, [...it.valores]);
  }
}

/** Time do contexto (o índice cego de e-mail e telefone leva o time na conta). Sempre existe depois de `db()`. */
function exigirTime(): string {
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("writeContact: sem time no contexto");
  return teamId;
}

/** Acha o contato dono de QUALQUER um dos identifiers (dedup canônico). */
async function findByIdentifiers(rows: { canal: Canal; valor: string }[]): Promise<string | null> {
  if (rows.length === 0) return null;
  const prisma = db();
  const found = await prisma.channelIdentifier.findFirst({
    where: ondeIdentificadoresExatos(exigirTime(), rows),
    select: { contactId: true },
  });
  return found?.contactId ?? null;
}

/**
 * Grava a proveniência da escrita em `enrichment.provenance` (snapshot barato). Em
 * Fase B esta atribuição ganha a tabela append-only `EnrichmentFact`; aqui o Json
 * já registra quem/como escreveu, matando o prefixo frágil "IA:".
 */
async function writeProvenance(contactId: string, input: ContactUpsertParsed): Promise<void> {
  const prisma = db();
  try {
    await prisma.contact.update({
      where: { id: contactId },
      data: {
        enrichment: {
          provenance: {
            source: input.provenance.source,
            actor: input.provenance.actor,
            at: new Date().toISOString(),
          },
        } as Prisma.InputJsonValue,
      },
    });
  } catch {
    // proveniência é auditoria best-effort — não derruba a escrita.
  }
}

/**
 * Cria o contato + identifiers (top-level, para a extensão tenant injetar o teamId)
 * numa transação atômica. Devolve o id. Companies e triggers ficam FORA da tx.
 */
async function insertContact(
  input: ContactUpsertParsed,
  identifiers: { canal: Canal; valor: string }[],
  ownerId: string | null,
): Promise<string> {
  const prisma = db();
  return prisma.$transaction(async (tx) => {
    const contact = await tx.contact.create({
      // F3: dono = quem cadastra (ou o dono passado: importação no worker).
      data: tenantData<Prisma.ContactUncheckedCreateInput>({ ...personColumns(input), nome: input.nome, ownerId }),
    });
    if (identifiers.length) {
      // skipDuplicates: o unique (teamId,canal,valor) é GLOBAL no time. Se o
      // identifier já pertence a outro contato, ele é ignorado em vez de estourar
      // P2002 (que virava 500 + flood de log). O contato é criado mesmo assim.
      await tx.channelIdentifier.createMany({
        data: identifiers.map((i, idx) =>
          tenantData<Prisma.ChannelIdentifierCreateManyInput>({
            contactId: contact.id,
            canal: i.canal,
            valor: i.valor,
            // 1º identifier de cada canal é primário.
            isPrimary: identifiers.findIndex((x) => x.canal === i.canal) === idx,
          }),
        ),
        skipDuplicates: true,
      });
    }
    return contact.id;
  });
}

/**
 * Vincula as empresas do input ao contato (dedup por CNPJ). Import tardio para
 * quebrar o ciclo write↔companies (uso em nível de função, seguro no ESM).
 */
async function linkCompanies(contactId: string, input: ContactUpsertParsed): Promise<void> {
  if (!input.companies?.length) return;
  const { createCompanyForContact } = await import("../companies/service");
  for (const co of input.companies) {
    const { papel, ...rest } = co;
    try {
      await createCompanyForContact(contactId, rest, papel);
    } catch {
      // falha ao vincular uma empresa não impede o cadastro do contato.
    }
  }
}

/**
 * ESCRITA CANÔNICA de contato. `mode`:
 *   - "create": cria um contato novo; se algum identifier já é de um contato do
 *     time, RECUSA com `ContatoJaCadastrado` (regra do dono, 28/09 — antes criava
 *     a pessoa duplicada sem o identifier). Só a corrida entre o check e o
 *     insert ainda cai no skipDuplicates dos identifiers.
 *   - "upsert": se já existe contato com algum identifier, REUSA (não duplica) —
 *     base do webhook e dos tools da IA. Vincula companies novas ao existente.
 *     Contato de OUTRO responsável (para quem age) é recusado, sem escrever nada.
 *
 * O responsável do contato novo é `opts.ownerId` (o job que age em nome de
 * alguém) ou quem está no contexto; sistema sem pessoa → o master do time.
 */
export async function writeContact(
  rawInput: ContactUpsertInput,
  opts: { mode?: WriteMode; emLote?: boolean; gatilho?: boolean; ownerId?: string | null } = {},
): Promise<WriteContactResult> {
  requireCan("contacts.write");
  // Responsável OBRIGATÓRIO (regra do dono, 28/09): quem cadastra (ou quem o job
  // representa); sistema sem pessoa → o master do time.
  const ownerId = await responsavelObrigatorio(opts.ownerId !== undefined ? opts.ownerId : donoPadrao());
  const mode = opts.mode ?? "create";
  const input = contactUpsertSchema.parse(rawInput);
  const identifiers = normalizedIdentifiers(input);

  // Mesma pessoa não se cadastra duas vezes (regra do dono, 28/09).
  //  - "create" (cadastro manual, captação): recusa SEMPRE. O erro é para quem
  //    está na tela — o gestor recebe o id do existente (mesmo escolhendo outro
  //    responsável); o vendedor, só o nome do responsável.
  //  - "upsert" (IA, webhook, lista de campanha): reaproveita — mas o contato de
  //    OUTRO responsável não é usado por quem não vê o time (nem pelo job que
  //    age em nome dela). Recusado ANTES de qualquer escrita (empresas, nota).
  const existente = identifiers.length ? await findByIdentifiers(identifiers) : null;
  if (existente) {
    if (mode === "create") await recusarJaCadastrado(existente, await quemAge());
    await recusarSeDeOutro(existente, await quemAge(opts.ownerId));
    // Reusa: só complementa as empresas (fill-only via createCompanyForContact).
    await linkCompanies(existente, input);
    return { contactId: existente, created: false };
  }

  let contactId: string;
  try {
    contactId = await insertContact(input, identifiers, ownerId);
  } catch (e) {
    // Corrida no upsert: outro request criou o mesmo identifier entre o check e o
    // insert. Re-consulta e devolve o vencedor (idempotência real).
    if (mode === "upsert" && isUniqueViolation(e)) {
      const dono = await findByIdentifiers(identifiers);
      if (dono) {
        await recusarSeDeOutro(dono, await quemAge(opts.ownerId));
        await linkCompanies(dono, input);
        return { contactId: dono, created: false };
      }
    }
    throw e;
  }

  await linkCompanies(contactId, input);
  await writeProvenance(contactId, input);

  // Reconcilia histórico e SEMPRE dispara o gatilho do motor — inclusive no
  // caminho de import CSV, que antes entrava "morto" para o motor.
  await reconcileHistoryOnCreate(
    contactId,
    identifiers.map((i) => i.valor),
  );
  // `emLote` (importações): o gatilho espalha as inscrições com jitter padrão.
  // `gatilho: false` só para quem JÁ É o primeiro contato com a pessoa (lista de
  // campanha): um fluxo de boas-vindas mandaria uma segunda mensagem.
  if (opts.gatilho !== false) {
    await safeEnrollByTrigger("contact_created", { contactId, ...(opts.emLote ? { emLote: true } : {}) });
  }

  return { contactId, created: true };
}

/** Resultado de uma entrada do lote (na mesma ordem da entrada). */
export type WriteContactLoteResult = WriteContactResult | { contactId: null; created: false; erro: string };

/** Identifiers por consulta de dedup no lote. */
const DEDUP_LOTE = 1000;

/**
 * `writeContact` em modo "upsert" para MUITOS contatos (importação em lote —
 * produto §C). Mesmas regras do caminho canônico, por BLOCO em vez de por
 * contato (~8 idas ao banco por linha → um punhado por bloco):
 *   1. schema canônico (zod) em cada entrada — a inválida volta com `erro`;
 *   2. identifiers normalizados;
 *   3. dedup por identifier do time (`IN` por canal) — quem já existe volta
 *      `created: false` com o id existente; duas entradas com o mesmo
 *      identifier viram UM contato. O existente de OUTRO responsável (para quem
 *      age) volta com `erro` "já cadastrado com o responsável X";
 *   4. contato + identifiers numa transação (`createMany`). Identifier que outro
 *      processo gravou entre a dedup e a transação é descartado pelo
 *      `skipDuplicates` e o contato nasce SEM ele (`created: true`) — o mesmo
 *      comportamento aceito do `insertContact`; na importação é raro (uma por
 *      time por vez) e a tela de duplicados acha;
 *   5. proveniência em `enrichment.provenance`;
 *   6. reconcile de histórico e `contact_created` em lote (`emLote` → jitter).
 * Sem `companies` (quem precisa de empresa estruturada usa `writeContact`).
 */
export async function writeContactsEmLote(
  rawInputs: readonly ContactUpsertInput[],
  opts: { emLote?: boolean; ownerId?: string | null } = {},
): Promise<WriteContactLoteResult[]> {
  requireCan("contacts.write");
  const prisma = db(); // antes de qualquer await (AGENTS.md §12)
  const teamId = exigirTime();
  const ownerId = await responsavelObrigatorio(opts.ownerId !== undefined ? opts.ownerId : donoPadrao());
  type Item =
    | { ok: true; input: ContactUpsertParsed; identifiers: { canal: Canal; valor: string }[] }
    | { ok: false; erro: string };
  const itens: Item[] = rawInputs.map((raw) => {
    const r = contactUpsertSchema.safeParse(raw);
    if (!r.success) return { ok: false, erro: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    if (r.data.companies?.length) return { ok: false, erro: "companies: use writeContact" };
    return { ok: true, input: r.data, identifiers: normalizedIdentifiers(r.data) };
  });

  // 3) Quem já existe no time (por identifier), em blocos por canal.
  const dono = new Map<string, string>();
  const porCanal = new Map<Canal, Set<string>>();
  for (const it of itens) {
    if (!it.ok) continue;
    for (const i of it.identifiers) porCanal.set(i.canal, (porCanal.get(i.canal) ?? new Set()).add(i.valor));
  }
  for (const [canal, conjunto] of porCanal) {
    const valores = [...conjunto];
    for (let i = 0; i < valores.length; i += DEDUP_LOTE) {
      const achados = await prisma.channelIdentifier.findMany({
        where: ondeIdentificadorExato(teamId, canal, valores.slice(i, i + DEDUP_LOTE)),
        select: { canal: true, valor: true, valorCifrado: true, contactId: true },
      });
      for (const a of achados) {
        const valor = valorDe(a);
        if (valor) dono.set(`${a.canal}:${valor}`, a.contactId);
      }
    }
  }

  // Já cadastrados com OUTRO responsável: a linha é recusada (não reaproveita).
  const foraDoResponsavel = await deOutroResponsavel([...new Set(dono.values())], await quemAge(opts.ownerId));

  const resultados: WriteContactLoteResult[] = [];
  const novos: { id: string; input: ContactUpsertParsed; identifiers: { canal: Canal; valor: string }[] }[] = [];
  for (const it of itens) {
    if (!it.ok) {
      resultados.push({ contactId: null, created: false, erro: it.erro });
      continue;
    }
    const chaves = it.identifiers.map((i) => `${i.canal}:${i.valor}`);
    const existente = chaves.map((k) => dono.get(k)).find((id) => id);
    if (existente) {
      if (foraDoResponsavel.has(existente)) {
        const nome = foraDoResponsavel.get(existente);
        resultados.push({ contactId: null, created: false, erro: `já cadastrado${nome ? ` com o responsável ${nome}` : " com outro responsável"}` });
        continue;
      }
      resultados.push({ contactId: existente, created: false });
      continue;
    }
    const id = randomUUID();
    for (const k of chaves) dono.set(k, id); // a próxima entrada com o mesmo identifier reusa este
    novos.push({ id, input: it.input, identifiers: it.identifiers });
    resultados.push({ contactId: id, created: true });
  }

  if (novos.length) {
    const at = new Date().toISOString();
    await prisma.$transaction(async (tx) => {
      await tx.contact.createMany({
        data: novos.map((n) =>
          tenantData<Prisma.ContactUncheckedCreateInput>({
            ...personColumns(n.input),
            ownerId,
            id: n.id,
            nome: n.input.nome,
            enrichment: {
              provenance: { source: n.input.provenance.source, actor: n.input.provenance.actor, at },
            } as Prisma.InputJsonValue,
          }),
        ),
      });
      const idents = novos.flatMap((n) =>
        n.identifiers.map((i, idx) =>
          tenantData<Prisma.ChannelIdentifierCreateManyInput>({
            contactId: n.id,
            canal: i.canal,
            valor: i.valor,
            isPrimary: n.identifiers.findIndex((x) => x.canal === i.canal) === idx,
          }),
        ),
      );
      if (idents.length) await tx.channelIdentifier.createMany({ data: idents, skipDuplicates: true });
    });
    await reconcileHistoryOnCreateMany(novos.map((n) => ({ contactId: n.id, valores: n.identifiers.map((i) => i.valor) })));
    await safeEnrollManyByTrigger(
      "contact_created",
      novos.map((n) => n.id),
      opts.emLote ? { emLote: true } : {},
    );
  }
  return resultados;
}
