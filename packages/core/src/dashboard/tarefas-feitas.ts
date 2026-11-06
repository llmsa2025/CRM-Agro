import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db, SYSTEM_USER_ID, tenantData, type TenantPrismaClient } from "@crmagro/db";
import { ForbiddenError, requireCan, type Actor } from "../auth/authz";
import { zonedParts } from "../motor-do-dia/tz";

/**
 * Tarefas do dia com estado "feita" (produto §F).
 *
 * A lista do dia é DERIVADA (deal parado, lead sem 1º toque, follow-up vencido):
 * não existe linha de "tarefa" no banco. Marcar como feita grava só uma chave
 * `"<kind>:<id>:<YYYY-MM-DD>"` por usuário em `DailyTaskState`, com o dia no
 * FUSO DO TIME. A lista esconde o que casa com a chave de hoje; amanhã a chave
 * é outra, então a tarefa volta sozinha se a condição ainda valer (o deal
 * continua parado, o lead continua sem toque).
 *
 * A marca é POR USUÁRIO: um vendedor marcar "feita" não some da lista do
 * colega. O `id` dentro da chave não é FK (a tarefa não existe como linha): uma
 * chave com id de outro time só esconderia, na lista do próprio usuário, um item
 * que ele nunca veria. A retenção (core/retencao) apaga marcas com mais de 30 dias.
 */

export const KINDS_DIA = ["deal_parado", "lead_sem_toque", "followup_vencido"] as const;
export type KindDia = (typeof KINDS_DIA)[number];

/** Ids marcados como feitos no dia, por tipo de tarefa. */
export type IdsFeitos = Record<KindDia, string[]>;

export type TarefaFeitaDTO = { chave: string; feitoEm: Date };

/** Chave que não segue `"<kind>:<id>:<YYYY-MM-DD>"`. */
export class ChaveDeTarefaInvalida extends Error {
  constructor(chave: string) {
    super(`Chave de tarefa inválida: ${chave.slice(0, 80)}`);
    this.name = "ChaveDeTarefaInvalida";
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Dia-calendário ("YYYY-MM-DD") de `agora` no fuso do time. */
export function diaNoFuso(tz: string, agora: Date = new Date()): string {
  const p = zonedParts(agora, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function chaveDaTarefa(kind: KindDia, id: string, dia: string): string {
  return `${kind}:${id}:${dia}`;
}

// Os ids do sistema são uuid; o padrão aceita qualquer id sem ":" (a chave é
// separada por ":") e com tamanho limitado, para não guardar lixo do cliente.
const chaveSchema = z
  .string()
  .regex(new RegExp(`^(${KINDS_DIA.join("|")}):[A-Za-z0-9_-]{1,64}:\\d{4}-\\d{2}-\\d{2}$`));

function validarChave(chave: unknown): string {
  const r = chaveSchema.safeParse(chave);
  if (!r.success) throw new ChaveDeTarefaInvalida(String(chave));
  return r.data;
}

/** Marca é de uma PESSOA: o sistema (motor, jobs) não marca tarefa de ninguém. */
function atorHumano(): Actor {
  const ator = requireCan("tasks.write");
  if (ator.system || ator.userId === SYSTEM_USER_ID) {
    throw new ForbiddenError("Tarefa do dia é marcada por um usuário, não pelo sistema");
  }
  return ator;
}

/**
 * Marca a tarefa como feita para o usuário da sessão. Idempotente: marcar de
 * novo (clique duplo, duas abas) não duplica nem muda o `feitoEm` da 1ª vez —
 * `createMany` + `skipDuplicates` vira `ON CONFLICT DO NOTHING` na unique
 * `(teamId, userId, chave)`, sem corrida entre ler e gravar.
 */
export async function markTaskDone(chave: string): Promise<TarefaFeitaDTO> {
  const prisma = db();
  const ator = atorHumano();
  const c = validarChave(chave);
  await prisma.dailyTaskState.createMany({
    data: [tenantData<Prisma.DailyTaskStateCreateManyInput>({ userId: ator.userId, chave: c })],
    skipDuplicates: true,
  });
  return prisma.dailyTaskState.findFirstOrThrow({
    where: { userId: ator.userId, chave: c },
    select: { chave: true, feitoEm: true },
  });
}

/** Desfaz a marca (a tarefa volta para a lista de hoje). Sem marca → `desfeita: false`. */
export async function undoTaskDone(chave: string): Promise<{ desfeita: boolean }> {
  const prisma = db();
  const ator = atorHumano();
  const c = validarChave(chave);
  const { count } = await prisma.dailyTaskState.deleteMany({ where: { userId: ator.userId, chave: c } });
  return { desfeita: count > 0 };
}

/**
 * Ids que `userId` marcou como feitos em `dia`, por tipo. Leitura pura (usada
 * pela lista do dia); o time vem do client tenant.
 */
export async function idsFeitosNoDia(prisma: TenantPrismaClient, userId: string, dia: string): Promise<IdsFeitos> {
  const linhas = await prisma.dailyTaskState.findMany({
    where: { userId, chave: { endsWith: `:${dia}` } },
    select: { chave: true },
  });
  const ids: IdsFeitos = { deal_parado: [], lead_sem_toque: [], followup_vencido: [] };
  for (const { chave } of linhas) {
    const [kind, id] = chave.split(":");
    if (kind && id && (KINDS_DIA as readonly string[]).includes(kind)) ids[kind as KindDia].push(id);
  }
  return ids;
}
