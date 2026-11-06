import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basePrisma } from "@crmagro/db";

/**
 * O motor de alertas respeitando a configuração da tela (alertas-config.ts +
 * alerta.ts): configuração vence o .env, desligado não envia, motivo e canal
 * desligados, intervalo mínimo, registro do que foi enviado. Banco e Redis de
 * TESTE reais; o e-mail e o Web Push são espiões (nada sai).
 */
const pushReal = vi.hoisted(() => ({
  enviarPush: vi.fn(async (_alvo: unknown, _p: unknown) => ({
    enviados: 1,
    removidas: 0,
    falhas: 0,
  })),
}));
vi.mock("../push/service", async (orig) => {
  const real = await orig<typeof import("../push/service")>();
  return { ...real, enviarPush: pushReal.enviarPush };
});

const { alertarSeDegradado, pushParaOperacao, motivosDoRelatorio } = await import("./alerta");
const { ID_DA_CONFIG_DE_ALERTAS, categoriaDoMotivo, configEfetiva, esperaEmSegundos } =
  await import("./alertas-config");
const { redisEstado } = await import("../shared/redis-cache");

const TEAM_OP = "00000000-0000-0000-0000-0000000a1e11";
const sufixo = Math.random().toString(36).slice(2, 8);
const antes = { emails: process.env.ALERT_EMAILS, time: process.env.ALERT_TEAM_ID };
const vazia = { waiting: 0, delayed: 0, active: 0, failed: 0, atrasoMs: 0 };

const ok = { status: "healthy" as const, latency_ms: 1 };
/** Relatório degradado com os checks pedidos fora do ar (o texto do erro de propósito tem host e porta). */
function relatorio(
  fora: Array<
    | "database"
    | "redis"
    | "evolution"
    | "worker"
    | "emailPlataforma"
    | "motor-filas"
    | "motor-inscricoes"
  >,
) {
  const r = {
    status:
      fora.includes("database") || fora.includes("redis")
        ? ("unhealthy" as const)
        : ("degraded" as const),
    timestamp: new Date().toISOString(),
    uptime_seconds: 1,
    checks: {
      database: ok,
      redis: ok,
      evolution: ok,
      worker: ok,
      emailPlataforma: ok,
      motor: {
        ...ok,
        filas: { flow: vazia, social: vazia },
        orfas: 0,
        falhasUltimaHora: 0,
        workers: [],
        motivos: [] as string[],
      },
    },
  };
  const falha = {
    status: "unhealthy" as const,
    latency_ms: 1,
    error: "connect ECONNREFUSED db.interno.exemplo:5432 senha=abc",
  };
  for (const f of fora) {
    if (f === "motor-filas" || f === "motor-inscricoes") {
      const m =
        f === "motor-filas"
          ? `fila flow atrasada 1${sufixo.length} min ${sufixo}`
          : `3 inscrição(ões) órfã(s) há mais de 15 min ${sufixo}`;
      const motivos = [...r.checks.motor.motivos, m];
      (r.checks as Record<string, unknown>).motor = {
        ...r.checks.motor,
        status: "unhealthy",
        error: motivos.join("; "),
        motivos,
      };
    } else (r.checks as Record<string, unknown>)[f] = falha;
  }
  return r as unknown as Parameters<typeof alertarSeDegradado>[0];
}

/** Os dígitos do motivo viram "#" na chave da trava (`motivosDoRelatorio`). */
const sufixoNaChave = sufixo.replace(/\d+/g, "#");
const CHAVES_REDIS = ["database", "redis", "evolution", "worker", "emailPlataforma"];
async function limparRedis() {
  const r = redisEstado();
  const chaves = [
    ...CHAVES_REDIS.flatMap((c) => [
      `alerta:saude:${c}`,
      `alerta:saude:email:${c}`,
      `alerta:saude:email:n:${c}`,
    ]),
    ...(await r.keys(`alerta:saude:*${sufixoNaChave}*`)),
    ...(await r.keys(`alerta:saude:email:*${sufixoNaChave}*`)),
    ...(await r.keys(`alerta:saude:email:n:*${sufixoNaChave}*`)),
  ];
  if (chaves.length) await r.del(...chaves);
}

async function configurar(
  p: Partial<{
    ligado: boolean;
    emails: string[];
    canalEmail: boolean;
    canalPush: boolean;
    motivosDesligados: string[];
    intervaloMinimoMin: number;
    timeOperacaoId: string | null;
  }> = {},
) {
  const dados = {
    ligado: true,
    emails: ["tela@exemplo.com.br"],
    canalEmail: true,
    canalPush: true,
    motivosDesligados: [],
    intervaloMinimoMin: 30,
    timeOperacaoId: TEAM_OP,
    ...p,
  };
  await basePrisma.alertaConfig.upsert({
    where: { id: ID_DA_CONFIG_DE_ALERTAS },
    create: { id: ID_DA_CONFIG_DE_ALERTAS, ...dados },
    update: dados,
  });
}

const enviar = vi.fn(
  async (_para: string[], _assunto: string, _texto: string, _html?: string) => {},
);
const push = vi.fn(async (_titulo: string, _corpo: string) => {});

beforeEach(async () => {
  enviar.mockReset();
  enviar.mockImplementation(async () => {});
  push.mockReset();
  push.mockImplementation(async () => {});
  pushReal.enviarPush.mockClear();
  process.env.ALERT_EMAILS = "env@exemplo.com.br";
  process.env.ALERT_TEAM_ID = TEAM_OP;
  await basePrisma.alertaConfig.deleteMany({ where: { id: ID_DA_CONFIG_DE_ALERTAS } });
  await basePrisma.alertaEnviado.deleteMany({});
  await limparRedis();
});

afterAll(async () => {
  await basePrisma.alertaConfig.deleteMany({ where: { id: ID_DA_CONFIG_DE_ALERTAS } });
  await basePrisma.alertaEnviado.deleteMany({});
  await limparRedis();
  for (const [k, v] of [
    ["ALERT_EMAILS", antes.emails],
    ["ALERT_TEAM_ID", antes.time],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("categorias dos motivos", () => {
  it("cada check cai na sua categoria; o motor se divide em filas e inscrições", () => {
    expect(categoriaDoMotivo("database")).toBe("banco");
    expect(categoriaDoMotivo("redis")).toBe("redis");
    expect(categoriaDoMotivo("evolution")).toBe("whatsapp");
    expect(categoriaDoMotivo("worker")).toBe("worker");
    expect(categoriaDoMotivo("emailPlataforma")).toBe("email_plataforma");
    expect(categoriaDoMotivo("backup")).toBe("backup");
    expect(categoriaDoMotivo("motor", "fila flow atrasada 12 min")).toBe("motor_filas");
    expect(categoriaDoMotivo("motor", "3 mensagem(ns) recebida(s) NÃO gravada(s)")).toBe(
      "motor_filas",
    );
    expect(categoriaDoMotivo("motor", "2 inscrição(ões) órfã(s) há mais de 15 min")).toBe(
      "motor_inscricoes",
    );
    expect(categoriaDoMotivo("motor", "1018 inscrição(ões) segurada(s) pela pausa")).toBe(
      "motor_inscricoes",
    );
    // Check novo sem categoria: segue alertando sob o próprio nome.
    expect(categoriaDoMotivo("disco")).toBe("disco");
    expect(
      motivosDoRelatorio(relatorio(["evolution", "motor-inscricoes"])).map((m) => m.categoria),
    ).toEqual(["whatsapp", "motor_inscricoes"]);
  });

  it("a espera é o degrau da escada, nunca abaixo do intervalo mínimo", () => {
    expect(esperaEmSegundos(30 * 60, 30)).toBe(30 * 60);
    expect(esperaEmSegundos(30 * 60, 120)).toBe(120 * 60);
    expect(esperaEmSegundos(6 * 60 * 60, 120)).toBe(6 * 60 * 60);
    expect(esperaEmSegundos(30 * 60, 360)).toBe(360 * 60);
  });
});

describe("sem nada configurado: o comportamento de antes (.env)", () => {
  it("vale ALERT_EMAILS e o time do ALERT_TEAM_ID, tudo ligado", async () => {
    expect(await configEfetiva()).toEqual({
      origem: "env",
      ligado: true,
      emails: ["env@exemplo.com.br"],
      canais: { email: true, push: true },
      motivosDesligados: [],
      intervaloMinimoMin: 30,
      timeOperacaoId: TEAM_OP,
    });
    await alertarSeDegradado(relatorio(["worker"]), enviar, push);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]![0]).toEqual(["env@exemplo.com.br"]);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("sem ALERT_EMAILS nem configuração: nenhum e-mail (só o push e o log), como sempre foi", async () => {
    delete process.env.ALERT_EMAILS;
    await alertarSeDegradado(relatorio(["worker"]), enviar, push);
    expect(enviar).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe("a configuração da tela manda", () => {
  it("os destinatários da tela vencem o ALERT_EMAILS do .env", async () => {
    await configurar({ emails: ["a@exemplo.com.br", "b@exemplo.com.br"] });
    expect((await configEfetiva()).origem).toBe("tela");
    await alertarSeDegradado(relatorio(["worker"]), enviar, push);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]![0]).toEqual(["a@exemplo.com.br", "b@exemplo.com.br"]);
  });

  it("DESLIGADO: não envia e-mail, não avisa por push e não gasta a trava de ninguém", async () => {
    await configurar({ ligado: false });
    expect(await alertarSeDegradado(relatorio(["worker", "database"]), enviar, push)).toEqual([]);
    expect(enviar).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(await redisEstado().exists("alerta:saude:worker", "alerta:saude:email:worker")).toBe(0);
    expect(await basePrisma.alertaEnviado.count()).toBe(0);
    // Ligando de novo, o MESMO problema avisa na hora (a trava não foi gasta enquanto estava desligado).
    await configurar({ ligado: true });
    await alertarSeDegradado(relatorio(["worker"]), enviar, push);
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("motivo desligado não alerta; os outros seguem", async () => {
    await configurar({ motivosDesligados: ["whatsapp"] });
    expect(await alertarSeDegradado(relatorio(["evolution"]), enviar, push)).toEqual([]);
    expect(enviar).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    const novos = await alertarSeDegradado(relatorio(["evolution", "worker"]), enviar, push);
    expect(novos).toHaveLength(1);
    expect(novos[0]).toMatch(/^worker:/);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]![2]).toMatch(/worker/);
    expect(enviar.mock.calls[0]![2]).not.toMatch(/evolution/);
  });

  it("canal e-mail desligado: só o push; canal push desligado: só o e-mail", async () => {
    await configurar({ canalEmail: false });
    await alertarSeDegradado(relatorio(["worker"]), enviar, push);
    expect(enviar).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);

    await limparRedis();
    enviar.mockClear();
    push.mockClear();
    await configurar({ canalPush: false });
    await alertarSeDegradado(relatorio(["worker"]), enviar, push);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("intervalo mínimo: a trava do e-mail e a do push respeitam o piso escolhido", async () => {
    await configurar({ intervaloMinimoMin: 120 });
    await alertarSeDegradado(relatorio(["worker"]), enviar, push);
    const r = redisEstado();
    expect(await r.ttl("alerta:saude:email:worker")).toBeGreaterThan(119 * 60);
    expect(await r.ttl("alerta:saude:worker")).toBeGreaterThan(119 * 60);
    // Repetiu antes do piso: nada novo.
    await alertarSeDegradado(relatorio(["worker"]), enviar, push);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("intervalo padrão (30 min) mantém a escada de antes", async () => {
    await configurar({ intervaloMinimoMin: 30 });
    await alertarSeDegradado(relatorio(["worker"]), enviar, push);
    const ttl = await redisEstado().ttl("alerta:saude:email:worker");
    expect(ttl).toBeGreaterThan(29 * 60);
    expect(ttl).toBeLessThanOrEqual(30 * 60);
  });
});

describe("registro do que foi enviado", () => {
  it("grava categoria, canal, status, resultado e a quantidade de destinatários, e nada do texto do erro", async () => {
    await configurar({ emails: ["a@exemplo.com.br", "b@exemplo.com.br"] });
    await alertarSeDegradado(relatorio(["database"]), enviar, push);
    const linhas = await basePrisma.alertaEnviado.findMany({ orderBy: { canal: "asc" } });
    expect(
      linhas.map((l) => ({
        canal: l.canal,
        motivo: l.motivo,
        status: l.status,
        resultado: l.resultado,
        destinatarios: l.destinatarios,
      })),
    ).toEqual([
      {
        canal: "email",
        motivo: "banco",
        status: "unhealthy",
        resultado: "enviado",
        destinatarios: 2,
      },
      {
        canal: "push",
        motivo: "banco",
        status: "unhealthy",
        resultado: "enviado",
        destinatarios: 0,
      },
    ]);
    const tudo = JSON.stringify(linhas);
    for (const proibido of [
      "ECONNREFUSED",
      "db.interno",
      "5432",
      "senha",
      "a@exemplo.com.br",
      "b@exemplo.com.br",
    ])
      expect(tudo).not.toContain(proibido);
  });

  it("e-mail que falhou fica como falhou", async () => {
    await configurar({ canalPush: false });
    enviar.mockRejectedValue(new Error("smtp fora do ar"));
    await alertarSeDegradado(relatorio(["worker"]), enviar, push);
    const l = await basePrisma.alertaEnviado.findFirstOrThrow({});
    expect(l).toMatchObject({ canal: "email", motivo: "worker", resultado: "falhou" });
  });

  it("push sem ninguém inscrito não vira registro; push entregue vira", async () => {
    await configurar({ canalEmail: false });
    push.mockResolvedValue({ enviados: 0, removidas: 0, falhas: 0 } as never);
    await alertarSeDegradado(relatorio(["worker"]), enviar, push);
    expect(await basePrisma.alertaEnviado.count()).toBe(0);
    await limparRedis();
    push.mockResolvedValue({ enviados: 2, removidas: 0, falhas: 0 } as never);
    await alertarSeDegradado(relatorio(["worker"]), enviar, push);
    expect(await basePrisma.alertaEnviado.findMany()).toMatchObject([
      { canal: "push", motivo: "worker", resultado: "enviado" },
    ]);
  });

  it("vários motivos da mesma categoria viram UM registro por canal", async () => {
    await configurar({ canalPush: false });
    await alertarSeDegradado(
      relatorio(["motor-filas", "motor-inscricoes", "worker"]),
      enviar,
      push,
    );
    const motivos = (await basePrisma.alertaEnviado.findMany()).map((l) => l.motivo).sort();
    expect(motivos).toEqual(["motor_filas", "motor_inscricoes", "worker"]);
  });
});

describe("pushParaOperacao respeita a configuração", () => {
  it("sem linha: usa o ALERT_TEAM_ID do .env", async () => {
    const r = await pushParaOperacao("t", "c");
    expect(r).toMatchObject({ enviados: 1 });
    expect(pushReal.enviarPush).toHaveBeenCalledTimes(1);
  });

  it("desligado, canal Web Push desligado ou sem time: não tenta (null)", async () => {
    await configurar({ ligado: false });
    expect(await pushParaOperacao("t", "c")).toBeNull();
    await configurar({ canalPush: false });
    expect(await pushParaOperacao("t", "c")).toBeNull();
    delete process.env.ALERT_TEAM_ID;
    await configurar({ timeOperacaoId: null });
    expect(await pushParaOperacao("t", "c")).toBeNull();
    expect(pushReal.enviarPush).not.toHaveBeenCalled();
  });

  it("com a linha da tela, o time de operação é o dela (não o do .env)", async () => {
    process.env.ALERT_TEAM_ID = "00000000-0000-0000-0000-0000000a1eff";
    await configurar({ timeOperacaoId: TEAM_OP });
    expect((await configEfetiva()).timeOperacaoId).toBe(TEAM_OP);
    expect(await pushParaOperacao("t", "c")).toMatchObject({ enviados: 1 });
  });
});
