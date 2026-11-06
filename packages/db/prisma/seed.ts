import { PrismaClient } from "@prisma/client";
import { env } from "@crmagro/config";

/**
 * Seed de dev: 1 Team + 1 User + 1 Goal (meta do mês) + 1 Funil padrão + 5 etapas.
 *
 * Usa o PrismaClient BASE (sem extensão de tenancy) porque é bootstrap. Em
 * runtime normal, use `db()` dentro de `runWithTeam`/`runAsDev`.
 *
 * IDs estáveis (hex) pra upsert ser idempotente.
 */
const prisma = new PrismaClient();

const TEAM = env.DEV_TEAM_ID;
if (!TEAM) throw new Error("DEV_TEAM_ID ausente: o seed precisa dela (ex.: 00000000-0000-0000-0000-000000000001).");
const GOAL_ID = "00000000-0000-0000-0000-00000000aa01";
const FUNNEL_ID = "00000000-0000-0000-0000-00000000bb01";
const STAGE_IDS = [
  "00000000-0000-0000-0000-00000000cc01",
  "00000000-0000-0000-0000-00000000cc02",
  "00000000-0000-0000-0000-00000000cc03",
  "00000000-0000-0000-0000-00000000cc04",
  "00000000-0000-0000-0000-00000000cc05",
];
const STAGES = [
  { nome: "Novo", cor: "#6b7280" },
  { nome: "Contatado", cor: "#3b82f6" },
  { nome: "Qualificado", cor: "#8b5cf6" },
  { nome: "Proposta", cor: "#f59e0b" },
  { nome: "Fechado", cor: "#10b981" },
];

async function main() {
  const team = await prisma.team.upsert({
    where: { id: TEAM },
    update: { name: "Time Demo" },
    create: { id: TEAM, name: "Time Demo" },
  });

  const user = await prisma.user.upsert({
    where: { email: "dono@crmagro.example" },
    update: { teamId: team.id, name: "Dono" },
    create: { teamId: team.id, name: "Dono", email: "dono@crmagro.example", role: "owner" },
  });
  // Master único: só vira master do time de dev se o time ainda não tem um
  // (rodar o seed de novo não toma o master de ninguém).
  if (!team.masterId && user.role === "owner") {
    await prisma.team.update({ where: { id: team.id }, data: { masterId: user.id } });
  }

  const goal = await prisma.goal.upsert({
    where: { id: GOAL_ID },
    update: { periodo: "2026-07", metaValor: 100000, toquesPorDia: 20 },
    create: { id: GOAL_ID, teamId: team.id, ownerId: user.id, periodo: "2026-07", metaValor: 100000, toquesPorDia: 20 },
  });

  const funnel = await prisma.funnel.upsert({
    where: { id: FUNNEL_ID },
    update: { nome: "Vendas", tipo: "pre_vendas" },
    create: { id: FUNNEL_ID, teamId: team.id, nome: "Vendas", tipo: "pre_vendas" },
  });

  for (let i = 0; i < STAGES.length; i++) {
    const s = STAGES[i]!;
    await prisma.stage.upsert({
      where: { id: STAGE_IDS[i]! },
      update: { funnelId: funnel.id, nome: s.nome, ordem: i, cor: s.cor },
      create: { id: STAGE_IDS[i]!, teamId: team.id, funnelId: funnel.id, nome: s.nome, ordem: i, cor: s.cor },
    });
  }

  // NÃO seedamos conta de canal: as contas nascem do fluxo "Conectar conta"
  // (/integracoes/canais → QR). As abas do inbox são dinâmicas por conta real.

   
  console.log("Seed OK:", {
    teamId: team.id,
    userId: user.id,
    goalId: goal.id,
    funnelId: funnel.id,
    stages: STAGES.length,
  });
}

main()
  .catch((e) => {
     
    console.error("Seed ERROR:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
