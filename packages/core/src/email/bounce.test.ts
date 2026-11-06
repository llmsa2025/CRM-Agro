import { describe, it, expect } from "vitest";
import { analisarBounce, pareceBounce, remetenteDeAviso } from "@crmagro/channels";

/**
 * Item 3.4 (INT-21) — leitura dos avisos de não entrega (DSN). Os exemplos
 * imitam os formatos reais do Postfix, do Exchange/Office 365 e do Gmail.
 */

const POSTFIX = [
  "Return-Path: <>",
  "From: MAILER-DAEMON@mx.provedor.test (Mail Delivery System)",
  "Subject: Undelivered Mail Returned to Sender",
  "Message-Id: <20260926.ABC@mx.provedor.test>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/report; report-type=delivery-status;',
  '\tboundary="B1"',
  "",
  "--B1",
  "Content-Type: text/plain; charset=us-ascii",
  "",
  "I'm sorry to have to inform you that your message could not",
  "be delivered to one or more recipients.",
  "",
  "--B1",
  "Content-Type: message/delivery-status",
  "",
  "Reporting-MTA: dns; mx.provedor.test",
  "",
  "Final-Recipient: rfc822; NaoExiste@Cliente.test",
  "Original-Recipient: rfc822;naoexiste@cliente.test",
  "Action: failed",
  "Status: 5.1.1",
  "Diagnostic-Code: smtp; 550 5.1.1 <naoexiste@cliente.test>: Recipient address",
  "    rejected: User unknown",
  "",
  "--B1",
  "Content-Type: text/rfc822-headers",
  "",
  "From: vendas@crmagro.test",
  "To: naoexiste@cliente.test",
  "Subject: Proposta",
  "Message-ID: <original-123@crmagro.test>",
  "",
  "--B1--",
].join("\r\n");

const EXCHANGE = [
  "From: postmaster@contoso.test",
  "Subject: Undeliverable: Proposta",
  "Content-Type: multipart/report; report-type=delivery-status; boundary=\"X\"",
  "Message-ID: <ndr-1@contoso.test>",
  "",
  "--X",
  "Content-Type: text/plain",
  "",
  "Your message to fulano@contoso.test couldn't be delivered.",
  "--X",
  "Content-Type: message/delivery-status",
  "",
  "Reporting-MTA: dns;BN6PR.prod.outlook.com",
  "",
  "Final-recipient: RFC822; fulano@contoso.test",
  "Action: failed",
  "Status: 5.1.10",
  "Diagnostic-code: smtp;550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup",
  "",
  "--X",
  "Content-Type: message/rfc822",
  "",
  "From: vendas@crmagro.test",
  "To: fulano@contoso.test",
  "Message-ID:",
  " <original-456@crmagro.test>",
  "Subject: Proposta",
  "",
  "corpo original",
  "--X--",
].join("\r\n");

const GMAIL = [
  "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
  "Subject: Delivery Status Notification (Failure)",
  "X-Failed-Recipients: sumiu@gmail.test",
  "Message-ID: <dsn-g@mx.google.com>",
  "",
  "Address not found",
  "Your message wasn't delivered to sumiu@gmail.test because the address couldn't be found.",
].join("\r\n");

const ATRASADO = [
  "From: MAILER-DAEMON@mx.provedor.test",
  "Subject: Delayed Mail (still being retried)",
  "Content-Type: multipart/report; report-type=delivery-status; boundary=\"D\"",
  "",
  "--D",
  "Content-Type: message/delivery-status",
  "",
  "Final-Recipient: rfc822; lento@cliente.test",
  "Action: delayed",
  "Status: 4.4.1",
  "Diagnostic-Code: X-Postfix; connect to mx.cliente.test: Connection timed out",
  "",
  "--D--",
].join("\r\n");

describe("analisarBounce", () => {
  it("Postfix: destinatário do DSN (minúsculo), permanente, e o Message-ID do original", () => {
    const b = analisarBounce(POSTFIX);
    expect(b.destinatarios).toEqual([
      expect.objectContaining({ email: "naoexiste@cliente.test", permanente: true, status: "5.1.1" }),
    ]);
    expect(b.destinatarios[0]!.diagnostico).toContain("User unknown");
    // O Message-ID do TOPO é do próprio aviso; o do original vem de dentro.
    expect(b.messageIdOriginal).toBe("<original-123@crmagro.test>");
  });

  it("Exchange: status 5.1.10 e Message-ID dobrado em duas linhas dentro do message/rfc822", () => {
    const b = analisarBounce(EXCHANGE);
    expect(b.destinatarios).toEqual([expect.objectContaining({ email: "fulano@contoso.test", permanente: true, status: "5.1.10" })]);
    expect(b.messageIdOriginal).toBe("<original-456@crmagro.test>");
  });

  it("Gmail: X-Failed-Recipients sem DSN conta como permanente", () => {
    const b = analisarBounce(GMAIL);
    expect(b.destinatarios).toEqual([{ email: "sumiu@gmail.test", permanente: true, status: null, diagnostico: null }]);
    expect(b.messageIdOriginal).toBeNull();
  });

  it("atraso (4.x.x / delayed) não é permanente", () => {
    const b = analisarBounce(ATRASADO);
    expect(b.destinatarios).toEqual([expect.objectContaining({ email: "lento@cliente.test", permanente: false, status: "4.4.1" })]);
  });

  it("sem DSN: texto dizendo que o endereço não existe vira 'permanente sem destinatário'", () => {
    const b = analisarBounce("From: postmaster@x.test\r\nSubject: Returned mail\r\n\r\n550 User unknown\r\n");
    expect(b).toEqual({ destinatarios: [], messageIdOriginal: null, permanenteSemDestinatario: true });
    expect(analisarBounce("Subject: oi\r\n\r\nqualquer coisa").permanenteSemDestinatario).toBe(false);
  });
});

describe("pareceBounce", () => {
  it("reconhece só por prova estrutural: remetente de sistema, X-Failed-Recipients ou multipart/report", () => {
    expect(pareceBounce("mailer-daemon@googlemail.com", "")).toBe(true);
    expect(pareceBounce("postmaster@outlook.com", "")).toBe(true);
    expect(pareceBounce("microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@cliente.onmicrosoft.com", "")).toBe(true);
    expect(pareceBounce("x@y.test", "X-Failed-Recipients: a@b.test")).toBe(true);
    expect(
      pareceBounce("x@y.test", "Content-Type: multipart/report;\r\n report-type=delivery-status; boundary=a"),
    ).toBe(true);
    expect(pareceBounce("lead@cliente.test", "References: <a@b>")).toBe(false);
  });

  it("auditoria do 3.4: ASSUNTO sozinho não é bounce (lead que responde 'Pedido não entregue')", () => {
    // Antes: "Undeliverable"/"não entregue" no assunto bastava — a resposta do
    // lead sumia e o e-mail dele virava inválido.
    expect(pareceBounce("lead@cliente.test", "References: <prop@crmagro.test>")).toBe(false);
    expect(pareceBounce("postmaster.joao@cliente.test", "")).toBe(false);
    expect(remetenteDeAviso("MAILER-DAEMON@mx.provedor.test")).toBe(true);
  });
});
