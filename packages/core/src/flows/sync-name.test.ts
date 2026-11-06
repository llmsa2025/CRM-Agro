import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Nó "Atualizar nome pelo WhatsApp" (`sync_name`) na ordem do nome da conversa
 * (pedido do dono, 28/09): o nome salvo na AGENDA do celular vem antes do
 * pushName. Fila e canal mockados: nada é enviado.
 */
vi.mock("./queue", () => ({
  scheduleStep: async () => {},
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
}));

const { executeNode } = await import("./executor");

const TEAM = "00000000-0000-0000-0000-0000000006e1";
const node = { id: "sync", tipo: "sync_name", config: {}, nextNodeId: "fim" } as never;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team sync_name (test)" } });
});
beforeEach(async () => {
  await basePrisma.conversation.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.contact.deleteMany({ where: { teamId: TEAM } });
});

async function rodar(contactId: string) {
  const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: contactId } });
  return runWithTeam(TEAM, () =>
    executeNode({ id: "e", teamId: TEAM, contactId, lastOutboundAt: null, contact: { id: c.id, nome: c.nome, tags: [], ownerId: null } }, node),
  );
}

describe("sync_name", () => {
  it("usa o nome da AGENDA antes do pushName", async () => {
    const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "+55 65 98888-1234" } });
    await basePrisma.conversation.create({ data: { teamId: TEAM, contactId: c.id, canal: "whatsapp", externalName: "Mai", nomeAgenda: "Maicon Fornecedor" } });
    expect(await rodar(c.id)).toEqual({ nextNodeId: "fim" });
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } })).nome).toBe("Maicon Fornecedor");
  });

  it("sem agenda, cai no pushName; sem nenhum, pula", async () => {
    const a = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "5565988881234" } });
    await basePrisma.conversation.create({ data: { teamId: TEAM, contactId: a.id, canal: "whatsapp", externalName: "Mai" } });
    await rodar(a.id);
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: a.id } })).nome).toBe("Mai");

    const b = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "5565988884321" } });
    await basePrisma.conversation.create({ data: { teamId: TEAM, contactId: b.id, canal: "whatsapp" } });
    expect(await rodar(b.id)).toEqual({ nextNodeId: "fim", skipped: true });
  });

  it("só grava nome de verdade: tira emoji e símbolo, recusa caractere solto e só emoji", async () => {
    const a = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "5565988880001" } });
    await basePrisma.conversation.create({ data: { teamId: TEAM, contactId: a.id, canal: "whatsapp", externalName: "✨ João Silva 🌾" } });
    await rodar(a.id);
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: a.id } })).nome).toBe("João Silva");

    for (const [i, ruim] of ["🌾", "A", "..", "😀😀"].entries()) {
      const b = await basePrisma.contact.create({ data: { teamId: TEAM, nome: `556598888100${i}` } });
      await basePrisma.conversation.create({ data: { teamId: TEAM, contactId: b.id, canal: "whatsapp", externalName: ruim } });
      expect(await rodar(b.id)).toEqual({ nextNodeId: "fim", skipped: true });
      expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: b.id } })).nome).toBe(`556598888100${i}`);
    }
  });
});

describe('condição "tem nome no WhatsApp"', () => {
  const condicao = { id: "c", tipo: "condition", branches: { branches: [{ id: "b", label: "Tem nome no WhatsApp", condition: { type: "whatsapp_name" }, nextNodeId: "sim" }], default: "nao" } } as never;
  const decidir = async (contactId: string) => {
    const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    return (await runWithTeam(TEAM, () => executeNode({ id: "e", teamId: TEAM, contactId, lastOutboundAt: null, contact: { id: c.id, nome: c.nome, tags: [], ownerId: null } } as never, condicao))).nextNodeId;
  };
  const contato = async (conversa?: { canal?: "whatsapp" | "instagram"; externalName?: string; nomeAgenda?: string }) => {
    const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "+55 65 98888-0000" } });
    if (conversa) await basePrisma.conversation.create({ data: { teamId: TEAM, contactId: c.id, canal: conversa.canal ?? "whatsapp", externalName: conversa.externalName, nomeAgenda: conversa.nomeAgenda } });
    return c.id;
  };

  it("sim: o nome do perfil ou o da agenda (com emoji limpo); não: sem conversa, só emoji ou nome de outro canal", async () => {
    expect(await decidir(await contato({ externalName: "João 🌾" }))).toBe("sim");
    expect(await decidir(await contato({ nomeAgenda: "Maria Silva" }))).toBe("sim");
    expect(await decidir(await contato({ externalName: "MariaSilva" }))).toBe("sim"); // nome junto
    expect(await decidir(await contato())).toBe("nao");
    for (const ruim of ["🌾", "A", "..", "@fulano"]) expect(await decidir(await contato({ externalName: ruim }))).toBe("nao");
    expect(await decidir(await contato({ canal: "instagram", externalName: "Ana Souza" }))).toBe("nao"); // só vale o do WhatsApp
  });

  it("a condição e o passo Atualizar nome concordam: quem tem nome no WhatsApp tem o cadastro atualizado", async () => {
    const id = await contato({ externalName: "✨ Carlos Lima ✨" });
    expect(await decidir(id)).toBe("sim");
    await rodar(id);
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id } })).nome).toBe("Carlos Lima");
  });
});

