import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { ForbiddenError } from "../auth/authz";
import { runWithTeam } from "../test-support/identidade";
import {
  ROTULO_TOKEN_DOWNLOAD,
  createRelayToken,
  descreverDonoDoToken,
  listRelayTokens,
  revogarTokensDeDownloadNaoUsados,
  rotuloDoTokenDeDownload,
} from "./tokens";

/**
 * Tokens que o DOWNLOAD da extensão cria: cada download cria um token novo, e sem
 * revogar o anterior eles se acumulavam ativos. Banco de TESTE real.
 */
const TEAM = "00000000-0000-0000-0000-0000000ec702";
const OUTRO_TIME = "00000000-0000-0000-0000-0000000ec703";
const ANA = "user-ana-download";
const BIA = "user-bia-download";
const CARLA_OUTRO_TIME = "user-carla-download";
const admin = (userId: string) => ({ userId, role: "admin" });

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Fazenda Boa (test)" } });
  await basePrisma.team.upsert({ where: { id: OUTRO_TIME }, update: {}, create: { id: OUTRO_TIME, name: "Outro Time (test)" } });
  for (const [id, teamId, name] of [
    [ANA, TEAM, "Ana Souza"],
    [BIA, TEAM, "Bia Lima"],
    [CARLA_OUTRO_TIME, OUTRO_TIME, "Carla Dias"],
  ] as const) {
    await basePrisma.user.upsert({ where: { id }, update: { teamId, role: "admin", name }, create: { id, teamId, role: "admin", name, email: `${id}@download.test` } });
  }
});
beforeEach(async () => {
  await basePrisma.relayAgentToken.deleteMany({ where: { teamId: { in: [TEAM, OUTRO_TIME] } } });
});

/** O que a rota de download faz: revoga os não usados e cria o token novo. */
async function baixar(userId: string, teamId = TEAM, quando = new Date("2026-09-30T12:00:00Z")) {
  return runWithTeam(
    teamId,
    async () => {
      const revogados = await revogarTokensDeDownloadNaoUsados(userId);
      const token = await createRelayToken({ label: rotuloDoTokenDeDownload(quando), userId, doDownload: true });
      return { revogados, token };
    },
    admin(userId),
  );
}
const ativosDe = (userId: string) => basePrisma.relayAgentToken.findMany({ where: { userId, revokedAt: null }, orderBy: { createdAt: "asc" } });
const marcarUsado = (id: string) => basePrisma.relayAgentToken.update({ where: { id }, data: { lastUsedAt: new Date() } });

describe("rótulo do download", () => {
  it("leva a data e o prefixo reservado", () => {
    expect(rotuloDoTokenDeDownload(new Date("2026-09-30T12:00:00Z"))).toBe("Extensão (download 2026-09-30)");
    expect(rotuloDoTokenDeDownload(new Date("2026-01-05T23:59:59Z")).startsWith(ROTULO_TOKEN_DOWNLOAD)).toBe(true);
  });
  it("quem gera token na mão não pode usar o rótulo reservado (senão o download o revogaria)", async () => {
    for (const label of ["Extensão (download 2026-09-30)", "  extensão (DOWNLOAD do notebook)"]) {
      await expect(runWithTeam(TEAM, () => createRelayToken({ label, userId: ANA }), admin(ANA)), label).rejects.toThrow(/reservado/);
    }
    expect(await basePrisma.relayAgentToken.count({ where: { teamId: TEAM } })).toBe(0);
  });
  it("nomes normais continuam valendo", async () => {
    const t = await runWithTeam(TEAM, () => createRelayToken({ label: "Meu notebook", userId: ANA }), admin(ANA));
    expect(t.label).toBe("Meu notebook");
  });
});

describe("baixar de novo não acumula token ativo", () => {
  it("vários downloads seguidos sem instalar: só o último fica ativo", async () => {
    const t1 = await baixar(ANA);
    const t2 = await baixar(ANA);
    const t3 = await baixar(ANA);
    expect([t1.revogados, t2.revogados, t3.revogados]).toEqual([0, 1, 1]);
    const ativos = await ativosDe(ANA);
    expect(ativos.map((t) => t.id)).toEqual([t3.token.id]);
    // os antigos ficam no banco, revogados (histórico), nunca apagados
    expect(await basePrisma.relayAgentToken.count({ where: { userId: ANA } })).toBe(3);
  });

  it("token JÁ USADO (extensão instalada) nunca é revogado: baixar para atualizar não derruba o outro computador", async () => {
    const t1 = await baixar(ANA);
    await marcarUsado(t1.token.id); // a extensão do notebook autenticou com ele
    const t2 = await baixar(ANA); // baixa de novo para atualizar
    expect(t2.revogados).toBe(0);
    const t3 = await baixar(ANA); // e mais uma vez: revoga só o t2, que ninguém usou
    expect(t3.revogados).toBe(1);
    expect((await ativosDe(ANA)).map((t) => t.id)).toEqual([t1.token.id, t3.token.id]);
  });

  it("token gerado na mão (outro rótulo) não é tocado", async () => {
    const manual = await runWithTeam(TEAM, () => createRelayToken({ label: "Chrome do escritório", userId: ANA }), admin(ANA));
    await baixar(ANA);
    const r = await baixar(ANA);
    expect(r.revogados).toBe(1); // só o download anterior
    expect((await ativosDe(ANA)).map((t) => t.id)).toContain(manual.id);
  });

  it("só os tokens do PRÓPRIO usuário: o download da Bia não revoga o da Ana", async () => {
    const ana = await baixar(ANA);
    const bia = await baixar(BIA);
    expect(bia.revogados).toBe(0);
    expect((await ativosDe(ANA)).map((t) => t.id)).toEqual([ana.token.id]);
    expect((await ativosDe(BIA)).map((t) => t.id)).toEqual([bia.token.id]);
  });

  it("dois times: o download de um time não mexe em token de outro", async () => {
    const carla = await baixar(CARLA_OUTRO_TIME, OUTRO_TIME);
    // mesmo com o id da Carla, dentro do contexto do time da Ana nada é encontrado
    const cruzado = await runWithTeam(TEAM, () => revogarTokensDeDownloadNaoUsados(CARLA_OUTRO_TIME), admin(ANA));
    expect(cruzado).toBe(0);
    expect((await ativosDe(CARLA_OUTRO_TIME)).map((t) => t.id)).toEqual([carla.token.id]);
  });

  it("token já revogado não é revogado de novo (a data original fica)", async () => {
    const t1 = await baixar(ANA);
    const antes = new Date("2026-01-01T00:00:00Z");
    await basePrisma.relayAgentToken.update({ where: { id: t1.token.id }, data: { revokedAt: antes } });
    const r = await baixar(ANA);
    expect(r.revogados).toBe(0);
    const linha = await basePrisma.relayAgentToken.findUniqueOrThrow({ where: { id: t1.token.id } });
    expect(linha.revokedAt?.toISOString()).toBe(antes.toISOString());
  });

  it("sem usuário (id vazio): não revoga nada", async () => {
    await baixar(ANA);
    expect(await runWithTeam(TEAM, () => revogarTokensDeDownloadNaoUsados(""), admin(ANA))).toBe(0);
    expect(await ativosDe(ANA)).toHaveLength(1);
  });

  it("quem não pode gerar token (membro) também não revoga", async () => {
    await expect(runWithTeam(TEAM, () => revogarTokensDeDownloadNaoUsados(ANA), { userId: ANA, role: "member" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runWithTeam(TEAM, () => revogarTokensDeDownloadNaoUsados(ANA), { userId: ANA, role: "viewer" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a lista da tela mostra os revogados como revogados", async () => {
    await baixar(ANA);
    await baixar(ANA);
    const lista = await runWithTeam(TEAM, () => listRelayTokens(), admin(ANA));
    expect(lista.filter((t) => !t.revokedAt)).toHaveLength(1);
    expect(lista.filter((t) => t.revokedAt)).toHaveLength(1);
  });
});

describe("dono do token (para o popup mostrar de quem é)", () => {
  it("devolve o nome da pessoa e do time, e nada além", async () => {
    expect(await descreverDonoDoToken(TEAM, ANA)).toEqual({ nome: "Ana Souza", time: "Fazenda Boa (test)" });
  });
  it("token sem dono, ou dono de outro time, não revela ninguém", async () => {
    expect(await descreverDonoDoToken(TEAM, null)).toEqual({ nome: null, time: null });
    expect(await descreverDonoDoToken(TEAM, CARLA_OUTRO_TIME)).toEqual({ nome: null, time: null });
    expect(await descreverDonoDoToken(TEAM, "usuario-que-nao-existe")).toEqual({ nome: null, time: null });
  });
});
