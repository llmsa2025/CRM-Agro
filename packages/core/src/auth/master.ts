import type { Prisma } from "@prisma/client";
import { basePrisma } from "@crmagro/db";

/**
 * O MASTER do time (pedido do dono, 28/09/2026): um só por time — quem criou a
 * empresa —, guardado em `Team.masterId` e com o papel "owner". Helper ÚNICO
 * do core para saber quem é; duas perguntas diferentes:
 *
 * - `masterDefinidoDoTime`: PERMISSÃO (quem mexe em "owner" antigo, quem passa
 *   o master). Só o `Team.masterId`; time antigo sem master definido → null,
 *   e ninguém ganha poder de master (não se inventa quem é).
 * - `masterDoTime`: quem RESPONDE pelo time para receber registro sem dono
 *   (responsável padrão do contato, `contacts/responsavel.ts`). O master se
 *   estiver ativo; senão (time antigo sem master, ou master desativado) o
 *   "owner" ativo mais antigo; sem owner, o administrador ativo mais antigo;
 *   sem administrador, qualquer pessoa ativa (a mais antiga) — a mesma ordem
 *   do backfill `20260928130000_responsavel_backfill`. null = time sem ninguém.
 *
 * `teamId` sempre do contexto/servidor (nunca do cliente). Aceita o cliente de
 * uma transação.
 */
type Cliente = Prisma.TransactionClient | typeof basePrisma;

export async function masterDefinidoDoTime(teamId: string, cliente: Cliente = basePrisma): Promise<string | null> {
  const t = await cliente.team.findUnique({ where: { id: teamId }, select: { masterId: true } });
  return t?.masterId ?? null;
}

export async function masterDoTime(teamId: string, cliente: Cliente = basePrisma): Promise<string | null> {
  const t = await cliente.team.findUnique({
    where: { id: teamId },
    select: { master: { select: { id: true, teamId: true, desativadoEm: true } } },
  });
  const m = t?.master;
  if (m && m.teamId === teamId && !m.desativadoEm) return m.id;
  for (const papel of [{ role: "owner" }, { role: "admin" }, {}]) {
    const u = await cliente.user.findFirst({
      where: { teamId, desativadoEm: null, ...papel },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (u) return u.id;
  }
  return null;
}
