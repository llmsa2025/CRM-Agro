import { describe, it, expect, afterAll } from "vitest";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { env } from "@crmagro/config";
import { esperaDoInbound, reprocessarInboundFalhos, inboundFalhosUltimaHora, INBOUND_TENTATIVAS } from "./inbound-queue";
import { erroDeInfra, erroDeRls, PREFIXO_INFRA } from "./service";
import { avaliarMotor } from "../health/motor";

/**
 * Auditoria do #56 (item 0.8): banco fora por mais de ~21 min perdia a mensagem
 * recebida de vez. Fila própria do teste no Redis de TESTE; nada é gravado.
 */
const sufixo = Math.random().toString(36).slice(2, 8);
const NOME = `inbound-teste-${sufixo}`;
const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const fila = new Queue(NOME, { connection: conn });

afterAll(async () => {
  await fila.obliterate({ force: true });
  await fila.close();
  conn.disconnect();
});

/** Faz um job falhar DE VEZ (esgota as `tentativas`) com a mensagem dada. */
async function falhar(nome: string, erro: string, tipo = "message", tentativas = 1): Promise<Job> {
  const job = await fila.add(tipo, { x: 1 }, { jobId: `${nome}-${sufixo}`, attempts: tentativas, backoff: { type: "fixed", delay: 10 } });
  const w = new Worker(NOME, async () => { throw new Error(erro); }, { connection: new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null }), autorun: true });
  await new Promise<void>((ok) => w.on("failed", (j) => { if (j && j.id === job.id && j.attemptsMade >= tentativas) ok(); }));
  await w.close();
  return job;
}

describe("inbound resiste a banco fora", () => {
  it("20 tentativas, espera dobrando a partir de 5 s e limitada a 10 min (≈ 2,5 h no total)", () => {
    expect(INBOUND_TENTATIVAS).toBe(20);
    expect(esperaDoInbound(1)).toBe(5_000);
    expect(esperaDoInbound(2)).toBe(10_000);
    expect(esperaDoInbound(12)).toBe(10 * 60_000);
    const total = Array.from({ length: INBOUND_TENTATIVAS - 1 }, (_, i) => esperaDoInbound(i + 1)).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(2 * 3_600_000); // antes: ~21 min
  });

  it("falha de INFRA volta para a fila com as tentativas ZERADAS; erro de código e evento de conexão não", async () => {
    const infra = await falhar("infra", `${PREFIXO_INFRA} Can't reach database server`, "message", 3);
    const bug = await falhar("bug", "TypeError: cannot read properties of undefined");
    const conexao = await falhar("conexao", `${PREFIXO_INFRA} timed out`, "conexao");
    expect(await inboundFalhosUltimaHora(Date.now(), fila)).toBe(3);

    expect(await reprocessarInboundFalhos(Date.now(), fila)).toEqual({ reprocessados: 1 });
    const volta = (await fila.getJob(infra.id!))!;
    expect(await volta.getState()).toBe("waiting");
    // Auditoria do #105: sem resetAttemptsMade o job voltava com as tentativas
    // gastas e falhava na 1ª, sem espera.
    expect(volta.attemptsMade).toBe(0);
    expect(await (await fila.getJob(bug.id!))!.getState()).toBe("failed");
    // Evento de conexão velho não é reaplicado (pausaria a conta que já voltou).
    expect(await (await fila.getJob(conexao.id!))!.getState()).toBe("failed");
  });

  it("classifica banco/rede fora pelo código ou pela mensagem do Prisma", () => {
    expect(erroDeInfra(Object.assign(new Error("x"), { name: "PrismaClientInitializationError" }))).toBe(true);
    expect(erroDeInfra(Object.assign(new Error("x"), { code: "P1017" }))).toBe(true);
    expect(erroDeInfra(new Error("Operations timed out after 10s"))).toBe(true);
    expect(erroDeInfra(new Error("Server has closed the connection."))).toBe(true);
    expect(erroDeInfra(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toBe(true);
    expect(erroDeInfra(new Error("Unique constraint failed"))).toBe(false);
    expect(erroDeInfra(new TypeError("cannot read properties of undefined"))).toBe(false);
  });

  it("P2028 (transação interativa que não começou a tempo) é infra, e P2024 também: repetir resolve quando a carga baixa", () => {
    expect(erroDeInfra(Object.assign(new Error("Transaction API error: Unable to start a transaction in the given time."), { code: "P2028" }))).toBe(true);
    expect(erroDeInfra(Object.assign(new Error("Timed out fetching a new connection from the connection pool"), { code: "P2024" }))).toBe(true);
    expect(erroDeInfra(new Error("Transaction API error: Unable to start a transaction in the given time."))).toBe(true);
  });

  it("erro de RLS ou de privilégio perdido é reconhecido (para gritar no log), e NÃO é infra (repetir não resolve)", () => {
    const rls = new Error('new row violates row-level security policy for table "Contact"');
    const privilegio = Object.assign(new Error("Raw query failed"), { meta: { message: 'ERROR: permission denied for table "Message"' } });
    expect(erroDeRls(rls)).toBe(true);
    expect(erroDeRls(privilegio)).toBe(true);
    expect(erroDeInfra(rls)).toBe(false);
    expect(erroDeRls(new Error("Unique constraint failed"))).toBe(false);
    expect(erroDeRls(null)).toBe(false);
  });

  it("o health do motor fica degraded com mensagem recebida não gravada", () => {
    const vazia = { waiting: 0, delayed: 0, active: 0, failed: 0, atrasoMs: 0 };
    expect(avaliarMotor({ flow: vazia, social: vazia, orfas: 0, inboundPerdidas: 2 })[0]).toMatch(/2 mensagem\(ns\) recebida\(s\) NÃO gravada/);
    expect(avaliarMotor({ flow: vazia, social: vazia, orfas: 0, inboundPerdidas: 0 })).toEqual([]);
  });
});
