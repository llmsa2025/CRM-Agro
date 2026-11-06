/**
 * Substitui o `as never` nos writes tenant-scoped.
 *
 * A extensão de tenancy injeta `teamId` em runtime (ver ./tenant), mas os tipos
 * do Prisma continuam exigindo `teamId` no `data` de create/createMany. O `as
 * never` que se usava pra contornar isso desligava a checagem de TODOS os campos
 * — um typo de campo, um enum errado ou um campo inexistente passavam batido.
 *
 * `tenantData` tipa o input como o *CreateInput do model SEM `teamId`, então o
 * compilador volta a validar todos os outros campos e só libera a ausência de
 * teamId (que a extensão preenche).
 *
 * Uso:
 *   prisma.contact.create({ data: tenantData<Prisma.ContactUncheckedCreateInput>({ nome }) })
 *   prisma.x.createMany({ data: rows.map(tenantData<Prisma.XCreateManyInput>) })
 */
export function tenantData<T>(data: Omit<T, "teamId">): T {
  return data as T;
}
