import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CONTEXTO_CPF,
  ChaveDeCredencialAusente,
  anelDeChaves,
  basePrisma,
  cifrarTexto,
  cifrarTextoCom,
  decifrarTextoCom,
  textoEstaCifrado,
  textoPrecisaRecifrar,
} from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { cifrarCpf, lerCpf } from "./cpf";

// writeContact agenda fluxos: a fila é mockada (como em contacts/write.test.ts), sem Redis nem envio.
vi.mock("../flows/queue", () => ({ scheduleStep: vi.fn(), getFlowQueue: () => ({}) }));
const { writeContact } = await import("./write");

/**
 * CPF do contato cifrado no banco (segurança, 01/10/2026). Quatro provas:
 *  1. o cifrador: valor de uma linha, aleatório, preso ao campo, aberto só com a chave certa;
 *  2. o leitor: texto puro legado passa, valor adulterado vira null sem derrubar a tela;
 *  3. o banco: o que o `writeContact` grava na coluna NÃO é o CPF, e a leitura devolve o CPF;
 *  4. o código: nenhum arquivo grava `cpfCifrado` sem passar por `cifrarCpf`.
 */
const TEAM = "00000000-0000-0000-0000-00000005c9f1";
const CPF = "123.456.789-09";

describe("cifrador", () => {
  it("o valor cifrado não contém o CPF, tem o formato versionado e muda a cada vez (IV aleatório)", () => {
    const a = cifrarCpf(CPF)!;
    const b = cifrarCpf(CPF)!;
    expect(textoEstaCifrado(a)).toBe(true);
    expect(a).toMatch(/^crmagro\.enc\.v2\.[0-9a-f]{8}\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a).not.toContain("123");
    expect(a).not.toContain("456");
    expect(a).not.toBe(b);
    expect(lerCpf(a)).toBe(CPF);
    expect(lerCpf(b)).toBe(CPF);
  });

  it("vazio, espaços e ausente viram null (nada é gravado)", () => {
    expect(cifrarCpf(undefined)).toBeNull();
    expect(cifrarCpf(null)).toBeNull();
    expect(cifrarCpf("")).toBeNull();
    expect(cifrarCpf("   ")).toBeNull();
    expect(lerCpf(null)).toBeNull();
    expect(lerCpf("")).toBeNull();
  });

  it("espaços nas pontas saem antes de cifrar", () => {
    expect(lerCpf(cifrarCpf("  123.456.789-09 "))).toBe(CPF);
  });
});

describe("leitor", () => {
  const erro = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => erro.mockClear());

  it("texto puro legado volta como está", () => {
    expect(lerCpf(CPF)).toBe(CPF);
  });

  it("valor adulterado não abre: devolve null e registra o erro (a tela não cai)", () => {
    const bom = cifrarCpf(CPF)!;
    const partes = bom.split(".");
    const dados = partes[partes.length - 1]!;
    partes[partes.length - 1] = (dados[0] === "A" ? "B" : "A") + dados.slice(1);
    expect(lerCpf(partes.join("."))).toBeNull();
    expect(erro).toHaveBeenCalled();
  });

  it("formato quebrado e chave desconhecida também viram null", () => {
    expect(lerCpf("crmagro.enc.v2.so-uma-parte")).toBeNull();
    expect(lerCpf("crmagro.enc.v2.deadbeef.aaaa.bbbb.cccc")).toBeNull();
  });

  it("valor cifrado para OUTRO campo não abre como CPF (contexto autenticado)", () => {
    const deOutroCampo = cifrarTexto(CPF, "Contact.sobrenome");
    expect(lerCpf(deOutroCampo)).toBeNull();
  });
});

describe("anel de chaves (rotação)", () => {
  const velha = "a".repeat(40);
  const nova = "b".repeat(40);
  const anelVelho = anelDeChaves(velha);
  const anelNovo = anelDeChaves(nova, undefined);
  const anelComAmbas = anelDeChaves(velha, nova); // principal = velha (legado); 1ª da lista = nova (atual)

  it("a chave nova cifra, e as duas abrem enquanto a velha estiver no anel", () => {
    const comVelha = cifrarTextoCom(anelVelho, CPF, CONTEXTO_CPF);
    const comNova = cifrarTextoCom(anelComAmbas, CPF, CONTEXTO_CPF);
    expect(decifrarTextoCom(anelComAmbas, comVelha, CONTEXTO_CPF)).toBe(CPF);
    expect(decifrarTextoCom(anelComAmbas, comNova, CONTEXTO_CPF)).toBe(CPF);
    expect(comNova.split(".")[3]).toBe(anelComAmbas.atual.kid);
  });

  it("sem a chave antiga no anel, abrir falha com erro nomeado (não devolve lixo)", () => {
    const comVelha = cifrarTextoCom(anelVelho, CPF, CONTEXTO_CPF);
    expect(() => decifrarTextoCom(anelNovo, comVelha, CONTEXTO_CPF)).toThrow(ChaveDeCredencialAusente);
  });

  it("textoPrecisaRecifrar: texto puro e chave antiga sim; chave atual não", () => {
    const comVelha = cifrarTextoCom(anelVelho, CPF, CONTEXTO_CPF);
    const comNova = cifrarTextoCom(anelComAmbas, CPF, CONTEXTO_CPF);
    expect(textoPrecisaRecifrar(anelComAmbas, CPF)).toBe(true);
    expect(textoPrecisaRecifrar(anelComAmbas, comVelha)).toBe(true);
    expect(textoPrecisaRecifrar(anelComAmbas, comNova)).toBe(false);
  });
});

describe("banco", () => {
  beforeAll(async () => {
    await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "CPF cifrado (test)" } });
  });
  afterAll(async () => {
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId: TEAM } });
    await basePrisma.activity.deleteMany({ where: { teamId: TEAM } });
    await basePrisma.contact.deleteMany({ where: { teamId: TEAM } });
  });

  it("writeContact grava o CPF cifrado na coluna, e a leitura pelo helper devolve o CPF", async () => {
    const { contactId } = await runWithTeam(TEAM, async () =>
      writeContact({ nome: "Com CPF", cpf: CPF, identifiers: { email: "cpf-cifrado@teste.crmagro" }, provenance: { source: "test", actor: "human" } }),
    );
    // A coluna, vista pelo dono do banco (sem nenhuma extensão): nunca o CPF.
    const [linha] = await basePrisma.$queryRaw<{ cpfCifrado: string | null }[]>`SELECT "cpfCifrado" FROM "Contact" WHERE "id" = ${contactId}`;
    expect(linha?.cpfCifrado).toBeTruthy();
    expect(linha!.cpfCifrado).not.toContain("123.456");
    expect(linha!.cpfCifrado).not.toContain("12345678909");
    expect(textoEstaCifrado(linha!.cpfCifrado)).toBe(true);
    // Lido pelo Prisma e aberto pelo helper.
    const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: contactId }, select: { cpfCifrado: true } });
    expect(lerCpf(c.cpfCifrado)).toBe(CPF);
  });

  it("sem CPF, a coluna fica nula", async () => {
    const { contactId } = await runWithTeam(TEAM, async () =>
      writeContact({ nome: "Sem CPF", identifiers: { email: "sem-cpf@teste.crmagro" }, provenance: { source: "test", actor: "human" } }),
    );
    const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: contactId }, select: { cpfCifrado: true } });
    expect(c.cpfCifrado).toBeNull();
  });

  it("a variável {cpf} das campanhas e dos fluxos sai em texto (o leitor abre antes de entregar)", async () => {
    const { contactId } = await runWithTeam(TEAM, async () =>
      writeContact({ nome: "Var CPF", cpf: CPF, identifiers: { email: "var-cpf@teste.crmagro" }, provenance: { source: "test", actor: "human" } }),
    );
    const { carregarVariaveis } = await import("../campaigns/variaveis");
    const vars = await runWithTeam(TEAM, () => carregarVariaveis([contactId]));
    expect(vars.get(contactId)?.cpf).toBe(CPF);
  });
});

describe("código", () => {
  // Quem pode tocar a coluna. Qualquer outro arquivo que cite `cpfCifrado` quebra o teste de propósito:
  // classifique o arquivo aqui e confira que ele grava só pelo `cifrarCpf` e lê só pelo `lerCpf`.
  const PERMITIDOS = new Set([
    "packages/core/src/contacts/cpf.ts",
    "packages/core/src/contacts/dto.ts", // só TIRA a coluna do contato que vai para o navegador (rotas REST)
    "packages/core/src/contacts/write.ts",
    "packages/core/src/ai/tools.ts",
    "packages/core/src/enrichment/pessoa.ts", // Enriquecer pessoa: lê o CPF só por lerCpf e o reduz à máscara da Receita no servidor
    "packages/core/src/campaigns/variaveis.ts",
    "apps/worker/src/handler.ts",
    "apps/web/app/contatos/[id]/page.tsx",
    "packages/db/scripts/recifrar-credenciais.ts",
    "packages/db/src/crypto.ts", // só comentário
    "packages/db/prisma/schema.prisma",
  ]);
  const RAIZ = join(__dirname, "..", "..", "..", "..");

  function arquivos(dir: string, saida: string[] = []): string[] {
    for (const nome of readdirSync(dir)) {
      if (["node_modules", ".next", "dist", "migrations", ".git"].includes(nome)) continue;
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) arquivos(caminho, saida);
      else if (/\.(ts|tsx|mjs|js|prisma)$/.test(nome) && !/\.test\.tsx?$/.test(nome)) saida.push(caminho);
    }
    return saida;
  }
  const fontes = ["apps", "packages"].flatMap((d) => arquivos(join(RAIZ, d))).map((f) => ({ rel: relative(RAIZ, f).replace(/\\/g, "/"), codigo: readFileSync(f, "utf8") }));
  const usam = fontes.filter((f) => f.codigo.includes("cpfCifrado"));

  it("encontra o código (o teste não pode passar vazio)", () => {
    expect(fontes.length).toBeGreaterThan(200);
    expect(usam.length).toBeGreaterThanOrEqual(5);
  });

  it("só os arquivos permitidos citam a coluna", () => {
    expect(usam.map((f) => f.rel).filter((r) => !PERMITIDOS.has(r))).toEqual([]);
  });

  it("toda ATRIBUIÇÃO à coluna passa pelo cifrarCpf (selects como `cpfCifrado: true` são leitura)", () => {
    const gravacoes = usam
      .filter((f) => f.rel !== "packages/db/prisma/schema.prisma" && f.rel !== "packages/db/scripts/recifrar-credenciais.ts")
      .flatMap((f) =>
        f.codigo
          .split("\n")
          .map((linha, i) => ({ rel: f.rel, n: i + 1, linha }))
          .filter(({ linha }) => /cpfCifrado\s*[:=](?!\s*(true\b|\{\s*not:))/.test(linha) && !/^\s*(\/\/|\*)/.test(linha)), // `true` é select e `{ not: null }` é filtro: nenhum dos dois grava
      );
    const semCifrar = gravacoes.filter(({ linha }) => !linha.includes("cifrarCpf("));
    expect(semCifrar.map((g) => `${g.rel}:${g.n}: ${g.linha.trim()}`)).toEqual([]);
    expect(gravacoes.length).toBeGreaterThanOrEqual(2); // write.ts e ai/tools.ts
  });

  it("toda LEITURA do valor da coluna passa pelo lerCpf", () => {
    const leituras = usam
      .filter((f) => !["packages/core/src/contacts/cpf.ts", "packages/db/prisma/schema.prisma", "packages/db/scripts/recifrar-credenciais.ts"].includes(f.rel))
      .flatMap((f) =>
        f.codigo
          .split("\n")
          .map((linha, i) => ({ rel: f.rel, n: i + 1, linha }))
          .filter(({ linha }) => /\.cpfCifrado\b(?!\s*=[^=])/.test(linha) && !/^\s*(\/\/|\*)/.test(linha)),
      );
    const semAbrir = leituras.filter(({ linha }) => !/lerCpf\([^)]*\.cpfCifrado/.test(linha));
    expect(semAbrir.map((g) => `${g.rel}:${g.n}: ${g.linha.trim()}`)).toEqual([]);
    expect(leituras.length).toBeGreaterThanOrEqual(4);
  });
});
