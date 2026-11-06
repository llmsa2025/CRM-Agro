import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { env } from "@crmagro/config";
import { basePrisma, encryptCredentials, runWithTeam } from "@crmagro/db";
import type { Prisma } from "@prisma/client";

// Rate limit mockado e içado: o teste não depende da virada do minuto (a janela é fixa)
// nem escreve no Redis de TESTE. Padrão `allowed: true`; só o caso 10 muda uma vez.
const rl = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ allowed: true, remaining: 1, retryAfterMs: 0 })));
vi.mock("../rate-limit/service", async (orig) => ({ ...(await orig<typeof import("../rate-limit/service")>()), rateLimit: rl }));

// Falha do banco ao achar o endereço, ligada só pelo caso 9 (sem `spyOn` no Prisma).
const banco = vi.hoisted(() => ({ falhar: false }));
vi.mock("./encaminhamento", async (orig) => {
  const m = await orig<typeof import("./encaminhamento")>();
  return {
    ...m,
    acharEncaminhamentoPeloToken: async (token: string) => {
      if (banco.falhar) throw new Error("banco fora");
      return m.acharEncaminhamentoPeloToken(token);
    },
  };
});

import { gerarEncaminhamento } from "./encaminhamento";
import { CABECALHOS_ENTRADA, assinaturaDaEntrada, hashDoToken, tokenDoEndereco } from "./entrada-assinatura";
import type { EmailEncaminhadoJob } from "./entrada-encaminhada";
import { jobIdDoEmailEncaminhado } from "./entrada-fila";
import { aceitarEmailEncaminhado, LIMITE_ENTRADA_BYTES } from "./entrada-webhook";

/**
 * Rota de entrada de e-mail (ficha E4): a decisão de cada resposta do contrato da E1.
 * Dois times (A e B), uma caixa e um encaminhamento em cada.
 */
const A = "00000000-0000-0000-0000-0000000e4a01";
const B = "00000000-0000-0000-0000-0000000e4a02";
const DOMINIO = "in.crmagro.example";
const SEGREDO = "s".repeat(40);
const envAntes = { dominio: env.EMAIL_ENTRADA_DOMINIO, segredo: env.EMAIL_ENTRADA_SEGREDO };

let encA = "", encB = "";
let paraA = "", paraB = "";
const enfileirar = vi.fn(async (_job: EmailEncaminhadoJob) => {});

const dono = <T>(teamId: string, fn: () => Promise<T>) => runWithTeam(teamId, fn, { userId: `dono-${teamId.slice(-4)}`, role: "owner" });

async function limpar() {
  for (const teamId of [A, B]) {
    await basePrisma.emailEncaminhamento.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
  }
}

async function criarCaixa(teamId: string): Promise<{ enc: string; para: string }> {
  const caixa = await basePrisma.channelAccount.create({
    data: {
      teamId,
      canal: "email",
      label: "Caixa de teste",
      provider: "smtp",
      ownerId: `dono-${teamId.slice(-4)}`,
      credentials: encryptCredentials({ host: "smtp.teste.invalid", port: 465, user: "a@gmail.com", pass: "x", from: "a@gmail.com" }) as unknown as Prisma.InputJsonValue,
    },
  });
  const dto = await dono(teamId, () => gerarEncaminhamento(caixa.id));
  const linha = await basePrisma.emailEncaminhamento.findUniqueOrThrow({ where: { channelAccountId: caixa.id } });
  return { enc: linha.id, para: dto.endereco! };
}

beforeAll(async () => {
  Object.assign(env, { EMAIL_ENTRADA_DOMINIO: DOMINIO, EMAIL_ENTRADA_SEGREDO: SEGREDO });
  for (const [id, name] of [[A, "Rota de entrada A (test)"], [B, "Rota de entrada B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await limpar();
  ({ enc: encA, para: paraA } = await criarCaixa(A));
  ({ enc: encB, para: paraB } = await criarCaixa(B));
});

beforeEach(() => {
  banco.falhar = false;
  enfileirar.mockClear();
  rl.mockClear();
  Object.assign(env, { EMAIL_ENTRADA_DOMINIO: DOMINIO, EMAIL_ENTRADA_SEGREDO: SEGREDO });
});

afterAll(async () => {
  Object.assign(env, { EMAIL_ENTRADA_DOMINIO: envAntes.dominio, EMAIL_ENTRADA_SEGREDO: envAntes.segredo });
  await limpar();
});

type Opcoes = {
  para?: string;
  de?: string;
  corpo?: Buffer;
  carimbo?: number;
  chegada?: number;
  segredo?: string;
  sem?: string[];
  extra?: Record<string, string>;
  assinaturaErrada?: boolean;
};

/** Monta os cabeçalhos assinados como o Worker do Cloudflare faz (contrato da E1). */
function pedido(o: Opcoes = {}): { cabecalhos: Headers; corpo: Buffer } {
  const corpo = o.corpo ?? Buffer.from("Oi!\r\n");
  const campos = {
    carimbo: String(o.carimbo ?? Math.floor(Date.now() / 1000)),
    chegada: String(o.chegada ?? Date.now() - 1500),
    para: o.para ?? paraA,
    de: o.de ?? "ana+caf_=r+x=in.crmagro.example@gmail.com",
    tamanho: String(corpo.length),
    truncado: "0",
  };
  const assinatura = assinaturaDaEntrada(o.segredo ?? SEGREDO, campos, corpo);
  const cabecalhos = new Headers({
    [CABECALHOS_ENTRADA.carimbo]: campos.carimbo,
    [CABECALHOS_ENTRADA.chegada]: campos.chegada,
    [CABECALHOS_ENTRADA.para]: campos.para,
    [CABECALHOS_ENTRADA.de]: campos.de,
    [CABECALHOS_ENTRADA.tamanho]: campos.tamanho,
    [CABECALHOS_ENTRADA.truncado]: campos.truncado,
    [CABECALHOS_ENTRADA.assinatura]: o.assinaturaErrada ? (assinatura.startsWith("0") ? "1" : "0") + assinatura.slice(1) : assinatura,
    ...(o.extra ?? {}),
  });
  for (const nome of o.sem ?? []) cabecalhos.delete(nome);
  return { cabecalhos, corpo };
}

const aceitar = (o: Opcoes = {}, fila = enfileirar) => aceitarEmailEncaminhado(pedido(o), fila);

describe("1. tudo certo", () => {
  it("200 e enfileira 1 vez com o encaminhamento e o time do banco, o corpo e a chegada do cabeçalho", async () => {
    const chegada = Date.now() - 4000;
    const corpo = Buffer.from("From: a@b.c\r\n\r\nOlá, mundo\r\n");
    const r = await aceitar({ corpo, chegada });

    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(enfileirar).toHaveBeenCalledTimes(1);
    const job = enfileirar.mock.calls[0]![0];
    expect(job.encaminhamentoId).toBe(encA);
    expect(job.teamId).toBe(A);
    expect(job.envelopeDe).toBe("ana+caf_=r+x=in.crmagro.example@gmail.com");
    expect(Buffer.from(job.rawB64, "base64").equals(corpo)).toBe(true);
    expect(job.chegadaEm).toBe(chegada);
  });
});

describe("2 a 4. assinatura e cabeçalhos", () => {
  it("2. assinatura errada → 401, sem enfileirar", async () => {
    expect(await aceitar({ assinaturaErrada: true })).toEqual({ status: 401, body: { ok: false } });
    expect(enfileirar).not.toHaveBeenCalled();
  });

  it("2b. segredo errado (outro Worker) → 401", async () => {
    expect((await aceitar({ segredo: "outro-segredo-de-32-caracteres-ou-mais" })).status).toBe(401);
    expect(enfileirar).not.toHaveBeenCalled();
  });

  it("3. carimbo de 10 minutos atrás → 401", async () => {
    expect((await aceitar({ carimbo: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    expect(enfileirar).not.toHaveBeenCalled();
  });

  it("4. falta um cabeçalho (x-crmagro-de, e cada um dos outros) → 401", async () => {
    for (const nome of Object.values(CABECALHOS_ENTRADA)) {
      expect((await aceitar({ sem: [nome] })).status, nome).toBe(401);
    }
    expect(enfileirar).not.toHaveBeenCalled();
  });

  it("corpo alterado depois de assinado → 401", async () => {
    const p = pedido();
    expect((await aceitarEmailEncaminhado({ ...p, corpo: Buffer.from("Oi?\r\n") }, enfileirar)).status).toBe(401);
    expect(enfileirar).not.toHaveBeenCalled();
  });
});

describe("5 a 8. endereço, entrada desligada e tamanho", () => {
  it("5. token que não existe (32 hex aleatórios) → 404", async () => {
    const aleatorio = `r+${"ab12".repeat(8)}@${DOMINIO}`;
    expect(await aceitar({ para: aleatorio })).toEqual({ status: 404, body: { ok: false } });
    expect(enfileirar).not.toHaveBeenCalled();
  });

  it("6. o token de A em outro domínio → 404", async () => {
    const token = tokenDoEndereco(paraA, DOMINIO)!;
    expect((await aceitar({ para: `r+${token}@outro.com` })).status).toBe(404);
    expect(enfileirar).not.toHaveBeenCalled();
  });

  it("7. entrada desligada (sem EMAIL_ENTRADA_SEGREDO) → 404", async () => {
    const p = pedido();
    Object.assign(env, { EMAIL_ENTRADA_SEGREDO: "" });
    expect((await aceitarEmailEncaminhado(p, enfileirar)).status).toBe(404);
    expect(enfileirar).not.toHaveBeenCalled();
  });

  it("8. corpo null (passou do teto) → 413", async () => {
    const p = pedido();
    expect((await aceitarEmailEncaminhado({ cabecalhos: p.cabecalhos, corpo: null }, enfileirar)).status).toBe(413);
    expect(enfileirar).not.toHaveBeenCalled();
    expect(LIMITE_ENTRADA_BYTES).toBeGreaterThan(262_144); // o Worker manda no máximo 262144
  });
});

describe("9. falha passageira vira 503, nunca 404", () => {
  it("a fila lança → 503", async () => {
    const quebrada = vi.fn(async () => {
      throw new Error("Redis fora");
    });
    expect(await aceitar({}, quebrada)).toEqual({ status: 503, body: { ok: false } });
    expect(quebrada).toHaveBeenCalledTimes(1);
  });

  it("o banco falha ao achar o endereço → 503 (e nada é enfileirado)", async () => {
    banco.falhar = true;
    expect(await aceitar()).toEqual({ status: 503, body: { ok: false } });
    expect(enfileirar).not.toHaveBeenCalled();
  });
});

describe("10. limite por endereço", () => {
  it("pede o limite com a chave, o teto e a janela certos; estourou → 429 e não enfileira", async () => {
    const token = tokenDoEndereco(paraA, DOMINIO)!;
    const chave = `email-entrada:token:${hashDoToken(token).slice(0, 16)}`;
    expect(chave).toMatch(/^email-entrada:token:[0-9a-f]{16}$/);

    await aceitar();
    expect(rl).toHaveBeenCalledWith(chave, 120, 60_000);

    rl.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    enfileirar.mockClear();
    expect(await aceitar()).toEqual({ status: 429, body: { ok: false } });
    expect(enfileirar).not.toHaveBeenCalled();
  });

  it("o limite só é pedido depois da assinatura (pedido sem assinatura válida não gasta o orçamento do endereço)", async () => {
    await aceitar({ assinaturaErrada: true });
    expect(rl).not.toHaveBeenCalled();
  });
});

describe("11. dois times", () => {
  it("o token de B enfileira com o time B; um x-crmagro-team: A é ignorado", async () => {
    const r = await aceitar({ para: paraB, extra: { "x-crmagro-team": A } });
    expect(r.status).toBe(200);
    const job = enfileirar.mock.calls[0]![0];
    expect(job.teamId).toBe(B);
    expect(job.encaminhamentoId).toBe(encB);
  });

  it("o token de A continua sendo do time A", async () => {
    await aceitar({ para: paraA, extra: { "x-crmagro-team": B } });
    expect(enfileirar.mock.calls[0]![0].teamId).toBe(A);
  });
});

describe("12. jobIdDoEmailEncaminhado", () => {
  it("mesmo encaminhamento e mesmo conteúdo dão o mesmo id; outro conteúdo ou outro encaminhamento dão outro", () => {
    const base = jobIdDoEmailEncaminhado(encA, "Y29udGV1ZG8=");
    expect(jobIdDoEmailEncaminhado(encA, "Y29udGV1ZG8=")).toBe(base);
    expect(jobIdDoEmailEncaminhado(encA, "b3V0cm8=")).not.toBe(base);
    expect(jobIdDoEmailEncaminhado(encB, "Y29udGV1ZG8=")).not.toBe(base);
  });

  it("o id não contém ':' (o BullMQ recusa) e tem o formato ee_<32 hex>", () => {
    const id = jobIdDoEmailEncaminhado(encA, "Y29udGV1ZG8=");
    expect(id).not.toContain(":");
    expect(id).toMatch(/^ee_[0-9a-f]{32}$/);
  });
});
