import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ChannelSendFailed,
  EmailProvider,
  GmailApiProvider,
  GmailSemAutorizacao,
  getChannelProvider,
  isChannelSendFailed,
  isGmailSemAutorizacao,
  montarMime,
  opcoesDoEmail,
  transporteSmtpPara,
  type SmtpConfig,
} from "@crmagro/channels";

/**
 * Envio pela API do Gmail (E6): o `GmailApiProvider` monta o MESMO MIME que o SMTP
 * e o manda pelo endpoint de upload do `users.messages.send`. O `fetch` é simulado
 * (`vi.stubGlobal`, desfeito a cada teste): nada sai para o Google. Sem banco.
 */
const TOKEN = "ya29.token-secreto-de-teste";
const URL_ENVIO = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";

type Chamada = { url: string; init: RequestInit };

/** Troca o `fetch` por um que registra o pedido e devolve a resposta dada. */
function fingirGmail(resposta: () => Response | Promise<Response>): Chamada[] {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      chamadas.push({ url: String(url), init });
      return resposta();
    }),
  );
  return chamadas;
}

const json = (status: number, corpo: unknown) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
const enviou = () => json(200, { id: "18c1", threadId: "18c1" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function provider(extra: Partial<ConstructorParameters<typeof GmailApiProvider>[0]> = {}) {
  return new GmailApiProvider({ accessToken: TOKEN, from: "Ana <ana@gmail.com>", ...extra });
}

/** O MIME que foi no corpo do POST (o `send` manda os bytes como Uint8Array). */
function mimeDe(c: Chamada): string {
  return Buffer.from(c.init.body as Uint8Array).toString("utf8");
}

/** Valor de um cabeçalho do MIME (junta as linhas dobradas); null se não existir. */
function cabecalho(mime: string, nome: string): string | null {
  const achou = new RegExp(`^${nome}:[ \\t]*(.*(?:\\r\\n[ \\t]+.*)*)`, "im").exec(mime);
  return achou ? achou[1]!.replace(/\r\n[ \t]+/g, " ").trim() : null;
}

async function falhaDe(p: Promise<unknown>): Promise<ChannelSendFailed> {
  try {
    await p;
  } catch (e) {
    expect(isChannelSendFailed(e)).toBe(true);
    return e as ChannelSendFailed;
  }
  throw new Error("era para o envio falhar");
}

describe("GmailApiProvider: o pedido e o MIME", () => {
  it("1. um POST no endpoint de upload, com Bearer e message/rfc822; o MIME tem os cabeçalhos pedidos e o Message-ID vira o providerMessageId", async () => {
    const chamadas = fingirGmail(enviou);
    const saida = await provider().send({
      to: "lead@exemplo.com.br",
      content: {
        subject: "Proposta",
        text: "Oi, tudo bem?",
        inReplyTo: "<anterior@exemplo.com.br>",
        references: ["<primeira@exemplo.com.br>", "<anterior@exemplo.com.br>"],
      },
    });

    expect(chamadas).toHaveLength(1);
    const { url, init } = chamadas[0]!;
    expect(url).toBe(URL_ENVIO);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ authorization: `Bearer ${TOKEN}`, "content-type": "message/rfc822" });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const mime = mimeDe(chamadas[0]!);
    expect(cabecalho(mime, "From")).toBe("Ana <ana@gmail.com>");
    expect(cabecalho(mime, "To")).toBe("lead@exemplo.com.br");
    expect(cabecalho(mime, "Subject")).toBe("Proposta");
    expect(cabecalho(mime, "In-Reply-To")).toBe("<anterior@exemplo.com.br>");
    expect(cabecalho(mime, "References")).toBe("<primeira@exemplo.com.br> <anterior@exemplo.com.br>");
    const messageId = cabecalho(mime, "Message-ID");
    expect(messageId).toMatch(/^<.+@gmail\.com>$/);
    expect(saida.providerMessageId).toBe(messageId);
    expect(mime).toContain("Oi, tudo bem?");
  });

  it("o MIME usa CRLF (sem quebra de linha solta) e vai como bytes crus, não como base64 do e-mail inteiro", async () => {
    const chamadas = fingirGmail(enviou);
    await provider().send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "linha 1\nlinha 2" } });
    const mime = mimeDe(chamadas[0]!);
    expect(mime).not.toMatch(/(?<!\r)\n/);
    expect(mime.startsWith("Content-Type:") || /^[A-Za-z-]+: /.test(mime)).toBe(true);
    expect(mime).toContain("\r\n\r\n");
  });

  it("2. assinatura com imagem data: vira parte inline com Content-ID, como no SMTP", async () => {
    const chamadas = fingirGmail(enviou);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    await provider().send({
      to: "lead@exemplo.com.br",
      content: { subject: "s", text: "t", html: `<p>Oi</p><img src="data:image/png;base64,${png}">` },
    });
    const mime = mimeDe(chamadas[0]!);
    expect(cabecalho(mime, "Content-Id")).toMatch(/^<img1\..+@crmagro>$/);
    expect(mime).toMatch(/Content-Disposition: inline/i);
    expect(mime).toMatch(/Content-Type: image\/png/i);
    // O HTML aponta para o CID e não carrega mais o data URI.
    expect(mime).toContain("cid:img1.");
    expect(mime).not.toContain("data:image/png");
  });

  it("3. icsEvent vira uma parte text/calendar com method=REQUEST", async () => {
    const chamadas = fingirGmail(enviou);
    const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:x@crmagro\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    await provider().send({ to: "lead@exemplo.com.br", content: { subject: "Reunião", text: "t", icsEvent: ics } });
    const mime = mimeDe(chamadas[0]!);
    expect(mime).toMatch(/Content-Type: text\/calendar;[^\r\n]*method=REQUEST/i);
    expect(mime).toContain("BEGIN:VCALENDAR");
  });

  it("reply-to, cabeçalhos extras e destinatário único chegam ao MIME", async () => {
    const chamadas = fingirGmail(enviou);
    await provider({
      replyTo: "suporte@exemplo.com.br",
      headers: { "Auto-Submitted": "auto-generated" },
      destinatarioUnico: true,
    }).send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "t" } });
    const mime = mimeDe(chamadas[0]!);
    expect(cabecalho(mime, "Reply-To")).toBe("suporte@exemplo.com.br");
    expect(cabecalho(mime, "Auto-Submitted")).toBe("auto-generated");
    expect(cabecalho(mime, "To")).toBe("lead@exemplo.com.br");
  });

  it("sem assunto usa o mesmo texto do SMTP", async () => {
    const chamadas = fingirGmail(enviou);
    await provider().send({ to: "lead@exemplo.com.br", content: { text: "t" } });
    expect(cabecalho(mimeDe(chamadas[0]!), "Subject")).toBe("(sem assunto)");
  });

  it("sem destinatário (o nodemailer monta o MIME sem To): falha antes da rede, não saiu e não repete, como o EENVELOPE do SMTP", async () => {
    const chamadas = fingirGmail(enviou);
    for (const to of ["", "sem arroba"]) {
      const e = await falhaDe(provider().send({ to, content: { subject: "s", text: "t" } }));
      expect(e.outcome, to).toBe("not_sent");
      expect(e.retryable).toBe(false);
    }
    expect(chamadas).toHaveLength(0);
  });
});

describe("GmailApiProvider: erros classificados", () => {
  it("4. 401: sem autorização, não saiu, não repete", async () => {
    fingirGmail(() => json(401, { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED", errors: [{ reason: "authError" }] } }));
    const e = await falhaDe(provider().send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "t" } }));
    expect(isGmailSemAutorizacao(e)).toBe(true);
    expect(e).toBeInstanceOf(GmailSemAutorizacao);
    expect(e.name).toBe("ChannelSendFailed");
    expect(e.outcome).toBe("not_sent");
    expect(e.retryable).toBe(false);
    expect(e.status).toBe(401);
  });

  it("5. 403 de limite (userRateLimitExceeded, dailyLimitExceeded, rateLimitExceeded, quotaExceeded) repete e NÃO derruba a conta", async () => {
    for (const reason of ["userRateLimitExceeded", "dailyLimitExceeded", "rateLimitExceeded", "quotaExceeded"]) {
      fingirGmail(() => json(403, { error: { code: 403, errors: [{ reason }], status: "PERMISSION_DENIED" } }));
      const e = await falhaDe(provider().send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "t" } }));
      expect(isGmailSemAutorizacao(e), reason).toBe(false);
      expect(e.outcome).toBe("not_sent");
      expect(e.retryable, reason).toBe(true);
      expect(e.message).toBe(`gmail send 403: ${reason}`);
      vi.unstubAllGlobals();
    }
  });

  it("5b. outro 403 (domainPolicy do Workspace, escopo insuficiente, sem motivo) é falta de autorização", async () => {
    const corpos = [
      { error: { code: 403, errors: [{ reason: "domainPolicy" }], status: "PERMISSION_DENIED" } },
      { error: { code: 403, errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED" } },
      { error: { code: 403, status: "PERMISSION_DENIED" } },
    ];
    for (const corpo of corpos) {
      fingirGmail(() => json(403, corpo));
      const e = await falhaDe(provider().send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "t" } }));
      expect(isGmailSemAutorizacao(e)).toBe(true);
      expect(e.outcome).toBe("not_sent");
      expect(e.retryable).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it("6. 429 e 503 repetem (not_sent, retryable) e não são falta de autorização; 400 não repete", async () => {
    for (const status of [429, 503, 500]) {
      fingirGmail(() => json(status, { error: { code: status, errors: [{ reason: "backendError" }], status: "UNAVAILABLE" } }));
      const e = await falhaDe(provider().send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "t" } }));
      expect(isGmailSemAutorizacao(e)).toBe(false);
      expect(e.outcome).toBe("not_sent");
      expect(e.retryable, String(status)).toBe(true);
      expect(e.status).toBe(status);
      vi.unstubAllGlobals();
    }
    fingirGmail(() => json(400, { error: { code: 400, errors: [{ reason: "invalidArgument" }], status: "INVALID_ARGUMENT" } }));
    const e400 = await falhaDe(provider().send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "t" } }));
    expect(e400.retryable).toBe(false);
    expect(e400.message).toBe("gmail send 400: invalidArgument");
  });

  it("o motivo é só o reason (ou o status) do JSON, nunca o corpo inteiro; corpo que não é JSON cai no código HTTP", async () => {
    fingirGmail(() => json(500, { error: { code: 500, message: "texto longo que não vai para a tela", errors: [{ reason: "backendError", message: "detalhe interno" }] } }));
    const e = await falhaDe(provider().send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "t" } }));
    expect(e.message).toBe("gmail send 500: backendError");

    vi.unstubAllGlobals();
    fingirGmail(() => json(502, { error: { code: 502, status: "BAD_GATEWAY" } }));
    expect((await falhaDe(provider().send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "t" } }))).message).toBe("gmail send 502: BAD_GATEWAY");

    vi.unstubAllGlobals();
    fingirGmail(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect((await falhaDe(provider().send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "t" } }))).message).toBe("gmail send 502: HTTP 502");
  });

  it("7. fetch que estoura o tempo (TimeoutError/AbortError) é 'unknown': pode ter saído, não repete sozinho", async () => {
    for (const nome of ["TimeoutError", "AbortError"]) {
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new DOMException("The operation was aborted", nome);
      }));
      const e = await falhaDe(provider().send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "t" } }));
      expect(e.outcome, nome).toBe("unknown");
      expect(e.retryable).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it("7b. conexão recusada (nem abriu): not_sent e repete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 142.250.0.1:443" } });
    }));
    const e = await falhaDe(provider().send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "t" } }));
    expect(e.outcome).toBe("not_sent");
    expect(e.retryable).toBe(true);
  });

  it("8. nenhuma mensagem de erro (nem o stack) contém o access token", async () => {
    const falhas: ChannelSendFailed[] = [];
    const pedir = async () =>
      falhas.push(await falhaDe(provider().send({ to: "lead@exemplo.com.br", content: { subject: "s", text: "t" } })));

    // Resposta HTTP cujo corpo devolve o token (o Google não faz isso, mas nada disso pode vazar).
    for (const status of [401, 403, 429, 500]) {
      fingirGmail(() => json(status, { error: { code: status, message: `Bearer ${TOKEN} recusado`, errors: [{ reason: "userRateLimitExceeded", message: TOKEN }], status: "X" } }));
      await pedir();
      vi.unstubAllGlobals();
    }
    // Erros de rede que trazem o token na mensagem e na causa.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new TypeError(`fetch failed (authorization: Bearer ${TOKEN})`), {
        cause: { code: "ECONNRESET", message: `reset ${TOKEN}` },
      });
    }));
    await pedir();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException(`aborted ${TOKEN}`, "TimeoutError");
    }));
    await pedir();

    expect(falhas.length).toBe(6);
    for (const e of falhas) {
      expect(e.message).not.toContain(TOKEN);
      expect(e.stack ?? "").not.toContain(TOKEN);
      expect(JSON.stringify({ ...e, message: e.message })).not.toContain(TOKEN);
    }
  });
});

describe("factory e SMTP", () => {
  it("9. getChannelProvider: gmail_api devolve o GmailApiProvider; gmail continua SMTP; canal errado ou credencial incompleta dá null", () => {
    const gmailApi = getChannelProvider({ canal: "email", provider: "gmail_api", credentials: { accessToken: "t", from: "a@b.c" } });
    expect(gmailApi).toBeInstanceOf(GmailApiProvider);
    // Campos a mais (como o id da conexão) são tolerados.
    expect(getChannelProvider({ canal: "email", provider: "gmail_api", credentials: { accessToken: "t", from: "a@b.c", oauthConnectionId: "x" } })).toBeInstanceOf(GmailApiProvider);

    const cfg = { host: "smtp.teste.invalid", port: 465, secure: true, user: `u-${randomUUID()}`, pass: "x", from: "a@b.c" };
    const smtp = getChannelProvider({ canal: "email", provider: "gmail", credentials: cfg });
    expect(smtp).toBeInstanceOf(EmailProvider);
    expect(smtp).not.toBeInstanceOf(GmailApiProvider);
    transporteSmtpPara(cfg as SmtpConfig).close();

    expect(getChannelProvider({ canal: "whatsapp", provider: "gmail_api", credentials: { accessToken: "t", from: "a@b.c" } })).toBeNull();
    expect(getChannelProvider({ canal: "email", provider: "gmail_api", credentials: { from: "a@b.c" } })).toBeNull();
    expect(getChannelProvider({ canal: "email", provider: "gmail_api", credentials: { accessToken: "", from: "a@b.c" } })).toBeNull();
    expect(getChannelProvider({ canal: "email", provider: "gmail_api", credentials: null })).toBeNull();
  });

  it("o SMTP e o Gmail montam as mesmas opções (mesmo caminho: opcoesDoEmail)", async () => {
    const cfg: SmtpConfig = {
      host: "smtp.teste.invalid", port: 465, secure: true, user: `u-${randomUUID()}`, pass: "x",
      from: "Ana <ana@gmail.com>", replyTo: "suporte@exemplo.com.br", headers: { "Auto-Submitted": "auto-generated" }, destinatarioUnico: true,
    };
    const transporte = transporteSmtpPara(cfg);
    const sendMail = vi.spyOn(transporte, "sendMail").mockResolvedValue({ messageId: "<x@teste>" } as never);
    const input = {
      to: "lead@exemplo.com.br",
      content: { subject: "s", text: "t", html: "<p>t</p>", inReplyTo: "<a@b>", references: ["<a@b>"], icsEvent: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" },
    };
    try {
      await new EmailProvider(cfg).send(input);
    } finally {
      transporte.close();
    }
    const doSmtp = sendMail.mock.calls[0]![0];
    expect(doSmtp).toEqual(opcoesDoEmail({ from: cfg.from, replyTo: cfg.replyTo, headers: cfg.headers, destinatarioUnico: true }, input));

    // E o MIME que o Gmail recebe sai dessas mesmas opções.
    const { raw, messageId } = await montarMime(doSmtp);
    expect(raw.toString("utf8")).toContain(`Message-ID: ${messageId}`);
  });
});
