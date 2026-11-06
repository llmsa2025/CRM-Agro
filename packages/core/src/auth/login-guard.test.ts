import { describe, it, expect } from "vitest";
import { LOGIN_LIMITES, checkLoginRateLimit, registrarFalhaDeLogin, registrarSucessoDeLogin } from "./login-guard";

/**
 * Limite de tentativas de login (auditoria S8 / #52): força bruta por par (e-mail, IP), por e-mail
 * em vários IPs, por IP varrendo e-mails, e o teto de CPU por IP. Usa o Redis de teste com
 * e-mails e IPs únicos por teste (as janelas são de 15 minutos).
 */
const sufixo = Math.random().toString(36).slice(2, 8);
let n = 0;
let m = 0;
const email = () => `alvo-${sufixo}-${++n}@teste.dev`;
// Cada chamada devolve um IP NOVO (contador próprio): "outro IP" nunca coincide com o do atacante.
const ip = () => `10.${(++m >> 8) & 255}.${m & 255}.${(parseInt(sufixo, 36) % 200) + 1}`;

/** Uma tentativa ERRADA completa: confere o limite e, se passou, registra a falha. */
async function tentarErrado(e: string, i: string): Promise<boolean> {
  const r = await checkLoginRateLimit({ ip: i, email: e });
  if (!r.allowed) return false;
  await registrarFalhaDeLogin({ ip: i, email: e });
  return true;
}

describe("login: par (e-mail, IP)", () => {
  it("10 falhas passam; a 11ª é barrada ANTES do bcrypt", async () => {
    const e = email();
    const i = ip();
    for (let k = 0; k < LOGIN_LIMITES.falhasPorEmailEIp.max; k++) expect(await tentarErrado(e, i), `falha ${k + 1}`).toBe(true);
    const r = await checkLoginRateLimit({ ip: i, email: e });
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it("quem chuta a senha de um lugar só tranca a si mesmo: o dono, de outro IP, entra", async () => {
    const e = email();
    const atacante = ip();
    for (let k = 0; k < LOGIN_LIMITES.falhasPorEmailEIp.max; k++) await tentarErrado(e, atacante);
    expect((await checkLoginRateLimit({ ip: atacante, email: e })).allowed).toBe(false);
    expect((await checkLoginRateLimit({ ip: ip(), email: e })).allowed).toBe(true);
  });

  it("o login certo zera as falhas do par (erro de digitação do próprio dono)", async () => {
    const e = email();
    const i = ip();
    for (let k = 0; k < 9; k++) await tentarErrado(e, i);
    await registrarSucessoDeLogin({ ip: i, email: e });
    for (let k = 0; k < LOGIN_LIMITES.falhasPorEmailEIp.max; k++) expect(await tentarErrado(e, i), `falha ${k + 1} depois do acerto`).toBe(true);
    expect((await checkLoginRateLimit({ ip: i, email: e })).allowed).toBe(false);
  });

  it("e-mail em maiúsculas e com espaço conta como o mesmo e-mail", async () => {
    const e = email();
    const i = ip();
    for (let k = 0; k < LOGIN_LIMITES.falhasPorEmailEIp.max; k++) await tentarErrado(e, i);
    expect((await checkLoginRateLimit({ ip: i, email: `  ${e.toUpperCase()} ` })).allowed).toBe(false);
  });
});

describe("login: força bruta distribuída e robô varrendo e-mails", () => {
  it("o mesmo e-mail atacado de muitos IPs é barrado no teto do e-mail (50 em 15 min)", async () => {
    const e = email();
    for (let k = 0; k < LOGIN_LIMITES.falhasPorEmail.max; k++) expect(await tentarErrado(e, ip()), `falha ${k + 1}`).toBe(true);
    // Um IP novo, sem nenhuma falha, já não passa: o e-mail está no teto.
    expect((await checkLoginRateLimit({ ip: ip(), email: e })).allowed).toBe(false);
  });

  it("um IP errando e-mails diferentes é barrado no teto de falhas do IP (20 em 15 min)", async () => {
    const i = ip();
    for (let k = 0; k < LOGIN_LIMITES.falhasPorIp.max; k++) expect(await tentarErrado(email(), i), `falha ${k + 1}`).toBe(true);
    expect((await checkLoginRateLimit({ ip: i, email: email() })).allowed).toBe(false);
  });

  it("teto de CPU: 60 tentativas por IP (mesmo sem registrar falha) e a 61ª é barrada", async () => {
    const i = ip();
    for (let k = 0; k < LOGIN_LIMITES.tentativasPorIp.max; k++) {
      expect((await checkLoginRateLimit({ ip: i, email: email() })).allowed, `tentativa ${k + 1}`).toBe(true);
    }
    expect((await checkLoginRateLimit({ ip: i, email: email() })).allowed).toBe(false);
  });
});
