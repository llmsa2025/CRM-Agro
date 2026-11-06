import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { remetenteDaPlataforma, VARIAVEIS_PLATAFORMA } from "@crmagro/config";

/**
 * PLATFORM_* com erro NÃO derruba o boot (achado da revisão do PR #165): antes,
 * o `superRefine` do @crmagro/config lançava "Env inválido" no import, e web e
 * worker caíam no PRÓXIMO restart (o pm2 reinicia o web várias vezes por dia),
 * horas depois de alguém mexer no .env. Agora o erro vira estado `invalido`
 * (o envio recusa e o /api/health mostra).
 *
 * Dois testes importam o @crmagro/config num PROCESSO FILHO com o .env pela
 * metade, como o run-web.sh/run-worker.sh fariam. Nada é enviado.
 */
const WORKER = fileURLToPath(new URL("../../../../apps/worker", import.meta.url));

function importarConfig(extra: Record<string, string>): { status: number | null; saida: string } {
  const ambiente: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("PLATFORM_")) ambiente[k] = v;
  const r = spawnSync(
    "pnpm",
    ["exec", "tsx", "-e", 'import("@crmagro/config").then((c) => console.log("estado=" + c.remetenteDaPlataforma().estado));'],
    { cwd: WORKER, env: { ...ambiente, ...extra }, encoding: "utf8", timeout: 60_000 },
  );
  return { status: r.status, saida: `${r.stdout}\n${r.stderr}` };
}

describe("remetente da plataforma — o boot não cai por causa de e-mail", () => {
  it("só o HOST preenchido: o import do @crmagro/config NÃO lança; o estado é 'invalido' e o log diz o que falta", () => {
    const r = importarConfig({ PLATFORM_SMTP_HOST: "smtp.resend.com" });
    expect(r.saida).not.toContain("Env inválido");
    expect(r.status).toBe(0);
    expect(r.saida).toContain("estado=invalido");
    expect(r.saida).toContain("PLATFORM_SMTP_PASS ausente");
  }, 90_000);

  it("REPLY_TO com erro de digitação e SECURE=True também não derrubam", () => {
    const r = importarConfig({ PLATFORM_EMAIL_REPLY_TO: "suporte@crmagro", PLATFORM_SMTP_SECURE: "True" });
    expect(r.status).toBe(0);
    expect(r.saida).toContain("estado=invalido");
  }, 90_000);

  it("sem nenhuma PLATFORM_*: desligado (legado)", () => {
    expect(remetenteDaPlataforma({})).toEqual({ estado: "desligado" });
    const vazio = Object.fromEntries(VARIAVEIS_PLATAFORMA.map((k) => [k, "  "]));
    expect(remetenteDaPlataforma(vazio)).toEqual({ estado: "desligado" });
  });

  it("completo: ok, com o teto diário padrão (90) ou o do .env", () => {
    const base = {
      PLATFORM_EMAIL_FROM: "CRM Agro <noreply@crmagro.example>",
      PLATFORM_SMTP_HOST: "smtp.resend.com",
      PLATFORM_SMTP_USER: "resend",
      PLATFORM_SMTP_PASS: "re_x",
    };
    expect(remetenteDaPlataforma(base)).toMatchObject({ estado: "ok", port: 465, secure: true, limiteDia: 90 });
    expect(remetenteDaPlataforma({ ...base, PLATFORM_EMAIL_LIMITE_DIA: "5000" })).toMatchObject({ estado: "ok", limiteDia: 5000 });
  });
});
