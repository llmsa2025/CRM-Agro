import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import * as contacts from "../contacts/index";
import { ForbiddenError } from "../auth/authz";
import * as calls from "./index";

// Limpeza SÓ dos times deste arquivo: a base de TESTE é compartilhada (outros
// arquivos e agentes em paralelo) — antes, deleteMany({}) apagava a base toda.
const TIMES_DO_ARQUIVO = ["00000000-0000-0000-0000-0000000000a1", "00000000-0000-0000-0000-0000000000b2"];

// Times de teste (hex válido). DEV_TEAM_ID (000...001) é do seed — usamos outros.
const TEAM_A = "00000000-0000-0000-0000-0000000000a1";
const TEAM_B = "00000000-0000-0000-0000-0000000000b2";

let contactAId: string;

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Team A (test)"],
    [TEAM_B, "Team B (test)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});

beforeEach(async () => {
  // Limpa ligações/atividades/identifiers/contatos entre testes (todos os times).
  await basePrisma.call.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.activity.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.channelIdentifier.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });

  // setup: 1 contato no team A
  const c = await runWithTeam(TEAM_A, async () => await contacts.create({ nome: "Lead Call", tags: [] }));
  contactAId = c.id;
});

describe("calls service — createCall", () => {
  it("cria Call no escopo do time + Activity 'call' (direcao out p/ outbound)", async () => {
    const call = await runWithTeam(TEAM_A, async () =>
      await calls.createCall({
        contactId: contactAId,
        phoneNumber: "(11) 99999-8888",
        direction: "outbound",
        provider: "voopi",
      }),
    );
    expect(call.teamId).toBe(TEAM_A);
    expect(call.direction).toBe("outbound");
    expect(call.status).toBe("scheduled"); // default do Prisma
    expect(call.phoneNumber).toBe("+5511999998888"); // normalizado p/ E.164
    expect(call.provider).toBe("voopi");
    expect(call.contact?.id).toBe(contactAId);

    // Activity de rastreabilidade criada e vinculada ao contato
    const acts = await basePrisma.activity.findMany({
      where: { contactId: contactAId, tipo: "call" },
    });
    expect(acts).toHaveLength(1);
    expect(acts[0]?.direcao).toBe("out");
    expect(acts[0]?.meta).toMatchObject({ callId: call.id, direction: "outbound", provider: "voopi" });
  });

  it("direção inbound → Activity direcao 'in' e status scheduled", async () => {
    const call = await runWithTeam(TEAM_A, async () =>
      await calls.createCall({
        contactId: contactAId,
        phoneNumber: "+5511988887777",
        direction: "inbound",
        provider: "manual",
      }),
    );
    expect(call.direction).toBe("inbound");
    const acts = await basePrisma.activity.findMany({
      where: { contactId: contactAId, tipo: "call" },
    });
    expect(acts[0]?.direcao).toBe("in");
  });

  it("rejeita contactId de outro time (fail-closed)", async () => {
    const b = await runWithTeam(TEAM_B, async () => await contacts.create({ nome: "Lead B", tags: [] }));

    await expect(
      runWithTeam(TEAM_A, async () =>
        await calls.createCall({
          contactId: b.id,
          phoneNumber: "(11) 90000-0000",
          direction: "outbound",
          provider: "voopi",
        }),
      ),
    ).rejects.toThrow(/ContactNotFound/);
  });

  it("aceita channelAccountId e providerCallId opcionais", async () => {
    const acct = await basePrisma.channelAccount.create({
      data: { teamId: TEAM_A, canal: "whatsapp", label: "WA test", provider: "evolution", status: "connected" },
    });
    const call = await runWithTeam(TEAM_A, async () =>
      await calls.createCall({
        contactId: contactAId,
        phoneNumber: "(11) 98888-8888",
        direction: "outbound",
        provider: "manual",
        channelAccountId: acct.id,
        providerCallId: "prov-call-1",
      }),
    );
    expect(call.channelAccountId).toBe(acct.id);
    expect(call.providerCallId).toBe("prov-call-1");
  });
});

describe("calls service — listCalls", () => {
  it("lista apenas ligações do time (isolamento) e aplica filtros", async () => {
    await runWithTeam(TEAM_A, async () =>
      await calls.createCall({
        contactId: contactAId,
        phoneNumber: "(11) 91111-1111",
        direction: "outbound",
        provider: "voopi",
      }),
    );
    await runWithTeam(TEAM_B, async () => {
      const c = await contacts.create({ nome: "Lead B", tags: [] });
      await calls.createCall({
        contactId: c.id,
        phoneNumber: "(21) 92222-2222",
        direction: "inbound",
        provider: "manual",
      });
    });

    const allA = await runWithTeam(TEAM_A, async () => (await calls.listCalls()).items);
    expect(allA).toHaveLength(1);
    expect(allA[0]?.phoneNumber).toBe("+5511911111111");

    const allB = await runWithTeam(TEAM_B, async () => (await calls.listCalls()).items);
    expect(allB).toHaveLength(1);

    // filtro por status (scheduled = default)
    const scheduled = await runWithTeam(TEAM_A, async () => (await calls.listCalls({ status: "scheduled" })).items);
    expect(scheduled).toHaveLength(1);
    const answered = await runWithTeam(TEAM_A, async () => (await calls.listCalls({ status: "answered" })).items);
    expect(answered).toHaveLength(0);

    // filtro por contactId
    const byContact = await runWithTeam(TEAM_A, async () => (await calls.listCalls({ contactId: contactAId })).items);
    expect(byContact).toHaveLength(1);
    const byOther = await runWithTeam(TEAM_A, async () => (await calls.listCalls({ contactId: "00000000-0000-0000-0000-000000000000" })).items);
    expect(byOther).toHaveLength(0);

    // filtro por período: from no futuro → 0; to agora+10s → 1
    const futuro = await runWithTeam(TEAM_A, async () => (await calls.listCalls({ from: new Date(Date.now() + 60_000) })).items);
    expect(futuro).toHaveLength(0);
    const ateAgora = await runWithTeam(TEAM_A, async () => (await calls.listCalls({ to: new Date(Date.now() + 10_000) })).items);
    expect(ateAgora).toHaveLength(1);
  });
});

describe("calls service — getCall", () => {
  it("busca a ligação pelo id dentro do time", async () => {
    const call = await runWithTeam(TEAM_A, async () =>
      await calls.createCall({
        contactId: contactAId,
        phoneNumber: "(11) 93333-3333",
        direction: "outbound",
        provider: "voopi",
      }),
    );
    const got = await runWithTeam(TEAM_A, async () => await calls.getCall(call.id));
    expect(got.id).toBe(call.id);
    expect(got.contact?.nome).toBe("Lead Call");
  });

  it("outro time não enxerga a ligação (CallNotFound)", async () => {
    const call = await runWithTeam(TEAM_A, async () =>
      await calls.createCall({
        contactId: contactAId,
        phoneNumber: "(11) 94444-4444",
        direction: "outbound",
        provider: "voopi",
      }),
    );
    await expect(runWithTeam(TEAM_B, async () => await calls.getCall(call.id))).rejects.toThrow(/CallNotFound/);
  });

  it("lança CallNotFound quando o id não existe", async () => {
    await expect(runWithTeam(TEAM_A, async () => await calls.getCall("inexistente-id"))).rejects.toThrow(
      /CallNotFound/,
    );
  });
});

describe("calls service — anotarCamposDaLigacao (PATCH da API, lista de permissão)", () => {
  const nova = (phone: string) =>
    runWithTeam(TEAM_A, async () =>
      await calls.createCall({ contactId: contactAId, phoneNumber: phone, direction: "outbound", provider: "manual" }),
    );

  it("grava notes e disposition e NADA mais: o que é do provedor fica como estava", async () => {
    const call = await nova("(11) 95555-5555");
    // Fatos que só o provedor escreve (aqui simulados direto no banco).
    await basePrisma.call.update({
      where: { id: call.id },
      data: {
        status: "completed",
        startedAt: new Date("2032-05-01T10:00:00Z"),
        endedAt: new Date("2032-05-01T10:02:00Z"),
        durationSeconds: 120,
        outcome: "answered",
        recordingUrl: "https://gravacao.exemplo.invalid/a.mp3",
        transcript: "texto do provedor",
        summary: "resumo do provedor",
        providerCallId: "prov-123",
      },
    });
    const antes = await basePrisma.call.findUniqueOrThrow({ where: { id: call.id } });
    const atividadesAntes = await basePrisma.activity.findMany({ where: { contactId: contactAId }, orderBy: { id: "asc" } });

    const r = await runWithTeam(TEAM_A, async () =>
      await calls.anotarCamposDaLigacao(call.id, { notes: "bom lead", disposition: "interested" }),
    );
    expect(r.notes).toBe("bom lead");
    expect(r.disposition).toBe("interested");
    expect(r.contact).toMatchObject({ id: contactAId });

    const depois = await basePrisma.call.findUniqueOrThrow({ where: { id: call.id } });
    expect({ ...depois, notes: antes.notes, disposition: antes.disposition, updatedAt: antes.updatedAt }).toEqual(antes);
    // Anotar não cria nem muda Activity: não vira toque nem entra no placar.
    const atividadesDepois = await basePrisma.activity.findMany({ where: { contactId: contactAId }, orderBy: { id: "asc" } });
    expect(atividadesDepois).toEqual(atividadesAntes);
  });

  it("só notes: a disposition que já existia não muda", async () => {
    const call = await nova("(11) 95555-0001");
    await runWithTeam(TEAM_A, async () => await calls.anotarCamposDaLigacao(call.id, { disposition: "callback" }));
    const r = await runWithTeam(TEAM_A, async () => await calls.anotarCamposDaLigacao(call.id, { notes: "ligar amanhã" }));
    expect(r.notes).toBe("ligar amanhã");
    expect(r.disposition).toBe("callback");
  });

  it("texto em branco limpa o campo e grava null (nunca \"\"), sem tocar no outro", async () => {
    const call = await nova("(11) 95555-0003");
    await runWithTeam(TEAM_A, async () => await calls.anotarCamposDaLigacao(call.id, { notes: "nota antiga", disposition: "callback" }));
    // Só notes em branco: a nota some (de propósito: é como se apaga) e a disposition fica.
    const r1 = await runWithTeam(TEAM_A, async () => await calls.anotarCamposDaLigacao(call.id, { notes: "" }));
    expect(r1.notes).toBeNull();
    expect(r1.disposition).toBe("callback");
    // Só disposition em branco: some também, e a nota (já limpa) segue null.
    const r2 = await runWithTeam(TEAM_A, async () => await calls.anotarCamposDaLigacao(call.id, { disposition: "" }));
    expect(r2.disposition).toBeNull();
    const linha = await basePrisma.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(linha.notes).toBeNull();
    expect(linha.disposition).toBeNull();
  });

  it("é idempotente: o mesmo corpo duas vezes deixa a mesma ligação", async () => {
    const call = await nova("(11) 95555-0002");
    const a = await runWithTeam(TEAM_A, async () => await calls.anotarCamposDaLigacao(call.id, { notes: "x", disposition: "y" }));
    const b = await runWithTeam(TEAM_A, async () => await calls.anotarCamposDaLigacao(call.id, { notes: "x", disposition: "y" }));
    expect({ ...b, updatedAt: a.updatedAt }).toEqual(a);
  });

  it("lança CallNotFound se a ligação não existe no time", async () => {
    await expect(
      runWithTeam(TEAM_A, async () => await calls.anotarCamposDaLigacao("inexistente", { notes: "x" })),
    ).rejects.toThrow(/CallNotFound/);
  });

  it("outro time não anota ligação alheia (CallNotFound) e nada muda", async () => {
    const call = await nova("(11) 96666-6666");
    await expect(
      runWithTeam(TEAM_B, async () => await calls.anotarCamposDaLigacao(call.id, { notes: "invasão", disposition: "invasão" })),
    ).rejects.toThrow(/CallNotFound/);
    const depois = await basePrisma.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(depois.notes).toBeNull();
    expect(depois.disposition).toBeNull();
  });

  it("papel só de leitura não anota (RBAC no serviço)", async () => {
    const call = await nova("(11) 96666-0001");
    await expect(
      runWithTeam(TEAM_A, async () => await calls.anotarCamposDaLigacao(call.id, { notes: "x" }), { userId: "leitor", role: "viewer" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await basePrisma.call.findUniqueOrThrow({ where: { id: call.id } })).notes).toBeNull();
  });

  it("sem time e sem identidade no contexto recusa (fail-closed)", async () => {
    const call = await nova("(11) 96666-0002");
    await expect(calls.anotarCamposDaLigacao(call.id, { notes: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await basePrisma.call.findUniqueOrThrow({ where: { id: call.id } })).notes).toBeNull();
  });
});

describe("anotarLigacaoApiSchema — lista de permissão da borda", () => {
  const CAMPOS_DO_PROVEDOR = [
    ["status", "completed"],
    ["startedAt", "2032-05-01T10:00:00Z"],
    ["endedAt", "2032-05-01T10:02:00Z"],
    ["durationSeconds", 120],
    ["outcome", "answered"],
    ["recordingUrl", "https://gravacao.exemplo.invalid/a.mp3"],
    ["transcript", "texto"],
    ["summary", "resumo"],
    ["provider", "manual"],
    ["providerCallId", "prov-1"],
    ["channelAccountId", "00000000-0000-0000-0000-000000000001"],
    ["phoneNumber", "+5511999998888"],
    ["direction", "inbound"],
    ["contactId", "00000000-0000-0000-0000-000000000002"],
    ["userId", "outro-usuario"],
    ["teamId", "00000000-0000-0000-0000-000000000003"],
    ["id", "00000000-0000-0000-0000-000000000004"],
  ] as const;

  it.each(CAMPOS_DO_PROVEDOR)("recusa %s sozinho", (campo, valor) => {
    expect(calls.anotarLigacaoApiSchema.safeParse({ [campo]: valor }).success).toBe(false);
  });

  it.each(CAMPOS_DO_PROVEDOR)("recusa %s mesmo junto de notes (nada é aplicado pela metade)", (campo, valor) => {
    expect(calls.anotarLigacaoApiSchema.safeParse({ notes: "ok", [campo]: valor }).success).toBe(false);
  });

  it("exige ao menos um dos dois e recusa corpo que não é objeto", () => {
    for (const corpo of [{}, null, undefined, [], "texto", 7, { notes: null }, { notes: 5 }, { disposition: ["a"] }]) {
      expect(calls.anotarLigacaoApiSchema.safeParse(corpo).success, JSON.stringify(corpo)).toBe(false);
    }
  });

  it("aceita notes, disposition ou os dois, e tira os espaços das pontas", () => {
    expect(calls.anotarLigacaoApiSchema.parse({ notes: "  oi  " })).toEqual({ notes: "oi" });
    expect(calls.anotarLigacaoApiSchema.parse({ disposition: " callback " })).toEqual({ disposition: "callback" });
    expect(calls.anotarLigacaoApiSchema.parse({ notes: "a", disposition: "b" })).toEqual({ notes: "a", disposition: "b" });
  });

  it("corpo só de espaços passa como texto vazio (o serviço o grava como null, ver o teste de anotarCamposDaLigacao)", () => {
    expect(calls.anotarLigacaoApiSchema.parse({ notes: "   " })).toEqual({ notes: "" });
    expect(calls.anotarLigacaoApiSchema.parse({ disposition: "  " })).toEqual({ disposition: "" });
  });

  it("limita o tamanho do texto", () => {
    expect(calls.anotarLigacaoApiSchema.safeParse({ notes: "a".repeat(5000) }).success).toBe(true);
    expect(calls.anotarLigacaoApiSchema.safeParse({ notes: "a".repeat(5001) }).success).toBe(false);
    expect(calls.anotarLigacaoApiSchema.safeParse({ disposition: "a".repeat(201) }).success).toBe(false);
  });
});

describe("calls service — updateCallTranscription", () => {
  it("atualiza transcript, summary e recordingUrl", async () => {
    const call = await runWithTeam(TEAM_A, async () =>
      await calls.createCall({
        contactId: contactAId,
        phoneNumber: "(11) 97777-7777",
        direction: "outbound",
        provider: "voopi",
      }),
    );
    const updated = await runWithTeam(TEAM_A, async () =>
      await calls.updateCallTranscription(call.id, {
        transcript: "olá, tudo bem?",
        summary: "resumo da ligação",
        recordingUrl: "https://example.com/audio.mp3",
      }),
    );
    expect(updated.transcript).toBe("olá, tudo bem?");
    expect(updated.summary).toBe("resumo da ligação");
    expect(updated.recordingUrl).toBe("https://example.com/audio.mp3");
  });

  it("lança CallNotFound se a ligação não existe", async () => {
    await expect(
      runWithTeam(TEAM_A, async () => await calls.updateCallTranscription("inexistente", { summary: "x" })),
    ).rejects.toThrow(/CallNotFound/);
  });
});
