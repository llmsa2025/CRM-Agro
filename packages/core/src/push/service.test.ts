import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { ZodError } from "zod";
import { env } from "@crmagro/config";
import { basePrisma, runAsSystem, runWithTeam } from "@crmagro/db";

/**
 * Web Push: assinatura pela sessão, envio por papel/usuário, limpeza de
 * assinatura morta, timeout, push desligado sem chave — e os "dois times": a
 * assinatura de um time nunca recebe o push do outro. O `web-push` é MOCKADO:
 * nenhum aviso sai de verdade.
 */
const wp = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(async (..._args: unknown[]) => ({ statusCode: 201, body: "", headers: {} })),
}));
vi.mock("web-push", () => ({ default: wp, ...wp }));

const {
  salvarAssinaturaPush,
  removerAssinaturaPush,
  enviarPush,
  chavePublicaPush,
  reiniciarPushParaTeste,
} = await import("./service");
const { aplicarEstadoDaConexao } = await import("../integrations/whatsapp-conexao");
const { alertarSeDegradado } = await import("../health/alerta");
const { redisEstado } = await import("../shared/redis-cache");
const { logger } = await import("../logger/index");

const TEAM = "00000000-0000-0000-0000-0000000006a1";
const OUTRO = "00000000-0000-0000-0000-0000000006a2";
const sufixo = Math.random().toString(36).slice(2, 8);

const U = {
  donoA: `push-${sufixo}-dono-a`,
  adminA: `push-${sufixo}-admin-a`,
  membroA: `push-${sufixo}-membro-a`,
  donoB: `push-${sufixo}-dono-b`,
};
const USUARIOS: Array<{ id: string; teamId: string; role: string }> = [
  { id: U.donoA, teamId: TEAM, role: "owner" },
  { id: U.adminA, teamId: TEAM, role: "admin" },
  { id: U.membroA, teamId: TEAM, role: "member" },
  { id: U.donoB, teamId: OUTRO, role: "owner" },
];

const ep = (nome: string) => `https://fcm.googleapis.com/fcm/send/${sufixo}-${nome}`;
const assinatura = (nome: string) => ({ endpoint: ep(nome), keys: { p256dh: `p256-${nome}`, auth: `auth-${nome}` } });

/** Executa como o usuário (sessão): time e papel dele. */
function como<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const u = USUARIOS.find((x) => x.id === userId)!;
  return runWithTeam(u.teamId, fn, { userId, role: u.role });
}

const VAPID = { VAPID_PUBLIC_KEY: "BChavePublicaDeTeste", VAPID_PRIVATE_KEY: "privada-de-teste", VAPID_SUBJECT: "mailto:ops@exemplo.com.br" };
const envOriginal = { VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY, VAPID_SUBJECT: env.VAPID_SUBJECT };

async function limpar() {
  for (const teamId of [TEAM, OUTRO]) {
    await basePrisma.pushSubscription.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
  }
}

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Push A (test)" } });
  await basePrisma.team.upsert({ where: { id: OUTRO }, update: {}, create: { id: OUTRO, name: "Team Push B (test)" } });
  for (const u of USUARIOS) {
    await basePrisma.user.create({ data: { ...u, name: u.id, email: `${u.id}@teste.crmagro` } });
  }
});
beforeEach(async () => {
  Object.assign(env, VAPID);
  reiniciarPushParaTeste();
  wp.setVapidDetails.mockClear();
  wp.sendNotification.mockReset();
  wp.sendNotification.mockImplementation(async () => ({ statusCode: 201, body: "", headers: {} }));
  await limpar();
});
afterAll(async () => {
  Object.assign(env, envOriginal);
  reiniciarPushParaTeste();
  await limpar();
  for (const teamId of [TEAM, OUTRO]) await basePrisma.user.deleteMany({ where: { teamId, id: { in: Object.values(U) } } });
});

const destinos = () => wp.sendNotification.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint).sort();

describe("assinatura (sessão)", () => {
  it("grava com time e usuário da SESSÃO; viewer também pode; o motor não assina", async () => {
    await como(U.membroA, () => salvarAssinaturaPush(assinatura("membro"), "Mozilla/5.0 teste"));
    const linha = await basePrisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: ep("membro") } });
    expect(linha).toMatchObject({ teamId: TEAM, userId: U.membroA, p256dh: "p256-membro", auth: "auth-membro", userAgent: "Mozilla/5.0 teste" });

    await runWithTeam(TEAM, () => salvarAssinaturaPush(assinatura("viewer")), { userId: U.membroA, role: "viewer" });
    expect(await basePrisma.pushSubscription.count({ where: { endpoint: ep("viewer") } })).toBe(1);

    await expect(runAsSystem(TEAM, () => salvarAssinaturaPush(assinatura("motor")))).rejects.toThrow(/negado/i);
  });

  it("endpoint fora dos serviços de push conhecidos (SSRF) → recusado", async () => {
    for (const endpoint of ["http://127.0.0.1:6379/x", "https://metadata.google.internal/x", "https://fcm.googleapis.com.evil.com/x", "https://fcm.googleapis.com:8443/x"]) {
      await expect(como(U.donoA, () => salvarAssinaturaPush({ endpoint, keys: { p256dh: "a", auth: "b" } }))).rejects.toBeInstanceOf(ZodError);
    }
    expect(await basePrisma.pushSubscription.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("mesmo navegador assinado por alguém do OUTRO time: a linha antiga sai (dois times)", async () => {
    await como(U.donoA, () => salvarAssinaturaPush(assinatura("compartilhado")));
    await como(U.donoB, () => salvarAssinaturaPush(assinatura("compartilhado")));
    const linhas = await basePrisma.pushSubscription.findMany({ where: { endpoint: ep("compartilhado") } });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ teamId: OUTRO, userId: U.donoB });
    // O push do time A não chega mais nesse navegador.
    expect(await runAsSystem(TEAM, () => enviarPush({ papelMinimo: "admin" }, { titulo: "t", corpo: "c" }))).toMatchObject({ enviados: 0 });
    expect(wp.sendNotification).not.toHaveBeenCalled();
  });

  it("remover só apaga a assinatura do próprio usuário", async () => {
    await como(U.donoA, () => salvarAssinaturaPush(assinatura("dono")));
    expect(await como(U.adminA, () => removerAssinaturaPush({ endpoint: ep("dono") }))).toEqual({ removidas: 0 });
    expect(await como(U.donoA, () => removerAssinaturaPush({ endpoint: ep("dono") }))).toEqual({ removidas: 1 });
  });

  it("teto de 10 navegadores: sai o usado há mais tempo, nunca o que acabou de assinar", async () => {
    const base = Date.now() - 30 * 24 * 60 * 60_000;
    for (let i = 0; i < 10; i++) {
      await basePrisma.pushSubscription.create({
        data: {
          teamId: TEAM,
          userId: U.donoA,
          endpoint: ep(`n${i}`),
          p256dh: "k",
          auth: "a",
          createdAt: new Date(base + i * 60_000),
          // A mais ANTIGA (n0) é a que recebeu aviso por último: fica.
          ultimoOkEm: i === 0 ? new Date() : null,
        },
      });
    }
    // Reassinar um navegador antigo (n1) não o torna candidato a sair.
    await como(U.donoA, () => salvarAssinaturaPush(assinatura("n1")));
    await como(U.donoA, () => salvarAssinaturaPush(assinatura("novo")));
    const restantes = (await basePrisma.pushSubscription.findMany({ where: { userId: U.donoA } })).map((x) => x.endpoint);
    expect(restantes).toHaveLength(10);
    expect(restantes).toEqual(expect.arrayContaining([ep("novo"), ep("n0"), ep("n1")]));
    expect(restantes).not.toContain(ep("n2")); // a menos usada
  });

  it("chave pública: presente com VAPID; null sem (push desligado)", () => {
    expect(chavePublicaPush()).toEqual({ chave: VAPID.VAPID_PUBLIC_KEY });
    Object.assign(env, { VAPID_PRIVATE_KEY: undefined });
    expect(chavePublicaPush()).toEqual({ chave: null });
  });
});

describe("enviarPush", () => {
  async function assinarTodos() {
    await como(U.donoA, () => salvarAssinaturaPush(assinatura("dono-a")));
    await como(U.adminA, () => salvarAssinaturaPush(assinatura("admin-a")));
    await como(U.membroA, () => salvarAssinaturaPush(assinatura("membro-a")));
    await como(U.donoB, () => salvarAssinaturaPush(assinatura("dono-b")));
  }

  it("papel mínimo admin: owner + admin do time do contexto; nunca o outro time (dois times)", async () => {
    await assinarTodos();
    const r = await runAsSystem(TEAM, () => enviarPush({ papelMinimo: "admin" }, { titulo: "Oi", corpo: "Corpo", url: "/x", tag: "t1" }));
    expect(r).toEqual({ enviados: 2, removidas: 0, falhas: 0 });
    expect(destinos()).toEqual([ep("admin-a"), ep("dono-a")].sort());
    expect(JSON.parse(wp.sendNotification.mock.calls[0]![1] as string)).toEqual({ titulo: "Oi", corpo: "Corpo", url: "/x", tag: "t1" });
    const ok = await basePrisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: ep("dono-a") } });
    expect(ok.ultimoOkEm).not.toBeNull();
  });

  it("por userIds: id de usuário do outro time não acha assinatura (dois times)", async () => {
    await assinarTodos();
    const r = await runAsSystem(TEAM, () => enviarPush({ userIds: [U.membroA, U.donoB] }, { titulo: "t", corpo: "c" }));
    expect(r.enviados).toBe(1);
    expect(destinos()).toEqual([ep("membro-a")]);
  });

  it("404/410 apaga a assinatura morta; outro erro conta falha e mantém; nunca lança", async () => {
    await assinarTodos();
    wp.sendNotification.mockImplementation(async (...args: unknown[]) => {
      const endpoint = (args[0] as { endpoint: string }).endpoint;
      if (endpoint === ep("dono-a")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      throw Object.assign(new Error("Erro do serviço"), { statusCode: 500 });
    });
    const r = await runAsSystem(TEAM, () => enviarPush({ papelMinimo: "admin" }, { titulo: "t", corpo: "c" }));
    expect(r).toEqual({ enviados: 0, removidas: 1, falhas: 1 });
    expect(await basePrisma.pushSubscription.count({ where: { endpoint: ep("dono-a") } })).toBe(0);
    expect(await basePrisma.pushSubscription.count({ where: { endpoint: ep("admin-a") } })).toBe(1);
  });

  it("serviço de push que não responde: corta no timeout e segue", async () => {
    await como(U.donoA, () => salvarAssinaturaPush(assinatura("lento")));
    wp.sendNotification.mockImplementation(() => new Promise(() => {}));
    const inicio = Date.now();
    const r = await runAsSystem(TEAM, () => enviarPush({ papelMinimo: "admin" }, { titulo: "t", corpo: "c" }, { timeoutMs: 100 }));
    expect(r).toEqual({ enviados: 0, removidas: 0, falhas: 1 });
    expect(Date.now() - inicio).toBeLessThan(5_000);
  });

  it("sem as chaves VAPID: desligado, não chama o web-push e loga UMA vez", async () => {
    await assinarTodos();
    Object.assign(env, { VAPID_PUBLIC_KEY: undefined });
    reiniciarPushParaTeste();
    const info = vi.spyOn(logger, "info");
    try {
      for (let i = 0; i < 2; i++) {
        expect(await runAsSystem(TEAM, () => enviarPush({ papelMinimo: "admin" }, { titulo: "t", corpo: "c" }))).toEqual({
          enviados: 0,
          removidas: 0,
          falhas: 0,
        });
      }
      expect(wp.sendNotification).not.toHaveBeenCalled();
      expect(info.mock.calls.filter((c) => String(c[0]).includes("[push] desligado"))).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  it("chave VAPID inválida: desligado, sem lançar", async () => {
    await assinarTodos();
    wp.setVapidDetails.mockImplementationOnce(() => {
      throw new Error("Vapid public key should be 65 bytes long when decoded.");
    });
    expect(await runAsSystem(TEAM, () => enviarPush({ papelMinimo: "admin" }, { titulo: "t", corpo: "c" }))).toMatchObject({ enviados: 0 });
    expect(wp.sendNotification).not.toHaveBeenCalled();
  });
});

describe("alertas que já existiam, agora com push", () => {
  it("WhatsApp caiu → push para owner/admin DO TIME da conta, nunca do outro (dois times)", async () => {
    await como(U.donoA, () => salvarAssinaturaPush(assinatura("dono-a")));
    await como(U.membroA, () => salvarAssinaturaPush(assinatura("membro-a")));
    await como(U.donoB, () => salvarAssinaturaPush(assinatura("dono-b")));
    const conta = await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "whatsapp", label: "Comercial", provider: "evolution", externalId: `push-${sufixo}`, status: "connected" },
    });
    expect(await aplicarEstadoDaConexao({ instance: conta.externalId!, state: "close" })).toBe("desconectou");
    await vi.waitFor(() => expect(wp.sendNotification).toHaveBeenCalled());
    expect(destinos()).toEqual([ep("dono-a")]);
    expect(JSON.parse(wp.sendNotification.mock.calls[0]![1] as string)).toMatchObject({
      titulo: "WhatsApp desconectado",
      url: "/integracoes",
      tag: `wa-caiu-${conta.id}`,
    });
  });

  it("motor degradado → push para owner/admin do time de operação (ALERT_TEAM_ID), junto do e-mail", async () => {
    await como(U.adminA, () => salvarAssinaturaPush(assinatura("admin-a")));
    await como(U.donoB, () => salvarAssinaturaPush(assinatura("dono-b")));
    const motivo = `teste push ${sufixo} fila flow atrasada 12 min`;
    const antes = { team: process.env.ALERT_TEAM_ID, emails: process.env.ALERT_EMAILS };
    process.env.ALERT_TEAM_ID = TEAM;
    process.env.ALERT_EMAILS = "ops@exemplo.com.br";
    const email = vi.fn(async () => {});
    try {
      const vazia = { waiting: 0, delayed: 0, active: 0, failed: 0, atrasoMs: 0 };
      const r = {
        status: "degraded" as const,
        timestamp: new Date().toISOString(),
        uptime_seconds: 1,
        checks: {
          database: { status: "healthy" as const, latency_ms: 1 },
          redis: { status: "healthy" as const, latency_ms: 1 },
          evolution: { status: "healthy" as const, latency_ms: 1 },
          worker: { status: "healthy" as const, latency_ms: 1 },
          emailPlataforma: { status: "healthy" as const, latency_ms: 0 },
          motor: { status: "unhealthy" as const, latency_ms: 1, error: motivo, filas: { flow: vazia, social: vazia }, orfas: 0, falhasUltimaHora: 0, workers: [], motivos: [motivo] },
        },
      };
      expect(await alertarSeDegradado(r, email)).toEqual([`motor: ${motivo}`]);
      expect(email).toHaveBeenCalledTimes(1);
      expect(destinos()).toEqual([ep("admin-a")]);
      expect(JSON.parse(wp.sendNotification.mock.calls[0]![1] as string).titulo).toContain("CRM Agro degraded");
    } finally {
      process.env.ALERT_TEAM_ID = antes.team;
      process.env.ALERT_EMAILS = antes.emails;
      if (antes.team === undefined) delete process.env.ALERT_TEAM_ID;
      if (antes.emails === undefined) delete process.env.ALERT_EMAILS;
      const chaves = await redisEstado().keys(`alerta:saude:motor:teste push ${sufixo}*`);
      if (chaves.length) await redisEstado().del(...chaves);
    }
  });
});
