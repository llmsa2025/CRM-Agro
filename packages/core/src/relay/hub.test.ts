import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma, encryptCredentials } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import {
  registrarContasDoAgente,
  agentesOnlineDaConta,
  waitForJob,
  deliverResult,
  relaySocialSend,
  touchAgent,
  pushJob,
} from "./hub";
import { connectSocialAccount, resolverContasDoNavegador, usernameEsperadoDaConta } from "../social/service";
import { normalizarDestinoSocial, mesmoDestinatario } from "@crmagro/channels";
import { redisEstado } from "../shared/redis-cache";

/**
 * Relay da extensão (item 1.8 — INT-07/MF-11, INT-08). Redis de TESTE real;
 * a "extensão" é simulada com waitForJob/deliverResult. Nada é enviado.
 */
const TEAM = "00000000-0000-0000-0000-0000000000cd";
const OUTRO = "00000000-0000-0000-0000-0000000000ce";
const sufixo = Math.random().toString(36).slice(2, 8);
let seq = 0;
const id = (p: string) => `${p}-${sufixo}-${seq++}`;

const spec = (accountId: string) => ({ network: "instagram" as const, to: "@lead", text: "Oi", accountId, expectedUsername: "vendedora" });
const rapido = { waitMs: 1200, gracaMs: 800 };

describe("fila por conta", () => {
  it("DM da conta A só chega à extensão logada em A; a do vendedor B não recebe (INT-08)", async () => {
    const contaA = id("contaA");
    const extA = id("extA");
    const extB = id("extB");
    await registrarContasDoAgente(TEAM, extA, [contaA]);
    await registrarContasDoAgente(TEAM, extB, [id("contaB")]);
    expect(await agentesOnlineDaConta(contaA)).toBe(1);

    const envio = relaySocialSend(TEAM, spec(contaA), rapido);
    expect(await waitForJob(TEAM, extB, 300)).toBeNull();
    const job = await waitForJob(TEAM, extA, 1000);
    expect(job?.spec).toMatchObject({ accountId: contaA, expectedUsername: "vendedora" });
    await deliverResult({ jobId: job!.id, ok: true }, TEAM);
    expect(await envio).toMatchObject({ ok: true });
  });

  it("nenhuma extensão com a conta logada → no_agent na hora (mesmo com extensão do time online)", async () => {
    await touchAgent(id("ext-sem-contas"), TEAM);
    expect(await relaySocialSend(TEAM, spec(id("conta")), rapido)).toMatchObject({ ok: false, error: "no_agent" });
  });
});

describe("sem DM duplicado (INT-07/MF-11)", () => {
  it("ninguém pegou → o job SAI da fila no timeout (a extensão que abrir amanhã não reenvia)", async () => {
    const conta = id("conta");
    const ext = id("ext");
    await registrarContasDoAgente(TEAM, ext, [conta]);
    expect(await relaySocialSend(TEAM, spec(conta), rapido)).toMatchObject({ ok: false, error: "timeout" });
    expect(await waitForJob(TEAM, ext, 300)).toBeNull();
  });

  it("a extensão pegou e não respondeu → 'incerto' (o motor segura, não cai no Playwright)", async () => {
    const conta = id("conta");
    const ext = id("ext");
    await registrarContasDoAgente(TEAM, ext, [conta]);
    const envio = relaySocialSend(TEAM, spec(conta), rapido);
    expect(await waitForJob(TEAM, ext, 1000)).not.toBeNull();
    expect(await envio).toMatchObject({ ok: false, error: "incerto" });
  });

  it("pegou, demorou além do prazo mas respondeu na graça → vale a resposta", async () => {
    const conta = id("conta");
    const ext = id("ext");
    await registrarContasDoAgente(TEAM, ext, [conta]);
    const envio = relaySocialSend(TEAM, spec(conta), { waitMs: 600, gracaMs: 2000 });
    const job = await waitForJob(TEAM, ext, 500);
    await new Promise((r) => setTimeout(r, 900));
    await deliverResult({ jobId: job!.id, ok: true }, TEAM);
    expect(await envio).toMatchObject({ ok: true });
  });

  it("auditoria do #70: DM do formato antigo (sem validade/conta) que sobrou na fila do time é descartado, não reenviado", async () => {
    const ext = id("ext");
    const antigo = { id: id("dm-antigo"), teamId: TEAM, type: "social_send" as const, spec: { network: "instagram", to: "@lead", text: "Oi" }, createdAt: Date.now() - 3 * 86_400_000 };
    await pushJob(antigo as never);
    expect(await waitForJob(TEAM, ext, 300)).toBeNull();
    // Saiu da fila do time de vez (auditoria do #86): não fica para a próxima extensão.
    expect(await redisEstado().llen(`relay:queue:${TEAM}`)).toBe(0);
  });

  it("job vencido na fila é descartado no poll, nunca executado", async () => {
    const ext = id("ext");
    await pushJob({ id: id("velho"), teamId: TEAM, type: "http_fetch", spec: { url: "https://www.google.com/", method: "GET" }, createdAt: 0, expiresAt: Date.now() - 1 });
    expect(await waitForJob(TEAM, ext, 300)).toBeNull();
  });

  it("dois times: resultado de job que o time NÃO pegou é ignorado", async () => {
    const conta = id("conta");
    const ext = id("ext");
    await registrarContasDoAgente(TEAM, ext, [conta]);
    const envio = relaySocialSend(TEAM, spec(conta), rapido);
    const job = await waitForJob(TEAM, ext, 1000);
    expect(await deliverResult({ jobId: job!.id, ok: true }, OUTRO)).toBe(false);
    expect(await envio).toMatchObject({ ok: false, error: "incerto" });
  });
});

describe("contas sociais por @ (INT-08)", () => {
  beforeAll(async () => {
    for (const t of [TEAM, OUTRO]) {
      await basePrisma.team.upsert({ where: { id: t }, update: {}, create: { id: t, name: `Team Relay ${t.slice(-2)} (test)` } });
    }
  });
  beforeEach(async () => {
    await basePrisma.channelAccount.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
  });

  it("2º vendedor conectando o PRÓPRIO Instagram cria outra conta (antes sobrescrevia a do 1º)", async () => {
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "instagram", label: "@ana", cookie: "c1", username: "ana" }));
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "instagram", label: "@bia", cookie: "c2", username: "bia" }));
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "instagram", label: "@ana", cookie: "c3", username: "ANA" }));
    const contas = await basePrisma.channelAccount.findMany({ where: { teamId: TEAM }, orderBy: { createdAt: "asc" } });
    expect(contas.map((c) => c.label)).toEqual(["@ana", "@bia"]);
  });

  it("conta antiga sem @ gravado é adotada pelo connect da extensão (não duplica)", async () => {
    await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "instagram", label: "Instagram", provider: "instagram_browser", status: "error", paused: true, credentials: encryptCredentials({ cookie: "velho" }) as never },
    });
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "instagram", label: "@ana", cookie: "novo", username: "ana" }));
    const contas = await basePrisma.channelAccount.findMany({ where: { teamId: TEAM } });
    expect(contas).toHaveLength(1);
    expect(contas[0]).toMatchObject({ label: "@ana", status: "connected", paused: false });
  });

  it("o navegador só atende contas do PRÓPRIO time com o mesmo @", async () => {
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "instagram", label: "@ana", cookie: "c", username: "ana" }));
    await runWithTeam(OUTRO, () => connectSocialAccount({ canal: "instagram", label: "@ana", cookie: "c", username: "ana" }));
    const [minha] = await basePrisma.channelAccount.findMany({ where: { teamId: TEAM } });
    const ids = await runWithTeam(TEAM, () =>
      resolverContasDoNavegador([
        { network: "instagram", username: "@Ana" },
        { network: "linkedin", username: "ana" },
      ]),
    );
    expect(ids).toEqual([minha!.id]);
    expect(await runWithTeam(TEAM, () => usernameEsperadoDaConta(minha!.id))).toBe("ana");
  });
});

describe("destino e destinatário (INT-09)", () => {
  it("Instagram: @, nome ou URL do perfil viram o perfil; post/reel/DM não", () => {
    expect(normalizarDestinoSocial("instagram", "@Fulano.Silva")).toMatchObject({ username: "fulano.silva", url: "https://www.instagram.com/fulano.silva/" });
    expect(normalizarDestinoSocial("instagram", "https://www.instagram.com/fulano/?hl=pt")).toMatchObject({ username: "fulano" });
    expect(normalizarDestinoSocial("instagram", "https://instagram.com/p/Cxyz/")).toBeNull();
    expect(normalizarDestinoSocial("instagram", "fulano silva")).toBeNull();
  });

  it("LinkedIn: só perfil /in/ (empresa e post não)", () => {
    expect(normalizarDestinoSocial("linkedin", "https://www.linkedin.com/in/joao-silva-123/")).toMatchObject({ id: "joao-silva-123" });
    expect(normalizarDestinoSocial("linkedin", "joão-silva")).toMatchObject({ url: "https://www.linkedin.com/in/jo%C3%A3o-silva/" });
    expect(normalizarDestinoSocial("linkedin", "https://www.linkedin.com/company/crmagro/")).toBeNull();
  });

  it("nome do perfil × cabeçalho da conversa", () => {
    expect(mesmoDestinatario("João Silva", "Joao Silva")).toBe(true);
    expect(mesmoDestinatario("João Silva", "João Silva, MBA")).toBe(true);
    expect(mesmoDestinatario("João Silva", "Maria Souza")).toBe(false);
    expect(mesmoDestinatario("João Silva", "")).toBe(false);
  });
});
