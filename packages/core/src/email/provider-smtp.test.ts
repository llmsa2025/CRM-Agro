import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { EmailProvider, transporteSmtpPara, type SmtpConfig } from "@crmagro/channels";

/**
 * O que o remetente da plataforma pede ao `EmailProvider` chega de fato ao
 * `sendMail` do nodemailer (os outros testes trocam o provider inteiro por um
 * espião): reply-to, `Auto-Submitted`, destinatário único e STARTTLS
 * obrigatório. O `sendMail` do transporte é espionado: nada sai para a rede.
 */
const abertos: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const t of abertos.splice(0)) t.close();
});

function conta(extra: Partial<SmtpConfig> = {}): SmtpConfig {
  // Usuário único: o transporte é cacheado por credencial dentro do processo.
  return { host: "smtp.teste.invalid", port: 465, secure: true, user: `u-${randomUUID()}`, pass: "x", from: "CRM Agro <noreply@crmagro.example>", ...extra };
}

function espiarEnvio(cfg: SmtpConfig) {
  const t = transporteSmtpPara(cfg);
  abertos.push(t);
  return vi.spyOn(t, "sendMail").mockResolvedValue({ messageId: "<x@teste>" } as never);
}

describe("EmailProvider — o que chega ao nodemailer", () => {
  it("remetente da plataforma: reply-to, Auto-Submitted e o destino como UM endereço (sem lista nem grupo)", async () => {
    const cfg = conta({
      replyTo: "suporte@crmagro.example",
      headers: { "Auto-Submitted": "auto-generated" },
      destinatarioUnico: true,
    });
    const sendMail = espiarEnvio(cfg);
    await new EmailProvider(cfg).send({ to: "pessoa@exemplo.com.br", content: { subject: "s", text: "t" } });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]![0]).toMatchObject({
      from: "CRM Agro <noreply@crmagro.example>",
      to: { name: "", address: "pessoa@exemplo.com.br" },
      replyTo: "suporte@crmagro.example",
      headers: { "Auto-Submitted": "auto-generated" },
      subject: "s",
      text: "t",
    });
  });

  it("caixa conectada de um time (sem as opções): nada muda — destino em texto, sem reply-to nem cabeçalho extra", async () => {
    const cfg = conta();
    const sendMail = espiarEnvio(cfg);
    await new EmailProvider(cfg).send({ to: "pessoa@exemplo.com.br", content: { subject: "s", text: "t" } });
    const enviado = sendMail.mock.calls[0]![0] as Record<string, unknown>;
    expect(enviado.to).toBe("pessoa@exemplo.com.br");
    expect(enviado).not.toHaveProperty("replyTo");
    expect(enviado).not.toHaveProperty("headers");
  });

  it("STARTTLS obrigatório (requireTLS) só quando pedido, e em transporte separado", () => {
    const base = conta({ port: 587, secure: false });
    const comTls = transporteSmtpPara({ ...base, requireTLS: true });
    const semTls = transporteSmtpPara(base);
    abertos.push(comTls, semTls);
    expect(comTls).not.toBe(semTls);
    expect((comTls as unknown as { options: { requireTLS?: boolean } }).options.requireTLS).toBe(true);
    expect((semTls as unknown as { options: { requireTLS?: boolean } }).options.requireTLS).toBeUndefined();
  });
});
