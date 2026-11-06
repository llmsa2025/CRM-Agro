import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

// Limpeza SÓ dos times deste arquivo: a base de TESTE é compartilhada (outros
// arquivos e agentes em paralelo) — antes, deleteMany({}) apagava a base toda.
const TIMES_DO_ARQUIVO = ["00000000-0000-0000-0000-0000000000c3"];

/**
 * Testes da ESCRITA CANÔNICA (writeContact) — foco no que era o pior furo do
 * diagnóstico: o import CSV entrava "morto" para o motor (sem `contact_created`).
 *
 * A fila é mockada (como em flows.test) — nenhum WhatsApp real é enviado e o teste
 * não depende de Redis. Provamos o gatilho pela criação de Enrollment no fluxo
 * ativo com triggerType `contact_created`.
 */
const scheduleStep = vi.fn();
vi.mock("../flows/queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const contacts = await import("./service");
const { writeContact } = await import("./write");

const TEAM = "00000000-0000-0000-0000-0000000000c3";

async function criarFluxoContactCreated() {
  const flow = await basePrisma.flow.create({
    data: { teamId: TEAM, nome: "Fluxo captação", triggerType: "contact_created", status: "active" },
  });
  await basePrisma.flowNode.create({
    data: { teamId: TEAM, flowId: flow.id, tipo: "notify_user" as never, config: {} as never, nextNodeId: null },
  });
  return flow;
}

beforeAll(async () => {
  await basePrisma.team.upsert({
    where: { id: TEAM },
    update: { name: "Team Write (test)" },
    create: { id: TEAM, name: "Team Write (test)" },
  });
});

beforeEach(async () => {
  scheduleStep.mockClear();
  await basePrisma.enrollment.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.flowNode.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.flow.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.contactCompany.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.company.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.activity.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.channelIdentifier.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
});

describe("writeContact — caminho canônico", () => {
  it("importCsv DISPARA contact_created para cada contato criado (fecha o furo)", async () => {
    await runWithTeam(TEAM, async () => {
      await criarFluxoContactCreated();
      const csv = `nome,telefone,email\nAna,(11) 99999-0001,ana@x.com\nBeto,(11) 99999-0002,beto@x.com\n`;
      const r = await contacts.importCsv(csv);
      expect(r.created).toBe(2);
    });

    // O motor foi acionado: 2 Enrollments (um por contato) no fluxo contact_created.
    const enrollments = await basePrisma.enrollment.findMany({ where: { teamId: TEAM } });
    expect(enrollments).toHaveLength(2);
    expect(scheduleStep).toHaveBeenCalledTimes(2);
  });

  it("upsert deduplica pelo identifier (não cria duplicata) e create sempre cria", async () => {
    const first = await runWithTeam(TEAM, async () =>
      writeContact(
        { nome: "Carla", identifiers: { email: "carla@x.com" }, provenance: { source: "test", actor: "human" } },
        { mode: "upsert" },
      ),
    );
    expect(first.created).toBe(true);

    const again = await runWithTeam(TEAM, async () =>
      writeContact(
        { nome: "Carla 2", identifiers: { email: "carla@x.com" }, provenance: { source: "test", actor: "human" } },
        { mode: "upsert" },
      ),
    );
    expect(again.created).toBe(false);
    expect(again.contactId).toBe(first.contactId);

    const total = await basePrisma.contact.count({ where: { teamId: TEAM } });
    expect(total).toBe(1);
  });

  it("rejeita CNPJ/site no nível da PESSOA (strict) — vão em companies[]", async () => {
    await expect(
      runWithTeam(TEAM, async () =>
        writeContact({
          nome: "Erro",
          // @ts-expect-error cnpj não é campo de pessoa
          cnpj: "12345678000199",
          identifiers: {},
          provenance: { source: "test", actor: "human" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("grava a EMPRESA via companies[] e denormaliza Contact.cnpj (dedup compat)", async () => {
    const res = await runWithTeam(TEAM, async () =>
      writeContact({
        nome: "Dono",
        identifiers: { whatsapp: "(11) 98888-0001" },
        companies: [{ nome: "Fazenda X", cnpj: "12.345.678/0001-99", papel: "dono" }],
        provenance: { source: "test", actor: "human" },
      }),
    );
    const contact = await basePrisma.contact.findUniqueOrThrow({ where: { id: res.contactId } });
    expect(contact.cnpj).toBe("12345678000199"); // denormalizado por createCompanyForContact
    const links = await basePrisma.contactCompany.findMany({ where: { contactId: res.contactId } });
    expect(links).toHaveLength(1);
    expect(links[0]?.papel).toBe("dono");
  });
});
