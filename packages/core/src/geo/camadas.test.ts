import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { basePrisma, runWithTeam as comPapel } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { ForbiddenError } from "../auth/authz";
import { OwnedNotFound } from "../tenancy/assert-owned";
import {
  listCamadas,
  createCamada,
  updateCamada,
  deleteCamada,
  moverContatosParaCamada,
  contatoNoMapa,
  CamadaJaExiste,
  CamadaNaoEncontrada,
} from "./camadas";

/**
 * Camadas do mapa (estilo Google My Maps): criar, listar, renomear, excluir e
 * mover contatos — e o teste "dois times" em cada escrita (o time B não
 * enxerga, não mexe e não move nada do A).
 */
const TEAM_A = "00000000-0000-0000-0000-00000000c4a1";
const TEAM_B = "00000000-0000-0000-0000-00000000c4a2";

async function limpar() {
  for (const teamId of [TEAM_A, TEAM_B]) {
    await basePrisma.contact.deleteMany({ where: { teamId } });
    await basePrisma.mapaCamada.deleteMany({ where: { teamId } });
  }
}

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Team A (camadas do mapa)"],
    [TEAM_B, "Team B (camadas do mapa)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});
beforeEach(limpar);
afterAll(limpar);

const emA = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_A, fn);
const emB = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_B, fn);

describe("camadas do mapa", () => {
  it("cria, lista na ordem com a contagem, renomeia e muda a cor", async () => {
    const grande = await emA(() => createCamada({ nome: "Acima de 5.000 ha", cor: "#A8321E" }));
    const centro = await emA(() => createCamada({ nome: "Centro-Sul" }));
    expect(grande).toMatchObject({ nome: "Acima de 5.000 ha", cor: "#A8321E", contatos: 0 });
    expect(centro.cor).toBe("#1F4A3A"); // cor padrão
    expect(centro.ordem).toBeGreaterThan(grande.ordem);

    const c = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Produtor", camadaId: grande.id } });
    await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Solto" } });
    const lista = await emA(() => listCamadas());
    expect(lista.camadas.map((x) => [x.nome, x.contatos])).toEqual([
      ["Acima de 5.000 ha", 1],
      ["Centro-Sul", 0],
    ]);
    expect(lista.semCamada).toBe(1);

    const renomeada = await emA(() => updateCamada(grande.id, { nome: "5.000 ha+", cor: "#2F5B8A" }));
    expect(renomeada).toMatchObject({ id: grande.id, nome: "5.000 ha+", cor: "#2F5B8A", contatos: 1 });
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } })).camadaId).toBe(grande.id);
  });

  it("nome repetido no mesmo time → CamadaJaExiste (criar e renomear); em outro time pode", async () => {
    const a = await emA(() => createCamada({ nome: "Feira 2026" }));
    const b = await emA(() => createCamada({ nome: "Outra" }));
    await expect(emA(() => createCamada({ nome: "Feira 2026" }))).rejects.toBeInstanceOf(CamadaJaExiste);
    await expect(emA(() => updateCamada(b.id, { nome: "Feira 2026" }))).rejects.toBeInstanceOf(CamadaJaExiste);
    await expect(emA(() => updateCamada(a.id, { nome: "Feira 2026" }))).resolves.toMatchObject({ nome: "Feira 2026" });
    await expect(emB(() => createCamada({ nome: "Feira 2026" }))).resolves.toMatchObject({ nome: "Feira 2026" });
  });

  it("cor fora do formato #rrggbb é recusada", async () => {
    await expect(emA(() => createCamada({ nome: "X", cor: "vermelho" }))).rejects.toThrow(/cor inválida/);
  });

  it("dois times: B não lista, não renomeia, não exclui e não usa a camada do A", async () => {
    const camA = await emA(() => createCamada({ nome: "Só do A" }));
    const contatoB = await basePrisma.contact.create({ data: { teamId: TEAM_B, nome: "Do B" } });

    expect((await emB(() => listCamadas())).camadas).toEqual([]);
    await expect(emB(() => updateCamada(camA.id, { nome: "Invadida" }))).rejects.toBeInstanceOf(CamadaNaoEncontrada);
    await expect(emB(() => deleteCamada(camA.id))).rejects.toBeInstanceOf(CamadaNaoEncontrada);
    await expect(emB(() => moverContatosParaCamada([contatoB.id], camA.id))).rejects.toBeInstanceOf(CamadaNaoEncontrada);

    const depois = await basePrisma.mapaCamada.findUniqueOrThrow({ where: { id: camA.id } });
    expect(depois.nome).toBe("Só do A");
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: contatoB.id } })).camadaId).toBeNull();
  });

  it("mover: contato de outro time na lista → OwnedNotFound e nada muda", async () => {
    const cam = await emA(() => createCamada({ nome: "Destino" }));
    const meu = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Meu" } });
    const alheio = await basePrisma.contact.create({ data: { teamId: TEAM_B, nome: "Alheio" } });
    await expect(emA(() => moverContatosParaCamada([meu.id, alheio.id], cam.id))).rejects.toBeInstanceOf(OwnedNotFound);
    for (const id of [meu.id, alheio.id]) {
      expect((await basePrisma.contact.findUniqueOrThrow({ where: { id } })).camadaId).toBeNull();
    }
  });

  it("mover para a camada e de volta para 'Sem camada' (null); ids repetidos contam uma vez", async () => {
    const cam = await emA(() => createCamada({ nome: "Centro-Sul" }));
    const c1 = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "C1" } });
    const c2 = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "C2" } });
    await expect(emA(() => moverContatosParaCamada([c1.id, c2.id, c1.id], cam.id))).resolves.toEqual({ movidos: 2 });
    expect((await emA(() => listCamadas())).camadas[0]!.contatos).toBe(2);
    await expect(emA(() => moverContatosParaCamada([c1.id], null))).resolves.toEqual({ movidos: 1 });
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: c1.id } })).camadaId).toBeNull();
    await expect(emA(() => moverContatosParaCamada([], cam.id))).resolves.toEqual({ movidos: 0 });
  });

  it("excluir a camada devolve os contatos para 'Sem camada'", async () => {
    const cam = await emA(() => createCamada({ nome: "Temporária" }));
    const c = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Dentro", camadaId: cam.id } });
    await emA(() => deleteCamada(cam.id));
    expect(await basePrisma.mapaCamada.findUnique({ where: { id: cam.id } })).toBeNull();
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } })).camadaId).toBeNull();
    expect((await emA(() => listCamadas())).semCamada).toBe(1);
  });

  it("contatoNoMapa: camada, área e faturamento do contato; o outro time recebe null", async () => {
    const cam = await emA(() => createCamada({ nome: "Com área" }));
    const c = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "C", camadaId: cam.id, areaHa: 800, faturamentoAnual: 1_500_000 } });
    await expect(emA(() => contatoNoMapa(c.id))).resolves.toEqual({ id: c.id, camadaId: cam.id, areaHa: 800, faturamentoAnual: 1_500_000 });
    await expect(emB(() => contatoNoMapa(c.id))).resolves.toBeNull();
  });

  it("RBAC: viewer lista, mas não cria, não renomeia, não exclui nem move", async () => {
    const cam = await emA(() => createCamada({ nome: "Do dono" }));
    const c = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "C" } });
    const comoViewer = <T>(fn: () => Promise<T>) => comPapel(TEAM_A, fn, { userId: "viewer-camadas", role: "viewer" });
    await expect(comoViewer(() => listCamadas())).resolves.toMatchObject({ camadas: [{ id: cam.id }] });
    await expect(comoViewer(() => createCamada({ nome: "Nova" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(comoViewer(() => updateCamada(cam.id, { nome: "Nova" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(comoViewer(() => deleteCamada(cam.id))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(comoViewer(() => moverContatosParaCamada([c.id], cam.id))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
