import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { marcasDoBanco } from "@crmagro/config";

/**
 * Papel `crmagro_sistema` (F2 do plano de CI/CD, 07/10/2026): o papel que o app e o worker usam no lugar do
 * dono do banco, para que a credencial da VPS (ou da Vercel) NÃO consiga apagar nem alterar a estrutura.
 *
 *  A) o catálogo: o papel tem só o que deve (DML nas tabelas, sem TRUNCATE, sem DDL, sem o histórico de
 *     migrations) e uma tabela nova já nasce acessível a ele. Roda em qualquer banco, sem login;
 *  B) o comportamento por LOGIN DIRETO: faz DML, enxerga todos os times (BYPASSRLS, como o dono de hoje) e é
 *     barrado em DROP, TRUNCATE, ALTER, CREATE, mexer em papel e escrever no `_prisma_migrations`.
 *
 * B conecta como `crmagro_sistema` por LOGIN DIRETO (nunca por `SET ROLE`: no Postgres 17 quem cria o papel
 * recebe ADMIN mas não SET, e o `postgres` do Supabase seria barrado). A URL vem de `DATABASE_URL_SISTEMA`
 * (modo da CI e do banco de TESTE) ou, num Postgres local, é montada aqui com uma senha de teste. Banco
 * remoto sem `DATABASE_URL_SISTEMA`: B fica pulado (nunca altera o papel de um banco remoto sozinho).
 * Cada tentativa proibida roda dentro de uma transação que sempre volta atrás, então um privilégio a mais
 * por engano falha o teste sem destruir nada. Docs: a documentação interna.
 */

const TEAM_A = "00000000-0000-0000-0000-00000005b001";
const TEAM_B = "00000000-0000-0000-0000-00000005b002";
const SENHA_TESTE = "sistema-teste-local";

/**
 * Client do DONO (DIRECT_URL), só para o que o teste faz como dono: ler o catálogo, semear, criar a tabela de
 * prova e ligar o login do papel. NÃO é o `basePrisma`: na rodada "suíte inteira como crmagro_sistema" da CI o
 * `DATABASE_URL` já é o papel limitado, e este teste precisa de um dono para comparar.
 */
const dono = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: [] });
afterAll(async () => {
  await dono.$disconnect();
});

const q = <T>(sql: string, ...params: unknown[]) => dono.$queryRawUnsafe<T[]>(sql, ...params);

/** URL do papel crmagro_sistema: a do ambiente (CI e banco de TESTE) ou, em Postgres LOCAL, uma montada com senha de teste. */
async function resolverUrlDoSistema(): Promise<string | null> {
  if (process.env.DATABASE_URL_SISTEMA) return process.env.DATABASE_URL_SISTEMA;
  const alvo = process.env.DIRECT_URL ?? "";
  if (marcasDoBanco(alvo)?.servidores.includes("loopback")) {
    await dono.$executeRawUnsafe(`ALTER ROLE crmagro_sistema LOGIN PASSWORD '${SENHA_TESTE}'`);
    const u = new URL(alvo);
    u.username = "crmagro_sistema";
    u.password = SENHA_TESTE;
    u.search = "";
    return u.toString();
  }
  return null;
}
const urlSistema = await resolverUrlDoSistema();
const comSistema = describe.skipIf(!urlSistema);

describe("A) catálogo do Postgres", () => {
  it("o papel existe, não é superusuário nem dono, não cria banco nem papel e ignora o RLS", async () => {
    const [papel] = await q<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean }>(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = 'crmagro_sistema'`,
    );
    expect(papel, "o papel crmagro_sistema não existe: falta aplicar a migration 20261010100000").toEqual({
      rolsuper: false,
      rolbypassrls: true,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
    });
    const donos = await q<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'crmagro_sistema'`);
    expect(donos, "o crmagro_sistema não pode ser dono de tabela").toEqual([]);
    const membro = await q<{ papel: string }>(
      `SELECT r.rolname AS papel FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
       WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'crmagro_sistema')`,
    );
    expect(membro, "o crmagro_sistema não pode herdar privilégio de outro papel").toEqual([]);
  });

  it("em TODA tabela de public (menos o histórico de migrations, que é só leitura): lê, insere, atualiza e apaga linha, mas não esvazia nem refere nem cria gatilho", async () => {
    const tabelas = await q<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`);
    expect(tabelas.length).toBeGreaterThan(20);
    const defeitos: string[] = [];
    for (const { t } of tabelas) {
      const [p] = await q<Record<string, boolean>>(
        `SELECT has_table_privilege('crmagro_sistema', format('public.%I', $1::text), 'SELECT') AS ler,
                has_table_privilege('crmagro_sistema', format('public.%I', $1::text), 'INSERT') AS inserir,
                has_table_privilege('crmagro_sistema', format('public.%I', $1::text), 'UPDATE') AS atualizar,
                has_table_privilege('crmagro_sistema', format('public.%I', $1::text), 'DELETE') AS apagar,
                has_table_privilege('crmagro_sistema', format('public.%I', $1::text), 'TRUNCATE') AS esvaziar,
                has_table_privilege('crmagro_sistema', format('public.%I', $1::text), 'REFERENCES') AS referir,
                has_table_privilege('crmagro_sistema', format('public.%I', $1::text), 'TRIGGER') AS gatilho`,
        t,
      );
      const esperado = { ler: true, inserir: true, atualizar: true, apagar: true, esvaziar: false, referir: false, gatilho: false };
      if (JSON.stringify(p) !== JSON.stringify(esperado)) defeitos.push(`${t}: ${JSON.stringify(p)}`);
    }
    expect(defeitos, "tabela sem os GRANTs do crmagro_sistema (ou com poder demais): confira a migration").toEqual([]);
  });

  it("o histórico de migrations (_prisma_migrations) é SÓ LEITURA para o papel (o deploy.sh e o pg_dump precisam ler)", async () => {
    const [p] = await q<{ ler: boolean; inserir: boolean; atualizar: boolean; apagar: boolean; esvaziar: boolean }>(
      `SELECT has_table_privilege('crmagro_sistema', 'public."_prisma_migrations"', 'SELECT') AS ler,
              has_table_privilege('crmagro_sistema', 'public."_prisma_migrations"', 'INSERT') AS inserir,
              has_table_privilege('crmagro_sistema', 'public."_prisma_migrations"', 'UPDATE') AS atualizar,
              has_table_privilege('crmagro_sistema', 'public."_prisma_migrations"', 'DELETE') AS apagar,
              has_table_privilege('crmagro_sistema', 'public."_prisma_migrations"', 'TRUNCATE') AS esvaziar`,
    );
    expect(p).toEqual({ ler: true, inserir: false, atualizar: false, apagar: false, esvaziar: false });
  });

  it("sequências: usa e lê, mas não reinicia valor", async () => {
    const seqs = await q<{ s: string }>(`SELECT sequencename AS s FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`);
    for (const { s } of seqs) {
      const [p] = await q<{ usar: boolean; ler: boolean; mudar: boolean }>(
        `SELECT has_sequence_privilege('crmagro_sistema', format('public.%I', $1::text), 'USAGE') AS usar,
                has_sequence_privilege('crmagro_sistema', format('public.%I', $1::text), 'SELECT') AS ler,
                has_sequence_privilege('crmagro_sistema', format('public.%I', $1::text), 'UPDATE') AS mudar`,
        s,
      );
      expect(p, s).toEqual({ usar: true, ler: true, mudar: false });
    }
  });

  it("não cria objeto no schema public", async () => {
    const [p] = await q<{ criar: boolean; usar: boolean }>(
      `SELECT has_schema_privilege('crmagro_sistema', 'public', 'CREATE') AS criar, has_schema_privilege('crmagro_sistema', 'public', 'USAGE') AS usar`,
    );
    expect(p).toEqual({ criar: false, usar: true });
  });

  it("tabela e sequência criadas por migration futura já nascem acessíveis (ALTER DEFAULT PRIVILEGES)", async () => {
    // Cria no schema public como o dono, confere os privilégios e DESFAZ (a exceção volta a transação).
    class Desfazer extends Error {}
    let visto: { ler: boolean; apagar: boolean; esvaziar: boolean; usarSeq: boolean } | null = null;
    await dono
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TABLE public.zz_papel_sistema_prova (id serial PRIMARY KEY, v text)`);
        const [r] = await tx.$queryRawUnsafe<{ ler: boolean; apagar: boolean; esvaziar: boolean; usarSeq: boolean }[]>(
          `SELECT has_table_privilege('crmagro_sistema', 'public.zz_papel_sistema_prova', 'SELECT') AS ler,
                  has_table_privilege('crmagro_sistema', 'public.zz_papel_sistema_prova', 'DELETE') AS apagar,
                  has_table_privilege('crmagro_sistema', 'public.zz_papel_sistema_prova', 'TRUNCATE') AS esvaziar,
                  has_sequence_privilege('crmagro_sistema', 'public.zz_papel_sistema_prova_id_seq', 'USAGE') AS "usarSeq"`,
        );
        visto = r ?? null;
        throw new Desfazer();
      })
      .catch((e) => {
        if (!(e instanceof Desfazer)) throw e;
      });
    expect(visto, "tabela nova sem privilégio para o crmagro_sistema: o ALTER DEFAULT PRIVILEGES da migration não vale para quem a criou").toEqual({
      ler: true,
      apagar: true,
      esvaziar: false,
      usarSeq: true,
    });
  });
});

/** Conexão do crmagro_sistema com UMA só conexão no pool (a mesma sessão serve a todas as tentativas). */
let sistema: PrismaClient;

/**
 * Roda `sql` como crmagro_sistema dentro de uma transação que SEMPRE volta atrás. Se o Postgres negar, devolve
 * a mensagem do erro; se aceitar, devolve null (e o teste falha), sem ter alterado nada.
 */
async function tentar(sql: string): Promise<string | null> {
  class Desfazer extends Error {}
  try {
    await sistema.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(sql);
      throw new Desfazer();
    });
    return null;
  } catch (e) {
    if (e instanceof Desfazer) return null;
    return e instanceof Error ? e.message : String(e);
  }
}

async function limpar() {
  for (const teamId of [TEAM_A, TEAM_B]) {
    await dono.contact.deleteMany({ where: { teamId } });
  }
}

comSistema("B) o papel crmagro_sistema no próprio Postgres", () => {
  beforeAll(async () => {
    const u = new URL(urlSistema!);
    u.searchParams.set("connection_limit", "1");
    sistema = new PrismaClient({ datasourceUrl: u.toString(), log: [] });
    await limpar();
    for (const [id, name] of [
      [TEAM_A, "Sistema A (test)"],
      [TEAM_B, "Sistema B (test)"],
    ] as const) {
      await dono.team.upsert({ where: { id }, update: {}, create: { id, name } });
    }
    await dono.contact.create({ data: { teamId: TEAM_A, nome: "Ana do A" } });
    await dono.contact.create({ data: { teamId: TEAM_B, nome: "Beto do B" } });
  });
  afterAll(async () => {
    await limpar();
    await sistema?.$disconnect();
  });

  it("conecta como crmagro_sistema, sem ser superusuário", async () => {
    const [r] = await sistema.$queryRawUnsafe<{ quem: string; super: boolean }[]>(
      `SELECT current_user::text AS quem, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`,
    );
    expect(r).toEqual({ quem: "crmagro_sistema", super: false });
  });

  it("enxerga as linhas de todos os times, sem declarar time (é o que o app faz hoje pelo dono)", async () => {
    const linhas = await sistema.$queryRawUnsafe<{ teamId: string }[]>(`SELECT "teamId" FROM "Contact" WHERE "teamId" IN ($1, $2) ORDER BY 1`, TEAM_A, TEAM_B);
    expect(linhas.map((l) => l.teamId)).toEqual([TEAM_A, TEAM_B]);
  });

  it("faz o que o app faz: inserir, atualizar, apagar, sequência, set_config e trava consultiva", async () => {
    await sistema.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO "Contact" (id, "teamId", nome, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'Carla do A', now(), now())`, TEAM_A);
      const n = await tx.$executeRawUnsafe(`UPDATE "Contact" SET nome = 'Carla do A (editada)' WHERE "teamId" = $1 AND nome = 'Carla do A'`, TEAM_A);
      expect(n).toBe(1);
      const m = await tx.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "teamId" = $1 AND nome = 'Carla do A (editada)'`, TEAM_A);
      expect(m).toBe(1);
      await tx.$queryRawUnsafe(`SELECT set_config('app.team_id', $1, true)`, TEAM_A);
      const [trava] = await tx.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT pg_try_advisory_xact_lock(424242) AS ok`);
      expect(trava!.ok).toBe(true);
    });
  });

  it("lê o histórico de migrations (para o deploy conferir pendência), mas não escreve nele", async () => {
    const [n] = await sistema.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "_prisma_migrations"`);
    expect(Number(n!.n)).toBeGreaterThan(0);
    expect(await tentar(`DELETE FROM "_prisma_migrations"`)).toMatch(/permission denied/i);
    expect(await tentar(`UPDATE "_prisma_migrations" SET logs = null`)).toMatch(/permission denied/i);
    expect(await tentar(`INSERT INTO "_prisma_migrations" (id, checksum, migration_name) VALUES ('zz', 'zz', 'zz')`)).toMatch(/permission denied/i);
  });

  it.each([
    ["TRUNCATE", `TRUNCATE TABLE "Contact"`, /permission denied/i],
    ["TRUNCATE em cascata", `TRUNCATE TABLE "Team" CASCADE`, /permission denied/i],
    ["DROP TABLE", `DROP TABLE "Contact"`, /must be owner|permission denied/i],
    ["DROP TABLE em cascata", `DROP TABLE "Team" CASCADE`, /must be owner|permission denied/i],
    ["DROP SCHEMA", `DROP SCHEMA public CASCADE`, /must be owner|permission denied/i],
    ["ALTER TABLE (coluna)", `ALTER TABLE "Contact" ADD COLUMN zz_x integer`, /must be owner|permission denied/i],
    ["ALTER TABLE (apagar coluna)", `ALTER TABLE "Contact" DROP COLUMN nome`, /must be owner|permission denied/i],
    ["desligar o RLS", `ALTER TABLE "Contact" DISABLE ROW LEVEL SECURITY`, /must be owner|permission denied/i],
    ["desligar gatilho", `ALTER TABLE "Contact" DISABLE TRIGGER ALL`, /must be owner|permission denied/i],
    ["apagar política de RLS", `DROP POLICY isolamento_por_time ON "Contact"`, /must be owner|permission denied/i],
    ["criar tabela", `CREATE TABLE public.zz_nao_pode (id int)`, /permission denied/i],
    ["criar índice", `CREATE INDEX zz_nao_pode ON "Contact" (nome)`, /must be owner|permission denied/i],
    ["criar papel", `CREATE ROLE zz_nao_pode`, /permission denied/i],
    ["dar BYPASSRLS a si", `ALTER ROLE crmagro_sistema NOBYPASSRLS`, /permission denied|must have/i],
    ["trocar a senha de outro papel", `ALTER ROLE crmagro_app PASSWORD 'zz'`, /permission denied|must have/i],
    ["apagar papel", `DROP ROLE crmagro_app`, /permission denied|must have/i],
  ])("é barrado em %s", async (_nome, sql, motivo) => {
    const erro = await tentar(sql);
    expect(erro, `o crmagro_sistema conseguiu rodar: ${sql}`).not.toBeNull();
    expect(erro!).toMatch(motivo);
  });
});
