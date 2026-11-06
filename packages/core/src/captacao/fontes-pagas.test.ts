import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { redisEstado } from "../shared/redis-cache";
import {
  CotaDaFonteEsgotada,
  CustoAcimaDoTeto,
  CustoNaoConfirmado,
  FonteDesligada,
  FonteSemAcesso,
  FonteSemCredito,
  PedidoDePessoaInvalido,
  buscarCandidatosPorNome,
  estimarBuscaPorNome,
  listarFontesPagas,
  mesDeSaoPaulo,
  removerFontePaga,
  salvarFontePaga,
} from "./fontes-pagas";

/**
 * Fonte PAGA (CNPJá, busca de pessoas por nome): desligada por padrão, só administrador, custo
 * mostrado antes e confirmado, tetos por busca e por mês, registro sem o nome inteiro, chave
 * cifrada e isolada por time. O `fetch` é FALSO: nenhum teste chama a API paga.
 */
const TEAM = "00000000-0000-0000-0000-0000000005d1";
const OUTRO = "00000000-0000-0000-0000-0000000005d2";
const CHAVE = "chave-falsa-de-teste-123456";
const admin = { userId: "adm", role: "admin" };
const membro = { userId: "mem", role: "member" };

const corpo = { count: 1, next: null, records: [{ id: "p1", type: "NATURAL", name: "MARIA APARECIDA SILVA", taxId: "***982247**", age: "51-60", membership: [{ company: { name: "AGRO TESTE LTDA" } }] }] };
const chamadas: { url: string; auth: string | undefined }[] = [];
let status = 200;
const fetchFalso = vi.fn(async (url: string | URL, init?: RequestInit) => {
  chamadas.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
  return new Response(status === 200 ? JSON.stringify(corpo) : "x", { status });
});

const ligar = (t = TEAM, extra: Partial<Parameters<typeof salvarFontePaga>[1]> = {}) =>
  runWithTeam(t, () => salvarFontePaga("cnpja", { apiKey: CHAVE, precoCreditoCentavos: 75, tetoCreditosPorBusca: 5, ...extra }), admin);
const buscar = (t = TEAM, o: Partial<Parameters<typeof buscarCandidatosPorNome>[0]> = {}, who = admin) =>
  runWithTeam(t, () => buscarCandidatosPorNome({ nome: "Maria Aparecida Silva", limite: 20, motivo: "cliente", creditosConfirmados: 2, ...o }), who);

async function limpar() {
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.integration.deleteMany({ where: { teamId: t, tipo: "cnpja" } });
    await basePrisma.consultaDocumento.deleteMany({ where: { teamId: t } });
    await redisEstado().del(`fonte:uso:${t}:cnpja:${mesDeSaoPaulo()}`);
  }
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Fonte A (test)"], [OUTRO, "Team Fonte B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const r = redisEstado();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});
beforeEach(async () => {
  vi.stubGlobal("fetch", fetchFalso);
  chamadas.length = 0;
  fetchFalso.mockClear();
  status = 200;
  await limpar();
});
afterEach(() => vi.unstubAllGlobals());

describe("configuração da fonte", () => {
  it("nasce DESLIGADA; ligar cifra a chave e a tela nunca a recebe", async () => {
    const antes = await runWithTeam(TEAM, () => listarFontesPagas(), admin);
    expect(antes[0]).toMatchObject({ id: "cnpja", ligada: false, chaveMascarada: null });
    await ligar();
    const depois = (await runWithTeam(TEAM, () => listarFontesPagas(), admin))[0]!;
    expect(depois).toMatchObject({ ligada: true, chaveMascarada: "••••3456", precoCreditoCentavos: 75, tetoCreditosPorBusca: 5, usoDoMes: 0 });
    expect(JSON.stringify(depois)).not.toContain(CHAVE);
    // Em repouso: a coluna é cifrada, sem a chave em claro.
    const linha = await basePrisma.integration.findFirstOrThrow({ where: { teamId: TEAM, tipo: "cnpja" } });
    expect(JSON.stringify(linha.credentials)).not.toContain(CHAVE);
    expect(linha.status).toBe("connected");
    expect(fetchFalso).not.toHaveBeenCalled(); // ligar não consulta nada (não gasta crédito)
  });

  it("só administrador liga e desliga; membro não", async () => {
    await expect(runWithTeam(TEAM, () => salvarFontePaga("cnpja", { apiKey: CHAVE }), membro)).rejects.toThrow();
    await expect(runWithTeam(TEAM, () => removerFontePaga("cnpja"), membro)).rejects.toThrow();
    expect(await basePrisma.integration.count({ where: { teamId: TEAM, tipo: "cnpja" } })).toBe(0);
  });

  it("chave curta ou com espaço é recusada; chave em branco numa fonte ligada mantém a atual", async () => {
    await expect(runWithTeam(TEAM, () => salvarFontePaga("cnpja", { apiKey: "curta" }), admin)).rejects.toThrow();
    await expect(runWithTeam(TEAM, () => salvarFontePaga("cnpja", { apiKey: "tem espaco na chave 123" }), admin)).rejects.toThrow();
    await expect(runWithTeam(TEAM, () => salvarFontePaga("cnpja", { apiKey: "" }), admin)).rejects.toBeInstanceOf(PedidoDePessoaInvalido); // desligada: precisa da chave
    await ligar();
    await runWithTeam(TEAM, () => salvarFontePaga("cnpja", { apiKey: "", tetoCreditosPorBusca: 9 }), admin);
    expect((await runWithTeam(TEAM, () => listarFontesPagas(), admin))[0]).toMatchObject({ chaveMascarada: "••••3456", tetoCreditosPorBusca: 9 });
    await buscar(TEAM, { creditosConfirmados: 2 });
    expect(chamadas[0]!.auth).toBe(CHAVE); // a chave mantida é a que vai à fonte
  });

  it("desligar apaga a chave; um time não vê nem usa a fonte do outro", async () => {
    await ligar(TEAM);
    expect((await runWithTeam(OUTRO, () => listarFontesPagas(), admin))[0]!.ligada).toBe(false);
    await expect(buscar(OUTRO)).rejects.toBeInstanceOf(FonteDesligada);
    await runWithTeam(TEAM, () => removerFontePaga("cnpja"), admin);
    expect((await runWithTeam(TEAM, () => listarFontesPagas(), admin))[0]!.ligada).toBe(false);
    await expect(buscar(TEAM)).rejects.toBeInstanceOf(FonteDesligada);
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("custo antes de consultar", () => {
  it("a estimativa mostra créditos e reais SEM chamar a fonte; sem o preço, só os créditos", async () => {
    await ligar();
    expect(await runWithTeam(TEAM, () => estimarBuscaPorNome({ nome: "Maria Silva", limite: 20 }), admin)).toMatchObject({ fonteLigada: true, creditos: 2, centavos: 150, tetoCreditosPorBusca: 5, dentroDoTeto: true });
    await runWithTeam(TEAM, () => salvarFontePaga("cnpja", { apiKey: "", precoCreditoCentavos: null }), admin);
    expect(await runWithTeam(TEAM, () => estimarBuscaPorNome({ nome: "Maria Silva", limite: 20 }), admin)).toMatchObject({ creditos: 2, centavos: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("estimar sem a fonte ligada diz isso; membro não estima", async () => {
    expect(await runWithTeam(TEAM, () => estimarBuscaPorNome({ nome: "Maria Silva" }), admin)).toMatchObject({ fonteLigada: false });
    await expect(runWithTeam(TEAM, () => estimarBuscaPorNome({ nome: "Maria Silva" }), membro)).rejects.toThrow();
  });

  it("sem a confirmação do custo, ou com confirmação menor que o custo, não consulta", async () => {
    await ligar();
    await expect(buscar(TEAM, { limite: 30, creditosConfirmados: 0 })).rejects.toBeInstanceOf(CustoNaoConfirmado);
    await expect(buscar(TEAM, { limite: 30, creditosConfirmados: 2 })).rejects.toBeInstanceOf(CustoNaoConfirmado); // custa 3
    await expect(buscar(TEAM, { creditosConfirmados: undefined })).rejects.toBeInstanceOf(CustoNaoConfirmado); // confirmação ausente
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("acima do teto por busca: recusa antes de consultar", async () => {
    await ligar(TEAM, { tetoCreditosPorBusca: 2 });
    await expect(buscar(TEAM, { limite: 50, creditosConfirmados: 5 })).rejects.toBeInstanceOf(CustoAcimaDoTeto); // 5 créditos > 2
    expect(fetchFalso).not.toHaveBeenCalled();
    expect((await runWithTeam(TEAM, () => estimarBuscaPorNome({ nome: "Maria Silva", limite: 50 }), admin)).dentroDoTeto).toBe(false);
  });
});

describe("a consulta", () => {
  it("só administrador; membro e viewer são recusados antes de qualquer rede", async () => {
    await ligar();
    await expect(buscar(TEAM, {}, membro)).rejects.toThrow();
    await expect(buscar(TEAM, {}, { userId: "v", role: "viewer" })).rejects.toThrow();
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("devolve candidatos, gasta os créditos do mês e registra quem, por quê e quanto, sem o nome inteiro", async () => {
    await ligar();
    const p = await buscar(TEAM, { motivo: "indicacao" });
    expect(p.candidatos).toHaveLength(1);
    expect(p.candidatos[0]).toMatchObject({ nome: "MARIA APARECIDA SILVA", cpfMascarado: "***982247**" });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.auth).toBe(CHAVE);
    expect(new URL(chamadas[0]!.url).searchParams.get("name.in")).toBe("Maria Aparecida Silva");
    expect((await runWithTeam(TEAM, () => listarFontesPagas(), admin))[0]!.usoDoMes).toBe(2);

    const linhas = await basePrisma.consultaDocumento.findMany({ where: { teamId: TEAM } });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ userId: "adm", tipo: "nome", motivo: "indicacao", fonte: "cnpja", creditos: 2, custoCentavos: 150, documentoMascarado: "Maria S." });
    const texto = JSON.stringify(linhas);
    expect(texto).not.toContain("Aparecida");
    expect(texto).not.toContain(CHAVE);
    expect(linhas[0]!.documentoHmac).toMatch(/^[0-9a-f]{20,}$/);
  });

  it("a impressão do nome é por time (o mesmo nome em dois times dá impressões diferentes)", async () => {
    await ligar(TEAM);
    await ligar(OUTRO);
    await buscar(TEAM);
    await buscar(OUTRO);
    const a = await basePrisma.consultaDocumento.findFirstOrThrow({ where: { teamId: TEAM } });
    const b = await basePrisma.consultaDocumento.findFirstOrThrow({ where: { teamId: OUTRO } });
    expect(a.documentoHmac).not.toBe(b.documentoHmac);
  });

  it("teto do mês: a consulta que passa dele é recusada e não gasta nem registra", async () => {
    await ligar(TEAM, { tetoCreditosMes: 3 });
    await buscar(TEAM, { creditosConfirmados: 2 }); // 2 de 3
    await expect(buscar(TEAM, { creditosConfirmados: 2 })).rejects.toBeInstanceOf(CotaDaFonteEsgotada); // 4 > 3
    expect(chamadas).toHaveLength(1);
    expect((await runWithTeam(TEAM, () => listarFontesPagas(), admin))[0]!.usoDoMes).toBe(2); // o recusado foi devolvido
    expect(await basePrisma.consultaDocumento.count({ where: { teamId: TEAM } })).toBe(1);
  });

  it("o teto do mês é por time", async () => {
    await ligar(TEAM, { tetoCreditosMes: 2 });
    await ligar(OUTRO, { tetoCreditosMes: 2 });
    await buscar(TEAM);
    await expect(buscar(TEAM)).rejects.toBeInstanceOf(CotaDaFonteEsgotada);
    await expect(buscar(OUTRO)).resolves.toBeTruthy(); // o outro time não gastou nada
  });

  it("falha da fonte (chave recusada, sem crédito, fora do ar) devolve os créditos e não registra consulta", async () => {
    await ligar();
    status = 401;
    await expect(buscar()).rejects.toBeInstanceOf(FonteSemAcesso);
    status = 429;
    await expect(buscar()).rejects.toBeInstanceOf(FonteSemCredito);
    status = 500;
    await expect(buscar()).rejects.toThrow(/fonte de dados falhou/);
    expect((await runWithTeam(TEAM, () => listarFontesPagas(), admin))[0]!.usoDoMes).toBe(0);
    expect(await basePrisma.consultaDocumento.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("nome sem sobrenome e motivo fora da lista são recusados", async () => {
    await ligar();
    await expect(buscar(TEAM, { nome: "Maria" })).rejects.toBeInstanceOf(PedidoDePessoaInvalido);
    await expect(buscar(TEAM, { motivo: "porque sim" as never })).rejects.toBeInstanceOf(PedidoDePessoaInvalido);
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});
