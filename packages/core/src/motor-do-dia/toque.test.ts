import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { basePrisma, db } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { CHAVE_COMPROVADA } from "../calls/comprovacao";
import {
  CHAVE_LIGACAO_FORA_DO_CRMAGRO,
  TIPOS_DE_TOQUE,
  sqlToqueDeSaida,
  whereContatoAbordado,
  whereToqueDeSaida,
} from "./toque";

/**
 * Fonte única do toque (F1A-03). Três blocos:
 * 1. a FORMA dos filtros (sem banco);
 * 2. a regra aplicada a uma matriz de Activity (tipo × direção × meta), conferida contra um predicado escrito à mão,
 *    com o filtro Prisma e o SQL cru dando o MESMO conjunto;
 * 3. dois times pelo `db()` do tenant.
 */

describe("forma dos filtros (sem banco)", () => {
  it("nomes das chaves e dos canais que a tela e as outras tarefas esperam", () => {
    expect(CHAVE_COMPROVADA).toBe("comprovada");
    expect(CHAVE_LIGACAO_FORA_DO_CRMAGRO).toBe("ligacaoForaDoCrmAgro");
    expect([...TIPOS_DE_TOQUE]).toEqual(["whatsapp", "email", "call"]);
  });

  it("whereToqueDeSaida: saída de WhatsApp e e-mail, ou ligação com comprovada = true", () => {
    expect(whereToqueDeSaida()).toEqual({
      direcao: "out",
      OR: [
        { tipo: { in: ["whatsapp", "email"] } },
        { tipo: "call", meta: { path: ["comprovada"], equals: true } },
      ],
    });
  });

  it("whereContatoAbordado: qualquer saída de toque, ou a anotação de ligação fora do CRM Agro", () => {
    expect(whereContatoAbordado()).toEqual({
      OR: [
        { direcao: "out", tipo: { in: ["whatsapp", "email", "call"] } },
        { tipo: "note", meta: { path: ["ligacaoForaDoCrmAgro"], equals: true } },
      ],
    });
  });

  it("os filtros são objetos novos a cada chamada (quem os recebe pode mexer sem sujar os outros)", () => {
    expect(whereToqueDeSaida()).not.toBe(whereToqueDeSaida());
    expect(whereContatoAbordado()).not.toBe(whereContatoAbordado());
  });

  it("sqlToqueDeSaida é Prisma.sql com a chave como PARÂMETRO, nunca texto concatenado", () => {
    const sql = sqlToqueDeSaida();
    expect(sql.values).toEqual(["comprovada"]);
    expect(sql.sql).toContain(`"Activity"."direcao" = 'out'`);
    expect(sql.sql).toContain(`"Activity"."tipo" IN ('whatsapp', 'email')`);
    // A chave não aparece escrita dentro do texto do SQL.
    expect(sql.sql).not.toContain("comprovada");
  });

  it("o mesmo pedaço de SQL pode entrar várias vezes na mesma consulta", () => {
    const saida = sqlToqueDeSaida();
    const junto = Prisma.sql`SELECT ${saida} AS a, ${saida} AS b`;
    expect(junto.values).toEqual(["comprovada", "comprovada"]);
  });
});

// ─── Matriz de Activity ──────────────────────────────────────────────────────

const TEAM = "00000000-0000-0000-0000-00000f1a3003";
const OUTRO_TEAM = "00000000-0000-0000-0000-00000f1a3004";

type Tipo = "whatsapp" | "email" | "call" | "note" | "stage_change";
type Direcao = "in" | "out" | null;
type Meta = { rotulo: string; valor: Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined; comprovada: boolean; foraDoCrmAgro: boolean };

const TIPOS: Tipo[] = ["whatsapp", "email", "call", "note", "stage_change"];
const DIRECOES: Direcao[] = ["out", "in", null];
const METAS: Meta[] = [
  { rotulo: "sem meta", valor: undefined, comprovada: false, foraDoCrmAgro: false },
  { rotulo: "json null", valor: Prisma.JsonNull, comprovada: false, foraDoCrmAgro: false },
  { rotulo: "comprovada true", valor: { comprovada: true }, comprovada: true, foraDoCrmAgro: false },
  { rotulo: "comprovada false", valor: { comprovada: false }, comprovada: false, foraDoCrmAgro: false },
  { rotulo: "comprovada texto", valor: { comprovada: "true" }, comprovada: false, foraDoCrmAgro: false },
  { rotulo: "comprovada número", valor: { comprovada: 1 }, comprovada: false, foraDoCrmAgro: false },
  { rotulo: "comprovada aninhada", valor: { prova: { comprovada: true } }, comprovada: false, foraDoCrmAgro: false },
  { rotulo: "meta lista", valor: [true], comprovada: false, foraDoCrmAgro: false },
  { rotulo: "foraDoCrmAgro true", valor: { ligacaoForaDoCrmAgro: true }, comprovada: false, foraDoCrmAgro: true },
  { rotulo: "foraDoCrmAgro texto", valor: { ligacaoForaDoCrmAgro: "true" }, comprovada: false, foraDoCrmAgro: false },
  { rotulo: "callId", valor: { callId: "x", status: "pending" }, comprovada: false, foraDoCrmAgro: false },
  { rotulo: "os dois", valor: { comprovada: true, ligacaoForaDoCrmAgro: true }, comprovada: true, foraDoCrmAgro: true },
];

const rotulo = (t: Tipo, d: Direcao, m: Meta) => `${t}|${d ?? "nula"}|${m.rotulo}`;

/** Predicados escritos à mão, de propósito sem reaproveitar nada de `toque.ts`. */
const contaNoPlacar = (t: Tipo, d: Direcao, m: Meta) => d === "out" && (t === "whatsapp" || t === "email" || (t === "call" && m.comprovada));
const abordou = (t: Tipo, d: Direcao, m: Meta) => (d === "out" && (t === "whatsapp" || t === "email" || t === "call")) || (t === "note" && m.foraDoCrmAgro);

const LINHAS = TIPOS.flatMap((t) => DIRECOES.flatMap((d) => METAS.map((m) => ({ t, d, m, rotulo: rotulo(t, d, m) }))));

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Toque (F1A-03)"], [OUTRO_TEAM, "Toque outro (F1A-03)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await basePrisma.activity.deleteMany({ where: { teamId: { in: [TEAM, OUTRO_TEAM] } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: [TEAM, OUTRO_TEAM] } } });
  const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Matriz de toques" } });
  const outro = await basePrisma.contact.create({ data: { teamId: OUTRO_TEAM, nome: "Matriz de toques (outro time)" } });
  await basePrisma.activity.createMany({
    data: LINHAS.map(({ t, d, m, rotulo: r }) => ({
      teamId: TEAM,
      contactId: contato.id,
      tipo: t,
      direcao: d,
      conteudo: r,
      ...(m.valor === undefined ? {} : { meta: m.valor }),
    })),
  });
  // O outro time tem uma ligação comprovada e um WhatsApp de saída: nunca podem aparecer no time TEAM.
  await basePrisma.activity.createMany({
    data: [
      { teamId: OUTRO_TEAM, contactId: outro.id, tipo: "call", direcao: "out", conteudo: "outro|call", meta: { comprovada: true } },
      { teamId: OUTRO_TEAM, contactId: outro.id, tipo: "whatsapp", direcao: "out", conteudo: "outro|whatsapp" },
    ],
  });
}, 30_000);

afterAll(async () => {
  await basePrisma.activity.deleteMany({ where: { teamId: { in: [TEAM, OUTRO_TEAM] } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: [TEAM, OUTRO_TEAM] } } });
});

describe("regra aplicada a uma matriz de Activity (Prisma e SQL dão o mesmo conjunto)", () => {
  const esperadoDoPlacar = LINHAS.filter((l) => contaNoPlacar(l.t, l.d, l.m)).map((l) => l.rotulo).sort();
  const esperadoDaLista = LINHAS.filter((l) => abordou(l.t, l.d, l.m)).map((l) => l.rotulo).sort();

  it("a matriz não é trivial (tem o que conta e o que não conta)", () => {
    expect(LINHAS).toHaveLength(TIPOS.length * DIRECOES.length * METAS.length);
    expect(esperadoDoPlacar.length).toBeGreaterThan(10);
    expect(esperadoDoPlacar.length).toBeLessThan(LINHAS.length / 2);
    expect(esperadoDaLista.length).toBeGreaterThan(esperadoDoPlacar.length);
    // Ligação de saída sem prova fica de fora do placar mas dentro da lista.
    expect(esperadoDoPlacar).not.toContain("call|out|sem meta");
    expect(esperadoDaLista).toContain("call|out|sem meta");
  });

  it("whereToqueDeSaida (Prisma) confere com o predicado escrito à mão", async () => {
    const achadas = await basePrisma.activity.findMany({ where: { AND: [{ teamId: TEAM }, whereToqueDeSaida()] }, select: { conteudo: true } });
    expect(achadas.map((a) => a.conteudo).sort()).toEqual(esperadoDoPlacar);
  });

  it("sqlToqueDeSaida (SQL cru) dá o MESMO conjunto do filtro Prisma", async () => {
    const achadas = await basePrisma.$queryRaw<{ conteudo: string }[]>`
      SELECT "conteudo" FROM "Activity" WHERE "teamId" = ${TEAM} AND ${sqlToqueDeSaida()}`;
    expect(achadas.map((a) => a.conteudo).sort()).toEqual(esperadoDoPlacar);
  });

  it("sqlToqueDeSaida funciona dentro de FILTER e junto com outra tabela (colunas qualificadas)", async () => {
    const [linha] = await basePrisma.$queryRaw<{ contados: bigint; ligacoes: bigint }[]>`
      SELECT
        count(*) FILTER (WHERE ${sqlToqueDeSaida()}) AS contados,
        count(*) FILTER (WHERE ${sqlToqueDeSaida()} AND "Activity"."tipo" = 'call') AS ligacoes
      FROM "Activity"
      JOIN "Contact" c ON c.id = "Activity"."contactId" AND c."teamId" = "Activity"."teamId"
      WHERE "Activity"."teamId" = ${TEAM}`;
    expect(Number(linha!.contados)).toBe(esperadoDoPlacar.length);
    expect(Number(linha!.ligacoes)).toBe(LINHAS.filter((l) => l.t === "call" && contaNoPlacar(l.t, l.d, l.m)).length);
  });

  it("whereContatoAbordado confere com o predicado escrito à mão (declarada e anotada abordam; nota comum e direção nula não)", async () => {
    const achadas = await basePrisma.activity.findMany({ where: { AND: [{ teamId: TEAM }, whereContatoAbordado()] }, select: { conteudo: true } });
    expect(achadas.map((a) => a.conteudo).sort()).toEqual(esperadoDaLista);
  });

  it("todo toque que conta no placar também abordou o contato (o placar é um subconjunto da lista)", () => {
    for (const r of esperadoDoPlacar) expect(esperadoDaLista).toContain(r);
  });
});

describe("dois times", () => {
  it("db() do tenant: o filtro do placar só enxerga o próprio time", async () => {
    const doA = await runWithTeam(TEAM, () => db().activity.count({ where: whereToqueDeSaida() }));
    const doOutro = await runWithTeam(OUTRO_TEAM, () => db().activity.count({ where: whereToqueDeSaida() }));
    expect(doA).toBe(LINHAS.filter((l) => contaNoPlacar(l.t, l.d, l.m)).length);
    expect(doOutro).toBe(2);
  });

  it("db() do tenant: a lista também", async () => {
    const doA = await runWithTeam(TEAM, () => db().activity.count({ where: whereContatoAbordado() }));
    const doOutro = await runWithTeam(OUTRO_TEAM, () => db().activity.count({ where: whereContatoAbordado() }));
    expect(doA).toBe(LINHAS.filter((l) => abordou(l.t, l.d, l.m)).length);
    expect(doOutro).toBe(2);
  });

  it("sem time no contexto, db() recusa (fail-closed): os filtros não abrem uma porta sem time", () => {
    expect(() => db().activity.count({ where: whereToqueDeSaida() })).toThrow();
  });

  it("SQL com teamId explícito (§12f): o time TEAM não enxerga as linhas do outro", async () => {
    const achadas = await basePrisma.$queryRaw<{ conteudo: string }[]>`
      SELECT "conteudo" FROM "Activity" WHERE "teamId" = ${TEAM} AND ${sqlToqueDeSaida()}`;
    expect(achadas.some((a) => a.conteudo?.startsWith("outro|"))).toBe(false);
  });
});
