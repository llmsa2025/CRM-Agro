import { randomUUID } from "node:crypto";
import type { ImportJob, Prisma } from "@prisma/client";
import { db, getCurrentTeamId, getCurrentUserId, tenantData, TenantContextRequiredError } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { whereDoEscopo, type UsoDoEscopo } from "../tenancy/escopo";
import { publishRealtime } from "../events/redis-bus";
import { deleteMedia, storageEnabled, StorageNaoConfigurado, uploadMedia } from "../storage/service";
import { enfileirarImportacao } from "./fila";
import { lerPlanilha, validarMapeamento, type LinhaRecusada } from "./planilha";
import { mapeamentoSchema, opcoesImportacaoSchema } from "./schema";
import { ImportJobNotFound, MapeamentoInvalido } from "./errors";

/**
 * Importação de contatos em 4 passos (produto §C) — o job.
 *
 * `commitImport` não grava contato nenhum: sobe a planilha para o Storage
 * PRIVADO (`imports/<teamId>/<id>.csv`), cria o `ImportJob` e enfileira a fila
 * `import`. O worker (`processarImportacao`) faz o resto em blocos. Assim uma
 * planilha de 10 mil linhas não segura a requisição web.
 */

export type ImportJobDTO = {
  id: string;
  status: ImportJob["status"];
  nomeArquivo: string;
  total: number;
  processadas: number;
  criadas: number;
  /** Já existiam (completados quando `existentes = "completar"`). */
  atualizadas: number;
  /** Repetidas na planilha (unidas à 1ª linha). */
  puladas: number;
  invalidas: number;
  /** Amostra das linhas recusadas. */
  erros: LinhaRecusada[];
  createdAt: string;
  iniciadoEm: string | null;
  concluidoEm: string | null;
};

export function importJobDTO(j: ImportJob): ImportJobDTO {
  return {
    id: j.id,
    status: j.status,
    nomeArquivo: j.nomeArquivo,
    total: j.total,
    processadas: j.processadas,
    criadas: j.criadas,
    atualizadas: j.atualizadas,
    puladas: j.puladas,
    invalidas: j.invalidas,
    erros: Array.isArray(j.erros) ? (j.erros as LinhaRecusada[]) : [],
    createdAt: j.createdAt.toISOString(),
    iniciadoEm: j.iniciadoEm?.toISOString() ?? null,
    concluidoEm: j.concluidoEm?.toISOString() ?? null,
  };
}

/** Evento de tempo real do andamento (a tela do passo 4 escuta). */
export function publicarProgresso(j: ImportJob): void {
  publishRealtime(
    {
      type: "import:progress",
      importJobId: j.id,
      status: j.status,
      total: j.total,
      processadas: j.processadas,
      criadas: j.criadas,
      atualizadas: j.atualizadas,
      puladas: j.puladas,
      invalidas: j.invalidas,
    },
    j.teamId,
  );
}

/** Pasta do time no Storage privado: o worker só lê arquivo daqui. */
export function pastaDoTime(teamId: string): string {
  return `imports/${teamId}/`;
}

/**
 * Passo 4 ("Importar"): grava a planilha e enfileira. `mapeamento`/`opcoes`
 * chegam como vieram do cliente — o zod valida aqui.
 */
export async function commitImport(input: {
  texto: string;
  nomeArquivo: string;
  mapeamento: unknown;
  opcoes?: unknown;
}): Promise<ImportJobDTO> {
  requireCan("contacts.import");
  const prisma = db();
  const teamId = getCurrentTeamId();
  if (!teamId) throw new TenantContextRequiredError("commitImport", "ImportJob");
  const planilha = lerPlanilha(input.texto);
  const mapeamento = mapeamentoSchema.parse(input.mapeamento);
  validarMapeamento(planilha.colunas, mapeamento);
  if (!mapeamento.includes("nome")) throw new MapeamentoInvalido("escolha a coluna do nome");
  const opcoes = opcoesImportacaoSchema.parse(input.opcoes ?? {});
  if (!storageEnabled()) throw new StorageNaoConfigurado();

  const id = randomUUID();
  const arquivoPath = `${pastaDoTime(teamId)}${id}.csv`;
  await uploadMedia(arquivoPath, new TextEncoder().encode(input.texto), "text/csv; charset=utf-8");
  let criado = false;
  try {
    const job = await prisma.importJob.create({
      data: tenantData<Prisma.ImportJobUncheckedCreateInput>({
        id,
        nomeArquivo: input.nomeArquivo.slice(0, 200) || "planilha.csv",
        arquivoPath,
        mapeamento: mapeamento as Prisma.InputJsonValue,
        opcoes: opcoes as Prisma.InputJsonValue,
        total: planilha.linhas.length,
        createdById: getCurrentUserId(),
      }),
    });
    criado = true;
    await enfileirarImportacao({ teamId, importJobId: id });
    publicarProgresso(job);
    return importJobDTO(job);
  } catch (e) {
    // Sem fila (ou sem banco): o arquivo não fica órfão no Storage.
    await deleteMedia(arquivoPath);
    if (criado) {
      await prisma.importJob.update({
        where: { id },
        data: { status: "failed", arquivoPath: null, concluidoEm: new Date(), erros: [{ linha: 0, motivo: "fila indisponível" }] },
      });
    }
    throw e;
  }
}

/**
 * Escopo por dono (auditoria de isolamento 09/2026): a importação é de quem
 * subiu a planilha — o tempo real do andamento já ia só para ela (e para quem
 * vê tudo), mas a lista, o detalhe e o "cancelar" eram do time inteiro: um
 * vendedor via o nome do arquivo e cancelava a importação do colega.
 */
function escopoImportacao(uso: UsoDoEscopo = {}): Prisma.ImportJobWhereInput {
  // A importação é de Contatos: o "ver tudo" (e o "editar", para cancelar) que vale é o dessa tela.
  return whereDoEscopo("contatos", "createdById", { escrita: uso.escrita }) as Prisma.ImportJobWhereInput;
}

export async function getImportJob(id: string): Promise<ImportJobDTO> {
  const prisma = db();
  const job = await prisma.importJob.findFirst({ where: { AND: [{ id }, escopoImportacao()] } });
  if (!job) throw new ImportJobNotFound(id);
  return importJobDTO(job);
}

/** Importações recentes de quem pede (a tela acha a que está rodando depois de recarregar). */
export async function listImportJobs(limit = 10): Promise<ImportJobDTO[]> {
  const prisma = db();
  const jobs = await prisma.importJob.findMany({
    where: escopoImportacao(),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(Math.trunc(limit), 1), 50),
  });
  return jobs.map(importJobDTO);
}

/**
 * Cancela: na fila ou rodando → `canceled`. O worker para ENTRE blocos (o bloco
 * em andamento termina) e apaga o arquivo. Já terminada → devolve como está.
 */
export async function cancelImport(id: string): Promise<ImportJobDTO> {
  requireCan("contacts.import");
  const prisma = db();
  const escopo = escopoImportacao({ escrita: true }); // cancelar a do colega pede "Ver e editar"
  await prisma.importJob.updateMany({
    where: { AND: [{ id, status: { in: ["queued", "processing"] } }, escopo] },
    data: { status: "canceled", concluidoEm: new Date() },
  });
  const job = await prisma.importJob.findFirst({ where: { AND: [{ id }, escopo] } });
  if (!job) throw new ImportJobNotFound(id);
  if (job.status === "canceled") publicarProgresso(job);
  return importJobDTO(job);
}
