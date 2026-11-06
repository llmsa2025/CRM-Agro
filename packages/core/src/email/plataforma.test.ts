import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "@crmagro/config";

/**
 * Remetente da PLATAFORMA (S-05). O envio é FALSO: o `EmailProvider` e o
 * provider das caixas do time são trocados por espiões — nenhum e-mail sai de
 * verdade. A configuração é ligada/desligada mexendo no `env` deste arquivo
 * (o vitest.config.ts zera PLATFORM_* para a suíte toda).
 */
const envio = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  plataforma: vi.fn(async (_input: { to: string; content: Record<string, unknown> }) => ({ providerMessageId: "<plataforma@teste>" })),
  caixaDoTime: vi.fn(async (_input: unknown) => ({ providerMessageId: "<time@teste>" })),
}));
// Web Push (aviso de 80% da cota) nunca sai de verdade daqui.
vi.mock("../push/service", () => ({ enviarPush: vi.fn(async () => ({ enviados: 0, removidas: 0, falhas: 0 })) }));
vi.mock("@crmagro/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crmagro/channels")>();
  class EmailProviderFalso {
    constructor(cfg: Record<string, unknown>) {
      envio.configs.push(cfg);
    }
    send(input: { to: string; content: Record<string, unknown> }) {
      return envio.plataforma(input);
    }
  }
  return { ...real, EmailProvider: EmailProviderFalso, getChannelProvider: () => ({ send: envio.caixaDoTime }) };
});

const { configDaPlataforma, enviarEmailDaPlataforma, estadoDaPlataforma, mascararEmail, plataformaConfigurada, rodapeDeResposta } = await import("./plataforma");
const { enviarEmailDoSistema } = await import("./sistema");
const { alertarSeDegradado } = await import("../health/alerta");
const { redisEstado } = await import("../shared/redis-cache");
const { peekRateLimit } = await import("../rate-limit/service");
const { EMAILS_POR_DESTINATARIO_POR_HORA, erroParaLog, mascararEmailsNoTexto, tetoDiarioDoTipo } = await import("./plataforma");
const { logger } = await import("../logger/index");

type Plataforma = Partial<
  Pick<
    typeof env,
    | "PLATFORM_EMAIL_FROM"
    | "PLATFORM_EMAIL_REPLY_TO"
    | "PLATFORM_SMTP_HOST"
    | "PLATFORM_SMTP_PORT"
    | "PLATFORM_SMTP_USER"
    | "PLATFORM_SMTP_PASS"
    | "PLATFORM_SMTP_SECURE"
    | "PLATFORM_EMAIL_LIMITE_DIA"
  >
>;
const CHAVES = [
  "PLATFORM_EMAIL_FROM",
  "PLATFORM_EMAIL_REPLY_TO",
  "PLATFORM_SMTP_HOST",
  "PLATFORM_SMTP_PORT",
  "PLATFORM_SMTP_USER",
  "PLATFORM_SMTP_PASS",
  "PLATFORM_SMTP_SECURE",
  "PLATFORM_EMAIL_LIMITE_DIA",
] as const;
const RESEND: Plataforma = {
  PLATFORM_EMAIL_FROM: "CRM Agro <noreply@crmagro.example>",
  PLATFORM_SMTP_HOST: "smtp.resend.teste.invalid",
  PLATFORM_SMTP_USER: "resend",
  PLATFORM_SMTP_PASS: "re_chave_de_teste",
  // O Redis de TESTE acumula a contagem do dia entre execuções: teto alto para
  // os testes não esbarrarem nele (o teste do teto usa um teto calculado).
  PLATFORM_EMAIL_LIMITE_DIA: "1000000",
};

function configurar(p: Plataforma | null): void {
  const alvo = env as Plataforma;
  for (const k of CHAVES) delete alvo[k];
  if (p) Object.assign(alvo, p);
}

const sufixo = Math.random().toString(36).slice(2, 8);
let seq = 0;
/** Destino novo a cada chamada: o teto por destinatário (Redis de teste) não passa de uma execução para outra. */
const destino = (nome = "a") => `${nome}-${sufixo}-${++seq}@exemplo.com.br`;

beforeEach(() => {
  configurar(null);
  envio.configs.length = 0;
  envio.plataforma.mockReset();
  envio.plataforma.mockImplementation(async () => ({ providerMessageId: "<plataforma@teste>" }));
  envio.caixaDoTime.mockClear();
});
afterEach(() => configurar(null));

describe("configuração do remetente da plataforma", () => {
  it("sem configuração: não envia nada e devolve false", async () => {
    expect(plataformaConfigurada()).toBe(false);
    expect(configDaPlataforma()).toBeNull();
    expect(await enviarEmailDaPlataforma({ to: destino(), subject: "x", text: "y", tipo: "teste" })).toBe(false);
    expect(envio.configs).toHaveLength(0);
    expect(envio.plataforma).not.toHaveBeenCalled();
  });

  it("Resend: sem porta, 465 com TLS direto; From do env; Auto-Submitted", () => {
    configurar(RESEND);
    expect(configDaPlataforma()).toEqual({
      host: "smtp.resend.teste.invalid",
      port: 465,
      secure: true,
      user: "resend",
      pass: "re_chave_de_teste",
      from: "CRM Agro <noreply@crmagro.example>",
      headers: { "Auto-Submitted": "auto-generated" },
      destinatarioUnico: true,
    });
  });

  it("porta e TLS: 587 = STARTTLS obrigatório; SECURE=false sem porta = 587; SECURE manda; 2465 é TLS direto", () => {
    configurar({ ...RESEND, PLATFORM_SMTP_PORT: "587" });
    expect(configDaPlataforma()).toMatchObject({ port: 587, secure: false, requireTLS: true });
    configurar({ ...RESEND, PLATFORM_SMTP_SECURE: "false" });
    expect(configDaPlataforma()).toMatchObject({ port: 587, secure: false, requireTLS: true });
    configurar({ ...RESEND, PLATFORM_SMTP_PORT: "2465", PLATFORM_SMTP_SECURE: "true" });
    expect(configDaPlataforma()).toMatchObject({ port: 2465, secure: true });
    expect(configDaPlataforma()).not.toHaveProperty("requireTLS");
    // Sem SECURE: 2465 também é TLS direto (antes caía em STARTTLS e dava timeout).
    configurar({ ...RESEND, PLATFORM_SMTP_PORT: "2465" });
    expect(configDaPlataforma()).toMatchObject({ port: 2465, secure: true });
  });

  it("SECURE tolera maiúscula e 1/0; espaço nas pontas de HOST/USER/PASS não chega ao SMTP", () => {
    configurar({ ...RESEND, PLATFORM_SMTP_SECURE: "True" });
    expect(configDaPlataforma()).toMatchObject({ port: 465, secure: true });
    configurar({ ...RESEND, PLATFORM_SMTP_SECURE: " 0 " });
    expect(configDaPlataforma()).toMatchObject({ port: 587, secure: false, requireTLS: true });
    configurar({ ...RESEND, PLATFORM_SMTP_HOST: " smtp.resend.teste.invalid ", PLATFORM_SMTP_USER: "resend ", PLATFORM_SMTP_PASS: " re_chave_de_teste\t" });
    expect(configDaPlataforma()).toMatchObject({ host: "smtp.resend.teste.invalid", user: "resend", pass: "re_chave_de_teste" });
  });

  it("PLATFORM_* pela metade ou malformado: NÃO derruba nada, fica 'inválido', recusa o envio e nunca cai na caixa do time", async () => {
    for (const quebrado of [
      { PLATFORM_SMTP_HOST: "smtp.resend.com" },
      { ...RESEND, PLATFORM_SMTP_PASS: "" },
      { ...RESEND, PLATFORM_SMTP_SECURE: "talvez" },
      { ...RESEND, PLATFORM_SMTP_PORT: "porta" },
      { ...RESEND, PLATFORM_EMAIL_FROM: "CRM Agro <noreply@crmagro" },
      { PLATFORM_EMAIL_REPLY_TO: "suporte@crmagro" },
      { ...RESEND, PLATFORM_EMAIL_LIMITE_DIA: "cem" },
    ] as Plataforma[]) {
      configurar(quebrado);
      expect(plataformaConfigurada()).toBe(true);
      expect(configDaPlataforma()).toBeNull();
      const estado = estadoDaPlataforma();
      expect(estado.estado).toBe("invalido");
      // Os problemas dizem o NOME da variável, nunca o valor (vão para o log e o /api/health).
      const problemas = estado.estado === "invalido" ? estado.problemas.join(" ") : "";
      expect(problemas).toMatch(/PLATFORM_/);
      expect(problemas).not.toContain("re_chave_de_teste");
      await expect(enviarEmailDoSistema({ to: destino(), subject: "x", text: "y", tipo: "teste" })).rejects.toThrow("RemetenteInvalido");
    }
    expect(envio.plataforma).not.toHaveBeenCalled();
    expect(envio.caixaDoTime).not.toHaveBeenCalled();
  });

  it("reply-to opcional vai para o provider e muda o rodapé; sem a plataforma, o rodapé não fala de resposta", () => {
    configurar({ ...RESEND, PLATFORM_EMAIL_REPLY_TO: "suporte@crmagro.example" });
    expect(configDaPlataforma()).toMatchObject({ replyTo: "suporte@crmagro.example" });
    expect(rodapeDeResposta()).toBe("responda");
    configurar(RESEND);
    expect(configDaPlataforma()).not.toHaveProperty("replyTo");
    expect(rodapeDeResposta()).toBe("nao-responda");
    configurar(null);
    expect(rodapeDeResposta()).toBe("omitir");
  });
});

describe("enviarEmailDaPlataforma", () => {
  it("envia pelo SMTP do env (falso) com assunto, texto e HTML", async () => {
    configurar(RESEND);
    const to = destino("marcos");
    expect(await enviarEmailDaPlataforma({ to, subject: "Assunto", text: "Texto", html: "<p>HTML</p>", tipo: "teste" })).toBe(true);
    expect(envio.configs).toHaveLength(1);
    expect(envio.configs[0]).toMatchObject({ host: "smtp.resend.teste.invalid", from: "CRM Agro <noreply@crmagro.example>" });
    expect(envio.plataforma).toHaveBeenCalledWith({
      to,
      content: { subject: "Assunto", text: "Texto", html: "<p>HTML</p>" },
    });
  });

  it("falha do SMTP sobe (quem chama decide) e não tenta outra via", async () => {
    configurar(RESEND);
    envio.plataforma.mockRejectedValueOnce(Object.assign(new Error("SMTP: 550 domínio não verificado"), { name: "ChannelSendFailed" }));
    await expect(enviarEmailDaPlataforma({ to: destino(), subject: "x", text: "y", tipo: "teste" })).rejects.toThrow("550");
    expect(envio.caixaDoTime).not.toHaveBeenCalled();
  });

  it("recusa lista, nome, grupo e texto livre no destino: nada é enviado", async () => {
    configurar(RESEND);
    for (const to of [
      "vitima1@a.com,vitima2@b.com",
      "vitima1@a.com; vitima3@c.com",
      "sua conta sera bloqueada, confirme em https://evil.example/entrar vitima@gmail.com",
      "Fulano <fulano@empresa.com>",
      "grupo: z@w.com;",
      "a@b.com\r\nBcc: z@w.com",
      `${"x".repeat(250)}@b.com`,
    ]) {
      await expect(enviarEmailDaPlataforma({ to, subject: "x", text: "y", tipo: "teste" })).rejects.toThrow("DestinatarioInvalido");
    }
    expect(envio.plataforma).not.toHaveBeenCalled();
  });

  it("o log de falha não grava o endereço inteiro, nem o que vem na resposta do servidor", async () => {
    configurar(RESEND);
    const to = destino("fulano");
    const espiao = vi.spyOn(logger, "error");
    try {
      envio.plataforma.mockRejectedValueOnce(new Error(`SMTP: 550 5.1.1 <${to}>: Recipient address rejected`));
      await expect(enviarEmailDaPlataforma({ to, subject: "x", text: "y", tipo: "teste" })).rejects.toThrow("550");
      const registrado = JSON.stringify(espiao.mock.calls);
      expect(registrado).not.toContain(to);
      expect(registrado).toContain("fu***@exemplo.com.br");
    } finally {
      espiao.mockRestore();
    }
    expect(mascararEmailsNoTexto("SMTP: 550 5.1.1 <fulano@empresa.com>: Recipient address rejected")).toBe(
      "SMTP: 550 5.1.1 <fu***@empresa.com>: Recipient address rejected",
    );
    expect(erroParaLog(new Error("a ana@x.com.br e b@y.io"))).toBe("a a***@x.com.br e b***@y.io");
  });

  it("mascara o destino no log", () => {
    expect(mascararEmail("maria.silva@gmail.com")).toBe("ma***@gmail.com");
    expect(mascararEmail("ana@Exemplo.COM")).toBe("a***@exemplo.com");
    expect(mascararEmail("sem-arroba")).toBe("***");
  });
});

describe("orçamento de envio (a cota do provedor é uma só para todos os times)", () => {
  it("teto por destinatário: passou de 6 na hora para o mesmo endereço, nada sai", async () => {
    configurar(RESEND);
    const to = destino("repetido");
    for (let i = 0; i < EMAILS_POR_DESTINATARIO_POR_HORA; i++) {
      expect(await enviarEmailDaPlataforma({ to, subject: "x", text: "y", tipo: "reset" })).toBe(true);
    }
    await expect(enviarEmailDaPlataforma({ to, subject: "x", text: "y", tipo: "reset" })).rejects.toThrow("LimiteDaPlataforma");
    expect(envio.plataforma).toHaveBeenCalledTimes(EMAILS_POR_DESTINATARIO_POR_HORA);
  });

  it("teto diário da plataforma (dia UTC): passou, nada sai", async () => {
    const antes = process.env.ALERT_TEAM_ID;
    delete process.env.ALERT_TEAM_ID;
    try {
      // O Redis de teste já tem a contagem de hoje: o teto fica 2 acima dela.
      const usados = 1e9 - (await peekRateLimit("email-plataforma:dia", 1e9, 24 * 60 * 60 * 1000)).remaining;
      configurar({ ...RESEND, PLATFORM_EMAIL_LIMITE_DIA: String(usados + 2) });
      expect(await enviarEmailDaPlataforma({ to: destino(), subject: "x", text: "y", tipo: "reset" })).toBe(true);
      expect(await enviarEmailDaPlataforma({ to: destino(), subject: "x", text: "y", tipo: "reset" })).toBe(true);
      await expect(enviarEmailDaPlataforma({ to: destino(), subject: "x", text: "y", tipo: "reset" })).rejects.toThrow("LimiteDaPlataforma");
      expect(envio.plataforma).toHaveBeenCalledTimes(2);
    } finally {
      if (antes !== undefined) process.env.ALERT_TEAM_ID = antes;
    }
  });

  it("teto por tipo: convite até 45% e alerta até 1/6 do dia; o reset fica com o resto", () => {
    expect(tetoDiarioDoTipo("convite", 90)).toBe(40);
    expect(tetoDiarioDoTipo("alerta", 90)).toBe(15);
    expect(tetoDiarioDoTipo("reset", 90)).toBe(90);
    // Cadastro (porta pública): até 30% — um robô de cadastros não leva a cota do reset.
    expect(tetoDiarioDoTipo("cadastro", 90)).toBe(27);
    expect(tetoDiarioDoTipo("cadastro", 2)).toBe(1);
    expect(tetoDiarioDoTipo("alerta", 3)).toBe(1);
  });
});

describe("enviarEmailDoSistema — por onde sai", () => {
  it("com a plataforma: só por ela; falha NÃO cai na caixa do time", async () => {
    configurar(RESEND);
    expect(await enviarEmailDoSistema({ to: destino(), subject: "x", text: "y", tipo: "teste" })).toEqual({ enviado: true, via: "plataforma" });
    envio.plataforma.mockRejectedValueOnce(new Error("SMTP: fora do ar"));
    await expect(enviarEmailDoSistema({ to: destino(), subject: "x", text: "y", tipo: "teste" })).rejects.toThrow("fora do ar");
    expect(envio.caixaDoTime).not.toHaveBeenCalled();
  });
});

describe("alerta de saúde pelo remetente da plataforma", () => {
  it("sem ALERT_TEAM_ID, o alerta sai pela plataforma para cada endereço, com o modelo HTML", async () => {
    configurar(RESEND);
    const antes = { emails: process.env.ALERT_EMAILS, time: process.env.ALERT_TEAM_ID };
    const ops = [destino("ops1"), destino("ops2")];
    process.env.ALERT_EMAILS = ops.join(", ");
    delete process.env.ALERT_TEAM_ID;
    const motivo = `teste-plataforma ${sufixo} fila flow atrasada 12 min`;
    const relatorio = {
      status: "degraded" as const,
      timestamp: new Date().toISOString(),
      checks: { motor: { status: "degraded" as const, motivos: [motivo] } },
    } as unknown as Parameters<typeof alertarSeDegradado>[0];
    try {
      const avisarPorPush = vi.fn(async () => {});
      expect(await alertarSeDegradado(relatorio, undefined, avisarPorPush)).toEqual([`motor: ${motivo}`]);
      expect(envio.plataforma).toHaveBeenCalledTimes(2);
      const destinos = envio.plataforma.mock.calls.map(([i]) => i.to);
      expect(destinos).toEqual(ops);
      const conteudo = envio.plataforma.mock.calls[0]![0].content as { subject: string; html: string; text: string };
      expect(conteudo.subject).toBe(`[CRM Agro] degraded: motor: ${motivo}`);
      expect(conteudo.html).toContain(motivo);
      expect(conteudo.text).toContain(motivo);
      expect(envio.caixaDoTime).not.toHaveBeenCalled();
    } finally {
      const r = redisEstado();
      const chaves = await r.keys(`alerta:saude:*teste-plataforma ${sufixo.replace(/\d+/g, "#")}*`);
      if (chaves.length) await r.del(...chaves);
      if (antes.emails === undefined) delete process.env.ALERT_EMAILS;
      else process.env.ALERT_EMAILS = antes.emails;
      if (antes.time !== undefined) process.env.ALERT_TEAM_ID = antes.time;
    }
  });
});
