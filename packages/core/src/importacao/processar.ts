import type { ImportJob, Prisma } from "@prisma/client";
import { db, getCurrentTeamId, tenantData, type TenantPrismaClient } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { createCompanyForContact } from "../companies/service";
import { completarCpfSeVazio } from "../contacts/cpf";
import { reconcileHistoryOnCreateMany, writeContactsEmLote } from "../contacts/write";
import { valorDe } from "../contacts/identificadores-cifra";
import { safeEnrollManyByTrigger } from "../flows/triggers";
import { logger } from "../logger/index";
import { somarTagsEmLote } from "../tags/do-contato";
import { redisEstado } from "../shared/redis-cache";
import { baixarArquivo, deleteMedia } from "../storage/service";
import type { ImportacaoJob } from "./fila";
import { pastaDoTime, publicarProgresso } from "./jobs";
import { lerPlanilha, montarRegistros, type LinhaRecusada, type Registro } from "./planilha";
import { mapeamentoSchema, opcoesImportacaoSchema, type OpcoesImportacao } from "./schema";
import { acharExistentes, existenteDe } from "./service";
import { deOutroResponsavel, quemAge } from "../contacts/responsavel";

/**
 * Worker da importação (fila `import`, produto §C). Roda em `runAsSystem(teamId)`.
 *
 * - UMA importação por time por vez (trava `import:trava:<teamId>` no Redis);
 *   outra do mesmo time → "ocupado" e o worker reagenda o job.
 * - Planilha lida do Storage privado — só de `imports/<teamId>/`.
 * - Mesmas regras da prévia (`planilha.ts`); linhas recusadas e repetidas já
 *   entram contadas antes do 1º bloco.
 * - Blocos de 500: novos por `writeContactsEmLote` (caminho canônico em lote,
 *   com `contact_created` em lote — MF-13); existentes COMPLETADOS (só campo
 *   vazio, tags somadas, identificador que faltava).
 * - Progresso gravado e publicado (`import:progress`) a cada bloco. Retentativa
 *   do BullMQ retoma do último bloco concluído (o que a tentativa anterior já
 *   tinha criado no bloco refeito conta como criado e recebe o gatilho).
 * - Cancelar vale ENTRE blocos.
 */

export const BLOCO_IMPORTACAO = 500;
/** Linhas recusadas guardadas no job (a tela mostra a amostra; o total está em `invalidas`). */
const MAX_ERROS_GUARDADOS = 500;
const TRAVA_MS = 10 * 60_000;

export type DesfechoImportacao = "concluido" | "cancelado" | "ocupado" | "nao_encontrado" | "falhou";

const chaveTrava = (teamId: string) => `import:trava:${teamId}`;

async function travar(teamId: string, jobId: string): Promise<boolean> {
  const r = redisEstado();
  const ok = await r.set(chaveTrava(teamId), jobId, "PX", TRAVA_MS, "NX");
  if (ok === "OK") return true;
  // Retentativa do MESMO job (a trava ficou do processo que caiu): segue.
  return (await r.get(chaveTrava(teamId))) === jobId;
}

/**
 * Renova só se a trava ainda for DESTE job (compare-and-set): se ela expirou e
 * outro job do time a pegou, estender a dele deixaria os dois rodando juntos.
 * Perdeu a trava → para (o BullMQ tenta de novo, retomando do último bloco).
 */
async function renovarTrava(teamId: string, jobId: string): Promise<void> {
  const ok = await redisEstado().eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
    1,
    chaveTrava(teamId),
    jobId,
    String(TRAVA_MS),
  );
  if (ok !== 1) throw new TravaDaImportacaoPerdida(teamId);
}

/** A trava do time passou para outro job (este demorou demais num bloco). */
export class TravaDaImportacaoPerdida extends Error {
  constructor(teamId: string) {
    super(`TravaDaImportacaoPerdida: outra importação do time ${teamId} assumiu a vez`);
    this.name = "TravaDaImportacaoPerdida";
  }
}

/** Solta só se ainda for deste job (compare-and-delete). */
async function soltar(teamId: string, jobId: string): Promise<void> {
  try {
    await redisEstado().eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      chaveTrava(teamId),
      jobId,
    );
  } catch {
    /* expira sozinha */
  }
}

export async function processarImportacao(job: ImportacaoJob): Promise<DesfechoImportacao> {
  const { teamId, importJobId } = job;
  const prisma = db();
  // O job carrega o time; o contexto (runAsSystem) tem de ser o mesmo.
  if (getCurrentTeamId() !== teamId) return "nao_encontrado";
  if (!(await travar(teamId, importJobId))) return "ocupado";
  try {
    const atual = await prisma.importJob.findUnique({ where: { id: importJobId } });
    if (!atual) return "nao_encontrado";
    if (atual.status === "done") return "concluido";
    if (atual.status === "failed") return "falhou";
    if (atual.status === "canceled") return encerrarCancelado(prisma, atual);
    if (!atual.arquivoPath || !atual.arquivoPath.startsWith(pastaDoTime(teamId))) {
      await falhar(prisma, atual, "arquivo fora da pasta do time");
      return "falhou";
    }

    const texto = new TextDecoder().decode(await baixarArquivo(atual.arquivoPath));
    const planilha = lerPlanilha(texto);
    const mapeamento = mapeamentoSchema.parse(atual.mapeamento);
    const opcoes = opcoesImportacaoSchema.parse(atual.opcoes);
    const { registros, invalidas, repetidas } = montarRegistros(planilha, mapeamento);

    // Recusadas e repetidas entram contadas logo no começo (1ª execução).
    const jaContadas = invalidas.length + repetidas.length;
    let j: ImportJob = atual;
    if (atual.processadas === 0) {
      j = await prisma.importJob.update({
        where: { id: importJobId },
        data: {
          status: "processing",
          iniciadoEm: atual.iniciadoEm ?? new Date(),
          total: planilha.linhas.length,
          processadas: jaContadas,
          puladas: repetidas.length,
          invalidas: invalidas.length,
          erros: invalidas.slice(0, MAX_ERROS_GUARDADOS) as unknown as Prisma.InputJsonValue,
        },
      });
      publicarProgresso(j);
    } else if (atual.status !== "processing") {
      j = await prisma.importJob.update({ where: { id: importJobId }, data: { status: "processing" } });
    }

    // Retomada: pula os blocos já concluídos. O bloco que caiu no meio é refeito
    // — e o que ele já tinha criado é reconhecido como "desta importação"
    // (`retomarCriadosAntes`), não como "já existia".
    const inicio = Math.max(0, j.processadas - jaContadas);
    const retomada = atual.status === "processing";
    for (let i = inicio; i < registros.length; i += BLOCO_IMPORTACAO) {
      const estado = await prisma.importJob.findUnique({ where: { id: importJobId }, select: { status: true } });
      if (estado?.status === "canceled") return encerrarCancelado(prisma, j);
      await renovarTrava(teamId, importJobId);

      const bloco = registros.slice(i, i + BLOCO_IMPORTACAO);
      const desde = retomada && i === inicio ? j.iniciadoEm : null;
      // F3: os contatos importados são de quem subiu a planilha (o worker é sistema).
      const r = await importarBloco(prisma, bloco, opcoes, desde, j.createdById ?? null);
      const errosAtuais = Array.isArray(j.erros) ? (j.erros as LinhaRecusada[]) : [];
      // As contagens entram mesmo se cancelaram durante o bloco (o bloco foi
      // gravado); o status "canceled" não é tocado aqui.
      j = await prisma.importJob.update({
        where: { id: importJobId },
        data: {
          processadas: { increment: bloco.length },
          criadas: { increment: r.criadas },
          atualizadas: { increment: r.atualizadas },
          invalidas: { increment: r.erros.length },
          ...(r.erros.length
            ? { erros: [...errosAtuais, ...r.erros].slice(0, MAX_ERROS_GUARDADOS) as unknown as Prisma.InputJsonValue }
            : {}),
        },
      });
      publicarProgresso(j);
      if (j.status === "canceled") return encerrarCancelado(prisma, j);
    }

    await deleteMedia(atual.arquivoPath);
    // Só vira "done" se ninguém cancelou depois do último bloco.
    const fim = await prisma.importJob.updateMany({
      where: { id: importJobId, status: "processing" },
      data: { status: "done", concluidoEm: new Date(), arquivoPath: null },
    });
    const final = await prisma.importJob.findUnique({ where: { id: importJobId } });
    if (!final) return "nao_encontrado";
    if (!fim.count) return encerrarCancelado(prisma, final);
    publicarProgresso(final);
    logger.info({ teamId, importJobId, criadas: final.criadas, atualizadas: final.atualizadas }, "[import] importação concluída");
    return "concluido";
  } finally {
    await soltar(teamId, importJobId);
  }
}

/** Marca a importação como falha (tentativas esgotadas no worker) e tira a planilha do Storage. */
export async function marcarImportacaoFalhou(importJobId: string, motivo: string): Promise<void> {
  const prisma = db();
  const j = await prisma.importJob.findUnique({ where: { id: importJobId } });
  if (j && (j.status === "queued" || j.status === "processing")) await falhar(prisma, j, motivo);
}

async function falhar(prisma: TenantPrismaClient, j: ImportJob, motivo: string): Promise<void> {
  const erros = Array.isArray(j.erros) ? (j.erros as LinhaRecusada[]) : [];
  // Planilha com dado pessoal não fica no Storage sem uso (LGPD).
  if (j.arquivoPath?.startsWith(pastaDoTime(j.teamId))) await deleteMedia(j.arquivoPath);
  const atualizado = await prisma.importJob.update({
    where: { id: j.id },
    data: {
      status: "failed",
      arquivoPath: null,
      concluidoEm: new Date(),
      erros: [...erros, { linha: 0, motivo: motivo.slice(0, 300) }].slice(-MAX_ERROS_GUARDADOS) as unknown as Prisma.InputJsonValue,
    },
  });
  publicarProgresso(atualizado);
}

async function encerrarCancelado(prisma: TenantPrismaClient, j: ImportJob): Promise<"cancelado"> {
  if (j.arquivoPath) await deleteMedia(j.arquivoPath);
  const final = await prisma.importJob.update({
    where: { id: j.id },
    data: { arquivoPath: null, concluidoEm: j.concluidoEm ?? new Date() },
  });
  publicarProgresso(final);
  logger.info({ importJobId: j.id, processadas: final.processadas }, "[import] importação cancelada entre blocos");
  return "cancelado";
}

/**
 * Um bloco: separa quem já existe (por WhatsApp/e-mail, no time), completa os
 * existentes e cria os novos pelo caminho canônico em lote.
 */
async function importarBloco(
  prisma: TenantPrismaClient,
  bloco: Registro[],
  opcoes: OpcoesImportacao,
  retomadaDesde: Date | null,
  ownerId: string | null,
): Promise<{ criadas: number; atualizadas: number; erros: LinhaRecusada[] }> {
  requireCan("contacts.write");
  const donos = await acharExistentes(prisma, bloco);
  let existentes: { registro: Registro; contactId: string }[] = [];
  const novos: Registro[] = [];
  for (const r of bloco) {
    const id = existenteDe(r, donos);
    if (id) existentes.push({ registro: r, contactId: id });
    else novos.push(r);
  }
  // Já cadastrado com OUTRO responsável (regra do dono, 28/09): a linha é
  // recusada — quem importa não completa nem "atualiza" o contato do colega.
  const fora = await deOutroResponsavel([...new Set(existentes.map((e) => e.contactId))], await quemAge(ownerId));
  const recusadas: LinhaRecusada[] = [];
  if (fora.size) {
    existentes = existentes.filter((e) => {
      if (!fora.has(e.contactId)) return true;
      const nome = fora.get(e.contactId);
      recusadas.push({ linha: e.registro.linha, motivo: `já cadastrado${nome ? ` com o responsável ${nome}` : " com outro responsável"}` });
      return false;
    });
  }
  const retomados = retomadaDesde ? await retomarCriadosAntes(prisma, existentes, retomadaDesde) : new Set<string>();
  // Quem a tentativa anterior criou também ganha as tags no catálogo: a queda pode ter vindo antes desse passo.
  const dosRetomados = existentes.filter((e) => retomados.has(e.contactId));
  existentes = existentes.filter((e) => !retomados.has(e.contactId));
  if (opcoes.existentes === "completar") {
    await completarExistentes(prisma, existentes);
    await acrescentarIdentificadores(prisma, existentes, donos);
    await vincularEmpresas(existentes);
    await catalogarTagsDoBloco(existentes);
  }

  const resultados = await writeContactsEmLote(
    novos.map((r) => ({
      nome: r.nome,
      sobrenome: r.sobrenome,
      empresa: r.empresa,
      cpf: r.cpf,
      cidade: r.cidade,
      estado: r.estado,
      cargo: r.cargo,
      origem: r.origem ?? opcoes.origem,
      tags: r.tags,
      identifiers: { whatsapp: r.whatsapp, email: r.email },
      provenance: { source: "importacao", actor: "human" },
    })),
    { emLote: true, ownerId },
  );
  const criadosAgora = novos.flatMap((r, i) => (resultados[i]?.created && resultados[i]?.contactId ? [{ registro: r, contactId: resultados[i]!.contactId! }] : []));
  await acrescentarIdentificadores(prisma, criadosAgora, donos); // 2º telefone, 2º e-mail e os de linhas unidas
  await vincularEmpresas(criadosAgora);
  await catalogarTagsDoBloco([...dosRetomados, ...criadosAgora]);
  let criadas = retomados.size;
  let atualizadas = existentes.length;
  const erros: LinhaRecusada[] = [...recusadas];
  resultados.forEach((res, i) => {
    if (res.created) criadas++;
    else if (res.contactId) atualizadas++; // outro processo criou no meio: já existe
    else erros.push({ linha: novos[i]!.linha, motivo: "erro" in res ? res.erro : "não gravado" });
  });
  return { criadas, atualizadas, erros };
}

/**
 * Bloco refeito depois de uma queda: contatos que ESTA importação criou na
 * tentativa anterior (proveniência "importacao" e criados depois do início do
 * job — uma importação por time por vez, então não há outra) contam como
 * criados, não como "já existiam". Se a queda foi entre gravar e disparar o
 * gatilho, eles ficariam fora do fluxo de entrada: recebem aqui o reconcile e o
 * `contact_created` — só quem ainda não tem NENHUMA inscrição num fluxo
 * `contact_created` (nada de mandar a boas-vindas duas vezes).
 */
async function retomarCriadosAntes(
  prisma: TenantPrismaClient,
  existentes: { registro: Registro; contactId: string }[],
  desde: Date,
): Promise<Set<string>> {
  if (existentes.length === 0) return new Set();
  const nossos = await prisma.contact.findMany({
    where: {
      id: { in: existentes.map((e) => e.contactId) },
      createdAt: { gte: desde },
      enrichment: { path: ["provenance", "source"], equals: "importacao" },
    },
    select: { id: true },
  });
  const ids = new Set(nossos.map((c) => c.id));
  if (ids.size === 0) return ids;
  const inscritos = await prisma.enrollment.findMany({
    where: { contactId: { in: [...ids] }, flow: { triggerType: "contact_created" } },
    select: { contactId: true },
  });
  const jaInscritos = new Set(inscritos.map((e) => e.contactId));
  const semGatilho = existentes.filter((e) => ids.has(e.contactId) && !jaInscritos.has(e.contactId));
  if (semGatilho.length) {
    await reconcileHistoryOnCreateMany(
      semGatilho.map((e) => ({ contactId: e.contactId, valores: [e.registro.whatsapp, e.registro.email].filter((v): v is string => !!v) })),
    );
    await safeEnrollManyByTrigger("contact_created", semGatilho.map((e) => e.contactId), { emLote: true });
    logger.warn({ contatos: semGatilho.length }, "[import] bloco refeito: gatilho disparado para quem a tentativa anterior criou");
  }
  return ids;
}

/**
 * Empresas da linha (uma por CNPJ ou IE): vincula cada uma ao contato, com a cidade e o estado dela. A de mesmo CNPJ
 * (ou mesma IE sem CNPJ) no time é reaproveitada e só tem os campos vazios preenchidos. Sem o nome da empresa na
 * planilha, usa o CNPJ ou "Empresa de <nome>" para não perder o dado. Falha numa empresa não derruba a linha.
 */
async function vincularEmpresas(itens: { registro: Registro; contactId: string }[]): Promise<void> {
  for (const { registro: r, contactId } of itens) {
    for (const e of r.empresas) {
      const nome = e.nome ?? r.empresa ?? (e.cnpj ? `CNPJ ${e.cnpj}` : `Empresa de ${r.nome}`);
      try {
        await createCompanyForContact(contactId, { nome, cnpj: e.cnpj, ie: e.ie, cidade: e.cidade, estado: e.estado }, "dono");
      } catch (err) {
        logger.warn({ linha: r.linha, err: err instanceof Error ? err.message : String(err) }, "[import] não deu para vincular a empresa da linha");
      }
    }
  }
}

/**
 * As tags da planilha entram no catálogo (a barra de filtro e o autocomplete de Contatos leem de lá; o campo antigo
 * já recebeu o texto). Em lote, SEM o gatilho "tag adicionada" (importar planilha não é aplicar tag à mão) e sem
 * derrubar o bloco: se falhar, o texto fica no campo antigo e o script de migração recupera depois.
 */
async function catalogarTagsDoBloco(itens: { registro: Registro; contactId: string }[]): Promise<void> {
  const comTags = itens.filter((i) => i.registro.tags.length > 0);
  if (comTags.length === 0) return;
  try {
    await somarTagsEmLote(comTags.map((i) => ({ contactId: i.contactId, nomes: i.registro.tags })));
  } catch (err) {
    logger.error(
      { contatos: comTags.length, err: err instanceof Error ? err.message : String(err) },
      "[import] falha ao levar as tags da planilha para o catálogo (o campo antigo guarda o texto)",
    );
  }
}

const CAMPOS_COMPLETAVEIS = ["sobrenome", "empresa", "cidade", "estado", "cargo"] as const;

/**
 * "Já existe · será completado": só preenche campo VAZIO, soma as tags e
 * acrescenta o WhatsApp/e-mail que o contato não tem (se não for de outro
 * contato). Nunca troca o que já está preenchido.
 */
async function completarExistentes(prisma: TenantPrismaClient, itens: { registro: Registro; contactId: string }[]): Promise<void> {
  if (itens.length === 0) return;
  const contatos = await prisma.contact.findMany({
    where: { id: { in: [...new Set(itens.map((i) => i.contactId))] } },
    select: {
      id: true,
      sobrenome: true,
      empresa: true,
      cidade: true,
      estado: true,
      cargo: true,
      tags: true,
    },
  });
  const porId = new Map(contatos.map((c) => [c.id, c]));
  const cpfs: { contactId: string; cpf: string }[] = [];
  for (const { registro: r, contactId } of itens) {
    const c = porId.get(contactId);
    if (!c) continue; // apagado no meio
    const data: Prisma.ContactUpdateInput = {};
    for (const campo of CAMPOS_COMPLETAVEIS) {
      if (!c[campo] && r[campo]) {
        data[campo] = r[campo];
        c[campo] = r[campo]!;
      }
    }
    if (r.cpf) cpfs.push({ contactId, cpf: r.cpf });
    const tagsNovas = r.tags.filter((t) => !c.tags.some((x) => x.toLowerCase() === t.toLowerCase()));
    if (tagsNovas.length) {
      c.tags = [...c.tags, ...tagsNovas];
      data.tags = c.tags;
    }
    if (Object.keys(data).length) await prisma.contact.update({ where: { id: contactId }, data });
  }
  await completarCpfSeVazio(cpfs);
}

/**
 * Soma ao contato os telefones e e-mails da linha que ele ainda não tem (o 2º telefone, o 2º e-mail e os das linhas
 * unidas). O 1º de cada canal vira o principal só se o contato não tinha nenhum. Nunca toma o que é de OUTRO contato.
 */
async function acrescentarIdentificadores(
  prisma: TenantPrismaClient,
  itens: { registro: Registro; contactId: string }[],
  donos: Map<string, string>,
): Promise<void> {
  if (itens.length === 0) return;
  const contatos = await prisma.contact.findMany({
    where: { id: { in: [...new Set(itens.map((i) => i.contactId))] } },
    select: { id: true, identifiers: { select: { canal: true, valor: true, valorCifrado: true } } },
  });
  const porId = new Map(contatos.map((c) => [c.id, c]));
  const novos: Prisma.ChannelIdentifierCreateManyInput[] = [];
  for (const { registro: r, contactId } of itens) {
    const c = porId.get(contactId);
    if (!c) continue; // apagado no meio
    const canais = new Set(c.identifiers.map((i) => i.canal));
    const tem = new Set(c.identifiers.map((i) => `${i.canal}:${valorDe(i)}`));
    for (const [canal, prefixo, valores] of [
      ["whatsapp", "w", r.whatsapps],
      ["email", "e", r.emails],
    ] as const) {
      for (const valor of valores) {
        const dono = donos.get(`${prefixo}:${valor}`);
        if (tem.has(`${canal}:${valor}`) || (dono && dono !== contactId)) continue; // já é dele, ou é de outro contato
        novos.push(tenantData<Prisma.ChannelIdentifierCreateManyInput>({ contactId, canal, valor, isPrimary: !canais.has(canal) }));
        donos.set(`${prefixo}:${valor}`, contactId);
        canais.add(canal);
      }
    }
  }
  if (novos.length) await prisma.channelIdentifier.createMany({ data: novos, skipDuplicates: true });
}
