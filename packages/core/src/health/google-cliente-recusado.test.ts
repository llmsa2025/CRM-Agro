import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { basePrisma } from "@crmagro/db";

/**
 * Saúde do motor: conexão do Google Agenda parada porque o Google recusa o cliente OAuth do servidor
 * (13/10/2026: `invalid_client` ficou 22 horas só como aviso no log do worker). Banco de TESTE real;
 * o Redis só entra no teste que passa pelo `checkMotor`.
 */
const { conexoesGoogleComClienteRecusado, avaliarMotor, checkMotor, FALHAS_DO_GOOGLE_PARA_AVISAR } = await import("./motor");
const { categoriaDoMotivo, MOTIVOS_DO_ALERTA } = await import("./alertas-config");
const { motivosDoRelatorio } = await import("./alerta");
const { redisEstado } = await import("../shared/redis-cache");

const sufixo = Math.random().toString(36).slice(2, 8);
const TIME_A = `saude-google-a-${sufixo}`;
const TIME_B = `saude-google-b-${sufixo}`;
const vazia = { waiting: 0, delayed: 0, active: 0, failed: 0, atrasoMs: 0 };
const EMAIL = `pessoa-${sufixo}@exemplo.com.br`;

let n = 0;
/** Cria pessoa + conexão + agenda sincronizada com o estado de falha pedido. Devolve só os ids. */
async function conexao(teamId: string, o: { falhas: number; ultimoErro: string | null; status?: "connected" | "reauth_required"; paradaHaHoras?: number }) {
  const i = ++n;
  const user = await basePrisma.user.create({ data: { teamId, role: "member", name: `Pessoa ${i}`, email: i === 1 ? EMAIL : `p${i}-${sufixo}@exemplo.com.br` } });
  const c = await basePrisma.oAuthConnection.create({
    data: {
      teamId,
      userId: user.id,
      provider: "google",
      externalAccountId: `sub-${i}-${sufixo}`,
      email: user.email,
      scopes: ["openid", "email"],
      credentials: { cifrado: "x" },
      status: o.status ?? "connected",
    },
  });
  await basePrisma.calendarSync.create({
    data: {
      teamId,
      connectionId: c.id,
      calendarId: "primary",
      falhas: o.falhas,
      ultimoErro: o.ultimoErro,
      updatedAt: new Date(Date.now() - (o.paradaHaHoras ?? 0) * 3_600_000),
    },
  });
  return { userId: user.id, connectionId: c.id };
}

async function limpar() {
  for (const teamId of [TIME_A, TIME_B]) {
    await basePrisma.calendarSync.deleteMany({ where: { teamId } });
    await basePrisma.oAuthConnection.deleteMany({ where: { teamId } });
    await basePrisma.user.deleteMany({ where: { teamId } });
  }
}

beforeAll(async () => {
  for (const id of [TIME_A, TIME_B]) await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: `Saúde Google ${id}` } });
  await limpar();
});
afterAll(async () => {
  await limpar();
  for (const id of [TIME_A, TIME_B]) await basePrisma.team.deleteMany({ where: { id } });
  await redisEstado().del("saude:motor");
});

describe("conexões do Google com o cliente OAuth recusado", () => {
  it("conta só quem falha seguido por erro de cliente recusado, há pouco, com a conexão ativa (entre times)", async () => {
    const base = await conexoesGoogleComClienteRecusado();
    // Contam (dois times: a saúde é da plataforma).
    await conexao(TIME_A, { falhas: 22, ultimoErro: "GoogleApiErro: HTTP 401 (invalid_client)" });
    await conexao(TIME_A, { falhas: FALHAS_DO_GOOGLE_PARA_AVISAR, ultimoErro: "GoogleApiErro: HTTP 401 (deleted_client)" });
    await conexao(TIME_B, { falhas: 5, ultimoErro: "GoogleApiErro: HTTP 400 (unauthorized_client)" });
    expect(await conexoesGoogleComClienteRecusado()).toBe(base + 3);

    // Não contam: poucas falhas, erro passageiro, erro sem relação, sem erro, conexão que já pede reconexão, falha antiga.
    await conexao(TIME_A, { falhas: FALHAS_DO_GOOGLE_PARA_AVISAR - 1, ultimoErro: "GoogleApiErro: HTTP 401 (invalid_client)" });
    await conexao(TIME_A, { falhas: 9, ultimoErro: "GoogleApiErro: HTTP 503 (backendError)" });
    await conexao(TIME_A, { falhas: 9, ultimoErro: "GoogleApiErro: HTTP 403 (rateLimitExceeded)" });
    await conexao(TIME_A, { falhas: 9, ultimoErro: "2 evento(s) não aplicado(s). Tenta de novo" });
    await conexao(TIME_A, { falhas: 9, ultimoErro: null });
    await conexao(TIME_B, { falhas: 9, ultimoErro: "GoogleApiErro: HTTP 401 (invalid_client)", status: "reauth_required" });
    await conexao(TIME_B, { falhas: 9, ultimoErro: "GoogleApiErro: HTTP 401 (invalid_client)", paradaHaHoras: 5 });
    expect(await conexoesGoogleComClienteRecusado()).toBe(base + 3);
  });

  it("volta a zero sozinho quando a sincronização funciona de novo (falhas e erro zerados)", async () => {
    const base = await conexoesGoogleComClienteRecusado();
    const { connectionId } = await conexao(TIME_A, { falhas: 8, ultimoErro: "GoogleApiErro: HTTP 401 (invalid_client)" });
    expect(await conexoesGoogleComClienteRecusado()).toBe(base + 1);
    await basePrisma.calendarSync.updateMany({ where: { connectionId }, data: { falhas: 0, ultimoErro: null } });
    expect(await conexoesGoogleComClienteRecusado()).toBe(base);
  });

  it("o motivo do alerta leva só o número: nenhum e-mail, nome ou id de pessoa ou de time", async () => {
    const { userId, connectionId } = await conexao(TIME_A, { falhas: 30, ultimoErro: "GoogleApiErro: HTTP 401 (invalid_client)" });
    const total = await conexoesGoogleComClienteRecusado();
    const [motivo] = avaliarMotor({ flow: vazia, social: vazia, orfas: 0, googleComClienteRecusado: total });
    expect(motivo).toMatch(new RegExp(`^${total} conexão\\(ões\\) do Google Agenda sem sincronizar`));
    // Cobre secret OU client ID recusado: a mensagem não afirma que o culpado é o secret.
    expect(motivo).toContain("o Google recusa as credenciais do cliente OAuth do servidor");
    expect(motivo).not.toMatch(/recusa o secret/);
    expect(motivo).not.toContain("secret (invalid_client)");
    expect(motivo).toMatch(/client ID e o secret do cliente OAuth/);
    for (const proibido of [EMAIL, "exemplo.com.br", userId, connectionId, TIME_A, TIME_B, "Pessoa", "@", "GOCSPX"]) expect(motivo).not.toContain(proibido);
  });

  it("passa pelo checkMotor: o motor fica unhealthy (health degraded) e o relatório só tem o número", async () => {
    await redisEstado().del("saude:motor");
    await conexao(TIME_A, { falhas: 12, ultimoErro: "GoogleApiErro: HTTP 401 (invalid_client)" });
    try {
      const motor = await checkMotor();
      expect(motor.status).toBe("unhealthy");
      expect(motor.googleComClienteRecusado).toBeGreaterThanOrEqual(1);
      expect(motor.motivos.some((m) => /conexão\(ões\) do Google Agenda sem sincronizar/.test(m))).toBe(true);
      expect(JSON.stringify(motor)).not.toContain(EMAIL);
    } finally {
      await redisEstado().del("saude:motor");
    }
  });
});

describe("avaliação e alerta", () => {
  it("sem conexão com problema não há motivo; com problema há exatamente um", () => {
    expect(avaliarMotor({ flow: vazia, social: vazia, orfas: 0, googleComClienteRecusado: 0 })).toEqual([]);
    expect(avaliarMotor({ flow: vazia, social: vazia, orfas: 0 })).toEqual([]);
    expect(avaliarMotor({ flow: vazia, social: vazia, orfas: 0, googleComClienteRecusado: 1 })).toHaveLength(1);
  });

  it("tem categoria própria na tela de alertas (liga e desliga) e não cai em 'Motor de fluxos atrasado'", () => {
    const [motivo] = avaliarMotor({ flow: vazia, social: vazia, orfas: 0, googleComClienteRecusado: 2 });
    expect(categoriaDoMotivo("motor", motivo)).toBe("google_agenda");
    expect(MOTIVOS_DO_ALERTA.some((m) => m.chave === "google_agenda" && m.rotulo === "Agenda do Google")).toBe(true);
    // Os motivos antigos continuam nas categorias de antes.
    expect(categoriaDoMotivo("motor", "fila flow atrasada 12 min")).toBe("motor_filas");
    expect(categoriaDoMotivo("motor", "3 inscrição(ões) órfã(s) há mais de 15 min")).toBe("motor_inscricoes");
  });

  it("a trava do alerta ignora o número: 2 e 3 conexões são o mesmo motivo (não repete o e-mail)", () => {
    const relatorio = (n: number) => {
      const motivo = avaliarMotor({ flow: vazia, social: vazia, orfas: 0, googleComClienteRecusado: n })[0] ?? "";
      return {
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
    };
    const a = motivosDoRelatorio(relatorio(2))[0];
    const b = motivosDoRelatorio(relatorio(3))[0];
    expect(a?.chave).toBe(b?.chave);
    expect(a?.categoria).toBe("google_agenda");
    expect(a?.texto).toMatch(/^motor: 2 conexão/);
  });
});
