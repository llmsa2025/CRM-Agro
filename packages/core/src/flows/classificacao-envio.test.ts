import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  ChannelSendFailed,
  classificarErroDeRede,
  classificarErroSmtp,
  evolutionFetch,
  exigirOk,
  falhaHttp,
  isChannelSendFailed,
} from "@crmagro/channels";

/**
 * Classificação do erro de envio (item 1.2, MF-03/INT-15): o motor precisa
 * saber se a mensagem SAIU. Testa contra um servidor HTTP LOCAL (sem Evolution
 * de verdade, sem envio real).
 */

let servidor: http.Server;
let base = "";

beforeAll(async () => {
  servidor = http.createServer((req, res) => {
    if (req.url === "/500") {
      res.writeHead(500).end("erro interno");
    } else if (req.url === "/400") {
      res.writeHead(400).end("numero invalido");
    } else if (req.url === "/trava") {
      // Não responde nunca: simula a Evolution travada (Baileys preso).
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end('{"key":{"id":"ABC"}}');
    }
  });
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(async () => {
  servidor.closeAllConnections?.();
  await new Promise<void>((r) => servidor.close(() => r()));
});

describe("Evolution: rede e HTTP", () => {
  it("5xx → não saiu, vale repetir; 4xx → não saiu, sem retry", async () => {
    const e500 = await exigirOk(await evolutionFetch(`${base}/500`, {}, 2000, "teste"), "teste").catch((e) => e);
    expect(isChannelSendFailed(e500)).toBe(true);
    expect(e500).toMatchObject({ outcome: "not_sent", retryable: true, status: 500 });

    const e400 = await exigirOk(await evolutionFetch(`${base}/400`, {}, 2000, "teste"), "teste").catch((e) => e);
    expect(e400).toMatchObject({ outcome: "not_sent", retryable: false, status: 400 });
  });

  it("Evolution travada → timeout = INCERTO (pode ter saído), nunca 'não saiu'", async () => {
    const t0 = Date.now();
    const e = await evolutionFetch(`${base}/trava`, {}, 300, "teste").catch((x) => x);
    expect(Date.now() - t0).toBeLessThan(3000); // não segura 300 s como antes
    expect(e).toMatchObject({ outcome: "unknown", retryable: false });
  });

  it("porta fechada (conexão recusada) → não saiu, vale repetir", async () => {
    const fechado = http.createServer();
    await new Promise<void>((r) => fechado.listen(0, "127.0.0.1", () => r()));
    const porta = (fechado.address() as AddressInfo).port;
    await new Promise<void>((r) => fechado.close(() => r()));
    const e = await evolutionFetch(`http://127.0.0.1:${porta}/x`, {}, 2000, "teste").catch((x) => x);
    expect(e).toMatchObject({ outcome: "not_sent", retryable: true });
  });

  it("2xx passa", async () => {
    const r = await evolutionFetch(`${base}/ok`, {}, 2000, "teste");
    await expect(exigirOk(r, "teste")).resolves.toBeUndefined();
  });

  it("helpers puros", () => {
    expect(falhaHttp(429, "", "x").retryable).toBe(true);
    expect(classificarErroDeRede({ cause: { code: "ENOTFOUND" } }, "x").outcome).toBe("not_sent");
    expect(classificarErroDeRede({ name: "TimeoutError" }, "x").outcome).toBe("unknown");
    expect(isChannelSendFailed(new ChannelSendFailed("x", "unknown", false))).toBe(true);
    expect(isChannelSendFailed(new Error("x"))).toBe(false);
  });
});

describe("SMTP", () => {
  it.each([
    [{ responseCode: 421, message: "tente mais tarde" }, "not_sent", true],
    [{ responseCode: 550, message: "caixa inexistente" }, "not_sent", false],
    [{ code: "EENVELOPE", message: "destinatário recusado" }, "not_sent", false],
    [{ code: "ECONNECTION", message: "sem conexão" }, "not_sent", true],
    [{ code: "EAUTH", message: "senha errada" }, "not_sent", true],
    [{ code: "ETIMEDOUT", command: "DATA", message: "timeout" }, "unknown", false],
  ] as const)("%o → %s (retry %s)", (erro, outcome, retryable) => {
    expect(classificarErroSmtp(erro)).toMatchObject({ outcome, retryable });
  });
});
