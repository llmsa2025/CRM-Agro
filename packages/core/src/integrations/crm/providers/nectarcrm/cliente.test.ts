/**
 * N1: cliente HTTP, erros e conector de LEITURA do Nectar, sempre contra o
 * Nectar FALSO (transporte em memória). Sem banco. O `fetch` real é proibido
 * no arquivo inteiro: qualquer chamada que escape do transporte falso quebra.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { criarNectarFalso, TOKEN_FALSO_NECTAR, type ConfigNectarFalso } from "../../../../test-support/nectar-falso";
import type { ConexaoAberta } from "../../contract";
import {
  CrmCotaEsgotada,
  CrmCredencialInvalida,
  CrmConflito,
  CrmDadoInvalido,
  CrmIndisponivel,
  CrmLimite,
  CrmNaoEncontrado,
  CrmResultadoIncerto,
  CrmRespostaInvalida,
  CrmSemPermissao,
  caminhoParaLog,
} from "../../errors";
import { baseDoNectar, criarClienteNectar, NECTAR_BASE, segmento } from "./client";
import { criarConectorNectar, temEtiquetaOptOutUtilizavel } from "./index";
import { distribuicaoDeFormatos, formatoDoTelefone } from "./telefone";

const fetchOriginal = globalThis.fetch;
const chamadasDeFetchReal: { url: string; init: RequestInit | undefined }[] = [];
const baseOriginal = process.env.NECTAR_API_BASE;

beforeAll(() => {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    chamadasDeFetchReal.push({ url: String(url), init });
    throw new Error("fetch real proibido");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = fetchOriginal;
});
afterEach(() => {
  // O caso do `baseDoNectar` mexe na variável: devolve como estava.
  if (baseOriginal === undefined) delete process.env.NECTAR_API_BASE;
  else process.env.NECTAR_API_BASE = baseOriginal;
});

const conexao = (token: string = TOKEN_FALSO_NECTAR): ConexaoAberta => ({ integrationId: "integracao-teste", token });

async function erroDe(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("era para lançar erro");
}

describe("N1: token e cabeçalhos", () => {
  it("todo pedido leva Access-Token e nenhuma URL contém o token nem api_token", async () => {
    const falso = criarNectarFalso();
    const diag = await criarConectorNectar({ transporte: falso.transporte }).testConnection(conexao());
    expect(diag.credencial).toBe("ok");
    expect(falso.pedidos.length).toBeGreaterThan(5);
    for (const p of falso.pedidos) {
      expect(p.cabecalhos["Access-Token"]).toBe(TOKEN_FALSO_NECTAR);
      expect(p.cabecalhos.Accept).toBe("application/json");
      expect(p.url).not.toContain(TOKEN_FALSO_NECTAR);
      expect(p.url).not.toContain("api_token");
    }
  });

  it("corpo JSON leva Content-Type; GET não leva", async () => {
    const falso = criarNectarFalso({ falhas: [{ metodo: "POST", caminho: /\/contatos\/$/, status: 200, texto: "{}" }] });
    const cliente = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: falso.transporte });
    await cliente.post("/contatos/", { nome: "x" }, z.unknown());
    await cliente.get("/queues/", z.unknown());
    expect(falso.pedidos[0]?.cabecalhos["Content-Type"]).toBe("application/json");
    expect(falso.pedidos[0]?.corpo).toBe('{"nome":"x"}');
    expect(falso.pedidos[1]?.cabecalhos["Content-Type"]).toBeUndefined();
  });

  it("o transporte padrão manda o token só no cabeçalho e não segue redirecionamento", async () => {
    chamadasDeFetchReal.length = 0;
    const cliente = criarClienteNectar({ token: "tok-padrao-123" });
    // O fetch de teste lança: o cliente vira CrmIndisponivel, sem sair do VPS.
    const e = await erroDe(() => cliente.get("/queues/", z.unknown()));
    expect(e).toBeInstanceOf(CrmIndisponivel);
    expect(chamadasDeFetchReal).toHaveLength(1);
    const { url, init } = chamadasDeFetchReal[0]!;
    expect((init?.headers as Record<string, string>)["Access-Token"]).toBe("tok-padrao-123");
    expect(init?.redirect).toBe("manual");
    expect(url).not.toContain("tok-padrao-123");
  });
});

describe("N1: query, segmento e base", () => {
  it("lista na query repete a chave (attribute=id&attribute=nome&…)", async () => {
    const falso = criarNectarFalso();
    await criarConectorNectar({ transporte: falso.transporte }).listUsers(conexao());
    const url = falso.pedidos[0]!.url;
    expect(url).toContain("attribute=id&attribute=nome&attribute=email&attribute=login&attribute=ativo&attribute=virtual&attribute=isSuporte");
    expect(new URL(url).searchParams.getAll("attribute")).toEqual(["id", "nome", "email", "login", "ativo", "virtual", "isSuporte"]);
    expect(new URL(url).searchParams.get("page")).toBe("-1");
  });

  it("segmento codifica +, espaço e parênteses", () => {
    expect(segmento("+55 (62) 99999-8888")).toBe("%2B55%20%2862%29%2099999-8888");
    expect(segmento("a@b.com")).toBe("a%40b.com");
    expect(segmento("!'*")).toBe("%21%27%2A");
  });

  it("baseDoNectar: usa NECTAR_API_BASE lida na hora; sem ela, a base real; sem barra no fim", async () => {
    process.env.NECTAR_API_BASE = "http://127.0.0.1:19/";
    const falso = criarNectarFalso();
    await criarConectorNectar({ transporte: falso.transporte }).listQueues(conexao());
    expect(falso.pedidos[0]!.url.startsWith("http://127.0.0.1:19/queues/")).toBe(true);

    delete process.env.NECTAR_API_BASE;
    await criarConectorNectar({ transporte: falso.transporte }).listQueues(conexao());
    expect(falso.pedidos[1]!.url.startsWith(`${NECTAR_BASE}/queues/`)).toBe(true);
    expect(baseDoNectar()).toBe(NECTAR_BASE);

    // A base passada pelo chamador vence a variável.
    process.env.NECTAR_API_BASE = "http://127.0.0.1:19";
    expect(baseDoNectar("http://exemplo.invalid/x/")).toBe("http://exemplo.invalid/x");
    // Variável vazia conta como ausente.
    process.env.NECTAR_API_BASE = "  ";
    expect(baseDoNectar()).toBe(NECTAR_BASE);
  });

  it("em produção, NECTAR_API_BASE só vale para loopback: endereço de fora não recebe o token", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      process.env.NECTAR_API_BASE = "https://coletor.exemplo.invalid/api";
      expect(baseDoNectar()).toBe(NECTAR_BASE);
      process.env.NECTAR_API_BASE = "http://127.0.0.1.exemplo.invalid/api"; // parece loopback, não é
      expect(baseDoNectar()).toBe(NECTAR_BASE);
      process.env.NECTAR_API_BASE = "http://localhost.exemplo.invalid";
      expect(baseDoNectar()).toBe(NECTAR_BASE);
      // Loopback continua valendo (o roteiro visual local roda em modo produção).
      process.env.NECTAR_API_BASE = "http://127.0.0.1:19/";
      expect(baseDoNectar()).toBe("http://127.0.0.1:19");
      process.env.NECTAR_API_BASE = "http://localhost:9";
      expect(baseDoNectar()).toBe("http://localhost:9");
      // A base passada pelo chamador não passa por esta regra (é código, não variável).
      expect(baseDoNectar("https://outro.exemplo.invalid/x")).toBe("https://outro.exemplo.invalid/x");
    } finally {
      vi.unstubAllEnvs();
    }
    // Fora de produção a variável vale qualquer que seja o endereço.
    process.env.NECTAR_API_BASE = "https://coletor.exemplo.invalid/api";
    expect(baseDoNectar()).toBe("https://coletor.exemplo.invalid/api");
  });

  it("nos testes, NECTAR_API_BASE aponta para 127.0.0.1:9 (nada sai do VPS)", () => {
    expect(baseOriginal).toBe("http://127.0.0.1:9");
  });
});

describe("N1: status HTTP vira erro nomeado", () => {
  const tabela = [
    [400, CrmDadoInvalido],
    [401, CrmCredencialInvalida],
    [403, CrmSemPermissao],
    [404, CrmNaoEncontrado],
    [409, CrmConflito],
    [422, CrmDadoInvalido],
    [429, CrmLimite],
    [500, CrmIndisponivel],
  ] as const;

  for (const [status, Classe] of tabela) {
    it(`GET ${status} vira ${Classe.name}`, async () => {
      const falso = criarNectarFalso({ falhas: [{ caminho: /^\/queues\/$/, status, texto: "detalhe interno" }] });
      const cliente = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: falso.transporte });
      const e = await erroDe(() => cliente.get("/queues/", z.unknown()));
      expect(e).toBeInstanceOf(Classe);
      expect(e.name).toBe(Classe.name);
      expect((e as CrmDadoInvalido).status).toBe(status);
      expect((e as CrmDadoInvalido).requestId).toMatch(/^req-falso-/);
      expect(e.message).toContain(`GET /queues/ → HTTP ${status} (x-request-id req-falso-`);
    });
  }

  it("5xx depois de POST e de PUT vira CrmResultadoIncerto", async () => {
    const falso = criarNectarFalso({ falhas: [{ caminho: /\/contatos\//, status: 502 }] });
    const cliente = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: falso.transporte });
    expect(await erroDe(() => cliente.post("/contatos/", {}, z.unknown()))).toBeInstanceOf(CrmResultadoIncerto);
    expect(await erroDe(() => cliente.put("/contatos/5", {}, z.unknown()))).toBeInstanceOf(CrmResultadoIncerto);
  });

  it("tempo esgotado: GET vira CrmIndisponivel e POST vira CrmResultadoIncerto", async () => {
    const falso = criarNectarFalso({ tempoEsgotado: [/./] });
    const cliente = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: falso.transporte });
    const get = await erroDe(() => cliente.get("/queues/", z.unknown()));
    const post = await erroDe(() => cliente.post("/contatos/", {}, z.unknown()));
    expect(get).toBeInstanceOf(CrmIndisponivel);
    expect(get.message).toContain("tempo esgotado");
    expect(post).toBeInstanceOf(CrmResultadoIncerto);
  });

  it("Retry-After em segundos vira ms; sem o cabeçalho fica undefined; data também vale", async () => {
    const falso = criarNectarFalso({
      falhas: [
        { caminho: /^\/queues\/$/, status: 429, retryAfter: "30", vezes: 1 },
        { caminho: /^\/queues\/$/, status: 429, vezes: 1 },
        { caminho: /^\/queues\/$/, status: 429, retryAfter: new Date(Date.now() + 60_000).toUTCString(), vezes: 1 },
      ],
    });
    const cliente = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: falso.transporte });
    const a = (await erroDe(() => cliente.get("/queues/", z.unknown()))) as CrmLimite;
    const b = (await erroDe(() => cliente.get("/queues/", z.unknown()))) as CrmLimite;
    const c = (await erroDe(() => cliente.get("/queues/", z.unknown()))) as CrmLimite;
    expect(a.retryAfterMs).toBe(30_000);
    expect(b.retryAfterMs).toBeUndefined();
    expect(c.retryAfterMs).toBeGreaterThan(50_000);
    expect(c.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("429 (e 403) com texto de cota vira CrmCotaEsgotada", async () => {
    const falso = criarNectarFalso({
      falhas: [
        { caminho: /^\/queues\/$/, status: 429, texto: "cota de requisições excedida", vezes: 1 },
        { caminho: /^\/queues\/$/, status: 403, texto: "Quota exceeded", vezes: 1 },
      ],
    });
    const cliente = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: falso.transporte });
    expect(await erroDe(() => cliente.get("/queues/", z.unknown()))).toBeInstanceOf(CrmCotaEsgotada);
    expect(await erroDe(() => cliente.get("/queues/", z.unknown()))).toBeInstanceOf(CrmCotaEsgotada);
  });

  it("a mensagem do erro nunca leva o token, o corpo da resposta nem a query", async () => {
    const token = "tok-SEGREDO-123";
    const falso = criarNectarFalso({ token, falhas: [{ caminho: /^\/queues\/$/, status: 500, texto: "corpo-secreto" }] });
    const cliente = criarClienteNectar({ token, transporte: falso.transporte });
    const e500 = await erroDe(() => cliente.get("/queues/", z.unknown(), { nome: "valor-da-query" }));
    expect(e500.message).not.toContain("SEGREDO");
    expect(e500.message).not.toContain("corpo-secreto");
    expect(e500.message).not.toContain("valor-da-query");
    // 401 (token errado) também não devolve o token.
    const errado = criarClienteNectar({ token: "tok-SEGREDO-999", transporte: falso.transporte });
    const e401 = await erroDe(() => errado.get("/queues/", z.unknown()));
    expect(e401).toBeInstanceOf(CrmCredencialInvalida);
    expect(e401.message).not.toContain("SEGREDO");
  });
});

describe("N1: usuários", () => {
  it("listUsers: sem sipPassword nem listaIps, o virtual some e o inativo fica com ativo false", async () => {
    const falso = criarNectarFalso();
    const lista = await criarConectorNectar({ transporte: falso.transporte }).listUsers(conexao());
    const texto = JSON.stringify(lista);
    expect(texto).not.toContain("sipPassword");
    expect(texto).not.toContain("segredo-sip");
    expect(texto).not.toContain("listaIps");
    expect(texto).not.toContain("1.2.3.4");
    expect(lista.map((u) => u.id)).toEqual(["1", "2"]);
    expect(lista[1]).toEqual({ id: "2", nome: "Bruno Inativo", email: "bruno@empresa.example", login: "bruno", ativo: false });
    expect(Object.keys(lista[0]!).sort()).toEqual(["ativo", "email", "id", "login", "nome"]);
  });

  it("mesmo que a API devolva os campos sensíveis (sem attribute), o zod os descarta", async () => {
    const falso = criarNectarFalso();
    // Chamada crua, sem `attribute`: o falso devolve tudo, como a API real faria.
    const cru = await criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: falso.transporte }).get("/usuarios/", z.array(z.record(z.unknown())));
    expect(JSON.stringify(cru)).toContain("sipPassword");
    // Pelo conector, o schema tira tudo o que não é dos 5 campos.
    const lista = await criarConectorNectar({ transporte: falso.transporte }).listUsers(conexao());
    expect(JSON.stringify(lista)).not.toContain("sip");
  });

  it("rotaUsuarios 'usuario': cai de /usuarios/ (404) para /usuario/", async () => {
    const falso = criarNectarFalso({ rotaUsuarios: "usuario" });
    const lista = await criarConectorNectar({ transporte: falso.transporte }).listUsers(conexao());
    expect(lista.length).toBe(2);
    expect(falso.pedidos.map((p) => new URL(p.url).pathname)).toEqual(["/usuarios/", "/usuario/"]);
    // O plano B também leva o `attribute`.
    expect(new URL(falso.pedidos[1]!.url).searchParams.getAll("attribute")).toContain("isSuporte");
  });

  it("outro erro em /usuarios/ NÃO cai para /usuario/", async () => {
    const falso = criarNectarFalso({ falhas: [{ caminho: /^\/usuarios\/$/, status: 500 }] });
    const e = await erroDe(() => criarConectorNectar({ transporte: falso.transporte }).listUsers(conexao()));
    expect(e).toBeInstanceOf(CrmIndisponivel);
    expect(falso.pedidos).toHaveLength(1);
  });
});

describe("N1: funis, ids e Leadboard", () => {
  it("listPipelines: etapas em ordem, funil com produto fica indisponível, modelo B2B/B2C", async () => {
    const falso = criarNectarFalso();
    const funis = await criarConectorNectar({ transporte: falso.transporte }).listPipelines(conexao(), "vendas");
    expect(new URL(falso.pedidos[0]!.url).searchParams.get("type")).toBe("0");
    expect(funis[0]?.etapas.map((e) => e.nome)).toEqual(["Gerar Interesse", "Processo de Cadência"]);
    expect(funis[0]).toMatchObject({ id: "1", tipo: "vendas", indisponivel: null, modeloVenda: "b2b", padrao: true });
    expect(funis[1]).toMatchObject({ id: "2", indisponivel: "o funil exige produto", modeloVenda: "b2c" });
    const pre = await criarConectorNectar({ transporte: falso.transporte }).listPipelines(conexao(), "pre_venda");
    expect(new URL(falso.pedidos[1]!.url).searchParams.get("type")).toBe("1");
    expect(pre[0]?.tipo).toBe("pre_venda");
  });

  it("funil inativo fica indisponível", async () => {
    const falso = criarNectarFalso({ funisVendas: [{ id: 5, nome: "Velho", ativo: false, sequencias: [] }] });
    const [f] = await criarConectorNectar({ transporte: falso.transporte }).listPipelines(conexao(), "vendas");
    expect(f?.indisponivel).toBe("funil inativo");
  });

  it("id numérico da resposta chega como string", async () => {
    const falso = criarNectarFalso({ funisVendas: [{ id: 12, nome: "F", sequencias: [{ id: 99, nome: "E", sequencia: 1 }] }] });
    const [f] = await criarConectorNectar({ transporte: falso.transporte }).listPipelines(conexao(), "vendas");
    expect(f?.id).toBe("12");
    expect(f?.etapas[0]?.id).toBe("99");
    expect(typeof f?.id).toBe("string");
  });

  it("Leadboard: lista vazia, 403 e 404 viram nao_tem; lista vira tem", async () => {
    const casos: [Partial<ConfigNectarFalso>, string][] = [
      [{ funisPreVenda: [] }, "nao_tem"],
      [{ funisPreVenda: "403" }, "nao_tem"],
      [{ funisPreVenda: "404" }, "nao_tem"],
      [{}, "tem"],
    ];
    for (const [cfg, esperado] of casos) {
      const diag = await criarConectorNectar({ transporte: criarNectarFalso(cfg).transporte }).testConnection(conexao());
      expect(diag.credencial).toBe("ok");
      expect(diag.leadboard).toBe(esperado);
    }
  });

  it("Leadboard: 500 ou 429 só na pré-venda vira desconhecido, e o resto do diagnóstico segue", async () => {
    for (const cfg of [
      { falhas: [{ caminho: /^\/pipeline\/$/, query: { type: "1" }, status: 500 }] },
      { falhas: [{ caminho: /^\/pipeline\/$/, query: { type: "1" }, status: 429 }] },
    ]) {
      const diag = await criarConectorNectar({ transporte: criarNectarFalso(cfg).transporte }).testConnection(conexao());
      expect(diag.credencial).toBe("ok");
      expect(diag.leadboard).toBe("desconhecido");
      expect(diag.funisVendas).toHaveLength(2);
      expect(diag.usuarios).not.toBeNull();
    }
  });
});

describe("N1: testConnection", () => {
  it("token errado: credencial invalida e só 1 chamada", async () => {
    const falso = criarNectarFalso();
    const diag = await criarConectorNectar({ transporte: falso.transporte }).testConnection(conexao("token-errado"));
    expect(diag.credencial).toBe("invalida");
    expect(falso.pedidos).toHaveLength(1);
    expect(diag.funisVendas).toEqual([]);
  });

  it("403 nos funis: sem_permissao e para na primeira chamada", async () => {
    const falso = criarNectarFalso({ falhas: [{ caminho: /^\/pipeline\/$/, status: 403 }] });
    const diag = await criarConectorNectar({ transporte: falso.transporte }).testConnection(conexao());
    expect(diag.credencial).toBe("sem_permissao");
    expect(falso.pedidos).toHaveLength(1);
  });

  it("Nectar fora do ar (500 e tempo esgotado): credencial indisponivel e para", async () => {
    for (const cfg of [{ falhas: [{ caminho: /^\/pipeline\/$/, status: 503 }] }, { tempoEsgotado: [/^\/pipeline\/$/] }]) {
      const falso = criarNectarFalso(cfg);
      const diag = await criarConectorNectar({ transporte: falso.transporte }).testConnection(conexao());
      expect(diag.credencial).toBe("indisponivel");
      expect(falso.pedidos).toHaveLength(1);
    }
  });

  it("diagnóstico completo: funis, usuários, filas, etiquetas, campos obrigatórios e formatos", async () => {
    const falso = criarNectarFalso();
    const diag = await criarConectorNectar({ transporte: falso.transporte }).testConnection(conexao());
    expect(diag.credencial).toBe("ok");
    expect(diag.leadboard).toBe("tem");
    expect(diag.funisVendas).toHaveLength(2);
    expect(diag.funisPreVenda).toHaveLength(1);
    expect(diag.usuarios).toEqual({ total: 2, ativos: 1 });
    expect(diag.filas).toBe(1);
    expect(diag.tags.map((t) => t.nome)).toContain("Opt-out (CRM Agro)");
    expect(diag.camposObrigatorios.map((c) => c.nome)).toEqual(["Código do cliente"]);
    expect(Object.keys(diag.formatosTelefone).sort()).toEqual(
      ["55", "e164", "ddd", "parenteses", "parenteses_hifen", "sem_nono", "sem_nono_parenteses_hifen"].sort(),
    );
    expect(diag.avisos).toEqual([]);
    // Nada de segredo nem de telefone no diagnóstico.
    const texto = JSON.stringify(diag);
    expect(texto).not.toContain("sipPassword");
    expect(texto).not.toContain("99999");
  });

  it("sem a etiqueta Opt-out (CRM Agro) utilizável em contato: aviso", async () => {
    const semEtiqueta = criarNectarFalso({ tags: [{ id: 2, nome: "Feira", ativo: true, relacionada: 2, podeIncluir: true }] });
    const soOportunidade = criarNectarFalso({ tags: [{ id: 1, nome: "Opt-out (CRM Agro)", ativo: true, relacionada: 1, podeIncluir: true }] });
    for (const falso of [semEtiqueta, soOportunidade]) {
      const diag = await criarConectorNectar({ transporte: falso.transporte }).testConnection(conexao());
      expect(diag.avisos).toContain("Crie no Nectar a etiqueta “Opt-out (CRM Agro)” para contatos.");
    }
  });

  it("lista de usuários que não vem: usuarios null e o aviso do plano B", async () => {
    const falso = criarNectarFalso({ falhas: [{ caminho: /^\/usuarios?\/$/, status: 403 }] });
    const diag = await criarConectorNectar({ transporte: falso.transporte }).testConnection(conexao());
    expect(diag.credencial).toBe("ok");
    expect(diag.usuarios).toBeNull();
    expect(diag.avisos).toContain("A lista de usuários não veio. Cada pessoa vai digitar o e-mail de login dela no Nectar.");
  });

  it("um passo que falha não derruba os outros", async () => {
    const falso = criarNectarFalso({ falhas: [{ caminho: /^\/queues\/$/, status: 500 }, { caminho: /^\/contatos\/$/, status: 500 }] });
    const diag = await criarConectorNectar({ transporte: falso.transporte }).testConnection(conexao());
    expect(diag.credencial).toBe("ok");
    expect(diag.filas).toBeNull();
    expect(diag.formatosTelefone).toEqual({});
    expect(diag.tags.length).toBe(2);
  });

  it("capacidades: tudo pendente de homologação, menos mover_card", () => {
    const { capacidades } = criarConectorNectar();
    const estados = Object.entries(capacidades);
    expect(capacidades.mover_card).toBe("nao_suportada");
    expect(estados.filter(([c]) => c !== "mover_card").every(([, e]) => e === "pendente_homologacao")).toBe(true);
  });

  it("temEtiquetaOptOutUtilizavel: nome sem diferença de maiúscula; inativa ou sem permissão não vale", () => {
    const base = { id: "1", nome: "opt-out (crm agro)", ativa: true, relacionada: "contato" as const, podeIncluir: true };
    expect(temEtiquetaOptOutUtilizavel([base])).toBe(true);
    expect(temEtiquetaOptOutUtilizavel([{ ...base, relacionada: null }])).toBe(true);
    expect(temEtiquetaOptOutUtilizavel([{ ...base, ativa: false }])).toBe(false);
    expect(temEtiquetaOptOutUtilizavel([{ ...base, podeIncluir: false }])).toBe(false);
    expect(temEtiquetaOptOutUtilizavel([{ ...base, relacionada: "oportunidade" }])).toBe(false);
  });
});

describe("N1: resposta fora do formato", () => {
  it("zod quebrado vira CrmRespostaInvalida e a mensagem não leva o corpo", async () => {
    const falso = criarNectarFalso({ funisVendas: [{ x: 1, segredoDoCorpo: "nao-vaza" }] });
    const e = await erroDe(() => criarConectorNectar({ transporte: falso.transporte }).listPipelines(conexao(), "vendas"));
    expect(e).toBeInstanceOf(CrmRespostaInvalida);
    expect(e.message).toContain("GET /pipeline/ → HTTP 200");
    expect(e.message).not.toContain("nao-vaza");
    expect(e.message).not.toContain('"x"');
  });

  it("2xx que não é JSON vira CrmRespostaInvalida; corpo vazio vira null", async () => {
    const falso = criarNectarFalso({
      falhas: [
        { caminho: /^\/queues\/$/, status: 200, texto: "<html>oi</html>", vezes: 1 },
        { caminho: /^\/queues\/$/, status: 200, texto: "", vezes: 1 },
      ],
    });
    const cliente = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: falso.transporte });
    const e = await erroDe(() => cliente.get("/queues/", z.unknown()));
    expect(e).toBeInstanceOf(CrmRespostaInvalida);
    expect(e.message).not.toContain("html");
    expect(await cliente.get("/queues/", z.null())).toBeNull();
    // Corpo vazio num schema que não aceita null também é resposta inválida.
    const falso2 = criarNectarFalso({ falhas: [{ caminho: /^\/queues\/$/, status: 200, texto: "" }] });
    const c2 = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: falso2.transporte });
    expect(await erroDe(() => c2.get("/queues/", z.array(z.unknown())))).toBeInstanceOf(CrmRespostaInvalida);
  });
});

describe("N1: telefone", () => {
  it("formatoDoTelefone: os 7 formatos do plano e o resto vira outro", () => {
    expect(formatoDoTelefone("+5562999998888")).toBe("e164");
    expect(formatoDoTelefone("5562999998888")).toBe("55");
    expect(formatoDoTelefone("62999998888")).toBe("ddd");
    expect(formatoDoTelefone("(62) 99999-8888")).toBe("parenteses_hifen");
    expect(formatoDoTelefone("(62) 999998888")).toBe("parenteses");
    expect(formatoDoTelefone("6299998888")).toBe("sem_nono");
    expect(formatoDoTelefone("(62) 9999-8888")).toBe("sem_nono_parenteses_hifen");
    expect(formatoDoTelefone("62 9 9999 8888")).toBe("outro");
    expect(formatoDoTelefone("")).toBe("outro");
  });

  it("distribuicaoDeFormatos conta cada formato", () => {
    expect(distribuicaoDeFormatos(["62999998888", "62988887777", "(62) 99999-8888", "+5562999998888", "abc"])).toEqual({
      ddd: 2,
      parenteses_hifen: 1,
      e164: 1,
      outro: 1,
    });
  });

  it("amostraFormatosTelefone devolve só a distribuição, também com telefone em objeto", async () => {
    const falso = criarNectarFalso({
      contatosAmostra: [
        { id: 1, telefones: [{ numero: "62999998888" }, "(62) 99999-8888"] },
        { id: 2 }, // sem a chave: lista vazia
      ],
    });
    const dist = await criarConectorNectar({ transporte: falso.transporte }).amostraFormatosTelefone(conexao());
    expect(dist).toEqual({ ddd: 1, parenteses_hifen: 1 });
    expect(new URL(falso.pedidos[0]!.url).searchParams.get("displayLength")).toBe("50");
  });
});

describe("N1: caminhoParaLog", () => {
  it("troca o dado pessoal por :valor e deixa o resto igual", () => {
    expect(caminhoParaLog("/contatos/email/a@b.com")).toBe("/contatos/email/:valor");
    expect(caminhoParaLog("/contatos/telefone/%2B5562999998888")).toBe("/contatos/telefone/:valor");
    expect(caminhoParaLog("/contatos/cpf/12345678901")).toBe("/contatos/cpf/:valor");
    expect(caminhoParaLog("/contatos/cnpj/12.345.678%2F0001-90")).toBe("/contatos/cnpj/:valor");
    expect(caminhoParaLog("/pipeline/")).toBe("/pipeline/");
    expect(caminhoParaLog("/contatos/123")).toBe("/contatos/123");
  });

  it("corta a query, se vier junto", () => {
    expect(caminhoParaLog("/contatos/?nome=abc&exato=true")).toBe("/contatos/");
  });

  it("erro de busca por CPF ou e-mail nunca leva o valor na mensagem", async () => {
    const falso = criarNectarFalso({ falhas: [{ caminho: /^\/contatos\/(cpf|email)\//, status: 500 }] });
    const cliente = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: falso.transporte });
    const eCpf = await erroDe(() => cliente.get(`/contatos/cpf/${segmento("12345678909")}`, z.unknown()));
    const eMail = await erroDe(() => cliente.get(`/contatos/email/${segmento("maria@cliente.com")}`, z.unknown()));
    expect(eCpf.message).not.toContain("12345678909");
    expect(eCpf.message).toContain("/contatos/cpf/:valor");
    expect(eMail.message).not.toContain("maria@cliente.com");
    expect(eMail.message).toContain("/contatos/email/:valor");
  });
});
