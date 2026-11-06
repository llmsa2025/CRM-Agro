import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { conditionDefSchema } from "./schema";
import { executeNode } from "./executor";

/**
 * Condições "tem WhatsApp" e "tem e-mail": ramificam pelo CADASTRO do contato (sem consultar a Evolution).
 * Número marcado errado e e-mail que voltou como inexistente não contam. Contato descartável.
 */
const TEAM = "00000000-0000-0000-0000-0000000007c1";
let contatoId = "";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team condição canal do contato" } });
});
const limpar = async () => {
  await basePrisma.channelIdentifier.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.contact.deleteMany({ where: { teamId: TEAM } });
};
beforeEach(async () => {
  await limpar();
  contatoId = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } })).id;
});
afterAll(limpar);

const identificador = (canal: "whatsapp" | "email", valor: string, extra: { isPrimary?: boolean; invalido?: boolean } = {}) =>
  basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contatoId, canal, valor, ...extra } });

const ramo = (condition: object) => ({
  id: "c",
  tipo: "condition",
  branches: { branches: [{ id: "b", label: "r", condition, nextNodeId: "SIM" }], default: "NAO" },
});
const rodar = async (no: object) =>
  (
    await runWithTeam(TEAM, () =>
      executeNode(
        { id: "enr", teamId: TEAM, contactId: contatoId, lastOutboundAt: null, round: 1, contact: { id: contatoId, nome: "Lead", tags: [], ownerId: null, relacionamentoStatus: "novo" } } as never,
        no as never,
      ),
    )
  ).nextNodeId;
const decidir = (condition: object) => rodar(ramo(condition));

const TEM_WHATSAPP = { type: "has_whatsapp" };
const TEM_EMAIL = { type: "has_email" };

describe("condição: tem WhatsApp", () => {
  it("sim com número no cadastro; não sem nenhum", async () => {
    expect(await decidir(TEM_WHATSAPP)).toBe("NAO");
    await identificador("whatsapp", "+5565988880001");
    expect(await decidir(TEM_WHATSAPP)).toBe("SIM");
  });

  it("número marcado como errado não conta, mas outro número bom sim", async () => {
    await identificador("whatsapp", "+5565988880002", { invalido: true });
    expect(await decidir(TEM_WHATSAPP)).toBe("NAO");
    await identificador("whatsapp", "+5565988880003");
    expect(await decidir(TEM_WHATSAPP)).toBe("SIM");
  });

  it("só tem e-mail: não tem WhatsApp", async () => {
    await identificador("email", "so-email@exemplo.com.br");
    expect(await decidir(TEM_WHATSAPP)).toBe("NAO");
  });
});

describe("condição: tem e-mail", () => {
  it("sim com e-mail no cadastro; não sem nenhum", async () => {
    expect(await decidir(TEM_EMAIL)).toBe("NAO");
    await identificador("email", "lead@exemplo.com.br");
    expect(await decidir(TEM_EMAIL)).toBe("SIM");
  });

  it("e-mail que voltou como inexistente (bounce) não conta, mas outro e-mail bom sim", async () => {
    await identificador("email", "morto@exemplo.com.br", { isPrimary: true, invalido: true });
    expect(await decidir(TEM_EMAIL)).toBe("NAO");
    await identificador("email", "vivo@exemplo.com.br");
    expect(await decidir(TEM_EMAIL)).toBe("SIM");
  });

  it("só tem WhatsApp: não tem e-mail", async () => {
    await identificador("whatsapp", "+5565988880004");
    expect(await decidir(TEM_EMAIL)).toBe("NAO");
  });
});

describe("as duas juntas, no mesmo nó", () => {
  it("cada ramo olha o seu canal: quem só tem e-mail cai no ramo do e-mail", async () => {
    await identificador("email", "lead@exemplo.com.br");
    const no = {
      id: "c",
      tipo: "condition",
      branches: {
        branches: [
          { id: "w", label: "Tem WhatsApp", condition: TEM_WHATSAPP, nextNodeId: "ZAP" },
          { id: "e", label: "Tem e-mail", condition: TEM_EMAIL, nextNodeId: "MAIL" },
        ],
        default: "NENHUM",
      },
    };
    expect(await rodar(no)).toBe("MAIL");
    await identificador("whatsapp", "+5565988880005");
    expect(await rodar(no)).toBe("ZAP"); // os dois: vale o primeiro ramo da lista
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId: TEAM, contactId: contatoId } });
    expect(await rodar(no)).toBe("NENHUM");
  });
});

describe("schema", () => {
  it("aceita os dois critérios e recusa um tipo que não existe", () => {
    expect(conditionDefSchema.safeParse(TEM_WHATSAPP).success).toBe(true);
    expect(conditionDefSchema.safeParse(TEM_EMAIL).success).toBe(true);
    expect(conditionDefSchema.safeParse({ type: "has_telefone" }).success).toBe(false);
  });
});
