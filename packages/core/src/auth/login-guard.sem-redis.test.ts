import { describe, it, expect, vi } from "vitest";

/**
 * O MESMO limite de login com o Redis FORA DE VERDADE (porta fechada). Antes, o limitador
 * travava a requisição de login; agora responde rápido e segue limitando em memória.
 */
vi.mock("@crmagro/config", async (orig) => {
  const m = await orig<typeof import("@crmagro/config")>();
  return { ...m, env: new Proxy(m.env, { get: (t, p) => (p === "REDIS_URL" ? "redis://127.0.0.1:9" : (t as never)[p as never]) }) };
});

const { LOGIN_LIMITES, checkLoginRateLimit, registrarFalhaDeLogin, registrarSucessoDeLogin } = await import("./login-guard");

const sufixo = Math.random().toString(36).slice(2, 8);
let n = 0;
let m = 0;
const email = () => `semredis-${sufixo}-${++n}@teste.dev`;
// Cada chamada devolve um IP NOVO (contador próprio): "outro IP" nunca coincide com o do atacante.
const ip = () => `172.16.${(++m >> 8) & 255}.${m & 255}`;

async function tentarErrado(e: string, i: string): Promise<boolean> {
  const r = await checkLoginRateLimit({ ip: i, email: e });
  if (!r.allowed) return false;
  await registrarFalhaDeLogin({ ip: i, email: e });
  return true;
}

describe("login com o Redis fora", () => {
  it("a força bruta continua barrada (11ª falha do par) e rápido, sem travar", async () => {
    const e = email();
    const i = ip();
    const inicio = Date.now();
    for (let k = 0; k < LOGIN_LIMITES.falhasPorEmailEIp.max; k++) expect(await tentarErrado(e, i), `falha ${k + 1}`).toBe(true);
    expect((await checkLoginRateLimit({ ip: i, email: e })).allowed).toBe(false);
    expect(Date.now() - inicio).toBeLessThan(5000);
  }, 20_000);

  it("o dono de outro IP entra, e o acerto zera o par", async () => {
    const e = email();
    const atacante = ip();
    for (let k = 0; k < LOGIN_LIMITES.falhasPorEmailEIp.max; k++) await tentarErrado(e, atacante);
    expect((await checkLoginRateLimit({ ip: ip(), email: e })).allowed).toBe(true);

    const e2 = email();
    const i2 = ip();
    for (let k = 0; k < 9; k++) await tentarErrado(e2, i2);
    await registrarSucessoDeLogin({ ip: i2, email: e2 });
    for (let k = 0; k < LOGIN_LIMITES.falhasPorEmailEIp.max; k++) expect(await tentarErrado(e2, i2)).toBe(true);
  }, 20_000);

  it("o teto de falhas por e-mail (vários IPs) também vale", async () => {
    const e = email();
    for (let k = 0; k < LOGIN_LIMITES.falhasPorEmail.max; k++) await tentarErrado(e, ip());
    expect((await checkLoginRateLimit({ ip: ip(), email: e })).allowed).toBe(false);
  }, 30_000);
});
