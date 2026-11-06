import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { basePrisma, db, estaCifrado, runAsSystem } from "@crmagro/db";
import { runWithTeam } from "../../test-support/identidade";
import { ForbiddenError } from "../../auth/authz";
import { OwnedNotFound } from "../../tenancy/assert-owned";
import { descritorDeTeste, entradaDeTeste } from "../provedor/apoio-de-teste";
import { ProvedorDeLigacaoNaoRegistrado, criarRegistroDeLigacao } from "../provedor/registro";
import {
  ConflitoNaLinhaPadrao,
  LinhaDeLigacaoDesativada,
  LinhaDeLigacaoInvalida,
  LinhaDeLigacaoJaCadastrada,
  LinhaDeLigacaoNaoEncontrada,
  LinhaDeLigacaoSemDono,
  SemLinhaParaLigar,
  criarLinha,
  definirLinhaPadrao,
  linhaParaLigar,
  listarLinhas,
  pausarLinha,
  reativarLinha,
  type CriarLinhaDeLigacaoInput,
} from "./linhas";

/**
 * Linhas de ligação (F1B-05). Banco de TESTE, dois times, sem provedor real: o registro dos testes tem um
 * provedor de brinquedo (`teste_um`), com um campo secreto e um campo comum de escopo "linha".
 */

const TEAM_A = "00000000-0000-0000-0000-0000f1b050a1";
const TEAM_B = "00000000-0000-0000-0000-0000f1b050b1";
const TIMES = [TEAM_A, TEAM_B];
const ADMIN_A = "00000000-0000-0000-0000-0000f1b050a2";
const ANA_A = "00000000-0000-0000-0000-0000f1b050a3"; // vendedora (member)
const BIA_A = "00000000-0000-0000-0000-0000f1b050a4"; // vendedora (member)
const DONO_B = "00000000-0000-0000-0000-0000f1b050b2";
const CONTA = "conta-f1b05";

const registro = criarRegistroDeLigacao();
registro.registrar(entradaDeTeste("teste_um"));
// Um provedor cuja linha não tem campo de credencial (só a conta tem): a linha pode nascer sem credenciais.
registro.registrar({
  ...entradaDeTeste("teste_sem_linha"),
  descritor: descritorDeTeste("teste_sem_linha", { campos: descritorDeTeste().campos.filter((c) => c.escopo === "conta") }),
});
const opcoes = { registro };

const comoAdminA = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_A, fn, { userId: ADMIN_A, role: "admin" });
const comoAna = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_A, fn, { userId: ANA_A, role: "member" });
const comoViewerA = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_A, fn, { userId: BIA_A, role: "viewer" });
const comoDonoB = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_B, fn, { userId: DONO_B, role: "owner" });

let idSeq = 0;
/** Dados de uma linha nova, com `idExterno` único dentro do teste e as credenciais obrigatórias do provedor de teste. */
function nova(troca: Partial<CriarLinhaDeLigacaoInput> = {}): CriarLinhaDeLigacaoInput {
  idSeq += 1;
  return {
    provedor: "teste_um",
    tipo: "ramal",
    contaExterna: CONTA,
    idExterno: `10${idSeq}`,
    credenciais: { ramal: `10${idSeq}`, senhaDoRamal: "senha-do-ramal-123" },
    ...troca,
  };
}

async function limpar() {
  await basePrisma.call.deleteMany({ where: { teamId: { in: TIMES } } });
  await basePrisma.linhaDeLigacao.deleteMany({ where: { teamId: { in: TIMES } } });
  await basePrisma.integration.deleteMany({ where: { teamId: { in: TIMES } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: TIMES } } });
}

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Linhas A (f1b-05)"],
    [TEAM_B, "Linhas B (f1b-05)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
  for (const [id, teamId, nome, role] of [
    [ADMIN_A, TEAM_A, "Admin A", "admin"],
    [ANA_A, TEAM_A, "Ana", "member"],
    [BIA_A, TEAM_A, "Bia", "viewer"],
    [DONO_B, TEAM_B, "Dono B", "owner"],
  ] as const) {
    await basePrisma.user.upsert({
      where: { id },
      update: { teamId },
      create: { id, teamId, name: nome, email: `${id}@linhas-f1b05.teste.local`, role },
    });
  }
});

beforeEach(limpar);
afterAll(limpar);

describe("dois times", () => {
  it("o time B não lista, pausa, reativa, promove nem escolhe a linha do time A, e a linha de A fica intacta", async () => {
    const a = await comoAdminA(() => criarLinha(nova({ userId: ANA_A }), opcoes));

    expect(await comoDonoB(() => listarLinhas({}, opcoes))).toEqual([]);
    await expect(comoDonoB(() => pausarLinha(a.id, { motivo: "invasão" }, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoNaoEncontrada);
    await expect(comoDonoB(() => reativarLinha(a.id, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoNaoEncontrada);
    await expect(comoDonoB(() => definirLinhaPadrao(a.id, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoNaoEncontrada);
    const erro = await comoDonoB(() => linhaParaLigar(DONO_B, a.id)).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(SemLinhaParaLigar);
    expect((erro as SemLinhaParaLigar).motivo).toBe("linha_indisponivel");

    const depois = await basePrisma.linhaDeLigacao.findUniqueOrThrow({ where: { id: a.id } });
    expect(depois).toMatchObject({ teamId: TEAM_A, estado: "ativa", padrao: false, motivoPausa: null });
  });

  it("o mesmo idExterno não entra em dois times, e a resposta não diz de quem é", async () => {
    const entrada = nova();
    await comoAdminA(() => criarLinha(entrada, opcoes));
    const erro = await comoDonoB(() => criarLinha(entrada, opcoes)).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LinhaDeLigacaoJaCadastrada);
    expect((erro as Error).message).toBe("Essa linha já está cadastrada.");
    expect(await basePrisma.linhaDeLigacao.count({ where: { teamId: TEAM_B } })).toBe(0);
    // No próprio time a repetição tem a mesma resposta.
    await expect(comoAdminA(() => criarLinha(entrada, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoJaCadastrada);
  });

  it("criar com userId ou integrationId do outro time é recusado e não grava nada", async () => {
    const integracaoB = await basePrisma.integration.create({ data: { teamId: TEAM_B, tipo: "webhook" } });
    await expect(comoAdminA(() => criarLinha(nova({ userId: DONO_B }), opcoes))).rejects.toBeInstanceOf(OwnedNotFound);
    await expect(comoAdminA(() => criarLinha(nova({ integrationId: integracaoB.id }), opcoes))).rejects.toBeInstanceOf(OwnedNotFound);
    expect(await basePrisma.linhaDeLigacao.count({ where: { teamId: { in: TIMES } } })).toBe(0);
  });

  it("teamId no corpo da criação é recusado (o time vem do contexto, nunca do corpo)", async () => {
    const entrada = { ...nova(), teamId: TEAM_B } as unknown as CriarLinhaDeLigacaoInput;
    await expect(comoAdminA(() => criarLinha(entrada, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoInvalida);
    expect(await basePrisma.linhaDeLigacao.count({ where: { teamId: TEAM_B } })).toBe(0);
  });
});

describe("linha padrão: uma por pessoa", () => {
  it("definir outra padrão tira a anterior, na criação e na troca", async () => {
    const l1 = await comoAdminA(() => criarLinha(nova({ userId: ANA_A, padrao: true }), opcoes));
    expect(l1.padrao).toBe(true);
    const l2 = await comoAdminA(() => criarLinha(nova({ userId: ANA_A, padrao: true }), opcoes));
    expect(l2.padrao).toBe(true);

    const padroes = async () =>
      (await basePrisma.linhaDeLigacao.findMany({ where: { userId: ANA_A, padrao: true }, select: { id: true } })).map((l) => l.id);
    expect(await padroes()).toEqual([l2.id]);

    const trocada = await comoAdminA(() => definirLinhaPadrao(l1.id, opcoes));
    expect(trocada.padrao).toBe(true);
    expect(await padroes()).toEqual([l1.id]);
  });

  it("a padrão de uma pessoa não mexe na padrão de outra", async () => {
    const ana = await comoAdminA(() => criarLinha(nova({ userId: ANA_A, padrao: true }), opcoes));
    const bia = await comoAdminA(() => criarLinha(nova({ userId: BIA_A, padrao: true }), opcoes));
    expect(await basePrisma.linhaDeLigacao.count({ where: { id: { in: [ana.id, bia.id] }, padrao: true } })).toBe(2);
  });

  it("o banco recusa duas padrão para a mesma pessoa (índice único parcial)", async () => {
    const l1 = await comoAdminA(() => criarLinha(nova({ userId: ANA_A, padrao: true }), opcoes));
    const l2 = await comoAdminA(() => criarLinha(nova({ userId: ANA_A }), opcoes));
    expect(l1.padrao).toBe(true);
    await expect(basePrisma.linhaDeLigacao.update({ where: { id: l2.id }, data: { padrao: true } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("padrão sem dono é recusada, na criação e na troca", async () => {
    await expect(comoAdminA(() => criarLinha(nova({ padrao: true }), opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoInvalida);
    const doTime = await comoAdminA(() => criarLinha(nova(), opcoes));
    await expect(comoAdminA(() => definirLinhaPadrao(doTime.id, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoSemDono);
  });

  it("criar uma linha repetida já como padrão é recusado como repetida e não tira a padrão que existia", async () => {
    const antiga = await comoAdminA(() => criarLinha(nova({ userId: ANA_A, padrao: true }), opcoes));
    const entrada = nova({ userId: ANA_A });
    await comoAdminA(() => criarLinha(entrada, opcoes));
    await expect(comoAdminA(() => criarLinha({ ...entrada, padrao: true }, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoJaCadastrada);
    expect((await basePrisma.linhaDeLigacao.findUniqueOrThrow({ where: { id: antiga.id } })).padrao).toBe(true);
  });

  it("duas trocas ao mesmo tempo: no máximo uma padrão no fim, e quem perde leva o conflito nomeado", async () => {
    const l1 = await comoAdminA(() => criarLinha(nova({ userId: ANA_A }), opcoes));
    const l2 = await comoAdminA(() => criarLinha(nova({ userId: ANA_A }), opcoes));
    const resultados = await Promise.allSettled([comoAdminA(() => definirLinhaPadrao(l1.id, opcoes)), comoAdminA(() => definirLinhaPadrao(l2.id, opcoes))]);
    for (const r of resultados) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflitoNaLinhaPadrao);
    expect(await basePrisma.linhaDeLigacao.count({ where: { userId: ANA_A, padrao: true } })).toBe(1);
  });
});

describe("linhaParaLigar", () => {
  it("usa a padrão da pessoa", async () => {
    await comoAdminA(() => criarLinha(nova({ userId: ANA_A }), opcoes));
    const padrao = await comoAdminA(() => criarLinha(nova({ userId: ANA_A, padrao: true }), opcoes));
    await comoAdminA(() => criarLinha(nova(), opcoes)); // linha do time também existe
    const escolhida = await comoAna(() => linhaParaLigar(ANA_A));
    expect(escolhida.id).toBe(padrao.id);
  });

  it("sem padrão, usa a única linha ativa do time sem dono", async () => {
    const doTime = await comoAdminA(() => criarLinha(nova(), opcoes));
    await comoAdminA(() => criarLinha(nova({ userId: BIA_A }), opcoes)); // linha de outra pessoa não conta
    const escolhida = await comoAna(() => linhaParaLigar(ANA_A));
    expect(escolhida.id).toBe(doTime.id);
  });

  it("sem padrão e sem linha do time, ou com mais de uma, devolve o erro nomeado com o motivo", async () => {
    const motivoDe = async () => ((await comoAna(() => linhaParaLigar(ANA_A)).catch((e: unknown) => e)) as SemLinhaParaLigar);
    const semNenhuma = await motivoDe();
    expect(semNenhuma).toBeInstanceOf(SemLinhaParaLigar);
    expect(semNenhuma.motivo).toBe("sem_linha");

    await comoAdminA(() => criarLinha(nova(), opcoes));
    const segunda = await comoAdminA(() => criarLinha(nova(), opcoes));
    expect((await motivoDe()).motivo).toBe("varias_linhas_do_time");

    // Pausar uma das duas deixa só uma ativa: volta a funcionar.
    await comoAdminA(() => pausarLinha(segunda.id, { motivo: "teste" }, opcoes));
    await expect(comoAna(() => linhaParaLigar(ANA_A))).resolves.toMatchObject({ userId: null });
  });

  it("padrão pausada não cai para a linha do time", async () => {
    const padrao = await comoAdminA(() => criarLinha(nova({ userId: ANA_A, padrao: true }), opcoes));
    await comoAdminA(() => criarLinha(nova(), opcoes));
    await comoAdminA(() => pausarLinha(padrao.id, { motivo: "limite do dia" }, opcoes));
    const erro = (await comoAna(() => linhaParaLigar(ANA_A)).catch((e: unknown) => e)) as SemLinhaParaLigar;
    expect(erro).toBeInstanceOf(SemLinhaParaLigar);
    expect(erro.motivo).toBe("linha_inativa");
    // Reativada, volta.
    await comoAdminA(() => reativarLinha(padrao.id, opcoes));
    expect((await comoAna(() => linhaParaLigar(ANA_A))).id).toBe(padrao.id);
  });

  it("com linhaId: a própria e a do time servem; a de outra pessoa, a pausada e a desativada não", async () => {
    const minha = await comoAdminA(() => criarLinha(nova({ userId: ANA_A }), opcoes));
    const doTime = await comoAdminA(() => criarLinha(nova(), opcoes));
    const daBia = await comoAdminA(() => criarLinha(nova({ userId: BIA_A }), opcoes));
    expect((await comoAna(() => linhaParaLigar(ANA_A, minha.id))).id).toBe(minha.id);
    expect((await comoAna(() => linhaParaLigar(ANA_A, doTime.id))).id).toBe(doTime.id);

    const alheia = (await comoAna(() => linhaParaLigar(ANA_A, daBia.id)).catch((e: unknown) => e)) as SemLinhaParaLigar;
    expect(alheia.motivo).toBe("linha_indisponivel");

    await comoAdminA(() => pausarLinha(minha.id, { motivo: "teste" }, opcoes));
    expect(((await comoAna(() => linhaParaLigar(ANA_A, minha.id)).catch((e: unknown) => e)) as SemLinhaParaLigar).motivo).toBe("linha_inativa");

    await basePrisma.linhaDeLigacao.update({ where: { id: doTime.id }, data: { estado: "desativada" } });
    expect(((await comoAna(() => linhaParaLigar(ANA_A, doTime.id)).catch((e: unknown) => e)) as SemLinhaParaLigar).motivo).toBe("linha_inativa");
  });

  it("estado desconhecido no banco não liga", async () => {
    const l = await comoAdminA(() => criarLinha(nova({ userId: ANA_A, padrao: true }), opcoes));
    await basePrisma.linhaDeLigacao.update({ where: { id: l.id }, data: { estado: "misterio" } });
    await expect(comoAna(() => linhaParaLigar(ANA_A))).rejects.toBeInstanceOf(SemLinhaParaLigar);
    const [vista] = await comoAdminA(() => listarLinhas({ incluirDesativadas: true }, opcoes));
    expect(vista!.estado).toBe("desativada");
  });

  it("quem não é administrador só resolve a própria linha; administrador e sistema resolvem a de outra pessoa", async () => {
    const daBia = await comoAdminA(() => criarLinha(nova({ userId: BIA_A, padrao: true }), opcoes));
    await expect(comoAna(() => linhaParaLigar(BIA_A))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await comoAdminA(() => linhaParaLigar(BIA_A))).id).toBe(daBia.id);
    expect((await runAsSystem(TEAM_A, () => linhaParaLigar(BIA_A))).id).toBe(daBia.id);
  });

  it("viewer e contexto sem identidade não resolvem linha", async () => {
    await comoAdminA(() => criarLinha(nova({ userId: BIA_A, padrao: true }), opcoes));
    await expect(comoViewerA(() => linhaParaLigar(BIA_A))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runWithTeam(TEAM_A, () => linhaParaLigar(BIA_A), {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("credenciais", () => {
  const SENHA = "senha-do-ramal-123456";

  it("ficam cifradas no banco, voltam abertas só para o servidor e a listagem mostra só os últimos 4", async () => {
    const criada = await comoAdminA(() =>
      criarLinha(nova({ userId: ANA_A, padrao: true, credenciais: { ramal: "1001", senhaDoRamal: SENHA } }), opcoes),
    );

    // No banco: um envelope cifrado, sem o texto da senha em lugar nenhum.
    const crua = await basePrisma.linhaDeLigacao.findUniqueOrThrow({ where: { id: criada.id } });
    expect(estaCifrado(crua.credentials)).toBe(true);
    expect(JSON.stringify(crua.credentials)).not.toContain(SENHA);

    // Para o servidor, aberta.
    const aberta = await comoAna(() => linhaParaLigar(ANA_A));
    expect(aberta.credenciais).toEqual({ ramal: "1001", senhaDoRamal: SENHA });

    // Para a tela, só a máscara. Nem a criação nem a listagem devolvem o segredo.
    const lista = await comoAdminA(() => listarLinhas({}, opcoes));
    for (const dto of [criada, lista[0]!]) {
      expect(JSON.stringify(dto)).not.toContain(SENHA);
      const senha = dto.credenciais.find((c) => c.chave === "senhaDoRamal")!;
      expect(senha).toMatchObject({ secreto: true, preenchido: true, ultimos4: SENHA.slice(-4) });
      expect(senha).not.toHaveProperty("valor");
      expect(dto.credenciais.find((c) => c.chave === "ramal")).toMatchObject({ secreto: false, valor: "1001" });
    }
  });

  it("pelo client do time, toda operação cifra ao gravar e abre ao ler (updateManyAndReturn, findFirstOrThrow, findUniqueOrThrow, delete)", async () => {
    const l = await comoAdminA(() => criarLinha(nova({ userId: ANA_A, credenciais: { ramal: "1001", senhaDoRamal: SENHA } }), opcoes));
    const NOVA = "outra-senha-do-ramal-9999";

    const [atualizada] = await runAsSystem(TEAM_A, () =>
      db().linhaDeLigacao.updateManyAndReturn({ where: { id: l.id }, data: { credentials: { ramal: "1001", senhaDoRamal: NOVA } } }),
    );
    expect(atualizada!.credentials).toEqual({ ramal: "1001", senhaDoRamal: NOVA });
    const crua = await basePrisma.linhaDeLigacao.findUniqueOrThrow({ where: { id: l.id } });
    expect(estaCifrado(crua.credentials)).toBe(true);
    expect(JSON.stringify(crua.credentials)).not.toContain(NOVA);

    const doPrimeiro = await runAsSystem(TEAM_A, () => db().linhaDeLigacao.findFirstOrThrow({ where: { id: l.id } }));
    const doUnico = await runAsSystem(TEAM_A, () => db().linhaDeLigacao.findUniqueOrThrow({ where: { id: l.id } }));
    expect(doPrimeiro.credentials).toEqual({ ramal: "1001", senhaDoRamal: NOVA });
    expect(doUnico.credentials).toEqual({ ramal: "1001", senhaDoRamal: NOVA });

    const apagada = await runAsSystem(TEAM_A, () => db().linhaDeLigacao.delete({ where: { id: l.id } }));
    expect(apagada.credentials).toEqual({ ramal: "1001", senhaDoRamal: NOVA });
  });

  it("segredo curto não mostra nem os últimos 4", async () => {
    const dto = await comoAdminA(() => criarLinha(nova({ credenciais: { ramal: "1002", senhaDoRamal: "curta123" } }), opcoes));
    expect(dto.credenciais.find((c) => c.chave === "senhaDoRamal")).toMatchObject({ preenchido: true, ultimos4: null });
  });

  it("campo guardado que o descritor não conhece, e provedor fora do registro, são tratados como secretos", async () => {
    const l = await comoAdminA(() => criarLinha(nova({ credenciais: { ramal: "1003", senhaDoRamal: SENHA } }), opcoes));
    // Um campo que o descritor não tem, gravado por fora do serviço (suporte, migração de dados).
    await runAsSystem(TEAM_A, () =>
      db().linhaDeLigacao.update({ where: { id: l.id }, data: { credentials: { ramal: "1003", senhaDoRamal: SENHA, extra: "valor-escondido-9876" } } }),
    );
    const [comExtra] = await comoAdminA(() => listarLinhas({}, opcoes));
    const extra = comExtra!.credenciais.find((c) => c.chave === "extra")!;
    expect(extra).toMatchObject({ secreto: true, preenchido: true });
    expect(extra).not.toHaveProperty("valor");
    expect(JSON.stringify(comExtra)).not.toContain("valor-escondido-9876");

    // Registro vazio: o provedor "saiu". Nada é mostrado em claro.
    const [semProvedor] = await comoAdminA(() => listarLinhas({}, { registro: criarRegistroDeLigacao() }));
    expect(semProvedor!.credenciais).toHaveLength(3);
    for (const c of semProvedor!.credenciais) {
      expect(c.secreto).toBe(true);
      expect(c).not.toHaveProperty("valor");
    }
    expect(JSON.stringify(semProvedor)).not.toContain(SENHA);
    expect(JSON.stringify(semProvedor)).not.toContain("1003");
  });

  it("campo desconhecido ou inválido é recusado sem repetir o valor e sem gravar", async () => {
    const e1 = await comoAdminA(() => criarLinha(nova({ credenciais: { ramal: "1001", senhaDoRamal: SENHA, extra: "x" } }), opcoes)).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(LinhaDeLigacaoInvalida);
    const e2 = await comoAdminA(() => criarLinha(nova({ credenciais: { ramal: "abc", senhaDoRamal: SENHA } }), opcoes)).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(LinhaDeLigacaoInvalida);
    expect((e1 as LinhaDeLigacaoInvalida).problemas[0]!.campo).toBe("credenciais");
    expect((e2 as LinhaDeLigacaoInvalida).problemas[0]!.campo).toBe("credenciais.ramal");
    for (const e of [e1, e2]) expect(JSON.stringify((e as LinhaDeLigacaoInvalida).problemas)).not.toContain(SENHA);
    expect(await basePrisma.linhaDeLigacao.count({ where: { teamId: TEAM_A } })).toBe(0);
  });

  it("provedor sem campo de credencial na linha: a linha sem credenciais guarda nulo", async () => {
    const dto = await comoAdminA(() => criarLinha(nova({ provedor: "teste_sem_linha", credenciais: undefined }), opcoes));
    expect((await basePrisma.linhaDeLigacao.findUniqueOrThrow({ where: { id: dto.id } })).credentials).toBeNull();
    const comNulo = await comoAdminA(() => criarLinha(nova({ provedor: "teste_sem_linha", credenciais: null }), opcoes));
    expect((await basePrisma.linhaDeLigacao.findUniqueOrThrow({ where: { id: comNulo.id } })).credentials).toBeNull();
  });

  it("campo obrigatório da linha faltando é recusado, com ou sem `credenciais`, e nada é gravado", async () => {
    const semNada = await comoAdminA(() => criarLinha(nova({ credenciais: undefined }), opcoes)).catch((e: unknown) => e);
    const comNulo = await comoAdminA(() => criarLinha(nova({ credenciais: null }), opcoes)).catch((e: unknown) => e);
    const vazio = await comoAdminA(() => criarLinha(nova({ credenciais: {} }), opcoes)).catch((e: unknown) => e);
    const soRamal = await comoAdminA(() => criarLinha(nova({ credenciais: { ramal: "1001" } }), opcoes)).catch((e: unknown) => e);
    for (const e of [semNada, comNulo, vazio]) {
      expect(e).toBeInstanceOf(LinhaDeLigacaoInvalida);
      expect((e as LinhaDeLigacaoInvalida).problemas.map((p) => p.campo).sort()).toEqual(["credenciais.ramal", "credenciais.senhaDoRamal"]);
    }
    expect(soRamal).toBeInstanceOf(LinhaDeLigacaoInvalida);
    expect((soRamal as LinhaDeLigacaoInvalida).problemas).toEqual([{ campo: "credenciais.senhaDoRamal", mensagem: "Preencha este campo." }]);
    expect(await basePrisma.linhaDeLigacao.count({ where: { teamId: TEAM_A } })).toBe(0);
  });
});

describe("validação e provedor", () => {
  it("provedor fora do registro é recusado", async () => {
    await expect(comoAdminA(() => criarLinha(nova({ provedor: "nao_existe" }), opcoes))).rejects.toBeInstanceOf(ProvedorDeLigacaoNaoRegistrado);
    // O registro do app está vazio até o primeiro adaptador (F2): fail-closed.
    await expect(comoAdminA(() => criarLinha(nova()))).rejects.toBeInstanceOf(ProvedorDeLigacaoNaoRegistrado);
  });

  it("tipo e campos fechados vêm do zod, sem repetir o valor digitado", async () => {
    const erro = (await comoAdminA(() => criarLinha(nova({ tipo: "telepatia" as never }), opcoes)).catch((e: unknown) => e)) as LinhaDeLigacaoInvalida;
    expect(erro).toBeInstanceOf(LinhaDeLigacaoInvalida);
    expect(erro.problemas).toEqual([{ campo: "tipo", mensagem: "Escolha uma das opções." }]);
    await expect(comoAdminA(() => criarLinha(nova({ idExterno: "   " }), opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoInvalida);
    await expect(comoAdminA(() => criarLinha(nova({ provedor: "Com Espaço" }), opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoInvalida);
  });

  it("aceita os três tipos e os valores padrão", async () => {
    for (const tipo of ["ramal", "numero_whatsapp", "dispositivo"] as const) {
      const dto = await comoAdminA(() => criarLinha(nova({ tipo }), opcoes));
      expect(dto).toMatchObject({ tipo, estado: "ativa", padrao: false, webhookVersao: 1, userId: null, motivoPausa: null, pausadaAte: null });
    }
  });
});

describe("pausar e reativar", () => {
  it("pausa com motivo e prazo, reativa limpando os dois, e não aceita prazo no passado", async () => {
    const l = await comoAdminA(() => criarLinha(nova({ userId: ANA_A }), opcoes));
    const ate = new Date(Date.now() + 3_600_000);
    const pausada = await comoAdminA(() => pausarLinha(l.id, { motivo: "Limite do dia", ate }, opcoes));
    expect(pausada).toMatchObject({ estado: "pausada", motivoPausa: "Limite do dia" });
    expect(pausada.pausadaAte?.getTime()).toBe(ate.getTime());

    await expect(comoAdminA(() => pausarLinha(l.id, { motivo: "x", ate: new Date(Date.now() - 1000) }, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoInvalida);
    await expect(comoAdminA(() => pausarLinha(l.id, { motivo: "" }, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoInvalida);

    const ativa = await comoAdminA(() => reativarLinha(l.id, opcoes));
    expect(ativa).toMatchObject({ estado: "ativa", motivoPausa: null, pausadaAte: null });
  });

  it("linha desativada não pausa, não reativa e não vira padrão", async () => {
    const l = await comoAdminA(() => criarLinha(nova({ userId: ANA_A }), opcoes));
    await basePrisma.linhaDeLigacao.update({ where: { id: l.id }, data: { estado: "desativada" } });
    await expect(comoAdminA(() => pausarLinha(l.id, { motivo: "x" }, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoDesativada);
    await expect(comoAdminA(() => reativarLinha(l.id, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoDesativada);
    await expect(comoAdminA(() => definirLinhaPadrao(l.id, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoDesativada);
  });

  it("id que não existe dá o erro nomeado", async () => {
    await expect(comoAdminA(() => pausarLinha("00000000-0000-0000-0000-00000000dead", { motivo: "x" }, opcoes))).rejects.toBeInstanceOf(LinhaDeLigacaoNaoEncontrada);
  });
});

describe("RBAC", () => {
  it("membro e viewer não criam, pausam, reativam nem trocam a padrão", async () => {
    const l = await comoAdminA(() => criarLinha(nova({ userId: ANA_A }), opcoes));
    for (const como of [comoAna, comoViewerA]) {
      await expect(como(() => criarLinha(nova(), opcoes))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(como(() => pausarLinha(l.id, { motivo: "x" }, opcoes))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(como(() => reativarLinha(l.id, opcoes))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(como(() => definirLinhaPadrao(l.id, opcoes))).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await basePrisma.linhaDeLigacao.count({ where: { teamId: TEAM_A } })).toBe(1);
  });

  it("contexto sem identidade é negado; o sistema e o administrador passam", async () => {
    await expect(runWithTeam(TEAM_A, () => criarLinha(nova(), opcoes), {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runAsSystem(TEAM_A, () => criarLinha(nova(), opcoes))).resolves.toMatchObject({ estado: "ativa" });
    await expect(comoAdminA(() => criarLinha(nova(), opcoes))).resolves.toMatchObject({ estado: "ativa" });
  });

  it("a listagem do membro mostra só a própria linha e as do time; o administrador vê todas", async () => {
    await comoAdminA(() => criarLinha(nova({ userId: ANA_A }), opcoes));
    await comoAdminA(() => criarLinha(nova({ userId: BIA_A }), opcoes));
    await comoAdminA(() => criarLinha(nova(), opcoes));
    expect(await comoAdminA(() => listarLinhas({}, opcoes))).toHaveLength(3);
    const dela = await comoAna(() => listarLinhas({}, opcoes));
    expect(dela.map((l) => l.userId).sort()).toEqual([ANA_A, null].sort());
    // Mesmo pedindo a linha da Bia, o membro não a recebe.
    expect(await comoAna(() => listarLinhas({ userId: BIA_A }, opcoes))).toEqual([]);
    await expect(runWithTeam(TEAM_A, () => listarLinhas({}, opcoes), {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a listagem esconde as desativadas, salvo pedido", async () => {
    const l = await comoAdminA(() => criarLinha(nova(), opcoes));
    await basePrisma.linhaDeLigacao.update({ where: { id: l.id }, data: { estado: "desativada" } });
    expect(await comoAdminA(() => listarLinhas({}, opcoes))).toHaveLength(0);
    expect(await comoAdminA(() => listarLinhas({ incluirDesativadas: true }, opcoes))).toHaveLength(1);
  });
});

describe("chaves estrangeiras da migration", () => {
  it("apagar o dono deixa a linha como linha do time; apagar a linha solta a ligação (SetNull)", async () => {
    const dono = await basePrisma.user.create({ data: { teamId: TEAM_A, name: "Saiu", email: `saiu-${Date.now()}@linhas-f1b05.teste.local`, role: "member" } });
    const l = await comoAdminA(() => criarLinha(nova({ userId: dono.id }), opcoes));
    const contato = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Contato da linha" } });
    const ligacao = await basePrisma.call.create({
      data: { teamId: TEAM_A, contactId: contato.id, phoneNumber: "+5511999990000", direction: "outbound", provider: "teste_um", linhaId: l.id },
    });

    await basePrisma.user.delete({ where: { id: dono.id } });
    expect((await basePrisma.linhaDeLigacao.findUniqueOrThrow({ where: { id: l.id } })).userId).toBeNull();

    await basePrisma.linhaDeLigacao.delete({ where: { id: l.id } });
    expect((await basePrisma.call.findUniqueOrThrow({ where: { id: ligacao.id } })).linhaId).toBeNull();
  });

  it("a FK de Call.linhaId está validada: id de linha que não existe é recusado", async () => {
    const contato = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Contato sem linha" } });
    await expect(
      basePrisma.call.create({
        data: { teamId: TEAM_A, contactId: contato.id, phoneNumber: "+5511999990001", direction: "outbound", provider: "teste_um", linhaId: "00000000-0000-0000-0000-00000000dead" },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});
