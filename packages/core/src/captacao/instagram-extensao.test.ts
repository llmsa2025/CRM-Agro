import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { redisEstado } from "../shared/redis-cache";

// A fila `capture` (BullMQ) é mockada só para PROVAR que nada vai ao worker: o estado, os rascunhos,
// o Redis do relay e o banco são de verdade (de TESTE).
const adicionados: { nome: string; data: unknown }[] = [];
vi.mock("bullmq", () => ({
  Queue: class {
    async add(nome: string, data: unknown) {
      adicionados.push({ nome, data });
    }
  },
}));

import { connectSocialAccount } from "../social/service";
import { ForbiddenError } from "../auth/authz";
import { createRelayToken, verifyRelayToken } from "../relay/tokens";
import { agentesOnlineDoUsuario, registrarContasDoAgente, touchAgent, waitForJob, pushJob } from "../relay/hub";
import type { IgFollowersSpec, RelayJob } from "../relay/jobs";
import {
  CAPTURA_IG_PENDENTE_MS,
  CAPTURA_IG_SEM_SINAL_MS,
  CAPTURA_WORKER_SEM_SINAL_MS,
  CapturaEmAndamento,
  CapturaInstagramSoPelaExtensao,
  ContaInstagramNaoConectada,
  ExtensaoIndisponivel,
  LoteDeOutraPessoa,
  LoteEncerrado,
  LoteInexistente,
  PerfilInstagramInvalido,
  aoEntregarJobAExtensao,
  aoRecusarJobAExtensao,
  capturaAtualDaPessoa,
  capturaEmAndamento,
  draftDoSeguidorInstagram,
  enqueueCapture,
  iniciarCapturaInstagramPelaExtensao,
  lerRegistroIg,
  lerStatusCaptura,
  mensagemDaCaptura,
  registrarLoteDaExtensao,
  statusDaCapturaAtual,
  statusVivo,
  type LoteDaExtensao,
  type MotivoCaptura,
} from "./index";

/**
 * Captação de seguidores do Instagram PELA EXTENSÃO: começar a busca (para a extensão da própria pessoa,
 * sem cair no worker), recusar a segunda busca, receber os lotes da extensão (dedupe, limite, time e
 * dono do token), estado final com motivo, e a expiração de quem nunca pegou ou sumiu.
 * Banco e Redis de TESTE reais; a "extensão" é simulada com waitForJob e registrarLoteDaExtensao.
 */
const TEAM = "00000000-0000-0000-0000-0000000ec7a1";
const OUTRO = "00000000-0000-0000-0000-0000000ec7a2";
const ANA = "user-igext-ana";
const BIA = "user-igext-bia";
const CARLA = "user-igext-carla"; // de OUTRO time
const VISOR = "user-igext-visor";
const membro = (userId: string) => ({ userId, role: "member" });
const admin = (userId: string) => ({ userId, role: "admin" });

const sufixo = Math.random().toString(36).slice(2, 8);
let seq = 0;
const id = (p: string) => `${p}-${sufixo}-${seq++}`;

let contaAna = "";
let contaBia = "";

const como = <T>(teamId: string, quem: { userId: string; role: string }, fn: () => T) => runWithTeam(teamId, fn, quem);
const ligarExtensao = async (userId: string, accountId: string, agentId = id("ext")) => {
  await registrarContasDoAgente(TEAM, agentId, [accountId], userId);
  return agentId;
};
const iniciar = (quem = ANA, perfil = "@Fazenda.Boa", limite = 50) => como(TEAM, membro(quem), () => iniciarCapturaInstagramPelaExtensao({ perfil, limite }));

const item = (username: string, extra: Record<string, unknown> = {}) => ({ username, nome: `Nome ${username}`, ...extra });
const corpo = (lote: string, jobId: string, extra: Partial<LoteDaExtensao> = {}) => ({ lote, jobId, itens: [], ...extra });
const rascunhos = (teamId: string, lote: string) => basePrisma.prospectDraft.findMany({ where: { teamId, lote }, orderBy: { nome: "asc" } });

/** Começa uma busca e devolve o lote e o job que a extensão receberia. */
async function comecar(limite = 50, quem = ANA, conta = contaAna) {
  const ext = await ligarExtensao(quem, conta);
  const { lote } = await iniciar(quem, "@fazenda.boa", limite);
  const job = await waitForJob(TEAM, ext, 1500, quem);
  expect(job, "a extensão da pessoa recebe a tarefa").not.toBeNull();
  return { lote, job: job!, ext };
}

async function limparRedis() {
  const r = redisEstado();
  for (const padrao of [`captacao:*${TEAM}*`, `captacao:*${OUTRO}*`, `relay:*${TEAM}*`, `relay:*${OUTRO}*`]) {
    const chaves = await r.keys(padrao);
    if (chaves.length) await r.del(...chaves);
  }
}

beforeAll(async () => {
  for (const [tid, nome] of [[TEAM, "Time IG Ext A (test)"], [OUTRO, "Time IG Ext B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id: tid }, update: {}, create: { id: tid, name: nome } });
  }
  for (const [uid, teamId, role, nome] of [
    [ANA, TEAM, "member", "Ana IG"],
    [BIA, TEAM, "member", "Bia IG"],
    [CARLA, OUTRO, "member", "Carla IG"],
    [VISOR, TEAM, "viewer", "Visor IG"],
  ] as const) {
    await basePrisma.user.upsert({ where: { id: uid }, update: { teamId, role, name: nome }, create: { id: uid, teamId, role, name: nome, email: `${uid}@igext.test` } });
  }
  const r = redisEstado();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});

beforeEach(async () => {
  adicionados.length = 0;
  await limparRedis();
  await basePrisma.prospectDraft.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
  await basePrisma.relayAgentToken.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
  await basePrisma.channelAccount.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
  // Cada pessoa conecta o PRÓPRIO Instagram (é assim que a conta fica com o dono dela).
  await como(TEAM, admin(ANA), () => connectSocialAccount({ canal: "instagram", label: "@ana.vendas", cookie: "cookie-ana", username: "ana.vendas" }, { origem: "extensao" }));
  await como(TEAM, admin(BIA), () => connectSocialAccount({ canal: "instagram", label: "@bia.vendas", cookie: "cookie-bia", username: "bia.vendas" }, { origem: "extensao" }));
  const contas = await basePrisma.channelAccount.findMany({ where: { teamId: TEAM }, orderBy: { createdAt: "asc" } });
  contaAna = contas.find((c) => c.label === "@ana.vendas")!.id;
  contaBia = contas.find((c) => c.label === "@bia.vendas")!.id;
});

describe("começar a busca: vai para a extensão da própria pessoa, nunca para o worker", () => {
  it("cria o lote 'na fila' e entrega a tarefa `ig_followers` na fila DA CONTA, com validade e o @ esperado", async () => {
    const ext = await ligarExtensao(ANA, contaAna);
    const antes = Date.now();
    const { lote } = await iniciar(ANA, "@Fazenda.Boa", 999);
    const st = await lerStatusCaptura(TEAM, lote);
    expect(st).toMatchObject({ origem: "instagram", estado: "na_fila", total: 300, processados: 0, criados: 0 });
    const job = await waitForJob(TEAM, ext, 1500, ANA);
    expect(job).toMatchObject({ type: "ig_followers", teamId: TEAM });
    const spec = job!.spec as IgFollowersSpec;
    expect(spec).toMatchObject({ accountId: contaAna, expectedUsername: "ana.vendas", perfil: "fazenda.boa", limite: 300, lote });
    expect(job!.expiresAt).toBeGreaterThanOrEqual(antes + CAPTURA_IG_PENDENTE_MS - 1000);
    expect(job!.expiresAt).toBeLessThanOrEqual(Date.now() + CAPTURA_IG_PENDENTE_MS);
    // o registro do lote guarda quem pediu
    expect(await lerRegistroIg(TEAM, lote)).toMatchObject({ ownerId: ANA, accountId: contaAna, jobId: job!.id, limite: 300 });
  });

  it("NÃO usa o worker: nada entra na fila do BullMQ (caminho antigo, sem uso)", async () => {
    await ligarExtensao(ANA, contaAna);
    await iniciar();
    expect(adicionados).toHaveLength(0);
    await expect(enqueueCapture({ origem: "instagram", teamId: TEAM, lote: crypto.randomUUID(), accountId: contaAna, perfil: "x", limite: 10, ownerId: ANA })).rejects.toBeInstanceOf(CapturaInstagramSoPelaExtensao);
    expect(adicionados).toHaveLength(0);
  });

  it("sem extensão online: erro claro e acionável, e a busca NÃO fica pendurada nem cai no worker", async () => {
    const e = await iniciar().catch((x) => x);
    expect(e).toBeInstanceOf(ExtensaoIndisponivel);
    expect(e).toMatchObject({ causa: "offline", message: "Abra o Chrome com a extensão do CRM Agro ligada e tente de novo." });
    expect(adicionados).toHaveLength(0);
    // a vaga foi solta: com a extensão ligada, a mesma pessoa consegue
    await ligarExtensao(ANA, contaAna);
    await expect(iniciar()).resolves.toMatchObject({ lote: expect.any(String) });
  });

  it("a extensão de OUTRO usuário do time online não serve: a tarefa não vai para ela", async () => {
    await ligarExtensao(BIA, contaBia); // Bia ligou o Chrome dela; a Ana não
    const e = await iniciar(ANA).catch((x) => x);
    expect(e).toBeInstanceOf(ExtensaoIndisponivel);
    expect(e.causa).toBe("offline");
    // nada foi enfileirado para a conta da Ana, e a Bia não recebe a tarefa da Ana
    expect(await waitForJob(TEAM, "qualquer-agente-da-bia", 200, BIA)).toBeNull();
    expect(await agentesOnlineDoUsuario(TEAM, ANA)).toBe(0);
  });

  it("extensão da pessoa ligada, mas o Chrome não tem a conta do Instagram: diz isso, com o que fazer", async () => {
    await touchAgent(id("ext"), TEAM, ANA); // ligada, sem registrar a conta (não leu o @)
    const e = await iniciar(ANA).catch((x) => x);
    expect(e).toBeInstanceOf(ExtensaoIndisponivel);
    expect(e.causa).toBe("conta_ausente");
    expect(e.message).toContain("Entre no Instagram neste navegador");
  });

  it("Instagram não conectado, @ inválido e sem permissão", async () => {
    await basePrisma.channelAccount.deleteMany({ where: { teamId: TEAM, id: contaAna } });
    await expect(iniciar(ANA)).rejects.toBeInstanceOf(ContaInstagramNaoConectada);
    await ligarExtensao(BIA, contaBia);
    for (const ruim of ["", "a b", "https://evil.com/x", "x".repeat(31), "<script>"]) {
      await expect(iniciar(BIA, ruim), ruim).rejects.toBeInstanceOf(PerfilInstagramInvalido);
    }
    await expect(como(TEAM, { userId: VISOR, role: "viewer" }, () => iniciarCapturaInstagramPelaExtensao({ perfil: "x", limite: 5 }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("aceita @ com maiúscula, URL do perfil e limite fora da faixa (vira 1 a 300)", async () => {
    await ligarExtensao(ANA, contaAna);
    const { lote } = await iniciar(ANA, "https://www.instagram.com/Fazenda.Boa/?hl=pt", 0);
    expect(await lerRegistroIg(TEAM, lote)).toMatchObject({ perfil: "fazenda.boa", limite: 1 });
  });
});

describe("uma busca por vez (também no servidor)", () => {
  it("recusa a segunda enquanto a primeira anda: 'Já existe uma busca em andamento'", async () => {
    const ext = await ligarExtensao(ANA, contaAna);
    const { lote } = await iniciar();
    const e = await iniciar().catch((x) => x);
    expect(e).toBeInstanceOf(CapturaEmAndamento);
    expect(e.message).toBe("Já existe uma busca em andamento.");
    expect(e.status).toMatchObject({ lote, estado: "na_fila" });
    // só UMA tarefa foi entregue
    expect(await waitForJob(TEAM, ext, 1500, ANA)).not.toBeNull();
    expect(await waitForJob(TEAM, ext, 300, ANA)).toBeNull();
  });

  it("dois cliques ao mesmo tempo: só um passa (a reserva é atômica)", async () => {
    const ext = await ligarExtensao(ANA, contaAna);
    const r = await Promise.allSettled([iniciar(), iniciar(), iniciar()]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected" && x.reason instanceof CapturaEmAndamento)).toHaveLength(2);
    expect(await waitForJob(TEAM, ext, 1500, ANA)).not.toBeNull();
    expect(await waitForJob(TEAM, ext, 300, ANA)).toBeNull();
  });

  it("vale enquanto está 'rodando', e libera quando termina (concluída ou interrompida)", async () => {
    const { lote, job } = await comecar();
    await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(job));
    await expect(iniciar()).rejects.toBeInstanceOf(CapturaEmAndamento);
    await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("a1")], fim: { motivo: null } })));
    await ligarExtensao(ANA, contaAna);
    await expect(iniciar()).resolves.toBeTruthy();
  });

  it("é por pessoa dentro do time: a Bia busca ao mesmo tempo que a Ana, cada uma pela própria extensão", async () => {
    await ligarExtensao(ANA, contaAna);
    await ligarExtensao(BIA, contaBia);
    const a = await iniciar(ANA);
    const b = await iniciar(BIA);
    expect(a.lote).not.toBe(b.lote);
    expect(await lerRegistroIg(TEAM, b.lote)).toMatchObject({ ownerId: BIA, accountId: contaBia });
  });

  it("outro time não é afetado", async () => {
    await ligarExtensao(ANA, contaAna);
    await iniciar(ANA);
    expect(await como(OUTRO, membro(CARLA), () => capturaAtualDaPessoa("instagram"))).toBeNull();
  });
});

describe("a tarefa sai da fila para a extensão (poll)", () => {
  it("marca o lote 'rodando' quando o dono da busca a recebe", async () => {
    const { lote, job } = await comecar();
    expect(await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(job))).toBe(true);
    expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "rodando", iniciadoEm: expect.any(String) });
  });

  it("recusa entregar a quem não é o dono da busca (a extensão de um colega): o lote não muda", async () => {
    const { lote, job } = await comecar();
    expect(await como(TEAM, membro(BIA), () => aoEntregarJobAExtensao(job))).toBe(false);
    expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "na_fila" });
  });

  it("recusa job com id diferente do registrado, e o de outro time", async () => {
    const { lote, job } = await comecar();
    expect(await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao({ ...job, id: "outro-id" }))).toBe(false);
    expect(await como(OUTRO, membro(CARLA), () => aoEntregarJobAExtensao(job))).toBe(false);
    expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "na_fila" });
  });

  it("busca que já venceu ou terminou não é entregue", async () => {
    const { lote, job } = await comecar();
    await statusVivo(TEAM, lote, Date.now() + CAPTURA_IG_PENDENTE_MS + 60_000);
    expect(await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(job))).toBe(false);
  });

  it("uma tarefa ig_followers na fila do TIME (sem conta) nunca chega a uma extensão", async () => {
    const outraConta = id("conta");
    const ext = id("ext");
    await registrarContasDoAgente(TEAM, ext, [outraConta], BIA);
    const spec: IgFollowersSpec = { accountId: outraConta, expectedUsername: "x", perfil: "y", limite: 5, lote: crypto.randomUUID() };
    const job: RelayJob = { id: id("job"), teamId: TEAM, type: "ig_followers", spec, createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
    await pushJob(job); // fila do time: qualquer extensão do time a pegaria
    expect(await waitForJob(TEAM, ext, 300, BIA)).toBeNull();
  });

  it("tarefa de uma conta que caiu na fila de OUTRA conta também não é entregue", async () => {
    const contaX = id("contaX");
    const contaY = id("contaY");
    const ext = id("ext");
    await registrarContasDoAgente(TEAM, ext, [contaY], BIA);
    const spec: IgFollowersSpec = { accountId: contaX, expectedUsername: "x", perfil: "y", limite: 5, lote: crypto.randomUUID() };
    const job: RelayJob = { id: id("job"), teamId: TEAM, type: "ig_followers", spec, createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
    await redisEstado().lpush(`relay:queue:${TEAM}:${contaY}`, JSON.stringify(job));
    expect(await waitForJob(TEAM, ext, 300, BIA)).toBeNull();
  });

  it("tipo fora do catálogo é descartado no poll", async () => {
    const ext = id("ext");
    await pushJob({ id: id("job"), teamId: TEAM, type: "rm_rf" as never, spec: {} as never, createdAt: Date.now() });
    expect(await waitForJob(TEAM, ext, 300, ANA)).toBeNull();
  });
});

describe("lotes da extensão", () => {
  it("grava os perfis na fila da Captação: time e dono do token, origem instagram, nome e bio", async () => {
    const { lote, job } = await comecar();
    await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(job));
    const r = await como(TEAM, membro(ANA), () =>
      registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("cliente_1", { bio: "Soja e milho" }), { username: "cliente_2" }], lidos: 2 })),
    );
    expect(r).toEqual({ estado: "rodando", criados: 2, encerrada: false });
    const linhas = await rascunhos(TEAM, lote);
    expect(linhas.map((l) => [l.origem, l.teamId, l.ownerId, l.status])).toEqual([
      ["instagram", TEAM, ANA, "pendente"],
      ["instagram", TEAM, ANA, "pendente"],
    ]);
    expect(linhas.find((l) => l.nome === "Nome cliente_1")!.extra).toEqual({ username: "cliente_1", bio: "Soja e milho" });
    // sem nome, o @ é o nome (como o coletor do worker fazia)
    expect(linhas.find((l) => l.nome === "cliente_2")!.extra).toEqual({ username: "cliente_2" });
    expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "rodando", criados: 2, processados: 2, total: 50 });
    // a tela só vê a fila de quem pediu (F3)
    expect(await basePrisma.prospectDraft.count({ where: { teamId: TEAM, ownerId: BIA } })).toBe(0);
  });

  it("dedupe por @ no lote: o mesmo @ (com outra caixa) não entra duas vezes, e reenviar o lote não duplica", async () => {
    const { lote, job } = await comecar();
    const enviar = (itens: ReturnType<typeof item>[], lidos?: number) => como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens, ...(lidos ? { lidos } : {}) })));
    await enviar([item("Dup_1"), item("dup_1"), item("outro")]);
    expect(await rascunhos(TEAM, lote)).toHaveLength(2);
    // a resposta se perdeu e a extensão manda o MESMO lote de novo
    const r = await enviar([item("Dup_1"), item("outro")]);
    expect(r.criados).toBe(2);
    expect(await rascunhos(TEAM, lote)).toHaveLength(2);
    // outro lote com um @ novo e um repetido
    await enviar([item("dup_1"), item("novo")]);
    expect((await rascunhos(TEAM, lote)).map((l) => (l.extra as { username: string }).username).sort()).toEqual(["dup_1", "novo", "outro"]);
  });

  it("dois envios do mesmo lote ao mesmo tempo (retentativa que cruzou a resposta) não duplicam", async () => {
    const { lote, job } = await comecar();
    const itens = Array.from({ length: 20 }, (_, i) => item(`par_${i}`));
    const um = () => como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens })));
    await Promise.all([um(), um(), um()]);
    expect(await rascunhos(TEAM, lote)).toHaveLength(20);
    expect((await lerStatusCaptura(TEAM, lote))!.criados).toBe(20);
  });

  it("nunca grava mais do que o limite pedido", async () => {
    const { lote, job } = await comecar(5);
    const r = await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: Array.from({ length: 12 }, (_, i) => item(`lim_${i}`)), lidos: 12 })));
    expect(r.criados).toBe(5);
    expect(await rascunhos(TEAM, lote)).toHaveLength(5);
    // o progresso também não passa do limite
    expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ processados: 5, total: 5 });
    // mais um lote depois do limite não entra
    await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("passou")] })));
    expect(await rascunhos(TEAM, lote)).toHaveLength(5);
  });

  it("limpa o texto: controle vira espaço, nome e bio são cortados", async () => {
    const { lote, job } = await comecar();
    await como(TEAM, membro(ANA), () =>
      registrarLoteDaExtensao(corpo(lote, job.id, { itens: [{ username: "sujo_1", nome: `  Joao\u0000 \n da   Silva ${"x".repeat(300)}`, bio: `linha1\nlinha2 ${"y".repeat(500)}` }] })),
    );
    const [l] = await rascunhos(TEAM, lote);
    expect([...l!.nome].some((c) => c.charCodeAt(0) < 32)).toBe(false);
    expect(l!.nome.startsWith("Joao da Silva")).toBe(true);
    expect(l!.nome.length).toBeLessThanOrEqual(150);
    expect((l!.extra as { bio: string }).bio.length).toBeLessThanOrEqual(300);
    expect((l!.extra as { bio: string }).bio).not.toContain("\n");
  });

  it("renova a presença do agente quando o lote traz o agentId", async () => {
    const { lote, job } = await comecar();
    const outraExt = id("ext-novo");
    expect(await agentesOnlineDoUsuario(TEAM, ANA)).toBe(1);
    await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { agentId: outraExt })));
    await new Promise((r) => setTimeout(r, 100));
    expect(await agentesOnlineDoUsuario(TEAM, ANA)).toBe(2);
  });

  describe("SEGURANÇA: quem pode mandar lote", () => {
    it("token de OUTRO time não acha o lote (recusado) e nada é gravado", async () => {
      const { lote, job } = await comecar();
      const e = await como(OUTRO, membro(CARLA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("invasor")] }))).catch((x) => x);
      expect(e).toBeInstanceOf(LoteInexistente);
      expect(await basePrisma.prospectDraft.count({ where: { lote } })).toBe(0);
      expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "na_fila", criados: 0 });
    });

    it("de ponta a ponta com tokens de verdade: o token da Carla (outro time) é recusado e o da Ana entra", async () => {
      const { lote, job } = await comecar();
      const tokenAna = await como(TEAM, admin(ANA), () => createRelayToken({ label: "Notebook da Ana", userId: ANA }));
      const tokenCarla = await como(OUTRO, admin(CARLA), () => createRelayToken({ label: "Notebook da Carla", userId: CARLA }));
      const daCarla = (await verifyRelayToken(tokenCarla.token))!;
      const daAna = (await verifyRelayToken(tokenAna.token))!;
      expect(daCarla.teamId).toBe(OUTRO);
      await expect(runWithTeam(daCarla.teamId, () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("x1")] })), { userId: daCarla.userId!, role: daCarla.role! })).rejects.toBeInstanceOf(LoteInexistente);
      await runWithTeam(daAna.teamId, () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("x1")] })), { userId: daAna.userId!, role: daAna.role! });
      expect(await rascunhos(TEAM, lote)).toHaveLength(1);
    });

    it("outra pessoa do MESMO time (o token do colega) não manda lote para a busca da Ana", async () => {
      const { lote, job } = await comecar();
      const e = await como(TEAM, membro(BIA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("intruso")] }))).catch((x) => x);
      expect(e).toBeInstanceOf(LoteDeOutraPessoa);
      expect(await rascunhos(TEAM, lote)).toHaveLength(0);
    });

    it("admin do time também não: o lote é de quem pediu", async () => {
      const { lote, job } = await comecar();
      await expect(como(TEAM, admin(BIA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("adm")] })))).rejects.toBeInstanceOf(LoteDeOutraPessoa);
    });

    it("lote inexistente, e jobId que não é o da tarefa", async () => {
      const { lote, job } = await comecar();
      await expect(como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(crypto.randomUUID(), job.id)))).rejects.toBeInstanceOf(LoteInexistente);
      await expect(como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, "job-de-outra-tarefa", { itens: [item("z")] })))).rejects.toBeInstanceOf(LoteInexistente);
      expect(await rascunhos(TEAM, lote)).toHaveLength(0);
    });

    it("token só de leitura não grava", async () => {
      const { lote, job } = await comecar();
      await expect(como(TEAM, { userId: VISOR, role: "viewer" }, () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("v")] })))).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("sem identidade no contexto (sem pessoa), nada entra", async () => {
      const { lote, job } = await comecar();
      await expect(runWithTeam(TEAM, () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("s")] })), { userId: "", role: "member" })).rejects.toThrow();
      expect(await rascunhos(TEAM, lote)).toHaveLength(0);
    });

    it.each([
      ["@ com espaço", { itens: [{ username: "a b" }] }],
      ["@ com HTML", { itens: [{ username: "<img src=x>" }] }],
      ["@ grande demais", { itens: [{ username: "x".repeat(31) }] }],
      ["lote gigante (101)", { itens: Array.from({ length: 101 }, (_, i) => ({ username: `g_${i}` })) }],
      ["motivo desconhecido", { fim: { motivo: "hackeado" } }],
      ["motivo que o servidor não aceita da extensão", { fim: { motivo: "sem_resultados" } }],
      ["lidos negativo", { lidos: -1 }],
      ["lidos que não é número", { lidos: "muitos" }],
    ])("payload inválido (%s) é recusado e nada é gravado", async (_nome, extra) => {
      const { lote, job } = await comecar();
      await expect(como(TEAM, membro(ANA), () => registrarLoteDaExtensao({ ...corpo(lote, job.id), ...extra }))).rejects.toThrow();
      expect(await rascunhos(TEAM, lote)).toHaveLength(0);
      expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "na_fila" });
    });

    it("lote que não é uuid nem chega a procurar", async () => {
      await expect(como(TEAM, membro(ANA), () => registrarLoteDaExtensao({ lote: "../../etc", jobId: "x", itens: [] }))).rejects.toThrow();
    });
  });

  describe("estado final, com motivo", () => {
    it("terminou com perfis: 'concluída', sem motivo", async () => {
      const { lote, job } = await comecar();
      const r = await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("f1"), item("f2")], lidos: 2, fim: { motivo: null } })));
      expect(r).toEqual({ estado: "concluida", criados: 2, encerrada: true });
      expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "concluida", motivo: null, mensagem: null, criados: 2, processados: 2 });
    });

    it("terminou sem nenhum perfil: 'vazia' (não é sucesso)", async () => {
      const { lote, job } = await comecar();
      await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { lidos: 0, fim: { motivo: null } })));
      expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "vazia", motivo: "sem_resultados", mensagem: "O perfil não tem seguidores visíveis." });
    });

    it.each<[MotivoCaptura, RegExp]>([
      ["limite_instagram", /O Instagram pediu para esperar/],
      ["sessao_instagram", /Entre de novo no Instagram/],
      ["perfil_nao_encontrado", /Perfil não encontrado/],
      ["perfil_privado", /Este perfil é privado/],
      ["cota_diaria", /limite de leituras do dia/],
      ["conta_errada", /outra conta do Instagram/],
      ["extensao_offline", /Abra o Chrome com a extensão ligada/],
      ["tempo_esgotado", /passou do tempo máximo/],
    ])("parou por %s: 'interrompida' com o motivo e a mensagem pronta", async (motivo, mensagem) => {
      const { lote, job } = await comecar();
      await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("p1")], lidos: 1, fim: { motivo: motivo as never } })));
      const st = await lerStatusCaptura(TEAM, lote);
      expect(st).toMatchObject({ estado: "interrompida", motivo, criados: 1 });
      expect(st!.mensagem).toMatch(mensagem);
      // parou no meio, o que veio está na fila
      expect(await rascunhos(TEAM, lote)).toHaveLength(1);
    });

    it("interrompida sem nenhum perfil também é 'interrompida' (com criados 0)", async () => {
      const { lote, job } = await comecar();
      await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { fim: { motivo: "sessao_instagram" } })));
      expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "interrompida", motivo: "sessao_instagram", criados: 0 });
    });

    it("erro traz o detalhe limpo e curto; a espera só vale no futuro e até 48 h", async () => {
      const { lote, job } = await comecar();
      const futuro = Date.now() + 3_600_000;
      await como(TEAM, membro(ANA), () =>
        registrarLoteDaExtensao(corpo(lote, job.id, { fim: { motivo: "erro", detalhe: `falha\u0000 ${"z".repeat(300)}`, tentarDepoisDe: futuro } })),
      );
      const st = (await lerStatusCaptura(TEAM, lote))!;
      expect(st.mensagem).toMatch(/^A busca parou por um erro \(falha z+/);
      expect(st.mensagem!.length).toBeLessThan(200);
      expect(st.tentarDepoisDe).toBeUndefined(); // espera só entra para 429 e sessão
    });

    it("tentarDepoisDe: no passado é ignorado, no futuro distante é cortado em 48 h", async () => {
      for (const [depois, confere] of [
        [Date.now() - 1000, (v: string | null | undefined) => expect(v).toBeUndefined()],
        [Date.now() + 90 * 24 * 3_600_000, (v: string | null | undefined) => expect(Date.parse(v!)).toBeLessThanOrEqual(Date.now() + 48 * 3_600_000 + 1000)],
        [Date.now() + 3_600_000, (v: string | null | undefined) => expect(Date.parse(v!)).toBeGreaterThan(Date.now() + 3_000_000)],
      ] as const) {
        await limparRedis();
        const { lote, job } = await comecar();
        await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { fim: { motivo: "limite_instagram", tentarDepoisDe: depois } })));
        confere((await lerStatusCaptura(TEAM, lote))!.tentarDepoisDe);
      }
    });

    it("depois do fim: mais perfis são recusados, e o mesmo fim repetido só confirma", async () => {
      const { lote, job } = await comecar();
      await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("u1")], fim: { motivo: null } })));
      await expect(como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("u2")] })))).rejects.toBeInstanceOf(LoteEncerrado);
      expect(await rascunhos(TEAM, lote)).toHaveLength(1);
      const de_novo = await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("u1")], fim: { motivo: null } })));
      expect(de_novo).toMatchObject({ estado: "concluida", criados: 1, encerrada: true });
      expect(await rascunhos(TEAM, lote)).toHaveLength(1);
    });
  });
});

describe("a extensão devolve a tarefa com erro, sem lotes", () => {
  const recusar = (quem: string, jobId: string, erro: string, teamId = TEAM) => como(teamId, membro(quem), () => aoRecusarJobAExtensao(jobId, erro));

  it("extensão antiga (não conhece ig_followers, responde not_implemented): a busca fecha como 'extensão desatualizada'", async () => {
    const { lote, job } = await comecar();
    await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(job));
    await recusar(ANA, job.id, "not_implemented");
    const st = await lerStatusCaptura(TEAM, lote);
    expect(st).toMatchObject({ estado: "interrompida", motivo: "extensao_desatualizada" });
    expect(st!.mensagem).toMatch(/desatualizada.*Extensão do navegador/);
    // o botão volta: dá para buscar de novo depois de atualizar
    await ligarExtensao(ANA, contaAna);
    await expect(iniciar()).resolves.toBeTruthy();
  });

  it("recusa antes de começar: tarefa vencida vira 'extensão não respondeu'; recusa da spec vira erro com o motivo", async () => {
    const a = await comecar();
    await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(a.job));
    await recusar(ANA, a.job.id, "expirada");
    expect(await lerStatusCaptura(TEAM, a.lote)).toMatchObject({ estado: "interrompida", motivo: "extensao_offline" });

    await limparRedis();
    const b = await comecar();
    await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(b.job));
    await recusar(ANA, b.job.id, "spec_invalida");
    const st = await lerStatusCaptura(TEAM, b.lote);
    expect(st).toMatchObject({ estado: "interrompida", motivo: "erro" });
    expect(st!.mensagem).toContain("a extensão recusou a tarefa");
  });

  it("o motivo que a extensão não conseguiu mandar no fim (rede fora na hora) vale como o motivo da parada", async () => {
    const { lote, job } = await comecar();
    await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(job));
    await recusar(ANA, job.id, "limite_instagram");
    expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "interrompida", motivo: "limite_instagram" });
  });

  it("SEGURANÇA: só o dono da busca fecha; colega e outro time não conseguem", async () => {
    const { lote, job } = await comecar();
    await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(job));
    await recusar(BIA, job.id, "not_implemented");
    await recusar(CARLA, job.id, "not_implemented", OUTRO);
    expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "rodando", motivo: null });
  });

  it("busca que já terminou não muda (o erro do resultado depois de um fim normal não estraga o estado)", async () => {
    const { lote, job } = await comecar();
    await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(job));
    await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("z1")], fim: { motivo: null } })));
    await recusar(ANA, job.id, "not_implemented");
    expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "concluida", motivo: null, criados: 1 });
  });

  it("job que não é de busca do Instagram, ou nunca entregue, é ignorado", async () => {
    const { lote } = await comecar();
    await recusar(ANA, "job-qualquer", "not_implemented");
    expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "na_fila" });
  });
});

describe("expiração: quem nunca pegou a tarefa ou sumiu no meio", () => {
  it("ninguém pegou em 10 min: 'interrompida' com motivo extensao_offline, e a tarefa SAI da fila", async () => {
    const ext = await ligarExtensao(ANA, contaAna);
    const { lote } = await iniciar();
    // dentro do prazo continua na fila
    expect((await statusVivo(TEAM, lote, Date.now() + CAPTURA_IG_PENDENTE_MS - 5_000))!.estado).toBe("na_fila");
    const st = await statusVivo(TEAM, lote, Date.now() + CAPTURA_IG_PENDENTE_MS + 5_000);
    expect(st).toMatchObject({ estado: "interrompida", motivo: "extensao_offline", criados: 0 });
    expect(st!.mensagem).toBe("A extensão do CRM Agro não respondeu. Abra o Chrome com a extensão ligada e tente de novo.");
    // fica gravado (não é só na resposta)
    expect(await lerStatusCaptura(TEAM, lote)).toMatchObject({ estado: "interrompida", motivo: "extensao_offline" });
    // uma extensão que abrir depois NÃO executa a busca vencida
    expect(await waitForJob(TEAM, ext, 300, ANA)).toBeNull();
  });

  it("depois de vencer, a pessoa pode buscar de novo (o botão volta)", async () => {
    await ligarExtensao(ANA, contaAna);
    const { lote } = await iniciar();
    await expect(iniciar()).rejects.toBeInstanceOf(CapturaEmAndamento);
    // simula o passar do tempo editando o instante do status (a extensão nunca pegou)
    const st = (await lerStatusCaptura(TEAM, lote))!;
    st.atualizadoEm = new Date(Date.now() - CAPTURA_IG_PENDENTE_MS - 60_000).toISOString();
    await redisEstado().set(`captacao:status:${TEAM}:${lote}`, JSON.stringify(st), "EX", 600);
    await expect(iniciar()).resolves.toMatchObject({ lote: expect.any(String) });
  });

  it("rodando e sem sinal há 5 min: 'interrompida' com o que já veio; com sinal recente, segue", async () => {
    const { lote, job } = await comecar();
    await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(job));
    await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("m1"), item("m2"), item("m3")], lidos: 3 })));
    expect((await statusVivo(TEAM, lote, Date.now() + CAPTURA_IG_SEM_SINAL_MS - 5_000))!.estado).toBe("rodando");
    const st = await statusVivo(TEAM, lote, Date.now() + CAPTURA_IG_SEM_SINAL_MS + 5_000);
    expect(st).toMatchObject({ estado: "interrompida", motivo: "extensao_offline", criados: 3 });
    // a extensão que volta depois do prazo não consegue mais mandar (o lote já acabou)
    await expect(como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("tarde")] })))).rejects.toBeInstanceOf(LoteEncerrado);
    expect(await rascunhos(TEAM, lote)).toHaveLength(3);
  });

  it("a extensão que manda lote mantém a busca viva (cada lote renova o sinal)", async () => {
    const { lote, job } = await comecar();
    await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(job));
    await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { lidos: 1 })));
    const st = (await lerStatusCaptura(TEAM, lote))!;
    expect(capturaEmAndamento(st, Date.now() + 60_000)).toBe(true);
  });

  it("a leitura do status de OUTRO time não fecha nem mostra a busca", async () => {
    await ligarExtensao(ANA, contaAna);
    const { lote } = await iniciar();
    expect(await como(OUTRO, membro(CARLA), () => statusDaCapturaAtual(lote))).toBeNull();
    expect(await como(TEAM, membro(ANA), () => statusDaCapturaAtual(lote))).toMatchObject({ estado: "na_fila", origem: "instagram" });
  });
});

describe("o que a tela lê: busca atual da pessoa", () => {
  it("andando: emAndamento verdadeiro, com o progresso; terminou: falso, com o motivo", async () => {
    const { lote, job } = await comecar();
    expect(await como(TEAM, membro(ANA), () => capturaAtualDaPessoa("instagram"))).toMatchObject({ emAndamento: true, status: { lote, estado: "na_fila", total: 50 } });
    await como(TEAM, membro(ANA), () => aoEntregarJobAExtensao(job));
    await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { itens: [item("t1")], lidos: 1 })));
    expect(await como(TEAM, membro(ANA), () => capturaAtualDaPessoa("instagram"))).toMatchObject({ emAndamento: true, status: { estado: "rodando", processados: 1 } });
    await como(TEAM, membro(ANA), () => registrarLoteDaExtensao(corpo(lote, job.id, { fim: { motivo: "limite_instagram" } })));
    expect(await como(TEAM, membro(ANA), () => capturaAtualDaPessoa("instagram"))).toMatchObject({ emAndamento: false, status: { estado: "interrompida", motivo: "limite_instagram" } });
  });

  it("é da pessoa: a Bia não vê a busca da Ana, e nunca buscou → null", async () => {
    await comecar();
    expect(await como(TEAM, membro(BIA), () => capturaAtualDaPessoa("instagram"))).toBeNull();
    expect(await como(TEAM, membro(ANA), () => capturaAtualDaPessoa("maps"))).toBeNull();
  });

  it("Maps e CNPJ (worker): o ponteiro nasce no enqueue e a tela vê 'na fila' com o total", async () => {
    const lote = crypto.randomUUID();
    await como(TEAM, membro(ANA), () => enqueueCapture({ origem: "maps", teamId: TEAM, lote, termo: "agropecuária", limite: 40, ownerId: ANA }));
    expect(adicionados).toHaveLength(1); // o Maps continua indo para o worker
    expect(await como(TEAM, membro(ANA), () => capturaAtualDaPessoa("maps"))).toMatchObject({ emAndamento: true, status: { lote, origem: "maps", estado: "na_fila", total: 40 } });
    expect(await como(TEAM, membro(BIA), () => capturaAtualDaPessoa("maps"))).toBeNull();
  });

  it("status de worker que ficou para trás (30 min sem sinal) não prende o botão", () => {
    const st = { estado: "rodando" as const, origem: "maps" as const, atualizadoEm: new Date(Date.now() - CAPTURA_WORKER_SEM_SINAL_MS - 1000).toISOString() };
    expect(capturaEmAndamento(st, Date.now())).toBe(false);
    expect(capturaEmAndamento({ ...st, atualizadoEm: new Date().toISOString() }, Date.now())).toBe(true);
    expect(capturaEmAndamento({ ...st, estado: "concluida" as never, atualizadoEm: new Date().toISOString() }, Date.now())).toBe(false);
    expect(capturaEmAndamento({ ...st, atualizadoEm: "lixo" }, Date.now())).toBe(false);
  });
});

describe("mensagens e mapeamento", () => {
  const motivos: MotivoCaptura[] = [
    "bloqueio_google", "tempo_esgotado", "limite_instagram", "sessao_instagram", "perfil_nao_encontrado", "perfil_privado",
    "interrompida", "sem_resultados", "extensao_offline", "extensao_desatualizada", "cota_diaria", "conta_errada", "erro",
  ];
  it("todo motivo tem texto, sem travessão nem meia-risca, e o CRM Agro é masculino", () => {
    for (const m of motivos) for (const via of ["servidor", "extensao"] as const) {
      const t = mensagemDaCaptura(m, "instagram", "detalhe", via);
      expect(t.length, m).toBeGreaterThan(10);
      expect(t, m).not.toMatch(/[—–]|\ba CRM Agro\b/);
    }
  });
  it("o caminho antigo (servidor) mantém o texto de reconectar; o da extensão manda entrar no Instagram", () => {
    expect(mensagemDaCaptura("sessao_instagram", "instagram")).toMatch(/Reconecte a conta/);
    expect(mensagemDaCaptura("sessao_instagram", "instagram", null, "extensao")).toMatch(/Entre de novo no Instagram/);
  });
  it("seguidor do Instagram vira rascunho com o mesmo formato do worker", () => {
    expect(draftDoSeguidorInstagram({ username: "ana", nome: " Ana Lima ", bio: " oi ", telefone: null, email: null })).toEqual({
      nome: "Ana Lima", telefone: null, email: null, extra: { username: "ana", bio: "oi" },
    });
    expect(draftDoSeguidorInstagram({ username: "ana" })).toEqual({ nome: "ana", telefone: null, email: null, extra: { username: "ana" } });
  });
});
