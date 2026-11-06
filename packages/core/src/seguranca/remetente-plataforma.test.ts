import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "@crmagro/config";
import { basePrisma, encryptCredentials } from "@crmagro/db";

/**
 * S-05 (auditoria de isolamento 09/2026) — "esqueci a senha" do master saía
 * pela caixa de e-mail mais antiga do time, que pode ser de outra pessoa: a
 * cópia em "Enviados" entregava o link de redefinir a senha do master.
 *
 * Com o remetente da PLATAFORMA configurado (PLATFORM_SMTP_*), reset e convite
 * saem SÓ por ele — nunca pela caixa do time, nem quando o envio falha. Sem
 * ele, o comportamento antigo continua (e o S-05 também: ver o relatório).
 *
 * Banco de TESTE. O envio é FALSO: o `EmailProvider` (plataforma) e o provider
 * das caixas do time são espiões — nenhum e-mail sai de verdade.
 */
const envio = vi.hoisted(() => ({
  plataforma: vi.fn(async (_input: { to: string; content: Record<string, unknown> }) => ({ providerMessageId: "<plataforma@teste>" })),
  caixaDoTime: vi.fn(async (_input: { to: string; content: Record<string, unknown> }) => ({ providerMessageId: "<time@teste>" })),
}));
vi.mock("@crmagro/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crmagro/channels")>();
  class EmailProviderFalso {
    send(input: { to: string; content: Record<string, unknown> }) {
      return envio.plataforma(input);
    }
  }
  return { ...real, EmailProvider: EmailProviderFalso, getChannelProvider: () => ({ send: envio.caixaDoTime }) };
});

const { requestPasswordReset, aguardarPedidosDeReset, RESET_POR_EMAIL } = await import("../auth/password-reset");
const { resetRateLimit, rateLimit } = await import("../rate-limit/service");

/** Pede o reset e espera o trabalho em segundo plano (o pedido volta antes do envio). */
async function pedirReset(email: string): Promise<void> {
  await requestPasswordReset(email);
  await aguardarPedidosDeReset();
}
const { createInvite } = await import("../auth/invites");
const { runWithTeam } = await import("../test-support/identidade");

const TEAM = randomUUID();
const sufixo = randomUUID().slice(0, 8);
const MASTER = `master-${sufixo}@time-s05.test`;
const ADMIN = `admin-${sufixo}@time-s05.test`;
const APP = "https://app.crmagro.example";
let masterId = "";

type Ajustes = Partial<
  Pick<typeof env, "PLATFORM_EMAIL_FROM" | "PLATFORM_SMTP_HOST" | "PLATFORM_SMTP_USER" | "PLATFORM_SMTP_PASS" | "PLATFORM_EMAIL_LIMITE_DIA" | "AUTH_URL">
>;
const PLATAFORMA: Ajustes = {
  PLATFORM_EMAIL_FROM: "CRM Agro <noreply@crmagro.example>",
  PLATFORM_SMTP_HOST: "smtp.resend.teste.invalid",
  PLATFORM_SMTP_USER: "resend",
  PLATFORM_SMTP_PASS: "re_chave_de_teste",
  // O Redis de TESTE acumula a contagem do dia entre execuções: teto alto aqui.
  PLATFORM_EMAIL_LIMITE_DIA: "1000000",
};
const original: Ajustes = { AUTH_URL: env.AUTH_URL };

function plataforma(ligada: boolean): void {
  const alvo = env as Ajustes;
  for (const k of Object.keys(PLATAFORMA) as Array<keyof Ajustes>) delete alvo[k];
  if (ligada) Object.assign(alvo, PLATAFORMA);
}

const conteudo = (spy: typeof envio.plataforma, i = 0) => spy.mock.calls[i]![0].content as { subject: string; text: string; html?: string };

beforeAll(async () => {
  await basePrisma.team.create({ data: { id: TEAM, name: `Agro <b>S-05</b> ${sufixo}` } });
  const master = await basePrisma.user.create({ data: { teamId: TEAM, name: "Master", email: MASTER, role: "owner", passwordHash: "x" } });
  const admin = await basePrisma.user.create({ data: { teamId: TEAM, name: "Admin", email: ADMIN, role: "admin", passwordHash: "x" } });
  masterId = master.id;
  // A caixa conectada MAIS ANTIGA do time é a do administrador (o cenário do S-05).
  await basePrisma.channelAccount.create({
    data: {
      teamId: TEAM,
      canal: "email",
      provider: "smtp",
      label: "Caixa do admin",
      status: "connected",
      ownerId: admin.id,
      credentials: encryptCredentials({
        host: "smtp.caixa-do-admin.invalid",
        port: 465,
        secure: true,
        user: ADMIN,
        pass: "senha-da-caixa",
        from: ADMIN,
      }) as object,
    },
  });
});

beforeEach(async () => {
  // Vários testes pedem o reset do MASTER (3/h por e-mail): zera a janela dele.
  await resetRateLimit(`pwreset:${MASTER}`, RESET_POR_EMAIL.janelaMs);
  (env as Ajustes).AUTH_URL = APP;
  plataforma(false);
  envio.plataforma.mockReset();
  envio.plataforma.mockImplementation(async () => ({ providerMessageId: "<plataforma@teste>" }));
  envio.caixaDoTime.mockClear();
});

afterEach(() => {
  plataforma(false);
  (env as Ajustes).AUTH_URL = original.AUTH_URL;
});

afterAll(async () => {
  // Cascata: usuários, tokens de reset, convites e a caixa do time.
  await basePrisma.team.delete({ where: { id: TEAM } }).catch(() => {});
});

describe("S-05 — reset de senha com o remetente da plataforma", () => {
  it("e-mail de redefinir senha nunca sai pela caixa de outra pessoa do time", async () => {
    plataforma(true);
    await pedirReset(MASTER);
    expect(envio.caixaDoTime).not.toHaveBeenCalled();
    expect(envio.plataforma).toHaveBeenCalledTimes(1);
    expect(envio.plataforma.mock.calls[0]![0].to).toBe(MASTER);
    const c = conteudo(envio.plataforma);
    expect(c.subject).toBe("Redefinição de senha no CRM Agro");
    expect(c.text).toMatch(new RegExp(`^${APP}/redefinir-senha\\?token=prt_`, "m"));
    expect(c.html).toContain(`href="${APP}/redefinir-senha?token=prt_`);
    expect(await basePrisma.passwordResetToken.count({ where: { userId: masterId } })).toBeGreaterThan(0);
  });

  it("falha no SMTP da plataforma NÃO cai na caixa do time (e o pedido segue sem erro)", async () => {
    plataforma(true);
    envio.plataforma.mockRejectedValueOnce(new Error("SMTP: 421 serviço indisponível"));
    await expect(requestPasswordReset(MASTER)).resolves.toBeUndefined();
    await aguardarPedidosDeReset();
    expect(envio.plataforma).toHaveBeenCalledTimes(1);
    expect(envio.caixaDoTime).not.toHaveBeenCalled();
  });

  it("o pedido volta ANTES do envio (o tempo de resposta não denuncia se a conta existe)", async () => {
    plataforma(true);
    let liberar: () => void = () => {};
    envio.plataforma.mockImplementationOnce(
      () => new Promise((ok) => (liberar = () => ok({ providerMessageId: "<plataforma@teste>" }))),
    );
    // Conta que existe: o SMTP "travado" não segura o pedido.
    const inicio = Date.now();
    await requestPasswordReset(MASTER);
    await requestPasswordReset(`ninguem-${sufixo}@time-s05.test`);
    expect(Date.now() - inicio).toBeLessThan(200);
    await vi.waitFor(() => expect(envio.plataforma).toHaveBeenCalledTimes(1));
    liberar();
    await aguardarPedidosDeReset();
    expect(envio.plataforma.mock.calls[0]![0].to).toBe(MASTER);
  });

  it("limite por IP: passou de 10 na hora, o pedido não gera token nem e-mail", async () => {
    plataforma(true);
    const ip = `ip-teste-${sufixo}`;
    for (let i = 0; i < 10; i++) await rateLimit(`pwreset:ip:${ip}`, 10, 60 * 60 * 1000);
    const antes = await basePrisma.passwordResetToken.count({ where: { userId: masterId } });
    await requestPasswordReset(MASTER, { ip });
    await aguardarPedidosDeReset();
    expect(envio.plataforma).not.toHaveBeenCalled();
    expect(await basePrisma.passwordResetToken.count({ where: { userId: masterId } })).toBe(antes);
  });

  it("sem a plataforma configurada, continua como antes (caixa do time)", async () => {
    await pedirReset(MASTER);
    expect(envio.plataforma).not.toHaveBeenCalled();
    expect(envio.caixaDoTime).toHaveBeenCalledTimes(1);
    expect(envio.caixaDoTime.mock.calls[0]![0].to).toBe(MASTER);
    // O modelo novo vale nas duas vias; pela caixa de uma pessoa, o rodapé não diz "não responda".
    const legado = conteudo(envio.caixaDoTime as typeof envio.plataforma);
    expect(legado.html).toContain("/redefinir-senha?token=prt_");
    expect(legado.html).not.toContain("Não responda");
  });
});

describe("convite de equipe com o remetente da plataforma", () => {
  const convidar = (email: string) => runWithTeam(TEAM, () => createInvite({ email, invitedByUserId: masterId }), { userId: masterId, role: "owner" });

  it("sai pela plataforma, com o link certo e o nome do time escapado; nunca pela caixa do time", async () => {
    plataforma(true);
    const novo = `novo1-${sufixo}@convidado.test`;
    const c = await convidar(novo);
    expect(c.emailSent).toBe(true);
    expect(c.link).toBe(`${APP}/criar-conta?token=${encodeURIComponent(c.token)}`);
    expect(envio.caixaDoTime).not.toHaveBeenCalled();
    expect(envio.plataforma).toHaveBeenCalledTimes(1);
    expect(envio.plataforma.mock.calls[0]![0].to).toBe(novo);
    const m = conteudo(envio.plataforma);
    expect(m.text).toContain(c.link!);
    expect(m.html).toContain(`href="${c.link}"`);
    expect(m.html).toContain("Agro &lt;b&gt;S-05&lt;/b&gt;");
    expect(m.html).not.toContain("<b>S-05</b>");
    expect(m.html).toContain("<strong>Master</strong>");
    expect(m.html).toContain("Não responda: este endereço não recebe mensagens.");
  });

  it("falha no envio: o convite fica criado, o link volta para copiar e nada cai na caixa do time", async () => {
    plataforma(true);
    envio.plataforma.mockRejectedValueOnce(new Error("SMTP: 550 domínio não verificado"));
    const novo = `novo2-${sufixo}@convidado.test`;
    const c = await convidar(novo);
    expect(c.emailSent).toBe(false);
    // A tela diz "o e-mail não saiu", e não "sem e-mail conectado" (que mandaria conectar uma caixa à toa).
    expect(c.emailMotivo).toBe("falhou");
    expect(c.link).toContain("/criar-conta?token=");
    expect(await basePrisma.invite.count({ where: { teamId: TEAM, email: novo } })).toBe(1);
    expect(envio.caixaDoTime).not.toHaveBeenCalled();
  });

  it("limite de 30 convites por hora do time: o 31º é criado, mas o e-mail não sai (motivo 'limite')", async () => {
    plataforma(true);
    const HORA = 60 * 60 * 1000;
    try {
      for (let i = 0; i < 30; i++) await rateLimit(`convite:email:${TEAM}`, 30, HORA);
      const novo = `novo-limite-${sufixo}@convidado.test`;
      const c = await convidar(novo);
      expect(c.emailSent).toBe(false);
      expect(c.emailMotivo).toBe("limite");
      expect(c.link).toContain("/criar-conta?token=");
      expect(envio.plataforma).not.toHaveBeenCalled();
      expect(envio.caixaDoTime).not.toHaveBeenCalled();
      expect(await basePrisma.invite.count({ where: { teamId: TEAM, email: novo } })).toBe(1);
    } finally {
      await resetRateLimit(`convite:email:${TEAM}`, HORA);
    }
  });

  it("recusa lista de destinatários e texto livre no e-mail do convite (nada é gravado nem enviado)", async () => {
    plataforma(true);
    for (const email of [
      `a-${sufixo}@x.com,b-${sufixo}@y.com`,
      `a-${sufixo}@x.com; b-${sufixo}@y.com`,
      `sua conta sera bloqueada, confirme em https://evil.example/entrar c-${sufixo}@gmail.com`,
      `Fulano <d-${sufixo}@empresa.com>`,
    ]) {
      await expect(convidar(email)).rejects.toThrow("e-mail inválido");
    }
    expect(envio.plataforma).not.toHaveBeenCalled();
    expect(await basePrisma.invite.count({ where: { teamId: TEAM, email: { contains: sufixo, mode: "insensitive" }, NOT: { email: { startsWith: "novo" } } } })).toBe(0);
  });

  it("sem a plataforma configurada, continua como antes (caixa do time)", async () => {
    const novo = `novo3-${sufixo}@convidado.test`;
    const c = await convidar(novo);
    expect(c.emailSent).toBe(true);
    expect(envio.plataforma).not.toHaveBeenCalled();
    expect(envio.caixaDoTime).toHaveBeenCalledTimes(1);
    expect(envio.caixaDoTime.mock.calls[0]![0].to).toBe(novo);
  });
});
