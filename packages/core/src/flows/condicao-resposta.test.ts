import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { conditionDefSchema } from "./schema";
import { executeNode } from "./executor";

/** Condição "o que ele respondeu": sem interesse / tenho interesse / outra, e a palavra escrita. Contato descartável. */
const TEAM = "00000000-0000-0000-0000-0000000000d8";
let contatoId = "";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team condição resposta" } });
});
const limpar = async () => {
  await basePrisma.activity.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.contact.deleteMany({ where: { teamId: TEAM } });
};
beforeEach(async () => {
  await limpar();
  contatoId = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } })).id;
});
afterAll(limpar);

const recebeu = (conteudo: string, quando = new Date()) =>
  basePrisma.activity.create({ data: { teamId: TEAM, contactId: contatoId, tipo: "whatsapp", direcao: "in", conteudo, createdAt: quando } });

const ramos = (...conds: object[]) => ({
  id: "c",
  tipo: "condition",
  branches: { branches: conds.map((condition, i) => ({ id: `b${i}`, label: `r${i}`, condition, nextNodeId: `N${i}` })), default: "D" },
});
const rodar = (no: object, lastOutboundAt: Date | null = null) =>
  runWithTeam(TEAM, () => executeNode({ id: "enr", teamId: TEAM, contactId: contatoId, lastOutboundAt, round: 1, contact: { id: contatoId, nome: "Lead", tags: [], ownerId: null, relacionamentoStatus: "novo" } } as never, no as never));

const CLASSES = ramos({ type: "reply_class", classe: "sem_interesse" }, { type: "reply_class", classe: "interesse" }, { type: "reply_class", classe: "outro" });

describe("condição: tipo da resposta", () => {
  it("'Obrigado, já tenho' vai para o ramo sem interesse; pedido de preço para interesse; o resto para outra", async () => {
    await recebeu("Obrigado, Já tenho");
    expect((await rodar(CLASSES)).nextNodeId).toBe("N0");
    await limpar();
    contatoId = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead 2" } })).id;
    await recebeu("Quanto custa?");
    expect((await rodar(CLASSES)).nextNodeId).toBe("N1");
    await limpar();
    contatoId = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead 3" } })).id;
    await recebeu("Quem é você?");
    expect((await rodar(CLASSES)).nextNodeId).toBe("N2");
  });

  it("sem resposta nenhuma, nada casa e cai no 'senão'", async () => {
    expect((await rodar(CLASSES)).nextNodeId).toBe("D");
  });

  it("só vale o que veio DEPOIS do último envio do fluxo", async () => {
    await recebeu("Não tenho interesse", new Date("2026-01-01T10:00:00Z"));
    const envio = new Date("2026-01-02T10:00:00Z");
    expect((await rodar(CLASSES, envio)).nextNodeId).toBe("D"); // resposta antiga: ainda não respondeu a este envio
    await recebeu("Quero saber mais", new Date("2026-01-03T10:00:00Z"));
    expect((await rodar(CLASSES, envio)).nextNodeId).toBe("N1");
  });

  it("várias mensagens seguidas são lidas juntas", async () => {
    await recebeu("Bom dia", new Date("2026-01-03T10:00:00Z"));
    await recebeu("já tenho, obrigado", new Date("2026-01-03T10:01:00Z"));
    expect((await rodar(CLASSES)).nextNodeId).toBe("N0");
  });

  it("mídia sem texto não conta como resposta", async () => {
    await recebeu("[audio]");
    expect((await rodar(CLASSES)).nextNodeId).toBe("D");
  });
});

describe("condição: palavra escrita pelo usuário", () => {
  it("contém: em qualquer parte; exato: a resposta inteira", async () => {
    await recebeu("Obrigado, Já tenho");
    const contem = ramos({ type: "reply_text", texto: "já tenho, não preciso", modo: "contem" });
    const exato = ramos({ type: "reply_text", texto: "já tenho", modo: "exato" });
    expect((await rodar(contem)).nextNodeId).toBe("N0");
    expect((await rodar(exato)).nextNodeId).toBe("D"); // a resposta tem mais que a palavra
    await recebeu("Já tenho");
    expect((await rodar(exato)).nextNodeId).toBe("N0"); // uma das mensagens é exatamente a palavra
  });

  it("o schema aceita as duas condições, assume 'contém' sem modo e recusa palavra vazia", () => {
    expect(conditionDefSchema.parse({ type: "reply_class", classe: "outro" })).toEqual({ type: "reply_class", classe: "outro" });
    expect(conditionDefSchema.parse({ type: "reply_text", texto: " sim " })).toEqual({ type: "reply_text", texto: "sim", modo: "contem" });
    expect(conditionDefSchema.safeParse({ type: "reply_text", texto: "  " }).success).toBe(false);
    expect(conditionDefSchema.safeParse({ type: "reply_class", classe: "talvez" }).success).toBe(false);
  });
});
