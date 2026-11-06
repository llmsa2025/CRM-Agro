import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { limparRascunhosPendentesAntigos } from "./service";
import { clearPendingDrafts } from "../captacao/service";
import { runWithTeam } from "../test-support/identidade";

/**
 * Fila da Captação persistente (produto, item H.1): a tela não apaga mais a
 * fila ao abrir; pendente esquecido expira em 30 dias; "Limpar fila" continua
 * existindo como ação explícita.
 */

const TEAM = "00000000-0000-0000-0000-0000000000c2";
const DIA = 86_400_000;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Captação (test)" } });
});

beforeEach(async () => {
  await basePrisma.prospectDraft.deleteMany({ where: { teamId: TEAM } });
});

async function rascunho(nome: string, status: string, diasAtras: number) {
  return basePrisma.prospectDraft.create({
    data: {
      teamId: TEAM,
      origem: "maps",
      lote: "lote-teste",
      nome,
      status,
      createdAt: new Date(Date.now() - diasAtras * DIA),
    },
  });
}

describe("retenção da fila da Captação", () => {
  it("apaga só PENDENTE com mais de 30 dias; recente e já importado ficam", async () => {
    const velho = await rascunho("velho", "pendente", 31);
    const recente = await rascunho("recente", "pendente", 2);
    const importado = await rascunho("importado", "importado", 60);

    const r = await limparRascunhosPendentesAntigos({ teamId: TEAM });
    expect(r.apagados).toBe(1);

    expect(await basePrisma.prospectDraft.findUnique({ where: { id: velho.id } })).toBeNull();
    expect(await basePrisma.prospectDraft.findUnique({ where: { id: recente.id } })).not.toBeNull();
    // Rascunho já tratado não é da conta deste job (entra no 2.7).
    expect(await basePrisma.prospectDraft.findUnique({ where: { id: importado.id } })).not.toBeNull();
  });

  it("'Limpar fila' explícito continua apagando os pendentes da origem", async () => {
    await rascunho("a", "pendente", 0);
    await rascunho("b", "pendente", 0);
    await runWithTeam(TEAM, () => clearPendingDrafts("maps"));
    expect(await basePrisma.prospectDraft.count({ where: { teamId: TEAM, status: "pendente" } })).toBe(0);
  });
});
