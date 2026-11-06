import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Conformidade (item 3.7): chave de credencial com id e rotação (S20) e token
 * do webhook do WhatsApp por instância, no header (S18). Evolution MOCKADA.
 */
const cfg = vi.hoisted(() => {
  // Antes do @crmagro/config ler o env: URL pública e segredo fixos no teste.
  process.env.APP_PUBLIC_URL = "https://crmagro.teste";
  process.env.WHATSAPP_WEBHOOK_TOKEN = "segredo-global-de-teste";
  return { segredo: "segredo-global-de-teste" };
});
const evo = vi.hoisted(() => ({
  createEvolutionInstance: vi.fn(async () => ({ ok: true })),
  setEvolutionWebhook: vi.fn(async (_i: { url: string; headers?: Record<string, string> }) => ({ ok: true })),
  getEvolutionQR: vi.fn(async () => ({ ok: true, state: "connecting", qrBase64: "QR" })),
  verifyEvolutionInstance: vi.fn(async () => ({ ok: true, state: "open", number: null })),
  deleteEvolutionInstance: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@crmagro/channels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@crmagro/channels")>()),
  ...evo,
}));

const { anelDeChaves, cifrarCom, decifrarCom, precisaRecifrar, recifrarCom, ChaveDeCredencialAusente } = await import(
  "@crmagro/db"
);
const { getAiApiKey } = await import("./service");
const { autenticarWebhookWhatsApp, tokenDoWebhookDaInstancia, WEBHOOK_TOKEN_HEADER } = await import("./whatsapp-webhook-token");
const { startWhatsAppOnboarding, cancelWhatsAppOnboarding } = await import("./whatsapp-onboarding");

const TEAM = "00000000-0000-0000-0000-0000000004a3";
const ADMIN = { userId: "admin-conf", role: "admin" } as const;

const VELHA = "chave-velha-de-teste-com-mais-de-32-caracteres";
const NOVA = "chave-nova-de-teste-com-mais-de-32-caracteres!!";

/** Cifra no formato ANTIGO (v1, sem kid) — exatamente como o código anterior gravava. */
function cifrarV1(segredo: string, json: unknown) {
  const key = crypto.createHash("sha256").update(segredo).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(json), "utf8")), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team conformidade (test)" } });
});
beforeEach(async () => {
  await basePrisma.integration.deleteMany({ where: { teamId: TEAM } });
  evo.setEvolutionWebhook.mockClear();
});

// ─── Credenciais: kid e rotação (S20) ───────────────────────────────────────

describe("credenciais — formato com kid e rotação", () => {
  it("dado cifrado no formato antigo (v1) continua legível com a chave atual", () => {
    const anel = anelDeChaves(VELHA);
    expect(decifrarCom(anel, cifrarV1(VELHA, { apiKey: "sk-velha" }))).toEqual({ apiKey: "sk-velha" });
  });

  it("grava v2 com o kid da chave atual", () => {
    const anel = anelDeChaves(VELHA);
    const c = cifrarCom(anel, { a: 1 });
    expect(c.v).toBe(2);
    expect(c.kid).toBe(anel.atual.kid);
    expect(decifrarCom(anel, c)).toEqual({ a: 1 });
  });

  it("rotação: a nova cifra, a antiga ainda decifra (v1 e v2), e a recifragem migra", () => {
    const antes = anelDeChaves(VELHA);
    const v2Velho = cifrarCom(antes, { apiKey: "v2" });
    const v1 = cifrarV1(VELHA, { apiKey: "v1" });

    const girado = anelDeChaves(VELHA, `${NOVA},${VELHA}`);
    expect(girado.atual.kid).not.toBe(antes.atual.kid);
    expect(decifrarCom(girado, v1)).toEqual({ apiKey: "v1" });
    expect(decifrarCom(girado, v2Velho)).toEqual({ apiKey: "v2" });
    expect(cifrarCom(girado, {}).kid).toBe(girado.atual.kid);

    expect(precisaRecifrar(girado, v1)).toBe(true);
    expect(precisaRecifrar(girado, v2Velho)).toBe(true);
    const migrado = recifrarCom(girado, v1) as { v: number; kid: string };
    expect(migrado).toMatchObject({ v: 2, kid: girado.atual.kid });
    expect(precisaRecifrar(girado, migrado)).toBe(false);

    // Depois de aposentar a velha, o migrado segue legível; o v2 velho não.
    const soNova = anelDeChaves(NOVA);
    expect(decifrarCom(soNova, migrado)).toEqual({ apiKey: "v1" });
    expect(() => decifrarCom(soNova, v2Velho)).toThrow(ChaveDeCredencialAusente);
  });

  it("recifragem preserva as camadas (Integration tem duas) e não cifra texto puro", () => {
    const anel = anelDeChaves(VELHA, `${NOVA},${VELHA}`);
    const duas = cifrarV1(VELHA, cifrarV1(VELHA, { apiKey: "x" }));
    const r = recifrarCom(anel, duas);
    const dentro = decifrarCom(anel, r) as { v: number; kid: string };
    expect(dentro).toMatchObject({ v: 2, kid: anel.atual.kid });
    expect(decifrarCom(anel, dentro)).toEqual({ apiKey: "x" });
    expect(recifrarCom(anel, { instance: "texto-puro" })).toEqual({ instance: "texto-puro" });
  });

  it("ponta a ponta: chave de IA gravada no formato antigo (2 camadas v1) é lida pelo serviço", async () => {
    const principal = process.env.CREDENTIALS_ENCRYPTION_KEY!;
    await basePrisma.integration.create({
      data: {
        teamId: TEAM,
        tipo: "anthropic",
        status: "connected",
        credentials: cifrarV1(principal, cifrarV1(principal, { apiKey: "sk-antiga" })),
      },
    });
    await expect(runWithTeam(TEAM, () => getAiApiKey("anthropic"))).resolves.toBe("sk-antiga");
  });
});

// ─── Webhook do WhatsApp: token por instância no header (S18) ───────────────

describe("webhook do WhatsApp — token por instância", () => {
  const segredo = "segredo-global";
  const tokenA = tokenDoWebhookDaInstancia("inst-a", segredo);

  it("a fórmula é HMAC-SHA256(segredo, 'wa-webhook:' + instância) — a mesma do script de reaplicar", () => {
    expect(tokenA).toBe(crypto.createHmac("sha256", segredo).update("wa-webhook:inst-a").digest("hex"));
  });

  it("header com o token da instância do payload passa; de outra instância, não", () => {
    const base = { segredo, producao: true, aceitarLegado: false };
    expect(autenticarWebhookWhatsApp({ instance: "inst-a", header: tokenA, query: null }, base)).toEqual({ ok: true, via: "instancia" });
    // Token vazado da instância A não forja evento da B.
    expect(autenticarWebhookWhatsApp({ instance: "inst-b", header: tokenA, query: null }, base).ok).toBe(false);
    expect(autenticarWebhookWhatsApp({ instance: null, header: tokenA, query: null }, base).ok).toBe(false);
  });

  it("transição: o segredo global na query vale até desligar o legado", () => {
    const e = { instance: "inst-a", header: null, query: segredo };
    expect(autenticarWebhookWhatsApp(e, { segredo, producao: true, aceitarLegado: true })).toEqual({ ok: true, via: "legado" });
    expect(autenticarWebhookWhatsApp(e, { segredo, producao: true, aceitarLegado: false }).ok).toBe(false);
    expect(autenticarWebhookWhatsApp({ ...e, query: "errado" }, { segredo, producao: true, aceitarLegado: true }).ok).toBe(false);
  });

  it("produção sem segredo → recusa; dev sem segredo → aceita", () => {
    const e = { instance: "x", header: null, query: null };
    expect(autenticarWebhookWhatsApp(e, { segredo: null, producao: true })).toEqual({ ok: false, motivo: "sem_segredo_em_producao" });
    expect(autenticarWebhookWhatsApp(e, { segredo: null, producao: false }).ok).toBe(true);
  });

  it("conexão nova configura o webhook SEM token na URL e com o token da instância no header", async () => {
    const r = await runWithTeam(TEAM, () => startWhatsAppOnboarding({ label: "Conformidade" }), ADMIN);
    expect(r.ok).toBe(true);
    const instance = (r as { instance: string }).instance;
    try {
      const arg = evo.setEvolutionWebhook.mock.calls[0]![0];
      expect(arg.url).toBe("https://crmagro.teste/api/webhooks/whatsapp");
      expect(arg.url).not.toContain("token");
      expect(arg.headers).toEqual({ [WEBHOOK_TOKEN_HEADER]: tokenDoWebhookDaInstancia(instance, cfg.segredo) });
    } finally {
      await runWithTeam(TEAM, () => cancelWhatsAppOnboarding(instance), ADMIN);
    }
  });
});
