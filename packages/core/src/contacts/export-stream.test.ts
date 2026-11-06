import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { ForbiddenError } from "../auth/authz";
import { runWithTeam } from "../test-support/identidade";
import {
  exportarContatosCsv,
  exportFiltersSchema,
  fetchContactsForExport,
  lotesDeContatosParaExportar,
  rowsToCsv,
  type ExportRow,
} from "./export";

/**
 * Exportação em streaming (item 2.7, K2): mesmas linhas, na mesma ordem, lidas
 * em lotes por cursor — e o papel/time resolvidos na chamada, porque o stream
 * é consumido fora do contexto da requisição.
 */
const TEAM = "00000000-0000-0000-0000-0000000002a9";
const OUTRO = "00000000-0000-0000-0000-0000000002aa";
const BASE = new Date("2026-09-01T12:00:00Z");

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Export (test)"], [OUTRO, "Team Export B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});

beforeEach(async () => {
  for (const teamId of [TEAM, OUTRO]) {
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId } });
    await basePrisma.contact.deleteMany({ where: { teamId } });
  }
});

/** `minutos` repetidos de propósito: o desempate por id tem de atravessar o lote. */
async function contato(teamId: string, nome: string, minutos: number, extra: { tel?: string; status?: "novo" | "cliente" } = {}) {
  const c = await basePrisma.contact.create({
    data: {
      teamId,
      nome,
      cidade: "Cuiabá",
      tags: ["a", "b"],
      relacionamentoStatus: extra.status ?? "novo",
      createdAt: new Date(BASE.getTime() + minutos * 60_000),
    },
  });
  if (extra.tel) {
    await basePrisma.channelIdentifier.create({ data: { teamId, contactId: c.id, canal: "whatsapp", valor: extra.tel, isPrimary: true } });
  }
  return c;
}

async function semear() {
  const nomes: Array<[string, number]> = [["A", 1], ["B", 2], ["C", 2], ["D", 2], ["E", 3], ["F", 5], ["G", 5]];
  for (const [i, [nome, min]] of nomes.entries()) await contato(TEAM, nome, min, { tel: `+55659999900${i}`, status: i % 2 ? "cliente" : "novo" });
  await contato(OUTRO, "Intruso", 4, { tel: "+5565999990999" });
}

/** Referência independente: a ordem que a exportação sempre teve. */
async function nomesEsperados(where: Record<string, unknown> = {}) {
  const rows = await basePrisma.contact.findMany({
    where: { teamId: TEAM, ...where },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { nome: true },
  });
  return rows.map((r) => r.nome);
}

async function coletar(it: AsyncIterable<ExportRow[]>) {
  const lotes: ExportRow[][] = [];
  for await (const l of it) lotes.push(l);
  return lotes;
}

async function lerTudo(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let texto = "";
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    texto += dec.decode(value, { stream: true });
  }
  return texto + dec.decode();
}

describe("exportação em lotes por cursor", () => {
  it("mesmas linhas e mesma ordem, em lotes de 3 (desempate por id atravessa o lote)", async () => {
    await semear();
    const lotes = await runWithTeam(TEAM, () => coletar(lotesDeContatosParaExportar({}, { lote: 3 })));
    expect(lotes.map((l) => l.length)).toEqual([3, 3, 1]);
    const linhas = lotes.flat();
    expect(linhas.map((l) => l.nome)).toEqual(await nomesEsperados());
    expect(linhas[0]).toMatchObject({ cidade: "Cuiabá", tags: "a, b", createdAt: "2026-09-01" });
    expect(linhas.every((l) => l.telefone.startsWith("+55659999900"))).toBe(true);
    // O caminho "tudo de uma vez" dá o mesmo resultado.
    expect(await runWithTeam(TEAM, () => fetchContactsForExport({}))).toEqual(linhas);
  });

  it("dois times: contato de outro time nunca aparece", async () => {
    await semear();
    const linhas = (await runWithTeam(TEAM, () => coletar(lotesDeContatosParaExportar({}, { lote: 2 })))).flat();
    expect(linhas).toHaveLength(7);
    expect(linhas.map((l) => l.nome)).not.toContain("Intruso");
  });

  it("filtros e seleção continuam valendo", async () => {
    await semear();
    const clientes = (await runWithTeam(TEAM, () => coletar(lotesDeContatosParaExportar({ status: "cliente" }, { lote: 2 })))).flat();
    expect(clientes.map((l) => l.nome)).toEqual(await nomesEsperados({ relacionamentoStatus: "cliente" }));

    const alvo = await basePrisma.contact.findMany({ where: { teamId: TEAM, nome: { in: ["B", "G"] } }, select: { id: true } });
    const intruso = await basePrisma.contact.findFirstOrThrow({ where: { teamId: OUTRO }, select: { id: true } });
    const sel = (
      await runWithTeam(TEAM, () => coletar(lotesDeContatosParaExportar({ ids: [...alvo.map((a) => a.id), intruso.id] })))
    ).flat();
    expect(sel.map((l) => l.nome).sort()).toEqual(["B", "G"]);
  });

  it("filtro de produtor rural (o chip da tela) vale na exportação", async () => {
    await semear();
    await basePrisma.contact.updateMany({ where: { teamId: TEAM, nome: { in: ["A", "E"] } }, data: { produtorLabel: "produtor" } });
    await basePrisma.contact.updateMany({ where: { teamId: OUTRO }, data: { produtorLabel: "produtor" } });
    const linhas = (await runWithTeam(TEAM, () => coletar(lotesDeContatosParaExportar({ produtor: "produtor" }, { lote: 1 })))).flat();
    expect(linhas.map((l) => l.nome)).toEqual(["E", "A"]);
    expect(exportFiltersSchema.safeParse({ produtor: "qualquer" }).success).toBe(false);
  });

  it("contato apagado no meio da exportação não corta o resto", async () => {
    await semear();
    const it = await runWithTeam(TEAM, () => lotesDeContatosParaExportar({}, { lote: 3 })[Symbol.asyncIterator]());
    const primeiro = (await it.next()).value as ExportRow[];
    // Apaga justamente o último do 1º lote (a "âncora" do cursor).
    await basePrisma.contact.deleteMany({ where: { teamId: TEAM, nome: primeiro[2]!.nome } });
    const resto: ExportRow[] = [];
    for (let r = await it.next(); !r.done; r = await it.next()) resto.push(...r.value);
    expect([...primeiro, ...resto].map((l) => l.nome)).toEqual([...primeiro.map((l) => l.nome), ...(await nomesEsperados()).slice(2)]);
  });
});

describe("CSV em streaming", () => {
  it("texto idêntico ao rowsToCsv, com a proteção de fórmula (item 3.7), lido FORA do contexto do time", async () => {
    await semear();
    await contato(TEAM, '=HYPERLINK("http://x","clique")', 0);
    // Cria dentro do runWithTeam (como a rota) e consome fora dele.
    const stream = runWithTeam(TEAM, () => exportarContatosCsv({}, { lote: 3 }));
    const csv = await lerTudo(stream);

    const todas = await runWithTeam(TEAM, () => fetchContactsForExport({}));
    expect(csv).toBe(rowsToCsv(todas));
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""clique"")"`);
    expect(csv).not.toContain("Intruso");
    expect(csv.split("\r\n")).toHaveLength(1 + 8);
  });

  it("time sem contatos: só o cabeçalho", async () => {
    const csv = await lerTudo(runWithTeam(TEAM, () => exportarContatosCsv({})));
    expect(csv).toBe(rowsToCsv([]));
  });

  it("RBAC: member é recusado NA CHAMADA, antes de qualquer leitura", () => {
    expect(() => runWithTeam(TEAM, () => exportarContatosCsv({}), { userId: "m", role: "member" })).toThrow(ForbiddenError);
    expect(() => runWithTeam(TEAM, () => lotesDeContatosParaExportar({}), { userId: "m", role: "member" })).toThrow(ForbiddenError);
  });
});

describe("filtros na borda (zod)", () => {
  it("status inválido é recusado; busca em branco passa", () => {
    expect(exportFiltersSchema.safeParse({ status: "inexistente" }).success).toBe(false);
    expect(exportFiltersSchema.safeParse({ search: "   ", status: "cliente" }).success).toBe(true);
  });
});
