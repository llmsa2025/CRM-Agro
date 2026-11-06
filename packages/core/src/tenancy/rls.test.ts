import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { basePrisma, sondarBancoApp, tenantClientViaRls, tenantData, TENANT_MODELS } from "@crmagro/db";
import { marcasDoBanco } from "@crmagro/config";

/**
 * RLS no Postgres (segurança, 01/10/2026). Três camadas de prova:
 *  A) o catálogo: toda tabela do schema `public` tem RLS ligado, e toda tabela com "teamId" tem a
 *     política por time EXATAMENTE no padrão (USING e WITH CHECK pelo app.team_id, sem política extra);
 *     uma tabela nova sem política, ou com política frouxa, quebra aqui, de propósito;
 *  B) o comportamento do papel `crmagro_app` no próprio Postgres (sem passar pela extensão do app), e o
 *     isolamento em TODAS as tabelas de time;
 *  C) a extensão do app (`tenantClientViaRls`): a mesma consulta, pelo client do time, só enxerga o
 *     time dele, também dentro de transação interativa e em lote, e nunca mistura times em paralelo.
 *
 * B e C conectam como o `crmagro_app` por LOGIN DIRETO (nunca por `SET ROLE`: no Postgres 17 quem cria o
 * papel recebe ADMIN mas não SET, e o `postgres` do Supabase seria barrado). A URL vem de
 * `DATABASE_URL_APP` (modo RLS da CI e do banco de TESTE) ou, num Postgres local, é montada aqui com uma
 * senha de teste. Banco remoto sem `DATABASE_URL_APP`: B e C ficam pulados (nunca altera o papel de um
 * banco remoto sozinho). Docs: a documentação interna.
 */

const TEAM_A = "00000000-0000-0000-0000-00000005af01";
const TEAM_B = "00000000-0000-0000-0000-00000005af02";
const SENHA_TESTE = "rls-teste-local";

/** Tabelas sem "teamId" e o motivo. Qualquer outra sem "teamId" precisa ser classificada aqui. */
const SEM_TEAM_ID: Record<string, string> = {
  Team: "raiz do tenant: política pelo próprio id",
  WhatsAppNumberCheck: "cache global de número com WhatsApp",
  GeoCache: "cache global de geocodificação",
  Municipio: "lista do IBGE, só leitura para o app",
  PasswordResetToken: "só o papel dono (login/troca de senha); crmagro_app sem acesso",
  CadastroPendente: "só o papel dono (cadastro com senha); crmagro_app sem acesso",
  AlertaConfig: "alertas da plataforma (cross-time); só o papel dono, crmagro_app sem acesso",
  AlertaEnviado: "registro dos alertas da plataforma; só o papel dono, crmagro_app sem acesso",
  _prisma_migrations: "controle do Prisma; crmagro_app sem acesso",
};
const SO_PAPEL_DONO = ["PasswordResetToken", "CadastroPendente", "AlertaConfig", "AlertaEnviado", "_prisma_migrations"];

const q = <T>(sql: string, ...params: unknown[]) => basePrisma.$queryRawUnsafe<T[]>(sql, ...params);

/** URL do papel crmagro_app: a do ambiente (modo RLS) ou, em Postgres LOCAL, uma montada com senha de teste. */
async function resolverUrlDoApp(): Promise<string | null> {
  if (process.env.DATABASE_URL_APP) return process.env.DATABASE_URL_APP;
  const alvo = process.env.DATABASE_URL ?? "";
  if (marcasDoBanco(alvo)?.servidores.includes("loopback")) {
    // Trocar a senha de um papel é coisa de DONO: pelo DIRECT_URL, não pelo basePrisma (que, na rodada da CI
    // "suíte inteira como crmagro_sistema", já é o papel limitado e não pode alterar papel).
    const dono = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? alvo, log: [] });
    try {
      await dono.$executeRawUnsafe(`ALTER ROLE crmagro_app LOGIN PASSWORD '${SENHA_TESTE}'`);
    } finally {
      await dono.$disconnect();
    }
    const u = new URL(alvo);
    u.username = "crmagro_app";
    u.password = SENHA_TESTE;
    u.search = "";
    return u.toString();
  }
  return null;
}
const urlApp = await resolverUrlDoApp();
const comApp = describe.skipIf(!urlApp);

/** Client do crmagro_app com UMA só conexão no pool (a mesma conexão serve a transação seguinte: é o que expõe vazamento de set_config). */
function clienteDoApp(conexoes?: number): PrismaClient {
  const u = new URL(urlApp!);
  if (conexoes) u.searchParams.set("connection_limit", String(conexoes));
  return new PrismaClient({ datasourceUrl: u.toString(), log: [] });
}
const atrasPoolerTransacao = /[?&]pgbouncer=true/.test(urlApp ?? "");

let appUnica: PrismaClient;

/** Roda `fn` numa transação como `crmagro_app`, declarando (ou não) o time. */
async function comoApp<T>(teamId: string | null, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return appUnica.$transaction(async (tx) => {
    if (teamId) await tx.$executeRaw`SELECT set_config('app.team_id', ${teamId}, true)`;
    return fn(tx);
  });
}

async function limpar() {
  for (const teamId of [TEAM_A, TEAM_B]) {
    await basePrisma.contact.deleteMany({ where: { teamId } });
  }
}

beforeAll(async () => {
  await limpar();
  for (const [id, name] of [
    [TEAM_A, "RLS A (test)"],
    [TEAM_B, "RLS B (test)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Ana do A" } });
  await basePrisma.contact.create({ data: { teamId: TEAM_B, nome: "Beto do B" } });
});

afterAll(limpar);

describe("A) catálogo do Postgres", () => {
  it("toda tabela do schema public tem RLS ligado", async () => {
    const sem = await q<{ tabela: string }>(
      `SELECT c.relname AS tabela FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity ORDER BY 1`,
    );
    expect(sem.map((r) => r.tabela), "tabela sem RLS: crie o ENABLE ROW LEVEL SECURITY na migration").toEqual([]);
  });

  it("toda tabela com a coluna teamId tem a política por time, e são exatamente as de TENANT_MODELS", async () => {
    const comTeamId = await q<{ t: string }>(
      `SELECT c.table_name AS t FROM information_schema.columns c
       JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
       WHERE c.table_schema = 'public' AND c.column_name = 'teamId' ORDER BY 1`,
    );
    const nomes = comTeamId.map((r) => r.t);
    expect(nomes).toEqual([...TENANT_MODELS].sort());

    const comPolitica = await q<{ t: string }>(
      `SELECT tablename AS t FROM pg_policies WHERE schemaname = 'public' AND policyname = 'isolamento_por_time' AND 'crmagro_app' = ANY(roles) ORDER BY 1`,
    );
    expect(comPolitica.map((r) => r.t), "tabela com teamId sem a política isolamento_por_time").toEqual(nomes);
  });

  it("em TODA tabela de time a política é exatamente a esperada (USING e WITH CHECK pelo app.team_id) e é a única que alcança o crmagro_app", async () => {
    // Só 1 das tabelas tem linha no banco de teste, então o comportamento sozinho não pega política frouxa
    // nas outras (0 igual a 0). Aqui o predicado é conferido tabela a tabela, sem depender de dado.
    const esperado = `("teamId" = ( SELECT current_setting('app.team_id'::text, true) AS current_setting))`;
    const todas = [...TENANT_MODELS].sort();
    const politicas = await q<{ tablename: string; policyname: string; cmd: string; permissive: string; roles: string; qual: string | null; with_check: string | null }>(
      `SELECT tablename, policyname, cmd, permissive, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY 1, 2`,
      todas,
    );
    const norm = (t: string | null) => (t ?? "").replace(/\s+/g, " ").trim();
    const defeitos: string[] = [];
    for (const tabela of todas) {
      const daTabela = politicas.filter((p) => p.tablename === tabela);
      // Outra política (mesmo uma "USING (true)" esquecida) soma por OR com a do time e abre a tabela.
      if (daTabela.length !== 1 || daTabela[0]!.policyname !== "isolamento_por_time") {
        defeitos.push(`${tabela}: políticas ${daTabela.map((p) => p.policyname).join(", ") || "nenhuma"} (esperado só isolamento_por_time)`);
        continue;
      }
      const p = daTabela[0]!;
      if (p.cmd !== "ALL" || p.permissive !== "PERMISSIVE" || p.roles !== "{crmagro_app}") defeitos.push(`${tabela}: cmd/papel inesperado (${p.cmd}, ${p.permissive}, ${p.roles})`);
      if (norm(p.qual) !== esperado) defeitos.push(`${tabela}: USING fora do padrão: ${norm(p.qual)}`);
      if (norm(p.with_check) !== esperado) defeitos.push(`${tabela}: WITH CHECK fora do padrão: ${norm(p.with_check)}`);
    }
    expect(defeitos, "política de time frouxa ou diferente do padrão (docs/seguranca/rls.md)").toEqual([]);
  });

  it("toda tabela sem teamId está classificada neste teste (nada fica de fora sem decisão)", async () => {
    const todas = await q<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
    const comTeamId = new Set([...TENANT_MODELS]);
    const sobrando = todas.map((r) => r.t).filter((t) => !comTeamId.has(t) && !(t in SEM_TEAM_ID));
    expect(sobrando, "tabela nova sem teamId: classifique em SEM_TEAM_ID e escreva a política na migration").toEqual([]);
  });

  it("crmagro_app não é dono, não é superusuário e não ignora o RLS", async () => {
    const [papel] = await q<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'crmagro_app'`,
    );
    expect(papel).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const donos = await q<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'crmagro_app'`);
    expect(donos).toEqual([]);
  });

  it("crmagro_app não tem nenhum privilégio nas tabelas que só o papel dono usa", async () => {
    for (const tabela of SO_PAPEL_DONO) {
      const [r] = await q<{ ler: boolean; gravar: boolean }>(
        `SELECT has_table_privilege('crmagro_app', format('public.%I', $1::text), 'SELECT') AS ler,
                has_table_privilege('crmagro_app', format('public.%I', $1::text), 'INSERT') AS gravar`,
        tabela,
      );
      expect(r, tabela).toEqual({ ler: false, gravar: false });
    }
  });

  it("anon e authenticated (API de dados do Supabase), quando existem, não alcançam tabela nenhuma", async () => {
    const papeis = await q<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`);
    for (const { rolname } of papeis) {
      const alcancam = await q<{ t: string }>(
        `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'
         AND (has_table_privilege($1::text, format('%I.%I', schemaname, tablename), 'SELECT') OR has_table_privilege($1::text, format('%I.%I', schemaname, tablename), 'INSERT')
           OR has_table_privilege($1::text, format('%I.%I', schemaname, tablename), 'UPDATE') OR has_table_privilege($1::text, format('%I.%I', schemaname, tablename), 'DELETE'))`,
        rolname,
      );
      expect(alcancam, `${rolname} alcança tabela`).toEqual([]);
    }
  });
});

comApp("B) o papel crmagro_app no próprio Postgres", () => {
  beforeAll(() => {
    appUnica = clienteDoApp(1);
  });
  afterAll(async () => {
    await appUnica?.$disconnect();
  });

  it("conecta como crmagro_app, sem ignorar o RLS", async () => {
    const [r] = await appUnica.$queryRaw<{ papel: string; ignora: boolean }[]>`
      SELECT current_user::text AS papel, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS ignora`;
    expect(r).toEqual({ papel: "crmagro_app", ignora: false });
  });

  it("sem declarar o time, nenhuma linha passa (fecha por padrão)", async () => {
    expect(await comoApp(null, (tx) => tx.contact.count())).toBe(0);
  });

  it("declarando o time A, só enxerga o A; declarando o B, só o B", async () => {
    const a = await comoApp(TEAM_A, (tx) => tx.contact.findMany({ select: { nome: true, teamId: true } }));
    expect(a.map((c) => c.nome)).toEqual(["Ana do A"]);
    const b = await comoApp(TEAM_B, (tx) => tx.contact.findMany({ select: { nome: true, teamId: true } }));
    expect(b.map((c) => c.nome)).toEqual(["Beto do B"]);
  });

  it("o time declarado não vale na transação seguinte, MESMO na mesma conexão (set_config local)", async () => {
    // O pool tem uma conexão só: a transação seguinte reaproveita exatamente a conexão da anterior.
    const [antes] = await appUnica.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
    await comoApp(TEAM_A, (tx) => tx.contact.count());
    const [depois] = await appUnica.$queryRaw<{ pid: number; time: string | null; linhas: number }[]>`
      SELECT pg_backend_pid()::int AS pid, nullif(current_setting('app.team_id', true), '') AS time, (SELECT count(*)::int FROM "Contact") AS linhas`;
    // Atrás de pooler em modo transação o pid pode mudar; direto, tem de ser o mesmo (prova que reaproveitou).
    if (!atrasPoolerTransacao) expect(depois?.pid).toBe(antes?.pid);
    expect(depois?.time, "o app.team_id vazou para a transação seguinte da mesma conexão").toBeNull();
    expect(depois?.linhas).toBe(0);
    expect(await comoApp(null, (tx) => tx.contact.count())).toBe(0);
  });

  it("não insere linha em outro time, nem move a própria para outro time", async () => {
    await expect(
      comoApp(TEAM_A, (tx) =>
        tx.$executeRaw`INSERT INTO "Contact" ("id", "teamId", "nome", "updatedAt") VALUES (gen_random_uuid()::text, ${TEAM_B}, 'Intruso', now())`,
      ),
    ).rejects.toThrow(/row-level security|violates/i);
    await expect(
      comoApp(TEAM_A, (tx) => tx.$executeRaw`UPDATE "Contact" SET "teamId" = ${TEAM_B} WHERE "teamId" = ${TEAM_A}`),
    ).rejects.toThrow(/row-level security|violates/i);
    expect(await basePrisma.contact.count({ where: { nome: "Intruso" } })).toBe(0);
  });

  it("não altera nem apaga linha de outro time (0 linhas afetadas)", async () => {
    const mudou = await comoApp(TEAM_A, (tx) => tx.$executeRaw`UPDATE "Contact" SET "nome" = 'Sequestrado' WHERE "teamId" = ${TEAM_B}`);
    const apagou = await comoApp(TEAM_A, (tx) => tx.$executeRaw`DELETE FROM "Contact" WHERE "teamId" = ${TEAM_B}`);
    expect([mudou, apagou]).toEqual([0, 0]);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_B, nome: "Beto do B" } })).toBe(1);
  });

  it("Team: lê e atualiza só o próprio; não cria nem apaga time", async () => {
    const times = await comoApp(TEAM_A, (tx) => tx.team.findMany({ select: { id: true } }));
    expect(times.map((t) => t.id)).toEqual([TEAM_A]);
    await expect(comoApp(TEAM_A, (tx) => tx.$executeRaw`DELETE FROM "Team" WHERE "id" = ${TEAM_A}`)).rejects.toThrow(/permission denied/i);
    await expect(
      comoApp(TEAM_A, (tx) => tx.$executeRaw`INSERT INTO "Team" ("id", "name", "updatedAt") VALUES ('outro-time', 'x', now())`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("tabelas de login e cadastro: negadas ao crmagro_app", async () => {
    await expect(comoApp(TEAM_A, (tx) => tx.$queryRaw`SELECT 1 FROM "PasswordResetToken" LIMIT 1`)).rejects.toThrow(/permission denied/i);
    await expect(comoApp(TEAM_A, (tx) => tx.$queryRaw`SELECT 1 FROM "CadastroPendente" LIMIT 1`)).rejects.toThrow(/permission denied/i);
  });

  it("tabelas globais: caches liberados, Municipio só leitura", async () => {
    await expect(comoApp(TEAM_A, (tx) => tx.$queryRaw`SELECT 1 FROM "GeoCache" LIMIT 1`)).resolves.toBeDefined();
    await expect(comoApp(TEAM_A, (tx) => tx.$queryRaw`SELECT 1 FROM "WhatsAppNumberCheck" LIMIT 1`)).resolves.toBeDefined();
    await expect(comoApp(TEAM_A, (tx) => tx.$queryRaw`SELECT 1 FROM "Municipio" LIMIT 1`)).resolves.toBeDefined();
    await expect(
      comoApp(TEAM_A, (tx) => tx.$executeRaw`INSERT INTO "Municipio" ("codigoIbge", "nome", "nomeBusca", "uf", "latitude", "longitude") VALUES (-1, 'x', 'x', 'MT', 0, 0)`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("o plano de consulta do crmagro_app aplica o filtro de time em TODA tabela de time, mesmo vazia (o Postgres mostra a política vigente)", async () => {
    // Prova de comportamento que não depende de linha: se a política de uma tabela virar USING (true), o
    // filtro some do plano; se outra política entrar por OR, aparece o OR.
    const defeitos: string[] = [];
    for (const tabela of [...TENANT_MODELS].sort()) {
      const plano = await comoApp(TEAM_A, (tx) => tx.$queryRawUnsafe<Record<string, string>[]>(`EXPLAIN (COSTS OFF) SELECT 1 FROM public."${tabela}"`));
      const texto = plano.map((l) => l["QUERY PLAN"]).join("\n");
      if (!/"teamId" = /.test(texto)) defeitos.push(`${tabela}: sem filtro por teamId no plano`);
      if (/ OR /.test(texto)) defeitos.push(`${tabela}: o filtro tem OR (política extra abrindo a tabela)`);
    }
    expect(defeitos).toEqual([]);
  });

  it("ISOLAMENTO EM TODAS AS TABELAS DE TIME (por dado, nas tabelas que têm linha): sem time ou com time inexistente, zero linha; com time, igual ao que o dono vê dele", async () => {
    const tabelas = [...TENANT_MODELS].sort();
    expect(tabelas.length).toBeGreaterThan(40);
    const contagem = (tx: Prisma.TransactionClient, onde: string) =>
      tx.$queryRawUnsafe<{ tabela: string; n: number }[]>(
        tabelas.map((t) => `SELECT '${t}' AS tabela, count(*)::int AS n FROM public."${t}"${onde}`).join(" UNION ALL ") + " ORDER BY 1",
      );
    const soma = (linhas: { n: number }[]) => linhas.reduce((acc, l) => acc + l.n, 0);

    // (a) sem time declarado e com um time que não existe: nenhuma linha em nenhuma tabela.
    expect(soma(await comoApp(null, (tx) => contagem(tx, "")))).toBe(0);
    expect(soma(await comoApp("time-que-nao-existe-rls-teste", (tx) => contagem(tx, "")))).toBe(0);

    // (b) paridade por time: o que o papel vê com o time declarado é EXATAMENTE o que o dono vê daquele time.
    const times = await q<{ id: string }>(`SELECT DISTINCT "teamId" AS id FROM "Contact" ORDER BY 1 LIMIT 10`);
    expect(times.length).toBeGreaterThanOrEqual(2);
    for (const { id } of times) {
      const dono = await q<{ tabela: string; n: number }>(
        tabelas.map((t) => `SELECT '${t}' AS tabela, count(*)::int AS n FROM public."${t}" WHERE "teamId" = '${id.replace(/'/g, "''")}'`).join(" UNION ALL ") + " ORDER BY 1",
      );
      const app = await comoApp(id, (tx) => contagem(tx, ""));
      expect(app, `o papel não vê o mesmo que o dono para o time ${id}`).toEqual(dono);
    }

    // (c) declarando o time A, as linhas do time B ficam invisíveis em toda tabela (WHERE explícito do outro time).
    expect(soma(await comoApp(TEAM_A, (tx) => contagem(tx, ` WHERE "teamId" = '${TEAM_B}'`)))).toBe(0);
  });
});

comApp("C) a extensão do app (client do time pelo papel crmagro_app)", () => {
  let app: PrismaClient;
  let a: ReturnType<typeof tenantClientViaRls>;
  let b: ReturnType<typeof tenantClientViaRls>;

  beforeAll(() => {
    app = clienteDoApp();
    a = tenantClientViaRls(app, TEAM_A);
    b = tenantClientViaRls(app, TEAM_B);
  });
  afterAll(async () => {
    await app?.$disconnect();
  });

  it("consulta avulsa: cada time só vê o seu; sem o time declarado, zero", async () => {
    expect((await a.contact.findMany()).map((c) => c.nome)).toEqual(["Ana do A"]);
    expect((await b.contact.findMany()).map((c) => c.nome)).toEqual(["Beto do B"]);
    expect(await app.contact.count()).toBe(0);
  });

  it("escrita avulsa grava no time do client", async () => {
    const c = await a.contact.create({ data: tenantData<Prisma.ContactUncheckedCreateInput>({ nome: "Nova do A" }) });
    expect(c.teamId).toBe(TEAM_A);
    expect(await basePrisma.contact.count({ where: { id: c.id, teamId: TEAM_A } })).toBe(1);
  });

  it("transação interativa: enxerga o que acabou de gravar, desfaz no erro e só vê o próprio time", async () => {
    class Desfaz extends Error {}
    await expect(
      a.$transaction(async (tx) => {
        const c = await tx.contact.create({ data: tenantData<Prisma.ContactUncheckedCreateInput>({ nome: "Só dentro da transação" }) });
        const lido = await tx.contact.findUnique({ where: { id: c.id } });
        expect(lido?.nome).toBe("Só dentro da transação");
        throw new Desfaz();
      }),
    ).rejects.toBeInstanceOf(Desfaz); // (não por texto: a mensagem de erro do Prisma cita o código do teste)
    expect(await basePrisma.contact.count({ where: { nome: "Só dentro da transação" } })).toBe(0);
    const vistos = await a.$transaction(async (tx) => tx.contact.findMany());
    expect(vistos.every((c) => c.teamId === TEAM_A)).toBe(true);
  });

  it("transação em lote: devolve só os resultados das operações (sem o do set_config)", async () => {
    const [total, linhas] = await a.$transaction([a.contact.count(), a.contact.findMany()]);
    expect(total).toBe(linhas.length);
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.every((c) => c.teamId === TEAM_A)).toBe(true);
  });

  it("SQL cru pelo client do time também passa pelo filtro do Postgres", async () => {
    const avulso = await a.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Contact"`;
    expect(avulso[0]?.n).toBe(await a.contact.count());
    const dentro = await a.$transaction(async (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Contact"`);
    expect(dentro[0]?.n).toBe(avulso[0]?.n);
  });

  it("trocar o time de um registro continua recusado", async () => {
    const ana = await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM_A, nome: "Ana do A" } });
    await expect(a.contact.update({ where: { id: ana.id }, data: { teamId: TEAM_B } })).rejects.toThrow();
  });

  it("consultas em paralelo dos dois times nunca se misturam", async () => {
    const resultados = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b).contact.findMany()));
    resultados.forEach((linhas, i) => {
      const esperado = i % 2 ? TEAM_A : TEAM_B;
      expect(linhas.length).toBeGreaterThan(0);
      expect(linhas.every((c) => c.teamId === esperado)).toBe(true);
    });
  });

  it("set_config é LOCAL à transação: com UMA conexão no pool, o time do client A não vaza para o B nem para quem não declara", async () => {
    const unica = clienteDoApp(1);
    try {
      const ua = tenantClientViaRls(unica, TEAM_A);
      const ub = tenantClientViaRls(unica, TEAM_B);
      // Alterna A, B, sem time, A, B... sempre na mesma conexão (connection_limit=1), avulsa e em transação.
      for (let i = 0; i < 6; i++) {
        expect((await ua.contact.findMany()).every((c) => c.teamId === TEAM_A)).toBe(true);
        expect((await ub.$transaction(async (tx) => tx.contact.findMany())).every((c) => c.teamId === TEAM_B)).toBe(true);
        expect(await unica.contact.count(), "uma consulta SEM time declarado enxergou linhas: o time do client anterior vazou").toBe(0);
        const [resto] = await unica.$queryRaw<{ time: string | null }[]>`SELECT nullif(current_setting('app.team_id', true), '') AS time`;
        expect(resto?.time).toBeNull();
      }
      // Rajada concorrente dos dois times disputando a conexão única: a fila do pool serializa sem misturar.
      const rajada = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? ua : ub).contact.findMany()));
      rajada.forEach((linhas, i) => expect(linhas.every((c) => c.teamId === (i % 2 ? TEAM_A : TEAM_B))).toBe(true));
    } finally {
      await unica.$disconnect();
    }
  });
});

describe("D) a sonda do pool do app (check rls do /api/health e conferência do boot)", () => {
  it("sondarBancoApp reflete o modo: sem DATABASE_URL_APP fica inativa; com ela, o papel é crmagro_app, não ignora RLS e passa", async () => {
    const sonda = await sondarBancoApp();
    if (!process.env.DATABASE_URL_APP) expect(sonda).toEqual({ ativo: false });
    else expect(sonda).toEqual({ ativo: true, ok: true, papel: "crmagro_app" });
  });
});
