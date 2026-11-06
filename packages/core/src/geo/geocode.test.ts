import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { basePrisma, nomeBuscaLugar } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { redisEstado } from "../shared/redis-cache";
import { normalizarEndereco, ufDe, geoHashDe } from "./endereco";
import { geocodificarContato, backfillGeocode } from "./geocode";
import { GeocodificadorIndisponivel, type Geocodificador, type ResultadoProvedor } from "./geocodificador";

/**
 * Geocodificação (produto §B.2): cidade → centroide do IBGE sem provedor;
 * logradouro → GeoCache global → provedor; contato sem endereço herda da
 * empresa; geoHash igual não regeocodifica; o banco invalida quando o endereço
 * muda; backfill por time, um registro ruim não trava a fila. O provedor aqui
 * é FALSO (nada vai ao Nominatim). Cidades fictícias com código IBGE fora da
 * faixa real (99004xx) e ruas "Geo Teste" (limpas do GeoCache).
 */
const TEAM = "00000000-0000-0000-0000-0000000004a9";
const OUTRO = "00000000-0000-0000-0000-0000000004aa";
const CIDADE_A = { codigoIbge: 9900411, nome: "Cidade Geo Teste A", uf: "MT", latitude: -12.5, longitude: -55.7 };
const CIDADE_B = { codigoIbge: 9900412, nome: "Cidade Geo Teste B", uf: "GO", latitude: -16.0, longitude: -49.0 };

/** Provedor falso: responde por trecho da consulta e conta as chamadas. */
function provedorFalso(respostas: Record<string, ResultadoProvedor | null | "fora" | "quebrado">): Geocodificador & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    nome: "falso",
    chamadas,
    async buscar(consulta: string) {
      chamadas.push(consulta);
      const chave = Object.keys(respostas).find((k) => consulta.includes(k));
      const r = chave ? respostas[chave]! : null;
      if (r === "fora") throw new GeocodificadorIndisponivel("teste");
      // Provedor com bug: coordenada que não é número (o banco recusa).
      if (r === "quebrado") return { latitude: "abc", longitude: "def", precisao: "endereco" } as unknown as ResultadoProvedor;
      return r;
    },
  };
}

const PERTO_A = { latitude: -12.51, longitude: -55.71, precisao: "endereco" as const };

async function contato(teamId: string, dados: { endereco?: string; cidade?: string; estado?: string; nome?: string; geoPrecisao?: string }) {
  return basePrisma.contact.create({ data: { teamId, nome: dados.nome ?? "Contato Geo", ...dados } });
}
const ler = (id: string) => basePrisma.contact.findUniqueOrThrow({ where: { id } });

async function limpar() {
  for (const teamId of [TEAM, OUTRO]) {
    await basePrisma.contactCompany.deleteMany({ where: { teamId } });
    await basePrisma.company.deleteMany({ where: { teamId } });
    await basePrisma.contact.deleteMany({ where: { teamId } });
  }
  await basePrisma.geoCache.deleteMany({ where: { chave: { contains: "geo teste" } } });
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Geo A (test)"], [OUTRO, "Team Geo B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  for (const c of [CIDADE_A, CIDADE_B]) {
    const dados = { ...c, nomeBusca: nomeBuscaLugar(c.nome) };
    await basePrisma.municipio.upsert({ where: { codigoIbge: c.codigoIbge }, update: dados, create: dados });
  }
  const r = redisEstado();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});
beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await basePrisma.municipio.deleteMany({ where: { codigoIbge: { in: [CIDADE_A.codigoIbge, CIDADE_B.codigoIbge] } } });
});

describe("normalizarEndereco", () => {
  it("logradouro → nível endereço; grafias diferentes, mesma chave; consulta com o texto original", () => {
    const a = normalizarEndereco({ endereco: "Rua Geo Teste, 100", cidade: "Cidade Geo Teste A", estado: "Mato Grosso" });
    expect(a).toMatchObject({ nivel: "endereco", uf: "MT", chave: "rua geo teste 100|cidade geo teste a|mt" });
    expect(a.consulta).toBe("Rua Geo Teste, 100, Cidade Geo Teste A, MT, Brasil");
    expect(normalizarEndereco({ endereco: "RUA GEO TESTE 100", cidade: "cidade geo teste a", estado: "mt" }).chave).toBe(a.chave);
  });

  it("só cidade → nível cidade; UF por nome ou sigla; UF tirada do endereço do Maps", () => {
    expect(normalizarEndereco({ cidade: "São Paulo", estado: "sp" })).toMatchObject({ nivel: "cidade", chave: "sao paulo|sp", uf: "SP" });
    expect(normalizarEndereco({ endereco: "Rua X, 100 - Centro, Sorriso - MT, 78890-000" }).uf).toBe("MT");
    expect(ufDe("Mato Grosso do Sul")).toBe("MS");
    expect(ufDe("XX")).toBeNull();
  });

  it("vazio, só pontuação ou lixo gigante: nada a localizar ou texto cortado (a chave cabe no índice)", () => {
    expect(normalizarEndereco({}).nivel).toBe("nenhum");
    expect(normalizarEndereco({ endereco: " --- ,, ", cidade: "   " }).nivel).toBe("nenhum");
    const enorme = normalizarEndereco({ endereco: "Rua Geo Teste ".repeat(500), cidade: "X" });
    expect(enorme.nivel).toBe("endereco");
    expect(enorme.chave.length).toBeLessThan(500);
    expect(enorme.consulta.length).toBeLessThan(500);
  });
});

describe("geocodificarContato", () => {
  it("só cidade: centroide do IBGE, SEM chamar o provedor", async () => {
    const p = provedorFalso({});
    const c = await contato(TEAM, { cidade: "cidade geo teste a", estado: "MT" });
    await runWithTeam(TEAM, () => geocodificarContato(c.id, p));
    expect(await ler(c.id)).toMatchObject({ latitude: -12.5, longitude: -55.7, geoPrecisao: "cidade", geoFonte: "ibge" });
    expect(p.chamadas).toHaveLength(0);
  });

  it("logradouro: provedor 1× e GeoCache global — o mesmo endereço no OUTRO time não chama de novo (dois times)", async () => {
    const p = provedorFalso({ "Rua Geo Teste, 10": PERTO_A });
    const a = await contato(TEAM, { endereco: "Rua Geo Teste, 10", cidade: "Cidade Geo Teste A", estado: "MT" });
    const b = await contato(OUTRO, { endereco: "rua geo teste 10", cidade: "cidade geo teste a", estado: "mt" });
    await runWithTeam(TEAM, () => geocodificarContato(a.id, p));
    await runWithTeam(OUTRO, () => geocodificarContato(b.id, p));
    expect(p.chamadas).toHaveLength(1);
    for (const id of [a.id, b.id]) expect(await ler(id)).toMatchObject({ latitude: -12.51, geoPrecisao: "endereco", geoFonte: "falso" });
    // Cada time só grava o próprio contato: o do B pelo contexto do A não é achado.
    expect(await runWithTeam(TEAM, () => geocodificarContato(b.id, p))).toBe("ausente");
  });

  it("provedor não achou: fica no centroide da cidade e o 'não achou' vai para o cache", async () => {
    const p = provedorFalso({});
    const a = await contato(TEAM, { endereco: "Rua Geo Teste Inexistente, 1", cidade: "Cidade Geo Teste A", estado: "MT" });
    const b = await contato(TEAM, { endereco: "Rua Geo Teste Inexistente, 1", cidade: "Cidade Geo Teste A", estado: "MT" });
    await runWithTeam(TEAM, () => geocodificarContato(a.id, p));
    await runWithTeam(TEAM, () => geocodificarContato(b.id, p));
    expect(p.chamadas).toHaveLength(1);
    expect(await ler(b.id)).toMatchObject({ latitude: -12.5, geoPrecisao: "cidade", geoFonte: "ibge" });
    expect(await basePrisma.geoCache.findFirst({ where: { chave: { contains: "rua geo teste inexistente" } } })).toMatchObject({
      latitude: null,
      precisao: "nenhuma",
    });
  });

  it("provedor fora: centroide PROVISÓRIO, nada no cache, geoHash nulo (tenta de novo)", async () => {
    const p = provedorFalso({ "Rua Geo Teste Fora": "fora" });
    const c = await contato(TEAM, { endereco: "Rua Geo Teste Fora, 5", cidade: "Cidade Geo Teste A", estado: "MT" });
    await runWithTeam(TEAM, () => geocodificarContato(c.id, p));
    const lido = await ler(c.id);
    expect(lido).toMatchObject({ latitude: -12.5, geoPrecisao: "cidade", geoHash: null });
    expect(lido.geoAtualizadoEm).not.toBeNull();
    expect(await basePrisma.geoCache.count({ where: { chave: { contains: "rua geo teste fora" } } })).toBe(0);
  });

  it("ponto do provedor longe da cidade informada (> 150 km) é descartado", async () => {
    const p = provedorFalso({ "Rodovia Geo Teste": { latitude: -3.0, longitude: -60.0, precisao: "endereco" } });
    const c = await contato(TEAM, { endereco: "Rodovia Geo Teste, km 10", cidade: "Cidade Geo Teste A", estado: "MT" });
    await runWithTeam(TEAM, () => geocodificarContato(c.id, p));
    expect(await ler(c.id)).toMatchObject({ latitude: -12.5, geoPrecisao: "cidade" });
  });

  it("geoHash igual não regeocodifica; coordenada manual nunca é sobrescrita", async () => {
    const p = provedorFalso({ "Rua Geo Teste, 20": PERTO_A });
    const c = await contato(TEAM, { endereco: "Rua Geo Teste, 20", cidade: "Cidade Geo Teste A", estado: "MT" });
    await runWithTeam(TEAM, () => geocodificarContato(c.id, p));
    expect(await runWithTeam(TEAM, () => geocodificarContato(c.id, p))).toBe("inalterado");
    expect(p.chamadas).toHaveLength(1);

    const m = await contato(TEAM, { endereco: "Rua Geo Teste, 20", cidade: "Cidade Geo Teste A", estado: "MT", geoPrecisao: "manual" });
    expect(await runWithTeam(TEAM, () => geocodificarContato(m.id, p))).toBe("manual");
    expect(await ler(m.id)).toMatchObject({ latitude: null, geoPrecisao: "manual" });
  });

  it("contato sem endereço próprio herda da empresa principal", async () => {
    const p = provedorFalso({});
    const c = await contato(TEAM, { nome: "Sócio sem endereço" });
    const co = await basePrisma.company.create({ data: { teamId: TEAM, nome: "Fazenda Geo Teste", cidade: "Cidade Geo Teste B", estado: "GO" } });
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: c.id, companyId: co.id } });
    await runWithTeam(TEAM, () => geocodificarContato(c.id, p));
    expect(await ler(c.id)).toMatchObject({ latitude: -16.0, longitude: -49.0, geoFonte: "empresa", geoHash: geoHashDe("empresa") });
    expect(await basePrisma.company.findUniqueOrThrow({ where: { id: co.id } })).toMatchObject({ latitude: -16.0, geoFonte: "ibge" });
  });
});

describe("edição durante a chamada ao provedor (auditoria do #115)", () => {
  /** Provedor que, no meio da busca, faz `durante()` (o usuário editando) e responde. */
  function provedorQueEdita(durante: () => Promise<unknown>): Geocodificador & { chamadas: number } {
    const p = {
      nome: "falso",
      chamadas: 0,
      async buscar() {
        p.chamadas++;
        await durante();
        return PERTO_A;
      },
    };
    return p;
  }

  it("endereço corrigido no meio: a coordenada velha NÃO fica gravada e o backfill refaz com o novo", async () => {
    const c = await contato(TEAM, { endereco: "Rua Geo Teste Velha, 1", cidade: "Cidade Geo Teste A", estado: "MT" });
    const p = provedorQueEdita(() => basePrisma.contact.update({ where: { id: c.id }, data: { endereco: "Rua Geo Teste Nova, 2" } }));
    expect(await runWithTeam(TEAM, () => geocodificarContato(c.id, p))).toBe("concorrente");
    expect(await ler(c.id)).toMatchObject({ endereco: "Rua Geo Teste Nova, 2", geoHash: null, latitude: null });
    // O backfill pega de novo e grava com o endereço NOVO.
    const certo = provedorFalso({ "Rua Geo Teste Nova": PERTO_A });
    expect(await backfillGeocode({ provedor: certo, teamIds: [TEAM] })).toMatchObject({ processados: 1, atualizados: 1 });
    expect(certo.chamadas).toEqual(["Rua Geo Teste Nova, 2, Cidade Geo Teste A, MT, Brasil"]);
    expect((await ler(c.id)).geoHash).not.toBeNull();
  });

  it("pino arrastado (manual) no meio: o pino do usuário fica", async () => {
    const c = await contato(TEAM, { endereco: "Rua Geo Teste Pino, 3", cidade: "Cidade Geo Teste A", estado: "MT" });
    const p = provedorQueEdita(() =>
      basePrisma.contact.update({ where: { id: c.id }, data: { geoPrecisao: "manual", geoFonte: "manual", latitude: -12.9, longitude: -55.9 } }),
    );
    expect(await runWithTeam(TEAM, () => geocodificarContato(c.id, p))).toBe("concorrente");
    expect(await ler(c.id)).toMatchObject({ geoPrecisao: "manual", latitude: -12.9, longitude: -55.9 });
  });

  it("empresa mudou de endereço no meio: nem ela nem o contato que herda gravam a coordenada velha", async () => {
    const c = await contato(TEAM, { nome: "Herdeiro concorrente" });
    const co = await basePrisma.company.create({
      data: { teamId: TEAM, nome: "Empresa Geo Teste", endereco: "Rua Geo Teste Empresa, 4", cidade: "Cidade Geo Teste A", estado: "MT" },
    });
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: c.id, companyId: co.id } });
    const p = provedorQueEdita(() => basePrisma.company.update({ where: { id: co.id }, data: { endereco: "Rua Geo Teste Empresa Nova, 5" } }));
    expect(await runWithTeam(TEAM, () => geocodificarContato(c.id, p))).toBe("concorrente");
    expect(await basePrisma.company.findUniqueOrThrow({ where: { id: co.id } })).toMatchObject({ geoHash: null, latitude: null });
    expect(await ler(c.id)).toMatchObject({ geoHash: null, latitude: null });
  });
});

describe("o banco invalida a coordenada quando o endereço muda", () => {
  it("contato: mudou a cidade → geoHash zerado; coordenada manual fica", async () => {
    const p = provedorFalso({});
    const c = await contato(TEAM, { cidade: "Cidade Geo Teste A", estado: "MT" });
    await runWithTeam(TEAM, () => geocodificarContato(c.id, p));
    expect((await ler(c.id)).geoHash).not.toBeNull();
    await basePrisma.contact.update({ where: { id: c.id }, data: { cidade: "Cidade Geo Teste B", estado: "GO" } });
    expect(await ler(c.id)).toMatchObject({ geoHash: null, geoAtualizadoEm: null });
    // Nome não é endereço: não invalida.
    await runWithTeam(TEAM, () => geocodificarContato(c.id, p));
    await basePrisma.contact.update({ where: { id: c.id }, data: { nome: "Outro nome" } });
    expect((await ler(c.id)).geoHash).not.toBeNull();

    const m = await contato(TEAM, { cidade: "Cidade Geo Teste A", estado: "MT", geoPrecisao: "manual" });
    await basePrisma.contact.update({ where: { id: m.id }, data: { geoHash: "fixo" } });
    await basePrisma.contact.update({ where: { id: m.id }, data: { cidade: "Cidade Geo Teste B" } });
    expect((await ler(m.id)).geoHash).toBe("fixo");
  });

  it("empresa mudou de endereço ou o vínculo mudou → o contato que herda é refeito", async () => {
    const p = provedorFalso({});
    const c = await contato(TEAM, { nome: "Herdeiro" });
    const co = await basePrisma.company.create({ data: { teamId: TEAM, nome: "Empresa Geo Teste", cidade: "Cidade Geo Teste A", estado: "MT" } });
    const v = await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: c.id, companyId: co.id } });
    await runWithTeam(TEAM, () => geocodificarContato(c.id, p));
    await basePrisma.company.update({ where: { id: co.id }, data: { cidade: "Cidade Geo Teste B", estado: "GO" } });
    expect((await ler(c.id)).geoHash).toBeNull();
    await runWithTeam(TEAM, () => geocodificarContato(c.id, p));
    expect(await ler(c.id)).toMatchObject({ latitude: -16.0, geoFonte: "empresa" });
    await basePrisma.contactCompany.delete({ where: { id: v.id } });
    expect((await ler(c.id)).geoHash).toBeNull();
  });
});

describe("backfillGeocode — fila do worker", () => {
  it("geocodifica os pendentes de cada time no próprio time; um registro ruim não trava o lote", async () => {
    const p = provedorFalso({ "Rua Geo Teste Quebrada": "quebrado", "Rua Geo Teste, 30": PERTO_A });
    const ok1 = await contato(TEAM, { cidade: "Cidade Geo Teste A", estado: "MT" });
    const ruim = await contato(TEAM, { endereco: "Rua Geo Teste Quebrada, 1", cidade: "Cidade Geo Teste A", estado: "MT" });
    const vazio = await contato(TEAM, { endereco: "   ", nome: "Sem nada" });
    const ok2 = await contato(OUTRO, { endereco: "Rua Geo Teste, 30", cidade: "Cidade Geo Teste A", estado: "MT" });

    const r = await backfillGeocode({ provedor: p, teamIds: [TEAM, OUTRO] });
    expect(r).toMatchObject({ processados: 4, erros: 1 });
    expect(await ler(ok1.id)).toMatchObject({ geoPrecisao: "cidade" });
    expect(await ler(ok2.id)).toMatchObject({ geoPrecisao: "endereco", teamId: OUTRO });
    expect(await ler(vazio.id)).toMatchObject({ geoPrecisao: "nenhuma", latitude: null });
    // O ruim foi carimbado: a próxima rodada não o pega de novo (só depois de 1 h).
    expect(await ler(ruim.id)).toMatchObject({ geoHash: null });
    expect((await ler(ruim.id)).geoAtualizadoEm).not.toBeNull();
    expect(await backfillGeocode({ provedor: p, teamIds: [TEAM, OUTRO] })).toMatchObject({ processados: 0 });
    // Uma hora depois, volta.
    const depois = Date.now() + 61 * 60_000;
    expect(await backfillGeocode({ provedor: p, teamIds: [TEAM, OUTRO], agora: () => depois })).toMatchObject({ processados: 1, erros: 1 });
  });

  it("pino manual sem geoHash não entra no backfill (senão voltaria em toda rodada)", async () => {
    await contato(TEAM, { cidade: "Cidade Geo Teste A", estado: "MT", geoPrecisao: "manual" });
    expect(await backfillGeocode({ provedor: provedorFalso({}), teamIds: [TEAM] })).toMatchObject({ processados: 0 });
  });

  it("dois backfills nunca rodam juntos (trava global)", async () => {
    await redisEstado().set("geo:backfill", "outro-processo", "PX", 10_000);
    try {
      expect(await backfillGeocode({ provedor: provedorFalso({}), teamIds: [TEAM] })).toMatchObject({ pulado: "trava" });
    } finally {
      await redisEstado().del("geo:backfill");
    }
  });
});
