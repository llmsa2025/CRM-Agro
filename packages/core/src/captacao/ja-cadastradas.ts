import { db } from "@crmagro/db";

/**
 * Empresas (por CNPJ) que a busca por filtro deixa de fora ANTES de contar a quantidade pedida.
 * Sempre em LOTE (uma página da fonte por vez) e por `db()`: quem chama abre o contexto do time
 * (`runAsSystem` no worker), então nunca olha outro time.
 */

/**
 * CNPJs que já estão cadastrados no time: gravados num contato (`Contact.cnpj`) ou numa empresa
 * ligada a um contato. Vale o time todo, de qualquer responsável (a mesma empresa não se cadastra
 * duas vezes).
 */
export async function cnpjsJaCadastrados(cnpjs: readonly string[]): Promise<Set<string>> {
  const achados = new Set<string>();
  const lista = [...new Set(cnpjs)];
  if (!lista.length) return achados;
  const prisma = db();
  const [doContato, daEmpresa] = await Promise.all([
    prisma.contact.findMany({ where: { cnpj: { in: lista } }, select: { cnpj: true } }),
    prisma.contactCompany.findMany({ where: { company: { cnpj: { in: lista } } }, select: { company: { select: { cnpj: true } } } }),
  ]);
  for (const c of doContato) if (c.cnpj) achados.add(c.cnpj);
  for (const c of daEmpresa) if (c.company?.cnpj) achados.add(c.company.cnpj);
  return achados;
}

/** CNPJs que já estão na fila de revisão DESTA pessoa (pendentes): não entram de novo e não contam. */
export async function cnpjsPendentesNaFila(cnpjs: readonly string[], ownerId: string | null): Promise<Set<string>> {
  const lista = [...new Set(cnpjs)];
  if (!lista.length) return new Set();
  const rows = await db().prospectDraft.findMany({
    where: { status: "pendente", ownerId, cnpj: { in: lista } },
    select: { cnpj: true },
  });
  return new Set(rows.flatMap((r) => (r.cnpj ? [r.cnpj] : [])));
}
