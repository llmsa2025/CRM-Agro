import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "@crmagro/config";

/**
 * Cadastro com senha com o Redis FORA DO AR: os limites de pedir e de reenviar
 * (cada um gasta um e-mail da cota da plataforma) são fail-closed — a porta
 * pública responde "indisponível" em vez de ficar sem limite nenhum.
 *
 * O `rateLimit`/`peekRateLimit` são trocados por versões que respondem como o
 * Redis fora (`semRedis`) quando pedem `falhaFecha`. O envio é FALSO (nenhum
 * e-mail sai) e nada chega ao banco nestes caminhos.
 */
const estado = vi.hoisted(() => ({ espiarCota: "sem-redis" as "sem-redis" | "livre" }));
const envio = vi.hoisted(() => ({ plataforma: vi.fn(async () => ({ providerMessageId: "<plataforma@teste>" })) }));
vi.mock("../push/service", () => ({ enviarPush: vi.fn(async () => ({ enviados: 0, removidas: 0, falhas: 0 })) }));
vi.mock("@crmagro/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crmagro/channels")>();
  class EmailProviderFalso {
    send() {
      return envio.plataforma();
    }
  }
  return { ...real, EmailProvider: EmailProviderFalso };
});
vi.mock("../rate-limit/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("../rate-limit/service")>();
  const semRedis = { allowed: false, remaining: 0, retryAfterMs: 60_000, semRedis: true as const };
  const livre = { allowed: true, remaining: 99, retryAfterMs: 0 };
  return {
    ...real,
    rateLimit: vi.fn(async (_k: string, _m: number, _w: number, o?: { falhaFecha?: boolean }) => (o?.falhaFecha ? semRedis : livre)),
    peekRateLimit: vi.fn(async (_k: string, _m: number, _w: number, o?: { falhaFecha?: boolean }) =>
      o?.falhaFecha && estado.espiarCota === "sem-redis" ? semRedis : livre,
    ),
  };
});

const { iniciarCadastroComSenha, reenviarConfirmacao, cadastroComSenhaDisponivel, aguardarCadastros, MENSAGEM_INDISPONIVEL } = await import(
  "./cadastro-com-senha"
);

const AJUSTES = {
  PLATFORM_EMAIL_FROM: "CRM Agro <noreply@crmagro.example>",
  PLATFORM_SMTP_HOST: "smtp.resend.teste.invalid",
  PLATFORM_SMTP_USER: "resend",
  PLATFORM_SMTP_PASS: "re_chave_de_teste",
  AUTH_URL: "https://app.crmagro.example",
} as const;
type Chave = keyof typeof AJUSTES;
const original = Object.fromEntries(Object.keys(AJUSTES).map((k) => [k, (env as Record<string, unknown>)[k]]));

beforeEach(() => {
  Object.assign(env as Record<Chave, string>, AJUSTES);
  estado.espiarCota = "sem-redis";
  envio.plataforma.mockClear();
});
afterEach(() => {
  const alvo = env as Record<string, unknown>;
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete alvo[k];
    else alvo[k] = v;
  }
});

const formulario = (email: string) => ({
  empresa: { nome: "Fazenda Três Rios" },
  nome: "Maria Pereira",
  email,
  senha: "colheita-de-soja-2026",
  confirmar: "colheita-de-soja-2026",
});
const hashSenha = async (s: string) => `hash:${s}`;

describe("Redis fora do ar: cadastro com senha indisponível (fail-closed)", () => {
  it("a opção some da tela e o cadastro responde 'indisponível' (sem gravar nem enviar)", async () => {
    expect(await cadastroComSenhaDisponivel()).toBe(false);
    const r = await iniciarCadastroComSenha(formulario(`sem-redis-${randomUUID()}@exemplo.com.br`), { hashSenha, ip: "200.1.2.3" });
    expect(r).toEqual({ ok: false, motivo: "fechado", mensagem: MENSAGEM_INDISPONIVEL });
    await aguardarCadastros();
    expect(envio.plataforma).not.toHaveBeenCalled();
  });

  it("mesmo com a cota consultada 'livre', o limite por IP/e-mail sem Redis recusa (não fica sem limite)", async () => {
    estado.espiarCota = "livre";
    const hash = vi.fn(hashSenha);
    const r = await iniciarCadastroComSenha(formulario(`sem-redis-${randomUUID()}@exemplo.com.br`), { hashSenha: hash, ip: "200.1.2.3" });
    expect(r).toEqual({ ok: false, motivo: "fechado", mensagem: MENSAGEM_INDISPONIVEL });
    expect(hash).not.toHaveBeenCalled();
    const re = await reenviarConfirmacao(randomUUID(), { ip: "200.1.2.3" });
    expect(re).toMatchObject({ ok: false, motivo: "fechado" });
    await aguardarCadastros();
    expect(envio.plataforma).not.toHaveBeenCalled();
  });

  it("reenviar também recusa quando não dá para consultar a cota", async () => {
    expect(await reenviarConfirmacao(randomUUID(), { ip: "200.1.2.3" })).toMatchObject({ ok: false, motivo: "fechado" });
  });
});
