/**
 * N2: conexão do time com o Nectar (token cifrado, "Testar", remover) e o beta
 * por time. Base de TESTE, times próprios, sempre contra o Nectar FALSO: o
 * `fetch` real é proibido no arquivo e `NECTAR_API_BASE` aponta para 127.0.0.1:9.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { timesDoBetaCrm } from "@crmagro/config";
import { basePrisma, estaCifrado, runWithTeam as runWithTeamDb } from "@crmagro/db";
import { ForbiddenError } from "../../../auth/authz";
import { criarNectarFalso, TOKEN_FALSO_NECTAR } from "../../../test-support/nectar-falso";
import { runWithTeam } from "../../../test-support/identidade";
import { CrmForaDoBeta, CrmNaoConfigurado } from "../errors";
import { crmLiberadoParaOTime } from "./beta";
import { abrirConexaoNectar, removerNectar, salvarTokenNectar, statusNectar, testarConexaoNectar } from "./conexao";

const TEAM_A = "00000000-0000-0000-0000-0000006e0201";
const TEAM_B = "00000000-0000-0000-0000-0000006e0202";

const fetchOriginal = globalThis.fetch;
const betaOriginal = process.env.CRM_BETA_TEAM_IDS;
const ipOriginal = process.env.CRMAGRO_IP_SAIDA;

const emA = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_A, fn);
const emB = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_B, fn);
const como = <T>(time: string, role: string, fn: () => Promise<T>) => runWithTeamDb(time, fn, { userId: `n2-${role}`, role });

async function limpar() {
  await basePrisma.integration.deleteMany({ where: { teamId: { in: [TEAM_A, TEAM_B] } } });
}

beforeAll(async () => {
  globalThis.fetch = (() => {
    throw new Error("fetch real proibido");
  }) as unknown as typeof fetch;
  for (const [id, name] of [[TEAM_A, "N2 time A (test)"], [TEAM_B, "N2 time B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await limpar();
});

afterAll(async () => {
  await limpar();
  globalThis.fetch = fetchOriginal;
  if (betaOriginal === undefined) delete process.env.CRM_BETA_TEAM_IDS;
  else process.env.CRM_BETA_TEAM_IDS = betaOriginal;
  if (ipOriginal === undefined) delete process.env.CRMAGRO_IP_SAIDA;
  else process.env.CRMAGRO_IP_SAIDA = ipOriginal;
});

beforeEach(async () => {
  process.env.CRM_BETA_TEAM_IDS = TEAM_A;
  delete process.env.CRMAGRO_IP_SAIDA;
  await limpar();
});

describe("N2: salvar e ler o token", () => {
  it("o dono salva: uma linha em Integration, com o token cifrado (nunca em texto)", async () => {
    const falso = criarNectarFalso();
    await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }));
    const linhas = await basePrisma.integration.findMany({ where: { teamId: TEAM_A, tipo: "nectarcrm" } });
    expect(linhas).toHaveLength(1);
    expect(estaCifrado(linhas[0]!.credentials)).toBe(true);
    expect(JSON.stringify(linhas[0]!.credentials)).not.toContain(TOKEN_FALSO_NECTAR);
    // Só o servidor, na hora da chamada, decifra.
    const conexao = await emA(() => abrirConexaoNectar());
    expect(conexao).toEqual({ integrationId: linhas[0]!.id, token: TOKEN_FALSO_NECTAR });
  });

  it("statusNectar: só os 4 últimos caracteres; o DTO não leva o token", async () => {
    process.env.CRMAGRO_IP_SAIDA = "203.0.113.7";
    const falso = criarNectarFalso();
    await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }));
    const dto = await emA(() => statusNectar());
    expect(dto.finalDoToken).toBe(`••••${TOKEN_FALSO_NECTAR.slice(-4)}`);
    expect(dto).toMatchObject({ liberado: true, configurado: true, status: "connected", ipSaida: "203.0.113.7" });
    expect(JSON.stringify(dto)).not.toContain(TOKEN_FALSO_NECTAR);
    expect(JSON.stringify(dto)).not.toContain(TOKEN_FALSO_NECTAR.slice(0, -4));
  });

  it("sem linha: não configurado, sem final de token, e abrir a conexão dá CrmNaoConfigurado", async () => {
    const dto = await emA(() => statusNectar());
    expect(dto).toMatchObject({ configurado: false, status: "disconnected", finalDoToken: null, atualizadoEm: null, ipSaida: null });
    await expect(emA(() => abrirConexaoNectar())).rejects.toBeInstanceOf(CrmNaoConfigurado);
    await expect(emA(() => testarConexaoNectar({ transporte: criarNectarFalso().transporte }))).rejects.toBeInstanceOf(CrmNaoConfigurado);
  });

  it("token curto ou com espaço é recusado pelo zod, sem gravar nada", async () => {
    const falso = criarNectarFalso();
    await expect(emA(() => salvarTokenNectar({ token: "curto" }, { transporte: falso.transporte }))).rejects.toMatchObject({ name: "ZodError" });
    await expect(emA(() => salvarTokenNectar({ token: "com espaco no meio do token 1234567890" }, { transporte: falso.transporte }))).rejects.toMatchObject({
      name: "ZodError",
    });
    expect(await basePrisma.integration.count({ where: { teamId: TEAM_A } })).toBe(0);
    expect(falso.pedidos).toHaveLength(0);
  });

  it("salvar de novo (trocar o token) atualiza a mesma linha", async () => {
    const falso = criarNectarFalso();
    await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }));
    const outro = "outro-token-valido-do-nectar-999";
    const falso2 = criarNectarFalso({ token: outro });
    await emA(() => salvarTokenNectar({ token: outro }, { transporte: falso2.transporte }));
    expect(await basePrisma.integration.count({ where: { teamId: TEAM_A, tipo: "nectarcrm" } })).toBe(1);
    expect((await emA(() => abrirConexaoNectar())).token).toBe(outro);
    expect((await emA(() => statusNectar())).finalDoToken).toBe(`••••${outro.slice(-4)}`);
  });

  it("credentials = {} gravado direto na linha: não configurado", async () => {
    const falso = criarNectarFalso();
    await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }));
    await basePrisma.integration.updateMany({ where: { teamId: TEAM_A, tipo: "nectarcrm" }, data: { credentials: {} } });
    const dto = await emA(() => statusNectar());
    expect(dto.configurado).toBe(false);
    expect(dto.finalDoToken).toBeNull();
    await expect(emA(() => abrirConexaoNectar())).rejects.toBeInstanceOf(CrmNaoConfigurado);
  });
});

describe("N2: testar a conexão", () => {
  it("token aceito: connected, credencial ok e todo pedido leva o Access-Token", async () => {
    const falso = criarNectarFalso();
    const r = await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }));
    expect(r.status.status).toBe("connected");
    expect(r.diagnostico.credencial).toBe("ok");
    expect(r.diagnostico.leadboard).toBe("tem");
    expect(falso.pedidos.length).toBeGreaterThan(5);
    for (const p of falso.pedidos) expect(p.cabecalhos["Access-Token"]).toBe(TOKEN_FALSO_NECTAR);
    expect((await basePrisma.integration.findFirstOrThrow({ where: { teamId: TEAM_A, tipo: "nectarcrm" } })).status).toBe("connected");
  });

  it("outro token no Nectar: error e credencial invalida (não lança)", async () => {
    const falso = criarNectarFalso({ token: "token-que-o-falso-aceita-9999" });
    const r = await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }));
    expect(r.status.status).toBe("error");
    expect(r.diagnostico.credencial).toBe("invalida");
    expect(falso.pedidos).toHaveLength(1);
    expect((await basePrisma.integration.findFirstOrThrow({ where: { teamId: TEAM_A, tipo: "nectarcrm" } })).status).toBe("error");
  });

  it("Nectar sem resposta: error e credencial indisponivel", async () => {
    const falso = criarNectarFalso({ tempoEsgotado: [/./] });
    const r = await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }));
    expect(r.status.status).toBe("error");
    expect(r.diagnostico.credencial).toBe("indisponivel");
  });

  it("testar de novo depois de conectar reaproveita o token salvo e volta a connected", async () => {
    const falso = criarNectarFalso();
    await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }));
    await basePrisma.integration.updateMany({ where: { teamId: TEAM_A, tipo: "nectarcrm" }, data: { status: "error" } });
    const r = await emA(() => testarConexaoNectar({ transporte: falso.transporte }));
    expect(r.status.status).toBe("connected");
  });

  it("o diagnóstico nunca leva sipPassword, listaIps nem o token", async () => {
    const falso = criarNectarFalso();
    const r = await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }));
    const texto = JSON.stringify(r);
    expect(texto).not.toContain("sipPassword");
    expect(texto).not.toContain("segredo-sip");
    expect(texto).not.toContain("listaIps");
    expect(texto).not.toContain(TOKEN_FALSO_NECTAR);
  });
});

describe("N2: permissão (só admin)", () => {
  it("member não salva, não testa e não remove", async () => {
    const falso = criarNectarFalso();
    await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }));
    const antes = falso.pedidos.length;
    await expect(como(TEAM_A, "member", () => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(TEAM_A, "member", () => testarConexaoNectar({ transporte: falso.transporte }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(TEAM_A, "member", () => removerNectar())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(TEAM_A, "viewer", () => removerNectar())).rejects.toBeInstanceOf(ForbiddenError);
    expect(falso.pedidos.length).toBe(antes);
    expect(await basePrisma.integration.count({ where: { teamId: TEAM_A, tipo: "nectarcrm" } })).toBe(1);
  });

  it("admin (não só o dono) salva e remove", async () => {
    const falso = criarNectarFalso();
    await como(TEAM_A, "admin", () => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }));
    await como(TEAM_A, "admin", () => removerNectar());
    expect(await basePrisma.integration.count({ where: { teamId: TEAM_A, tipo: "nectarcrm" } })).toBe(0);
  });
});

describe("N2: beta por time", () => {
  it("time fora do beta: CrmForaDoBeta em salvar e testar, sem chamar o Nectar nem gravar", async () => {
    const falso = criarNectarFalso();
    await expect(emB(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }))).rejects.toBeInstanceOf(CrmForaDoBeta);
    await expect(emB(() => testarConexaoNectar({ transporte: falso.transporte }))).rejects.toBeInstanceOf(CrmForaDoBeta);
    expect(falso.pedidos).toHaveLength(0);
    expect(await basePrisma.integration.count({ where: { teamId: TEAM_B } })).toBe(0);
    expect((await emB(() => statusNectar())).liberado).toBe(false);
  });

  it("todos e * liberam qualquer time", async () => {
    for (const valor of ["todos", "*", "TODOS"]) {
      process.env.CRM_BETA_TEAM_IDS = valor;
      await limpar();
      const r = await emB(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: criarNectarFalso().transporte }));
      expect(r.status.liberado).toBe(true);
      expect(r.status.status).toBe("connected");
    }
  });

  it("lista vazia ou ausente: ninguém (fail-closed)", async () => {
    for (const valor of ["", undefined]) {
      if (valor === undefined) delete process.env.CRM_BETA_TEAM_IDS;
      else process.env.CRM_BETA_TEAM_IDS = valor;
      expect(await emA(async () => crmLiberadoParaOTime())).toBe(false);
    }
  });

  it("a lista é lida na hora (mudar o valor muda o resultado) e ignora maiúscula do id", async () => {
    process.env.CRM_BETA_TEAM_IDS = TEAM_A.toUpperCase();
    expect(await emA(async () => crmLiberadoParaOTime())).toBe(true);
    process.env.CRM_BETA_TEAM_IDS = TEAM_B;
    expect(await emA(async () => crmLiberadoParaOTime())).toBe(false);
  });

  it("sem time no contexto, não está liberado", () => {
    expect(crmLiberadoParaOTime()).toBe(false);
  });

  it("timesDoBetaCrm: vírgula, ponto e vírgula, espaço, TODOS, * e vazio", () => {
    expect(timesDoBetaCrm("a, b")).toEqual({ todos: false, ids: new Set(["a", "b"]) });
    expect(timesDoBetaCrm("a;b c")).toEqual({ todos: false, ids: new Set(["a", "b", "c"]) });
    expect(timesDoBetaCrm("TODOS")).toMatchObject({ todos: true });
    expect(timesDoBetaCrm("*")).toMatchObject({ todos: true });
    expect(timesDoBetaCrm("A-1, todos")).toEqual({ todos: true, ids: new Set(["a-1"]) });
    expect(timesDoBetaCrm("")).toEqual({ todos: false, ids: new Set() });
    expect(timesDoBetaCrm(undefined)).toEqual({ todos: false, ids: new Set() });
    expect(timesDoBetaCrm(null)).toEqual({ todos: false, ids: new Set() });
  });
});

describe("N2: dois times", () => {
  it("o time B não vê a conexão do A, e remover em B deixa a linha de A", async () => {
    process.env.CRM_BETA_TEAM_IDS = `${TEAM_A},${TEAM_B}`;
    const falso = criarNectarFalso();
    await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: falso.transporte }));
    const deB = await emB(() => statusNectar());
    expect(deB).toMatchObject({ configurado: false, finalDoToken: null, status: "disconnected" });
    await expect(emB(() => abrirConexaoNectar())).rejects.toBeInstanceOf(CrmNaoConfigurado);
    await emB(() => removerNectar());
    expect(await basePrisma.integration.count({ where: { teamId: TEAM_A, tipo: "nectarcrm" } })).toBe(1);
    expect((await emA(() => statusNectar())).configurado).toBe(true);
  });

  it("cada time guarda o próprio token", async () => {
    process.env.CRM_BETA_TEAM_IDS = "todos";
    const tokenB = "token-do-time-b-nectar-777777";
    await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: criarNectarFalso().transporte }));
    await emB(() => salvarTokenNectar({ token: tokenB }, { transporte: criarNectarFalso({ token: tokenB }).transporte }));
    expect((await emA(() => abrirConexaoNectar())).token).toBe(TOKEN_FALSO_NECTAR);
    expect((await emB(() => abrirConexaoNectar())).token).toBe(tokenB);
  });
});

describe("N2: remover", () => {
  it("apaga a linha e o status volta a não configurado", async () => {
    await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: criarNectarFalso().transporte }));
    await emA(() => removerNectar());
    expect(await basePrisma.integration.count({ where: { teamId: TEAM_A, tipo: "nectarcrm" } })).toBe(0);
    expect((await emA(() => statusNectar())).configurado).toBe(false);
  });

  it("remover fora do beta é permitido (o token tem de poder sair do CRM Agro)", async () => {
    await emA(() => salvarTokenNectar({ token: TOKEN_FALSO_NECTAR }, { transporte: criarNectarFalso().transporte }));
    process.env.CRM_BETA_TEAM_IDS = "";
    await emA(() => removerNectar());
    expect(await basePrisma.integration.count({ where: { teamId: TEAM_A, tipo: "nectarcrm" } })).toBe(0);
  });
});
