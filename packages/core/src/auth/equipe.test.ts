import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { ForbiddenError } from "./authz";
import { getSessionState } from "./session";
import { provisionUserFromGoogle, ContaDesativada } from "./provisioning";
import { createInvite, acceptInvite } from "./invites";
import {
  listIntegrantes,
  alterarPapel,
  definirPermissoesEquipe,
  definirVerTudoEm,
  desativarIntegrante,
  reativarIntegrante,
  excluirIntegrante,
  redefinirSenhaDeIntegrante,
  contaDesativada,
  definirModulos,
  AcaoNaoPermitida,
  IntegranteNaoEncontrado,
} from "./equipe";
import { planejarMaster, definirMaster, MasterInvalido } from "./master-operacao";
import { masterDoTime, masterDefinidoDoTime } from "./master";

/**
 * Equipe (plano-equipe-permissoes F2a): o master decide papel e o que cada
 * administrador faz com a equipe; desativar corta o acesso; excluir transfere
 * os registros; o master redefine a senha (não "vê"). E dois times.
 */
const TEAM_A = "00000000-0000-0000-0000-00000000e2a1";
const TEAM_B = "00000000-0000-0000-0000-00000000e2a2";
// Time do master único: vários "owner" de antes da regra, sem master definido.
const TEAM_C = "00000000-0000-0000-0000-00000000e2a3";
const TEAM_D = "00000000-0000-0000-0000-00000000e2a4";
const sufixo = Math.random().toString(36).slice(2, 7);
const hashSenha = async (s: string) => `hash:${s}`;

type U = { id: string; email: string };
let master: U, admin: U, vendedor: U, leitor: U, outroTime: U;

async function pessoa(teamId: string, nome: string, role: string, extra: Record<string, unknown> = {}): Promise<U> {
  const email = `${nome}-${sufixo}@equipe.dev`;
  const u = await basePrisma.user.create({ data: { teamId, name: nome, email, role, passwordHash: "hash:velha", emailVerificadoEm: new Date(), ...extra } });
  return { id: u.id, email };
}
const como = <T>(u: U, role: string, fn: () => Promise<T>, teamId = TEAM_A) => runWithTeam(teamId, fn, { userId: u.id, role });

async function limpar() {
  for (const teamId of [TEAM_A, TEAM_B, TEAM_C, TEAM_D]) {
    await basePrisma.invite.deleteMany({ where: { teamId } });
    await basePrisma.pushSubscription.deleteMany({ where: { teamId } });
    await basePrisma.relayAgentToken.deleteMany({ where: { teamId } });
    await basePrisma.goal.deleteMany({ where: { teamId } });
    await basePrisma.appointment.deleteMany({ where: { teamId } });
    await basePrisma.campaign.deleteMany({ where: { teamId } });
    await basePrisma.call.deleteMany({ where: { teamId } });
    await basePrisma.linhaDeLigacao.deleteMany({ where: { teamId } });
    await basePrisma.deal.deleteMany({ where: { teamId } });
    await basePrisma.stage.deleteMany({ where: { teamId } });
    await basePrisma.funnel.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
    await basePrisma.flow.deleteMany({ where: { teamId } });
    await basePrisma.prospectDraft.deleteMany({ where: { teamId } });
    await basePrisma.contact.deleteMany({ where: { teamId } });
    await basePrisma.user.deleteMany({ where: { teamId } });
  }
}

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Equipe A (test)"],
    [TEAM_B, "Equipe B (test)"],
    [TEAM_C, "Equipe C — vários donos (test)"],
    [TEAM_D, "Equipe D — vários donos (test)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { masterId: null }, create: { id, name } });
  }
  await limpar();
  master = await pessoa(TEAM_A, "master", "owner");
  // Master único: o time A tem o seu (como nasce um time hoje).
  await basePrisma.team.update({ where: { id: TEAM_A }, data: { masterId: master.id } });
  admin = await pessoa(TEAM_A, "admin", "admin");
  vendedor = await pessoa(TEAM_A, "vendedor", "member");
  leitor = await pessoa(TEAM_A, "leitor", "viewer");
  outroTime = await pessoa(TEAM_B, "outro", "owner");
});
afterAll(limpar);

describe("equipe: papel e permissões do administrador", () => {
  it("master e administrador listam a equipe (sem hash de senha); membro não; o outro time não aparece", async () => {
    const lista = await como(admin, "admin", () => listIntegrantes());
    expect(lista.map((u) => u.email).sort()).toEqual([admin, leitor, master, vendedor].map((u) => u.email).sort());
    expect(JSON.stringify(lista)).not.toContain("hash:");
    await expect(como(vendedor, "member", () => listIntegrantes())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("só o master troca papel; nunca de si mesmo nem do master; rebaixar tira as permissões de equipe e derruba a sessão", async () => {
    await expect(como(admin, "admin", () => alterarPapel(vendedor.id, "admin"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(master, "owner", () => alterarPapel(master.id, "member"))).rejects.toBeInstanceOf(AcaoNaoPermitida);
    const promovido = await como(master, "owner", () => alterarPapel(vendedor.id, "admin"));
    expect(promovido.role).toBe("admin");
    await como(master, "owner", () => definirPermissoesEquipe(vendedor.id, ["convidar", "desativar"]));
    const antes = await basePrisma.user.findUniqueOrThrow({ where: { id: vendedor.id } });
    const rebaixado = await como(master, "owner", () => alterarPapel(vendedor.id, "member"));
    expect(rebaixado).toMatchObject({ role: "member", permissoesEquipe: [] });
    expect((await getSessionState(vendedor.id))?.sessionVersion).toBe(antes.sessionVersion + 1);
  });

  it("permissões de equipe: só para administrador e só o master define", async () => {
    await expect(como(master, "owner", () => definirPermissoesEquipe(vendedor.id, ["convidar"]))).rejects.toBeInstanceOf(AcaoNaoPermitida);
    await expect(como(admin, "admin", () => definirPermissoesEquipe(admin.id, ["excluir"]))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(master, "owner", () => definirPermissoesEquipe(admin.id, ["excluir", "voar"]))).rejects.toThrow();
  });

  it("administrador convida só com 'convidar'; nunca convida administrador; o convite leva 'ver tudo' e as permissões", async () => {
    await como(master, "owner", () => definirPermissoesEquipe(admin.id, []));
    await expect(como(admin, "admin", () => createInvite({ email: `novo1-${sufixo}@equipe.dev` }))).rejects.toBeInstanceOf(ForbiddenError);
    await como(master, "owner", () => definirPermissoesEquipe(admin.id, ["convidar"]));
    const novo1 = await como(admin, "admin", () => createInvite({ email: `novo1-${sufixo}@equipe.dev`, verTudoEm: ["contatos", "voar"] }));
    expect(novo1).toMatchObject({ email: `novo1-${sufixo}@equipe.dev` });
    // O "ver tudo" por tela vai com o convite (só telas com dono).
    expect((await acceptInvite(novo1.token!, { name: "Novo 1", passwordHash: "hash:x" })).ok).toBe(true);
    expect((await basePrisma.user.findUniqueOrThrow({ where: { email: `novo1-${sufixo}@equipe.dev` } })).verTudoEm).toEqual(["contatos"]);
    await expect(como(admin, "admin", () => createInvite({ email: `novo2-${sufixo}@equipe.dev`, role: "admin" }))).rejects.toBeInstanceOf(ForbiddenError);

    const c = await como(master, "owner", () =>
      createInvite({ email: `gestor-${sufixo}@equipe.dev`, role: "admin", permissoesEquipe: ["convidar", "desativar", "hackear"] }),
    );
    const res = await acceptInvite(c.token!, { name: "Gestor", passwordHash: "hash:x" });
    expect(res.ok).toBe(true);
    const gestor = await basePrisma.user.findUniqueOrThrow({ where: { email: `gestor-${sufixo}@equipe.dev` } });
    expect(gestor).toMatchObject({ role: "admin", permissoesEquipe: ["convidar", "desativar"] });
  });
});

describe("equipe: ver tudo, desativar, excluir e redefinir senha", () => {
  it("'ver tudo' por tela: administrador libera para membro (só telas com dono); não para o master nem para administrador", async () => {
    const antes = await basePrisma.user.findUniqueOrThrow({ where: { id: leitor.id } });
    // "editar" fora de "ver" (funis) é descartado: editar fica sempre dentro de ver.
    await expect(como(admin, "admin", () => definirVerTudoEm(leitor.id, ["conversas", "contatos", "voar", "contatos"], ["contatos", "funis"]))).resolves.toMatchObject({
      verTudoEm: ["contatos", "conversas"],
      editarTudoEm: ["contatos"],
    });
    // Derruba a sessão: o token novo leva a lista.
    expect((await getSessionState(leitor.id))?.sessionVersion).toBe(antes.sessionVersion + 1);
    await expect(como(admin, "admin", () => definirVerTudoEm(master.id, ["contatos"], []))).rejects.toBeInstanceOf(AcaoNaoPermitida);
    await expect(como(master, "owner", () => definirVerTudoEm(admin.id, ["contatos"], []))).rejects.toBeInstanceOf(AcaoNaoPermitida);
    await expect(como(vendedor, "member", () => definirVerTudoEm(leitor.id, ["contatos"], []))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("desativar exige a permissão; corta sessão e login (senha e Google); reativar devolve o acesso", async () => {
    await como(master, "owner", () => definirPermissoesEquipe(admin.id, ["convidar"]));
    await expect(como(admin, "admin", () => desativarIntegrante(vendedor.id))).rejects.toBeInstanceOf(ForbiddenError);
    await como(master, "owner", () => definirPermissoesEquipe(admin.id, ["convidar", "desativar"]));
    // Avisos no navegador, token da extensão e convite pendente que ele mandou (revisão do #149, B1).
    await basePrisma.pushSubscription.create({
      data: { teamId: TEAM_A, userId: vendedor.id, endpoint: `https://fcm.googleapis.com/fcm/send/${sufixo}`, p256dh: "p", auth: "a" },
    });
    await basePrisma.relayAgentToken.create({ data: { teamId: TEAM_A, userId: vendedor.id, label: "ext", tokenHash: `h-${sufixo}`, tokenPrefix: "rly_x" } });
    await basePrisma.invite.create({
      data: { teamId: TEAM_A, email: `conv-${sufixo}@equipe.dev`, tokenHash: `i-${sufixo}`, tokenPrefix: "inv_x", invitedByUserId: vendedor.id, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const d = await como(admin, "admin", () => desativarIntegrante(vendedor.id));
    expect(await basePrisma.pushSubscription.count({ where: { userId: vendedor.id } })).toBe(0);
    expect(await basePrisma.relayAgentToken.count({ where: { userId: vendedor.id, revokedAt: null } })).toBe(0);
    expect(await basePrisma.invite.count({ where: { invitedByUserId: vendedor.id, revokedAt: null } })).toBe(0);
    expect(d.desativadoEm).not.toBeNull();
    expect(await getSessionState(vendedor.id)).toBeNull();
    expect(await contaDesativada(vendedor.email)).toBe(true);
    await expect(provisionUserFromGoogle({ email: vendedor.email })).rejects.toBeInstanceOf(ContaDesativada);
    // Administrador não desativa outro administrador (só o master).
    const outroAdmin = await pessoa(TEAM_A, "admin2", "admin");
    await expect(como(admin, "admin", () => desativarIntegrante(outroAdmin.id))).rejects.toBeInstanceOf(AcaoNaoPermitida);

    await como(admin, "admin", () => reativarIntegrante(vendedor.id));
    expect(await getSessionState(vendedor.id)).not.toBeNull();
    expect(await contaDesativada(vendedor.email)).toBe(false);
  });

  it("excluir exige a permissão e transfere contatos, campanhas, compromissos e metas para quem fica", async () => {
    const saindo = await pessoa(TEAM_A, "saindo", "member");
    await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Do saindo", ownerId: saindo.id } });
    await basePrisma.campaign.create({ data: { teamId: TEAM_A, nome: "Camp", createdById: saindo.id } });
    await basePrisma.appointment.create({ data: { teamId: TEAM_A, titulo: "Visita", inicio: new Date(), responsavelId: saindo.id } });
    await basePrisma.goal.create({ data: { teamId: TEAM_A, ownerId: saindo.id, periodo: "2026-09", metaValor: 0, toquesPorDia: 0 } });
    // Escopo por dono (F3): negócio, canal, ligação, fluxo e fila de captação também passam.
    const contato = await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM_A, ownerId: saindo.id } });
    const funil = await basePrisma.funnel.create({ data: { teamId: TEAM_A, nome: "Vendas", tipo: "vendas" } });
    const etapa = await basePrisma.stage.create({ data: { teamId: TEAM_A, funnelId: funil.id, nome: "Novo", ordem: 0 } });
    await basePrisma.deal.create({ data: { teamId: TEAM_A, funnelId: funil.id, stageId: etapa.id, contactId: contato.id, ownerId: saindo.id } });
    await basePrisma.channelAccount.create({ data: { teamId: TEAM_A, canal: "whatsapp", label: "Do saindo", provider: "evolution", ownerId: saindo.id } });
    await basePrisma.call.create({ data: { teamId: TEAM_A, contactId: contato.id, phoneNumber: "+5565999990000", direction: "outbound", provider: "manual", userId: saindo.id } });
    await basePrisma.flow.create({ data: { teamId: TEAM_A, nome: "Fluxo do saindo", triggerType: "manual", createdById: saindo.id } });
    await basePrisma.prospectDraft.create({ data: { teamId: TEAM_A, origem: "maps", lote: "l1", nome: "Fazenda", ownerId: saindo.id } });

    await expect(como(admin, "admin", () => excluirIntegrante(saindo.id, master.id))).rejects.toBeInstanceOf(ForbiddenError);
    // Destino de outro time não vale.
    await expect(como(master, "owner", () => excluirIntegrante(saindo.id, outroTime.id))).rejects.toBeInstanceOf(IntegranteNaoEncontrado);

    const r = await como(master, "owner", () => excluirIntegrante(saindo.id, vendedor.id));
    expect(r.transferidos).toMatchObject({
      contatos: 1, campanhas: 1, compromissos: 1, metas: 1,
      negocios: 1, canais: 1, ligacoes: 1, fluxos: 1, captacao: 1,
    });
    expect(await basePrisma.user.findUnique({ where: { id: saindo.id } })).toBeNull();
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A, ownerId: vendedor.id } })).toBe(1);
  });

  it("excluir pausa as linhas de ligação da pessoa e tira a padrão, em vez de virarem linha do time", async () => {
    const saindo = await pessoa(TEAM_A, "saindo-linha", "member");
    const linha = (idExterno: string, extra: Record<string, unknown>) =>
      basePrisma.linhaDeLigacao.create({ data: { teamId: TEAM_A, provedor: "teste_um", tipo: "ramal", contaExterna: `conta-equipe-${sufixo}`, idExterno: `${idExterno}-${sufixo}`, userId: saindo.id, ...extra } });
    const padrao = await linha("1", { padrao: true });
    const outra = await linha("2", {});
    const desativada = await linha("3", { estado: "desativada", padrao: false });
    const doTime = await linha("4", { userId: null });
    const deOutraPessoa = await linha("5", { userId: vendedor.id, padrao: true });

    const r = await como(master, "owner", () => excluirIntegrante(saindo.id, vendedor.id));
    expect(r.transferidos).not.toHaveProperty("linhas");

    const depois = async (id: string) => basePrisma.linhaDeLigacao.findUniqueOrThrow({ where: { id } });
    // A pessoa saiu: as linhas dela ficam sem dono (FK), mas pausadas e sem padrão. Nenhuma pode ligar.
    for (const l of [padrao, outra]) {
      expect(await depois(l.id)).toMatchObject({ userId: null, estado: "pausada", padrao: false, pausadaAte: null });
      expect((await depois(l.id)).motivoPausa).toContain("saiu da equipe");
    }
    expect(await depois(desativada.id)).toMatchObject({ userId: null, estado: "desativada", padrao: false });
    // O que não era dela não muda.
    expect(await depois(doTime.id)).toMatchObject({ userId: null, estado: "ativa", padrao: false, motivoPausa: null });
    expect(await depois(deOutraPessoa.id)).toMatchObject({ userId: vendedor.id, estado: "ativa", padrao: true, motivoPausa: null });
  });

  it("o master redefine a senha (provisória, mostrada uma vez) e derruba as sessões; ninguém mais pode", async () => {
    const antes = await basePrisma.user.findUniqueOrThrow({ where: { id: leitor.id } });
    await expect(como(admin, "admin", () => redefinirSenhaDeIntegrante(leitor.id, { hashSenha }))).rejects.toBeInstanceOf(ForbiddenError);
    const { senhaProvisoria } = await como(master, "owner", () => redefinirSenhaDeIntegrante(leitor.id, { hashSenha }));
    expect(senhaProvisoria).toMatch(/^[a-zA-Z2-9]{12}$/);
    const depois = await basePrisma.user.findUniqueOrThrow({ where: { id: leitor.id } });
    expect(depois.passwordHash).toBe(`hash:${senhaProvisoria}`);
    expect(depois.sessionVersion).toBe(antes.sessionVersion + 1);
  });

  it("id que não é uuid (ex.: filtro no lugar do id) é recusado — nada de excluir sem transferir", async () => {
    await expect(como(master, "owner", () => desativarIntegrante({ in: [vendedor.id] } as unknown as string))).rejects.toBeInstanceOf(IntegranteNaoEncontrado);
    await expect(como(master, "owner", () => excluirIntegrante(leitor.id, { in: [leitor.id] } as unknown as string))).rejects.toBeInstanceOf(IntegranteNaoEncontrado);
    expect(await basePrisma.user.findUnique({ where: { id: leitor.id } })).not.toBeNull();
  });

  it("dois times: o master do time B não enxerga nem mexe em ninguém do time A", async () => {
    await expect(como(outroTime, "owner", () => desativarIntegrante(vendedor.id), TEAM_B)).rejects.toBeInstanceOf(IntegranteNaoEncontrado);
    await expect(como(outroTime, "owner", () => alterarPapel(vendedor.id, "admin"), TEAM_B)).rejects.toBeInstanceOf(IntegranteNaoEncontrado);
    await expect(como(outroTime, "owner", () => redefinirSenhaDeIntegrante(vendedor.id, { hashSenha }), TEAM_B)).rejects.toBeInstanceOf(IntegranteNaoEncontrado);
    const listaB = await como(outroTime, "owner", () => listIntegrantes(), TEAM_B);
    expect(listaB.map((u) => u.email)).toEqual([outroTime.email]);
  });
});

describe("master único (pedido do dono, 28/09)", () => {
  it("o time tem UM master: só ele aparece como master; ninguém vira 'owner' pela tela nem por convite", async () => {
    const lista = await como(master, "owner", () => listIntegrantes());
    expect(lista.filter((u) => u.master).map((u) => u.id)).toEqual([master.id]);
    expect(lista[0]?.id).toBe(master.id); // o master primeiro
    await expect(como(master, "owner", () => alterarPapel(vendedor.id, "owner"))).rejects.toThrow();
    expect((await basePrisma.user.findUniqueOrThrow({ where: { id: vendedor.id } })).role).not.toBe("owner");
    await expect(como(master, "owner", () => createInvite({ email: `dono-${sufixo}@equipe.dev`, role: "owner" }))).rejects.toThrow("papel inválido");
  });

  it("o master rebaixa um 'owner' antigo (vira administrador com convidar + desativar; a sessão cai); outro 'owner' e administrador não", async () => {
    await como(master, "owner", () => definirPermissoesEquipe(admin.id, ["convidar", "desativar"]));
    const antigo = await pessoa(TEAM_A, "dono-antigo", "owner");
    const outroAntigo = await pessoa(TEAM_A, "dono-antigo2", "owner");
    // "owner" antigo não mexe em outro "owner" nem no master; administrador também não.
    await expect(como(outroAntigo, "owner", () => alterarPapel(antigo.id, "admin"))).rejects.toBeInstanceOf(AcaoNaoPermitida);
    await expect(como(outroAntigo, "owner", () => alterarPapel(master.id, "admin"))).rejects.toBeInstanceOf(AcaoNaoPermitida);
    await expect(como(outroAntigo, "owner", () => desativarIntegrante(master.id))).rejects.toBeInstanceOf(AcaoNaoPermitida);
    await expect(como(admin, "admin", () => desativarIntegrante(antigo.id))).rejects.toBeInstanceOf(AcaoNaoPermitida);
    // Na lista, o "owner" antigo não é master.
    expect((await como(master, "owner", () => listIntegrantes())).find((u) => u.id === antigo.id)).toMatchObject({ role: "owner", master: false });

    const antes = await basePrisma.user.findUniqueOrThrow({ where: { id: antigo.id } });
    const r = await como(master, "owner", () => alterarPapel(antigo.id, "admin"));
    expect(r).toMatchObject({ role: "admin", master: false, permissoesEquipe: ["convidar", "desativar"] });
    expect((await getSessionState(antigo.id))?.sessionVersion).toBe(antes.sessionVersion + 1);
    // ...ou direto para membro.
    await expect(como(master, "owner", () => alterarPapel(outroAntigo.id, "member"))).resolves.toMatchObject({ role: "member", permissoesEquipe: [] });
  });

  it("administrador com 'excluir' exclui um membro, mas nunca mexe no master (excluir, desativar, rebaixar, senha, telas, ver tudo)", async () => {
    await como(master, "owner", () => definirPermissoesEquipe(admin.id, ["convidar", "desativar", "excluir"]));
    const membro = await pessoa(TEAM_A, "membro-sai", "member");
    await expect(como(admin, "admin", () => excluirIntegrante(membro.id, admin.id))).resolves.toHaveProperty("transferidos");
    expect(await basePrisma.user.findUnique({ where: { id: membro.id } })).toBeNull();

    await expect(como(admin, "admin", () => excluirIntegrante(master.id, admin.id))).rejects.toBeInstanceOf(AcaoNaoPermitida);
    await expect(como(admin, "admin", () => desativarIntegrante(master.id))).rejects.toBeInstanceOf(AcaoNaoPermitida);
    await expect(como(admin, "admin", () => alterarPapel(master.id, "member"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(admin, "admin", () => redefinirSenhaDeIntegrante(master.id, { hashSenha }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(admin, "admin", () => definirModulos(master.id, ["contatos"]))).rejects.toBeInstanceOf(AcaoNaoPermitida);
    await expect(como(admin, "admin", () => definirVerTudoEm(master.id, ["contatos"], ["contatos"]))).rejects.toBeInstanceOf(AcaoNaoPermitida);
    expect(await basePrisma.user.findUniqueOrThrow({ where: { id: master.id } })).toMatchObject({ role: "owner", desativadoEm: null, passwordHash: "hash:velha" });
    await como(master, "owner", () => definirPermissoesEquipe(admin.id, ["convidar", "desativar"]));
  });

  it("time antigo com vários 'owner' e sem master: ninguém mexe nos 'owner'; o script define o master, rebaixa os outros e (com a opção) passa os registros", async () => {
    // createdAt explícito: criados no mesmo milissegundo (CI rápida), o "mais
    // antigo" caía no desempate por id (aleatório) e o teste falhava às vezes.
    const base = Date.now() - 60_000;
    const c1 = await pessoa(TEAM_C, "c1-mais-antigo", "owner", { createdAt: new Date(base) });
    const c2 = await pessoa(TEAM_C, "c2-quem-criou", "owner", { createdAt: new Date(base + 1000) });
    const c3 = await pessoa(TEAM_C, "c3", "owner", { createdAt: new Date(base + 2000) });
    // O backfill de dono deu a base ao "owner" MAIS ANTIGO (c1), não a quem criou (c2).
    await basePrisma.contact.create({ data: { teamId: TEAM_C, nome: "Base do c1", ownerId: c1.id } });
    await basePrisma.flow.create({ data: { teamId: TEAM_C, nome: "Fluxo do c1", triggerType: "manual", createdById: c1.id } });
    await basePrisma.goal.create({ data: { teamId: TEAM_C, ownerId: c3.id, periodo: "2026-09", metaValor: 0, toquesPorDia: 0 } });
    // Registro de OUTRO time com o mesmo dono nunca é tocado (teamId explícito).
    await basePrisma.contact.create({ data: { teamId: TEAM_D, nome: "Alheio", ownerId: c1.id } });
    // Sem master definido: um "owner" não rebaixa o outro (não se inventa master).
    await expect(como(c1, "owner", () => alterarPapel(c2.id, "admin"), TEAM_C)).rejects.toBeInstanceOf(AcaoNaoPermitida);
    expect((await como(c1, "owner", () => listIntegrantes(), TEAM_C)).some((u) => u.master)).toBe(false);
    // Helper único: sem master definido, permissão = ninguém; quem recebe registro = o owner mais antigo.
    expect(await masterDefinidoDoTime(TEAM_C)).toBeNull();
    expect(await masterDoTime(TEAM_C)).toBe(c1.id);

    // Plano (só mostra): nada gravado.
    const plano = await planejarMaster(`  ${c2.email.toUpperCase()} `, { transferirRegistros: true });
    expect(plano).toMatchObject({ time: { id: TEAM_C, masterAtual: null }, master: { id: c2.id, mudaPapel: false }, nadaAFazer: false });
    expect(plano.rebaixar.map((r) => [r.id, r.registros.contatos, r.registros.fluxos, r.registros.metas])).toEqual([
      [c1.id, 1, 1, 0],
      [c3.id, 0, 0, 1],
    ]);
    expect((await basePrisma.team.findUniqueOrThrow({ where: { id: TEAM_C } })).masterId).toBeNull();

    const antesC1 = await basePrisma.user.findUniqueOrThrow({ where: { id: c1.id } });
    const antesC2 = await basePrisma.user.findUniqueOrThrow({ where: { id: c2.id } });
    const feito = await definirMaster(c2.email, { transferirRegistros: true });
    expect(feito.transferidos).toMatchObject({ contatos: 1, fluxos: 1, metas: 1, negocios: 0 });
    expect((await basePrisma.team.findUniqueOrThrow({ where: { id: TEAM_C } })).masterId).toBe(c2.id);
    expect(await masterDefinidoDoTime(TEAM_C)).toBe(c2.id);
    expect(await masterDoTime(TEAM_C)).toBe(c2.id);
    const depois = await basePrisma.user.findMany({ where: { teamId: TEAM_C }, orderBy: { createdAt: "asc" } });
    expect(depois.map((u) => [u.id, u.role])).toEqual([
      [c1.id, "admin"],
      [c2.id, "owner"],
      [c3.id, "admin"],
    ]);
    expect(depois.find((u) => u.id === c1.id)?.permissoesEquipe).toEqual(["convidar", "desativar"]);
    // Quem mudou de papel perde a sessão; o master (já era "owner") não.
    expect((await getSessionState(c1.id))?.sessionVersion).toBe(antesC1.sessionVersion + 1);
    expect((await getSessionState(c2.id))?.sessionVersion).toBe(antesC2.sessionVersion);
    // Os registros passaram para o master; o do outro time ficou onde estava.
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_C, ownerId: c2.id } })).toBe(1);
    expect(await basePrisma.flow.count({ where: { teamId: TEAM_C, createdById: c2.id } })).toBe(1);
    expect(await basePrisma.goal.count({ where: { teamId: TEAM_C, ownerId: c2.id } })).toBe(1);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_D, ownerId: c1.id } })).toBe(1);
    // Rodar de novo não faz nada; e-mail sem conta é recusado.
    expect((await definirMaster(c2.email)).nadaAFazer).toBe(true);
    await expect(planejarMaster(`ninguem-${sufixo}@equipe.dev`)).rejects.toBeInstanceOf(MasterInvalido);
    // Agora o master rebaixa quem quiser.
    await expect(como(c2, "owner", () => alterarPapel(c3.id, "viewer"), TEAM_C)).resolves.toMatchObject({ role: "viewer" });
  });

  it("sem a opção de transferir, o script só acerta os papéis: nenhum registro muda de dono", async () => {
    const d1 = await pessoa(TEAM_D, "d1", "owner");
    const d2 = await pessoa(TEAM_D, "d2", "owner");
    await basePrisma.contact.create({ data: { teamId: TEAM_D, nome: "Base do d1", ownerId: d1.id } });
    const feito = await definirMaster(d2.email);
    expect(feito.transferidos).toEqual({});
    expect((await basePrisma.team.findUniqueOrThrow({ where: { id: TEAM_D } })).masterId).toBe(d2.id);
    expect((await basePrisma.user.findUniqueOrThrow({ where: { id: d1.id } })).role).toBe("admin");
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_D, ownerId: d1.id } })).toBe(1);
  });

  it("o master é FIXO: não há 'passar o master' e nenhuma ação da tela troca o master do time", async () => {
    const c1 = await basePrisma.user.findFirstOrThrow({ where: { teamId: TEAM_C, name: "c1-mais-antigo" } });
    const c2 = await basePrisma.user.findFirstOrThrow({ where: { teamId: TEAM_C, name: "c2-quem-criou" } });
    const equipe = await import("./equipe");
    expect("transferirMaster" in equipe).toBe(false);
    // Nem virar "owner" pela tela, nem o master se rebaixar/desativar.
    await expect(como(c2, "owner", () => alterarPapel(c1.id, "owner"), TEAM_C)).rejects.toThrow();
    await expect(como(c2, "owner", () => alterarPapel(c2.id, "admin"), TEAM_C)).rejects.toBeInstanceOf(AcaoNaoPermitida);
    await expect(como(c2, "owner", () => desativarIntegrante(c2.id), TEAM_C)).rejects.toBeInstanceOf(AcaoNaoPermitida);
    // O ex-owner (agora administrador com convidar + desativar) não mexe no master.
    await expect(como(c1, "admin", () => desativarIntegrante(c2.id), TEAM_C)).rejects.toBeInstanceOf(AcaoNaoPermitida);
    await expect(como(c1, "admin", () => alterarPapel(c2.id, "member"), TEAM_C)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await basePrisma.team.findUniqueOrThrow({ where: { id: TEAM_C } })).masterId).toBe(c2.id);
  });
});
