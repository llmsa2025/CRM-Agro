import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Papel `evolution` e schema `evolution_api` (banco do WhatsApp no projeto do CRM Agro). Catálogo do Postgres, como o
 * dono: o papel é limitado, enxerga só o schema dele, e o `crmagro_sistema` (app e worker) não enxerga o dele.
 * Migration 20261012190000. Roteiro: a documentação interna.
 */
const dono = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: [] });
afterAll(async () => {
  await dono.$disconnect();
});
const q = <T>(sql: string, ...params: unknown[]) => dono.$queryRawUnsafe<T[]>(sql, ...params);

describe("papel evolution", () => {
  it("existe e é limitado: sem superusuário, sem criar banco ou papel, sem replicação, sem ignorar o RLS", async () => {
    const [papel] = await q<Record<string, boolean>>(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'evolution'`,
    );
    expect(papel, "o papel evolution não existe: falta aplicar a migration 20261012190000").toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    });
  });

  it("tem USAGE e CREATE no schema evolution_api, que ninguém mais (PUBLIC) alcança", async () => {
    const [s] = await q<{ usage: boolean; criar: boolean; publico: boolean }>(
      `SELECT has_schema_privilege('evolution', 'evolution_api', 'USAGE') AS usage,
              has_schema_privilege('evolution', 'evolution_api', 'CREATE') AS criar,
              has_schema_privilege('public', 'evolution_api', 'USAGE') AS publico`,
    );
    expect(s).toEqual({ usage: true, criar: true, publico: false });
  });

  it("não tem privilégio em nenhuma tabela do CRM Agro (schema public)", async () => {
    const [r] = await q<{ total: bigint; acessiveis: bigint }>(
      `SELECT count(*)::bigint AS total,
              count(*) FILTER (WHERE has_table_privilege('evolution', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))::bigint AS acessiveis
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    );
    expect(Number(r?.total)).toBeGreaterThan(0);
    expect(Number(r?.acessiveis)).toBe(0);
  });

  it("não cria objeto no schema public", async () => {
    const [r] = await q<{ criar: boolean }>(`SELECT has_schema_privilege('evolution', 'public', 'CREATE') AS criar`);
    expect(r?.criar).toBe(false);
  });

  it("o search_path do papel aponta para evolution_api", async () => {
    const [r] = await q<{ config: string[] | null }>(
      `SELECT rolconfig AS config FROM pg_roles WHERE rolname = 'evolution'`,
    );
    expect(r?.config).toContain("search_path=evolution_api");
  });
});

describe("o app não enxerga o schema do WhatsApp", () => {
  it("crmagro_sistema não tem USAGE em evolution_api", async () => {
    const [r] = await q<{ usage: boolean }>(`SELECT has_schema_privilege('crmagro_sistema', 'evolution_api', 'USAGE') AS usage`);
    expect(r?.usage).toBe(false);
  });
});
