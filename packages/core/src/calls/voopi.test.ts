import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { basePrisma, estaCifrado } from "@crmagro/db";
import type { VoopiConfig, VoopiWebhookEvent } from "@crmagro/channels";
import { runWithTeam } from "../test-support/identidade";

/**
 * Ligar pela Voopi de ponta a ponta: cadastro cifrado → "ligar" cria a Call e
 * chama o provider com a credencial DO TIME → o webhook atualiza status,
 * duração, gravação e o resultado (produto §D). A Voopi é FALSA e o `fetch`
 * global lança: nenhuma ligação de verdade sai daqui.
 */
const voopi = vi.hoisted(() => ({
  makeCall: [] as Array<{ config: VoopiConfig; to: string }>,
  hangup: [] as Array<{ config: VoopiConfig; id: string }>,
  falha: null as Error | null,
  /** Roda ANTES de a API "responder" (o webhook chegando antes do id). */
  antesDeResponder: null as null | ((config: VoopiConfig, providerCallId: string) => Promise<void>),
  seq: 0,
}));
vi.mock("@crmagro/channels", async (original) => {
  const real = await original<typeof import("@crmagro/channels")>();
  class VoopiFalsa {
    constructor(private config: VoopiConfig) {
      real.voopiConfigSchema.parse(config);
    }
    async makeCall({ to }: { to: string }) {
      voopi.makeCall.push({ config: this.config, to });
      if (voopi.falha) throw voopi.falha;
      const providerCallId = `vp-${++voopi.seq}-${Math.random().toString(36).slice(2, 8)}`;
      if (voopi.antesDeResponder) await voopi.antesDeResponder(this.config, providerCallId);
      return { providerCallId };
    }
    async hangup(id: string) {
      voopi.hangup.push({ config: this.config, id });
    }
    static parseWebhook = real.VoopiProvider.parseWebhook;
  }
  return { ...real, VoopiProvider: VoopiFalsa };
});
const scheduleTranscription = vi.fn(async (_id: string) => {});
vi.mock("./transcription-queue", () => ({ scheduleTranscription: (id: string) => scheduleTranscription(id) }));

const { salvarVoopi, statusVoopi, removerVoopi, ligarPelaVoopi, desligarPelaVoopi } = await import("./voopi");
const { autenticarWebhookVoopi, assinaturaDaLigacaoVoopi } = await import("./voopi-webhook-auth");
const { applyVoopiWebhookEvent, finishManualCall } = await import("./service");
const { markCallOutcome, getNextDialerSlot } = await import("./dialer");

const TEAM = "00000000-0000-0000-0000-0000000005a4";
const OUTRO = "00000000-0000-0000-0000-0000000005a5";
const NUMERO = "+5565999000541";
const SENHA = "senha-sip-super-secreta";
const ENV_ANTES = { ...process.env };

const fetchReal = globalThis.fetch;
beforeAll(async () => {
  // Guarda: qualquer fetch de verdade (API da Voopi) derruba o teste.
  globalThis.fetch = (async () => {
    throw new Error("fetch real proibido no teste da Voopi");
  }) as typeof fetch;
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.team.upsert({ where: { id: t }, update: {}, create: { id: t, name: `Team Voopi click-to-call ${t.slice(-2)} (test)` } });
  }
});
afterAll(() => {
  globalThis.fetch = fetchReal;
  process.env = { ...ENV_ANTES };
});

beforeEach(async () => {
  voopi.makeCall.length = 0;
  voopi.hangup.length = 0;
  voopi.falha = null;
  voopi.antesDeResponder = null;
  scheduleTranscription.mockClear();
  process.env = {
    ...ENV_ANTES,
    APP_PUBLIC_URL: "https://crmagro.teste/",
    VOOPI_WEBHOOK_TOKEN: "tok-teste",
    TRANSCRIPTION_SERVICE_URL: "https://whisper.teste/transcrever",
  };
  const w = { teamId: { in: [TEAM, OUTRO] } };
  await basePrisma.appointment.deleteMany({ where: w });
  await basePrisma.call.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.integration.deleteMany({ where: w });
});

async function contato(teamId: string, nome: string, numero = NUMERO, invalido = false) {
  const c = await basePrisma.contact.create({ data: { teamId, nome } });
  await basePrisma.channelIdentifier.create({
    data: { teamId, contactId: c.id, canal: "whatsapp", valor: numero, isPrimary: true, invalido },
  });
  return c;
}

const cadastrar = (teamId: string, sipUser = "ramal-a", extra: Record<string, string> = {}) =>
  runWithTeam(teamId, () => salvarVoopi({ sipUser, sipPassword: SENHA, ...extra }));

const evento = (e: Partial<VoopiWebhookEvent> & { event: VoopiWebhookEvent["event"]; callId: string }) =>
  ({ from: "ramal-a", to: NUMERO.replace("+", ""), ...e }) as VoopiWebhookEvent;

describe("cadastro da conta SIP", () => {
  it("fica cifrado, a tela nunca recebe a senha, editar sem senha mantém a salva; host fora da Voopi e member são recusados", async () => {
    const s = await cadastrar(TEAM);
    expect(s).toMatchObject({ configurada: true, pronta: true, falta: [], sipHost: "sip.voopi.com.br", sipPort: "5060", sipUser: "ramal-a", senhaSalva: true });
    expect(JSON.stringify(s)).not.toContain(SENHA);
    const cru = await basePrisma.integration.findFirstOrThrow({ where: { teamId: TEAM, tipo: "voopi" } });
    expect(estaCifrado(cru.credentials)).toBe(true);
    expect(JSON.stringify(cru.credentials)).not.toContain(SENHA);
    expect(JSON.stringify(cru.credentials)).not.toContain("ramal-a");

    await runWithTeam(TEAM, () => salvarVoopi({ sipUser: "ramal-b" }));
    const c = await contato(TEAM, "Ana");
    await runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id }));
    expect(voopi.makeCall[0]!.config).toMatchObject({ sipUser: "ramal-b", sipPassword: SENHA });

    await expect(runWithTeam(TEAM, () => salvarVoopi({ sipUser: "x", sipPassword: "y", sipHost: "169.254.169.254" }))).rejects.toThrow(/host/);
    await expect(runWithTeam(TEAM, () => salvarVoopi({ sipUser: "x", sipPassword: "y", sipHost: "sip.voopi.com.br.evil.com" }))).rejects.toThrow(/Voopi/);
    await expect(
      runWithTeam(TEAM, () => salvarVoopi({ sipUser: "x", sipPassword: "y" }), { userId: "m", role: "member" }),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    await runWithTeam(TEAM, () => removerVoopi());
    expect(await runWithTeam(TEAM, () => statusVoopi())).toMatchObject({ configurada: false, pronta: false });
  });
});

describe("sem Voopi pronta: erro nomeado, nada criado (a tela cai no discador manual)", () => {
  it("sem conta, sem APP_PUBLIC_URL e, em produção, sem VOOPI_WEBHOOK_TOKEN", async () => {
    const c = await contato(TEAM, "Bia");
    await expect(runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id }))).rejects.toMatchObject({
      name: "VoopiNaoConfigurada",
      message: expect.stringContaining("cadastre a conta da Voopi"),
    });

    await cadastrar(TEAM);
    delete process.env.APP_PUBLIC_URL;
    await expect(runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id }))).rejects.toMatchObject({
      name: "VoopiNaoConfigurada",
      message: expect.stringContaining("APP_PUBLIC_URL"),
    });
    process.env.APP_PUBLIC_URL = "https://crmagro.teste";
    delete process.env.VOOPI_WEBHOOK_TOKEN;
    process.env.NODE_ENV = "production";
    await expect(runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id }))).rejects.toMatchObject({
      name: "VoopiNaoConfigurada",
      message: expect.stringContaining("VOOPI_WEBHOOK_TOKEN"),
    });
    expect(await runWithTeam(TEAM, () => statusVoopi())).toMatchObject({ configurada: true, pronta: false, falta: ["VOOPI_WEBHOOK_TOKEN no servidor"] });

    expect(voopi.makeCall).toHaveLength(0);
    expect(await basePrisma.call.count({ where: { teamId: TEAM } })).toBe(0);
  });
});

describe("ligar pela Voopi, ponta a ponta", () => {
  it("cria a Call, liga com a credencial do time e o callbackUrl com token e ref; o webhook atualiza status, duração e gravação; o pop-up não apaga a duração real", async () => {
    await cadastrar(TEAM);
    const c = await contato(TEAM, "Caio");
    const r = await runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id, phoneNumber: "(65) 99900-0541" }));
    expect(voopi.makeCall).toHaveLength(1);
    const pedido = voopi.makeCall[0]!;
    expect(pedido.to).toBe(NUMERO);
    expect(pedido.config).toMatchObject({ sipHost: "sip.voopi.com.br", sipUser: "ramal-a" });
    // O segredo global NUNCA vai para a conta da Voopi: só o ref e a assinatura dele.
    expect(pedido.config.webhookUrl).toBe(
      `https://crmagro.teste/api/webhooks/voopi?ref=${r.callId}&sig=${assinaturaDaLigacaoVoopi(r.callId, "tok-teste")}`,
    );
    expect(pedido.config.webhookUrl).not.toContain("tok-teste");

    let call = await basePrisma.call.findUniqueOrThrow({ where: { id: r.callId } });
    expect(call).toMatchObject({ provider: "voopi", status: "ringing", providerCallId: r.providerCallId, contactId: c.id, phoneNumber: NUMERO });
    expect(await basePrisma.activity.count({ where: { teamId: TEAM, tipo: "call", contactId: c.id } })).toBe(1);

    await applyVoopiWebhookEvent(evento({ event: "call.answered", callId: r.providerCallId }));
    await applyVoopiWebhookEvent(evento({ event: "call.ended", callId: r.providerCallId, duration: 42 }));
    await applyVoopiWebhookEvent(
      evento({ event: "call.recording", callId: r.providerCallId, recordingUrl: "https://gravacoes.voopi.com.br/x.mp3" }),
    );
    call = await basePrisma.call.findUniqueOrThrow({ where: { id: r.callId } });
    expect(call).toMatchObject({ status: "completed", durationSeconds: 42, recordingUrl: "https://gravacoes.voopi.com.br/x.mp3", outcome: null });
    expect(call.startedAt).not.toBeNull();
    expect(scheduleTranscription).toHaveBeenCalledWith(r.callId);

    await runWithTeam(TEAM, () => finishManualCall(r.callId, { outcome: "answered", durationSec: 5, notes: "quer proposta" }));
    call = await basePrisma.call.findUniqueOrThrow({ where: { id: r.callId } });
    expect(call).toMatchObject({ status: "completed", durationSeconds: 42, outcome: "answered", notes: "quer proposta" });

    await runWithTeam(TEAM, () => desligarPelaVoopi(r.callId));
    expect(voopi.hangup).toEqual([{ config: expect.objectContaining({ sipUser: "ramal-a" }), id: r.providerCallId }]);
  });

  it("aviso da Voopi ANTES de gravarmos o id: acha pelo ref; caixa postal informada vira o resultado e marca o retorno", async () => {
    await cadastrar(TEAM);
    const c = await contato(TEAM, "Duda");
    voopi.antesDeResponder = async (config, providerCallId) => {
      // O aviso chega como a Voopi mandaria: no callbackUrl assinado.
      const u = new URL(config.webhookUrl);
      const auth = autenticarWebhookVoopi({ token: null, ref: u.searchParams.get("ref"), sig: u.searchParams.get("sig") });
      if (!auth.ok || auth.via !== "assinado") throw new Error("callbackUrl sem assinatura válida");
      // `to` de outro número: não é esta ligação — ignorado.
      await applyVoopiWebhookEvent(
        evento({ event: "call.ended", callId: providerCallId, to: "5565988887777", result: "voicemail" }),
        { soDaLigacao: auth.ref },
      );
      await applyVoopiWebhookEvent(evento({ event: "call.ended", callId: providerCallId, duration: 0, result: "voicemail" }), {
        soDaLigacao: auth.ref,
      });
    };
    const r = await runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id }));
    const call = await basePrisma.call.findUniqueOrThrow({ where: { id: r.callId } });
    expect(call).toMatchObject({ providerCallId: r.providerCallId, status: "no_answer", outcome: "voicemail" });
    const ag = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM } });
    expect(ag).toMatchObject({ tipo: "ligacao", contactId: c.id });
    const act = await basePrisma.activity.findFirstOrThrow({ where: { teamId: TEAM, tipo: "call" } });
    expect(act.conteudo).toBe("Ligação caiu na caixa postal");
    expect(act.meta).toMatchObject({ outcome: "voicemail", origemResultado: "voopi", retornoAppointmentId: ag.id });
  });

  it("a Voopi nunca passa por cima do resultado que o vendedor marcou", async () => {
    await cadastrar(TEAM);
    const c = await contato(TEAM, "Edu");
    const r = await runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id }));
    await runWithTeam(TEAM, () => finishManualCall(r.callId, { outcome: "wrong_number" }));
    await applyVoopiWebhookEvent(evento({ event: "call.ended", callId: r.providerCallId, result: "NO ANSWER" }));
    const call = await basePrisma.call.findUniqueOrThrow({ where: { id: r.callId } });
    expect(call.outcome).toBe("wrong_number");
  });

  it("a Voopi recusou: Call `failed` e erro nomeado sem a resposta crua", async () => {
    await cadastrar(TEAM);
    const c = await contato(TEAM, "Fabi");
    voopi.falha = new Error('Voopi makeCall failed (401): {"detail":"token abc123"}');
    const e = (await runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id })).catch((x: unknown) => x)) as Error;
    expect(e).toMatchObject({ name: "VoopiFalhou" });
    expect(e.message).toContain("HTTP 401");
    expect(e.message).not.toContain("abc123");
    expect(await basePrisma.call.findFirstOrThrow({ where: { teamId: TEAM } })).toMatchObject({ status: "failed", providerCallId: null });
  });

  it("discador: a Voopi origina a ligação do slot uma vez só; o resultado depois do webhook não é recusado", async () => {
    await cadastrar(TEAM);
    const c = await contato(TEAM, "Gil");
    const slot = await runWithTeam(TEAM, () => getNextDialerSlot());
    expect(slot).toMatchObject({ contactId: c.id, phoneNumber: NUMERO });
    const r = await runWithTeam(TEAM, () => ligarPelaVoopi({ callId: slot!.callId }));
    expect(r.callId).toBe(slot!.callId);
    await expect(runWithTeam(TEAM, () => ligarPelaVoopi({ callId: slot!.callId }))).rejects.toMatchObject({ name: "CallValidationError" });
    expect(voopi.makeCall).toHaveLength(1);

    await applyVoopiWebhookEvent(evento({ event: "call.ended", callId: r.providerCallId, duration: 30 }));
    await runWithTeam(TEAM, () => markCallOutcome(slot!.callId, "voicemail"));
    const call = await basePrisma.call.findUniqueOrThrow({ where: { id: slot!.callId } });
    expect(call).toMatchObject({ provider: "voopi", status: "completed", durationSeconds: 30, outcome: "voicemail" });
    expect(await basePrisma.appointment.count({ where: { teamId: TEAM } })).toBe(1);
  });

  it("dois cliques ao mesmo tempo: uma ligação só; com uma em curso, não liga de novo; se a Voopi recusou, dá para tentar na hora", async () => {
    await cadastrar(TEAM);
    const c = await contato(TEAM, "Lia");
    const r = await Promise.allSettled([
      runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id })),
      runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id })),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const recusa = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(recusa.reason).toMatchObject({ name: "CallValidationError", message: expect.stringContaining("já há uma ligação") });
    expect(voopi.makeCall).toHaveLength(1);
    expect(await basePrisma.call.count({ where: { teamId: TEAM, contactId: c.id } })).toBe(1);

    // Sem a trava do Redis (passou o tempo), a ligação em curso ainda segura.
    const { redisEstado } = await import("../shared/redis-cache");
    await redisEstado().del(`voopi:ligar:${TEAM}:${c.id}`);
    await expect(runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id }))).rejects.toMatchObject({ name: "CallValidationError" });
    expect(voopi.makeCall).toHaveLength(1);

    const outro = await contato(TEAM, "Mel", "+5565999000543");
    voopi.falha = new Error("Voopi makeCall failed (503): fora");
    await expect(runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: outro.id }))).rejects.toMatchObject({ name: "VoopiFalhou" });
    voopi.falha = null;
    await runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: outro.id }));
    expect(voopi.makeCall).toHaveLength(3);
  });

  it("contato que pediu para sair: só liga com a confirmação do vendedor", async () => {
    await cadastrar(TEAM);
    const c = await contato(TEAM, "Nina");
    await basePrisma.contact.update({ where: { id: c.id }, data: { relacionamentoStatus: "opt_out" } });
    await expect(runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id }))).rejects.toMatchObject({ name: "ContatoPediuParaSair" });
    expect(voopi.makeCall).toHaveLength(0);
    await runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id, confirmarOptOut: true }));
    expect(voopi.makeCall).toHaveLength(1);
  });

  it("sem serviço de transcrição, a gravação fica na ligação e nada é agendado", async () => {
    await cadastrar(TEAM);
    delete process.env.TRANSCRIPTION_SERVICE_URL;
    const c = await contato(TEAM, "Olga");
    const r = await runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: c.id }));
    await applyVoopiWebhookEvent(evento({ event: "call.ended", callId: r.providerCallId, duration: 10 }));
    await applyVoopiWebhookEvent(
      evento({ event: "call.recording", callId: r.providerCallId, recordingUrl: "https://gravacoes.voopi.com.br/o.mp3" }),
    );
    expect((await basePrisma.call.findUniqueOrThrow({ where: { id: r.callId } })).recordingUrl).toBe("https://gravacoes.voopi.com.br/o.mp3");
    expect(scheduleTranscription).not.toHaveBeenCalled();
  });

  it("não liga para número errado nem para número que não é do contato; viewer não liga", async () => {
    await cadastrar(TEAM);
    const errado = await contato(TEAM, "Hugo", NUMERO, true);
    await expect(runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: errado.id }))).rejects.toMatchObject({ name: "ContatoSemTelefoneValido" });
    const ok = await contato(TEAM, "Iara", "+5565999000542");
    await expect(runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: ok.id, phoneNumber: "+5511912345678" }))).rejects.toMatchObject({
      name: "CallValidationError",
    });
    await expect(
      runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: ok.id }), { userId: "v", role: "viewer" }),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(voopi.makeCall).toHaveLength(0);
  });
});

describe("webhook assinado por ligação (auditoria do #138)", () => {
  it("segredo global, assinatura da ligação, assinatura errada e sem segredo", () => {
    const sig = assinaturaDaLigacaoVoopi("ref-1", "seg");
    const a = (e: { token?: string; ref?: string; sig?: string }, o: { segredo?: string | null; producao?: boolean } = { segredo: "seg" }) =>
      autenticarWebhookVoopi({ token: e.token ?? null, ref: e.ref ?? null, sig: e.sig ?? null }, o);
    expect(a({ token: "seg" })).toEqual({ ok: true, via: "segredo" });
    expect(a({ ref: "ref-1", sig })).toEqual({ ok: true, via: "assinado", ref: "ref-1" });
    expect(a({ ref: "ref-2", sig })).toEqual({ ok: false, motivo: "token_invalido" }); // assinatura de OUTRA ligação
    expect(a({ ref: "ref-1", sig: "x".repeat(64) })).toEqual({ ok: false, motivo: "token_invalido" });
    expect(a({ token: "outro" })).toEqual({ ok: false, motivo: "token_invalido" });
    expect(a({}, { segredo: null, producao: true })).toEqual({ ok: false, motivo: "sem_segredo_em_producao" });
    expect(a({}, { segredo: null, producao: false })).toEqual({ ok: true, via: "sem_token_dev" });
  });

  it("com a assinatura da ligação do time A e o id da ligação do time B, o B fica intacto (e o A também)", async () => {
    await cadastrar(TEAM, "ramal-a");
    await cadastrar(OUTRO, "ramal-b");
    const a = await contato(TEAM, "Ka");
    const b = await contato(OUTRO, "Ka do B");
    const ra = await runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: a.id }));
    const rb = await runWithTeam(OUTRO, () => ligarPelaVoopi({ contactId: b.id }));
    const u = new URL(voopi.makeCall[0]!.config.webhookUrl);
    const auth = autenticarWebhookVoopi({ token: null, ref: u.searchParams.get("ref"), sig: u.searchParams.get("sig") });
    expect(auth).toEqual({ ok: true, via: "assinado", ref: ra.callId });

    await applyVoopiWebhookEvent(evento({ event: "call.ended", callId: rb.providerCallId, duration: 99, result: "voicemail" }), {
      soDaLigacao: ra.callId,
    });
    await applyVoopiWebhookEvent(
      evento({ event: "call.recording", callId: rb.providerCallId, recordingUrl: "https://gravacoes.voopi.com.br/b.mp3" }),
      { soDaLigacao: ra.callId },
    );
    for (const id of [ra.callId, rb.callId]) {
      expect(await basePrisma.call.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "ringing",
        durationSeconds: null,
        recordingUrl: null,
        outcome: null,
      });
    }
    expect(await basePrisma.appointment.count({ where: { teamId: { in: [TEAM, OUTRO] } } })).toBe(0);
    expect(scheduleTranscription).not.toHaveBeenCalled();
  });
});

describe("resultado informado pela Voopi", () => {
  it("normaliza as variantes conhecidas; o que não conhece fica para o vendedor", async () => {
    const { resultadoDoEventoVoopi } = await import("@crmagro/channels");
    const r = (x: Partial<VoopiWebhookEvent>) => resultadoDoEventoVoopi(evento({ event: "call.ended", callId: "x", ...x }));
    expect(r({ result: "NO ANSWER" })).toBe("no_answer");
    expect(r({ hangupCause: "USER_BUSY" })).toBe("busy");
    expect(r({ result: "Caixa Postal" })).toBe("voicemail");
    expect(r({ hangup_cause: "NORMAL_CLEARING", duration: 35 })).toBe("answered");
    expect(r({ hangup_cause: "NORMAL_CLEARING", duration: 0 })).toBeNull();
    expect(r({ result: "algo novo" })).toBeNull();
    expect(r({})).toBeNull();
  });
});

describe("dois times", () => {
  it("cada time liga com a PRÓPRIA conta; contato e ligação de outro time são recusados", async () => {
    await cadastrar(TEAM, "ramal-a");
    await cadastrar(OUTRO, "ramal-b");
    const a = await contato(TEAM, "Ju");
    const b = await contato(OUTRO, "Ju do B");

    const rb = await runWithTeam(OUTRO, () => ligarPelaVoopi({ contactId: b.id }));
    expect(voopi.makeCall[0]!.config.sipUser).toBe("ramal-b");
    await runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: a.id }));
    expect(voopi.makeCall[1]!.config.sipUser).toBe("ramal-a");

    await expect(runWithTeam(TEAM, () => ligarPelaVoopi({ contactId: b.id }))).rejects.toMatchObject({ name: "OwnedNotFound" });
    await expect(runWithTeam(TEAM, () => ligarPelaVoopi({ callId: rb.callId }))).rejects.toMatchObject({ name: "OwnedNotFound" });
    await expect(runWithTeam(TEAM, () => desligarPelaVoopi(rb.callId))).rejects.toMatchObject({ name: "CallNotFound" });
    expect((await runWithTeam(TEAM, () => statusVoopi())).sipUser).toBe("ramal-a");
    expect(voopi.makeCall).toHaveLength(2);
    expect(voopi.hangup).toHaveLength(0);
  });
});
