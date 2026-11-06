import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as barrelDoContrato from "../index";
import { ehProvedorComprovado, criarRegistroDeLigacao, problemasDoRegistroDeLigacao, registroPadraoDeLigacao } from "../index";
import { CredencialInvalidaDeLigacao, DestinoInvalidoDeLigacao, ErroDeLigacao, LimiteDeRequisicoesDeLigacao, LinhaOcupadaDeLigacao, NaoEncontradoDeLigacao, NaoSuportadoDeLigacao, ProvedorIndisponivelDeLigacao, RecusadoPeloProvedorDeLigacao } from "../erros";
import { ResultadoDaNormalizacaoDeLigacaoSchema, type FatoDeLigacao } from "../fato";
import {
  ATRASO_DO_AVISO_ATRASADO_MS,
  CHAVES_DO_FAKE_DE_LIGACAO,
  DESTINO_DO_AVISO_DIVERGENTE,
  ESPERA_DA_GRAVACAO_DO_FAKE_MS,
  FakeProvedorDeLigacao,
  PERFIS_DO_FAKE_DE_LIGACAO,
  SITUACOES_DE_LIGACAO,
  capacidadesDoPerfilDeLigacao,
  contextoDoFakeDeLigacao,
  criarRegistroDeLigacaoComFake,
  entradaDoFakeDeLigacao,
  fakeDeLigacaoPermitido,
  gerarSituacaoDeLigacao,
  registrarFakeDeLigacao,
  type AvisoGeradoDeLigacao,
  type PerfilDoFakeDeLigacao,
} from "./index";

const novo = (perfil: PerfilDoFakeDeLigacao) => {
  const fake = new FakeProvedorDeLigacao({ perfil });
  return { fake, ctx: contextoDoFakeDeLigacao(fake) };
};

const linhaDe = (ctx: ReturnType<typeof contextoDoFakeDeLigacao>) => ({ contaExterna: ctx.linha!.contaExterna, idExterno: ctx.linha!.idExterno });

async function ligar(fake: FakeProvedorDeLigacao, ctx: ReturnType<typeof contextoDoFakeDeLigacao>, extra: { destino?: string; gravar?: boolean; modo?: "navegador" | "ponte" } = {}) {
  const destinoE164 = extra.destino ?? "+5511977776666";
  fake.roteiro.permitirDestino(destinoE164);
  const r = await fake.originar(ctx, { callId: "6f1c8a3e-5b2d-4c7a-9e10-3a4b5c6d7e8f", destinoE164, modo: extra.modo ?? fake.capacidades.originar[0]!, linha: linhaDe(ctx), gravar: extra.gravar ?? false, urlDoCallback: null });
  return { ...r, destinoE164 };
}

const fatosDosAvisos = (fake: FakeProvedorDeLigacao, avisos: readonly AvisoGeradoDeLigacao[]): FatoDeLigacao[] => avisos.flatMap((a) => fake.normalizarWebhook(JSON.parse(a.req.corpo)).fatos);
const fimDe = (fatos: readonly FatoDeLigacao[]) => fatos.find((f) => f.tipo === "encerrada" || f.tipo === "falhou_ao_originar");

async function ler(fake: FakeProvedorDeLigacao, ctx: ReturnType<typeof contextoDoFakeDeLigacao>, ref: string) {
  const g = await fake.obterGravacao!(ctx, ref);
  const partes: Uint8Array[] = [];
  for await (const p of g.stream) partes.push(p);
  const bytes = Buffer.concat(partes);
  return { ...g, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), pedacos: partes.length };
}

// ---------------------------------------------------------------------------------------------------

describe("perfis do Fake de ligação", () => {
  it("cada perfil tem uma matriz válida e a forma do candidato que imita", () => {
    const so = capacidadesDoPerfilDeLigacao("so_no_fim");
    expect(so).toMatchObject({ webhook: "url_assinada", eventosAoVivo: false, consulta: { porId: true, porMinuto: 15, trazAtendimento: false }, pontasNoAviso: { destino: true, origem: true } });
    expect(so.gravacao).toMatchObject({ entrega: "webhook", prazoHoras: null, apagavel: false });

    const vivo = capacidadesDoPerfilDeLigacao("ao_vivo");
    expect(vivo).toMatchObject({ webhook: "assinatura_do_provedor", eventosAoVivo: true, originacaoSincrona: true, consulta: { porId: true, trazAtendimento: true } });
    expect(vivo.gravacao.apagavel).toBe(true);

    const sem = capacidadesDoPerfilDeLigacao("sem_consulta");
    expect(sem).toMatchObject({ webhook: "assinatura_do_provedor", ligaAFrio: false, consulta: { porId: false, porMinuto: null, trazAtendimento: false } });
    expect(sem.gravacao).toMatchObject({ entrega: "webhook", prazoHoras: 168, aviso: "provedor" });
  });

  it("os métodos opcionais existem só onde a matriz os declara", () => {
    const so = new FakeProvedorDeLigacao({ perfil: "so_no_fim" });
    expect(typeof so.consultar).toBe("function");
    expect(so.responderOriginacao).toBeUndefined();
    expect(so.apagarGravacao).toBeUndefined();
    const vivo = new FakeProvedorDeLigacao({ perfil: "ao_vivo" });
    expect(typeof vivo.responderOriginacao).toBe("function");
    expect(typeof vivo.apagarGravacao).toBe("function");
    const sem = new FakeProvedorDeLigacao({ perfil: "sem_consulta" });
    expect(sem.consultar).toBeUndefined();
    expect(sem.provisionarLinha).toBeUndefined();
  });

  it("o descritor, a matriz e o adaptador de cada perfil passam na conferência do registro", () => {
    for (const perfil of PERFIS_DO_FAKE_DE_LIGACAO) expect(problemasDoRegistroDeLigacao(entradaDoFakeDeLigacao(perfil)), perfil).toEqual([]);
  });

  it("o descritor só pede segredo de aviso onde a assinatura é do provedor", () => {
    expect(entradaDoFakeDeLigacao("so_no_fim").descritor.segredoDoWebhook).toBeNull();
    expect(entradaDoFakeDeLigacao("ao_vivo").descritor.segredoDoWebhook).not.toBeNull();
  });
});

describe("originar", () => {
  it("devolve o id da ligação, e o Fake guarda o id do CRM Agro e o endereço do aviso", async () => {
    const { fake, ctx } = novo("ao_vivo");
    fake.roteiro.permitirDestino("+5511977776666");
    const callId = "6f1c8a3e-5b2d-4c7a-9e10-3a4b5c6d7e8f";
    const r = await fake.originar(ctx, { callId, destinoE164: "+5511977776666", modo: "navegador", linha: linhaDe(ctx), gravar: true, urlDoCallback: "https://exemplo.invalid/aviso" });
    expect(r.providerCallId).toMatch(/^pc_\d+$/);
    expect(fake.roteiro.estadoDe(r.providerCallId)).toMatchObject({ estado: "criada", callId, urlDoCallback: "https://exemplo.invalid/aviso", atendida: false });
  });

  it("modo que a matriz não declara lança nao_suportado", async () => {
    const { fake, ctx } = novo("so_no_fim");
    await expect(ligar(fake, ctx, { modo: "ponte" })).rejects.toBeInstanceOf(NaoSuportadoDeLigacao);
  });

  it("destino fora de E.164 lança destino_invalido", async () => {
    const { fake, ctx } = novo("so_no_fim");
    await expect(ligar(fake, ctx, { destino: "11977776666" })).rejects.toBeInstanceOf(DestinoInvalidoDeLigacao);
  });

  it("a linha do pedido tem de ser a do contexto, e a chave de um ambiente não vale no outro", async () => {
    const { fake, ctx } = novo("so_no_fim");
    const outraLinha = { ...ctx, linha: { ...ctx.linha!, idExterno: "9999" } };
    await expect(fake.originar(outraLinha, { callId: "6f1c8a3e-5b2d-4c7a-9e10-3a4b5c6d7e8f", destinoE164: "+5511977776666", modo: "navegador", linha: linhaDe(ctx), gravar: false, urlDoCallback: null })).rejects.toBeInstanceOf(CredencialInvalidaDeLigacao);
    const vivo = novo("ao_vivo");
    await expect(vivo.fake.testarConexao({ ...vivo.ctx, ambiente: "producao" })).rejects.toBeInstanceOf(CredencialInvalidaDeLigacao);
  });

  it("sem permissão do contato, o provedor que não liga a frio recusa; com a permissão, liga", async () => {
    const { fake, ctx } = novo("sem_consulta");
    const pedido = { callId: "6f1c8a3e-5b2d-4c7a-9e10-3a4b5c6d7e8f", destinoE164: "+5511977776666", modo: "navegador" as const, linha: linhaDe(ctx), gravar: false, urlDoCallback: null };
    const e = await fake.originar(ctx, pedido).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RecusadoPeloProvedorDeLigacao);
    expect((e as RecusadoPeloProvedorDeLigacao).motivo).toBe("sem_permissao");
    fake.roteiro.permitirDestino("+5511977776666");
    await expect(fake.originar(ctx, pedido)).resolves.toMatchObject({ providerCallId: expect.any(String) });
  });

  it("a linha só faz uma ligação por vez, e fica livre quando a ligação termina", async () => {
    const { fake, ctx } = novo("so_no_fim");
    const a = await ligar(fake, ctx);
    await expect(ligar(fake, ctx)).rejects.toBeInstanceOf(LinhaOcupadaDeLigacao);
    await fake.encerrar(ctx, a.providerCallId);
    await expect(ligar(fake, ctx)).resolves.toBeDefined();
  });

  it("fora do ar lança provedor_indisponivel; a falha pontual vale uma vez só", async () => {
    const { fake, ctx } = novo("so_no_fim");
    fake.roteiro.foraDoAr(true);
    await expect(fake.testarConexao(ctx)).rejects.toBeInstanceOf(ProvedorIndisponivelDeLigacao);
    fake.roteiro.foraDoAr(false);
    fake.roteiro.falharProxima("testarConexao", new LimiteDeRequisicoesDeLigacao(fake.chave, 500));
    const e = await fake.testarConexao(ctx).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LimiteDeRequisicoesDeLigacao);
    expect((e as LimiteDeRequisicoesDeLigacao).esperarMs).toBe(500);
    await expect(fake.testarConexao(ctx)).resolves.toMatchObject({ ok: true });
  });

  it("encerrar uma ligação que atendeu fecha como atendida; antes de atender, como cancelada por quem ligou", async () => {
    const { fake, ctx } = novo("ao_vivo");
    const a = await ligar(fake, ctx);
    fake.roteiro.tocar(a.providerCallId);
    await fake.encerrar(ctx, a.providerCallId);
    expect(fake.roteiro.estadoDe(a.providerCallId)).toMatchObject({ estado: "encerrada", causa: "cancelada_por_quem_ligou" });
    const b = await ligar(fake, ctx);
    fake.roteiro.tocar(b.providerCallId);
    fake.roteiro.atender(b.providerCallId);
    await fake.encerrar(ctx, b.providerCallId);
    expect(fake.roteiro.estadoDe(b.providerCallId)).toMatchObject({ estado: "encerrada", causa: "atendida", atendida: true });
  });

  it("provisionarLinha devolve só o ramal; responderOriginacao existe só no perfil ao_vivo e leva o destino", async () => {
    const { fake, ctx } = novo("ao_vivo");
    const linha = await fake.provisionarLinha!(ctx, { rotulo: "Maria" });
    expect(Object.keys(linha.credenciais)).toEqual(["ramal"]);
    const r = fake.responderOriginacao!(ctx, { callId: "6f1c8a3e-5b2d-4c7a-9e10-3a4b5c6d7e8f", destinoE164: "+5511977776666" });
    expect(r.contentType).toBe("text/xml");
    expect(r.corpo).toContain("+5511977776666");
    expect(() => fake.responderOriginacao!(ctx, { callId: "x", destinoE164: "<Hangup/>" })).toThrow(DestinoInvalidoDeLigacao);
  });
});

describe("consulta: o fim REAL, nunca o que um aviso disse", () => {
  for (const perfil of ["so_no_fim", "ao_vivo"] as const) {
    it(`devolve o fim real mesmo com um aviso forjado e válido (${perfil})`, async () => {
      const { fake, ctx } = novo(perfil);
      const s = await gerarSituacaoDeLigacao(fake, ctx, "aviso_forjado");
      const forjado = fimDe(fatosDosAvisos(fake, s.avisos));
      expect(forjado).toMatchObject({ tipo: "encerrada", causa: "atendida" });
      const real = fimDe((await fake.consultar!(ctx, s.providerCallId)).fatos);
      expect(real).toMatchObject({ tipo: "encerrada", causa: "nao_atendeu" });
    });
  }

  it("só o perfil que traz o atendimento diz na consulta que a ligação foi atendida", async () => {
    const so = novo("so_no_fim");
    const a = await gerarSituacaoDeLigacao(so.fake, so.ctx, "atendida");
    const fatosA = (await so.fake.consultar!(so.ctx, a.providerCallId)).fatos;
    expect(fatosA.some((f) => f.tipo === "atendida")).toBe(false);
    expect(fimDe(fatosA)).toMatchObject({ causa: "atendida" });
    expect(fimDe(fatosA) && "atendidaEm" in fimDe(fatosA)!).toBe(false);

    const vivo = novo("ao_vivo");
    const b = await gerarSituacaoDeLigacao(vivo.fake, vivo.ctx, "atendida");
    const fatosB = (await vivo.fake.consultar!(vivo.ctx, b.providerCallId)).fatos;
    expect(fatosB.some((f) => f.tipo === "atendida")).toBe(true);
    expect(fimDe(fatosB)).toMatchObject({ atendidaEm: expect.any(String), duracaoConectadaS: 75 });
  });

  it("uma ligação que ainda não terminou não tem fim na consulta", async () => {
    const { fake, ctx } = novo("so_no_fim");
    const a = await ligar(fake, ctx);
    fake.roteiro.tocar(a.providerCallId);
    expect((await fake.consultar!(ctx, a.providerCallId)).fatos).toEqual([]);
  });

  it("as pontas da consulta seguem a matriz e pertencem a um fato do mesmo resultado", async () => {
    const { fake, ctx } = novo("so_no_fim");
    const s = await gerarSituacaoDeLigacao(fake, ctx, "atendida");
    const r = await fake.consultar!(ctx, s.providerCallId);
    expect(r.pontas).toEqual([{ idEvento: fimDe(r.fatos)!.idEvento, destinoE164: s.destinoE164, origemExterna: s.linha.idExterno }]);
  });

  it("respeita o teto por minuto: a 16ª consulta no mesmo minuto lança limite_de_requisicoes, e o relógio libera", async () => {
    const { fake, ctx } = novo("so_no_fim");
    const s = await gerarSituacaoDeLigacao(fake, ctx, "atendida");
    for (let i = 0; i < 15; i += 1) await fake.consultar!(ctx, s.providerCallId);
    const e = await fake.consultar!(ctx, s.providerCallId).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LimiteDeRequisicoesDeLigacao);
    expect((e as LimiteDeRequisicoesDeLigacao).esperarMs).toBeGreaterThan(0);
    expect((e as LimiteDeRequisicoesDeLigacao).esperarMs).toBeLessThanOrEqual(60_000);
    fake.roteiro.avancar(60_000);
    await expect(fake.consultar!(ctx, s.providerCallId)).resolves.toBeDefined();
  });

  it("sem teto declarado, não limita", async () => {
    const { fake, ctx } = novo("ao_vivo");
    const s = await gerarSituacaoDeLigacao(fake, ctx, "atendida");
    for (let i = 0; i < 50; i += 1) await fake.consultar!(ctx, s.providerCallId);
  });
});

describe("gravação", () => {
  it("só fica pronta depois da espera, e o aviso chega quando ela fica pronta", async () => {
    const { fake, ctx } = novo("sem_consulta");
    const a = await ligar(fake, ctx, { gravar: true });
    fake.roteiro.tocar(a.providerCallId);
    fake.roteiro.atender(a.providerCallId);
    fake.roteiro.avancar(40_000);
    await fake.encerrar(ctx, a.providerCallId);
    const antes = fake.roteiro.sacarAvisos(ctx).flatMap((r) => fake.normalizarWebhook(JSON.parse(r.corpo)).fatos);
    expect(antes.some((f) => f.tipo === "gravacao_pronta")).toBe(false);
    fake.roteiro.avancar(ESPERA_DA_GRAVACAO_DO_FAKE_MS);
    const depois = fake.roteiro.sacarAvisos(ctx).flatMap((r) => fake.normalizarWebhook(JSON.parse(r.corpo)).fatos);
    expect(depois.map((f) => f.tipo)).toEqual(["gravacao_pronta"]);
  });

  it("o arquivo vem em pedaços e confere com o sha256 do aviso; o perfil que não informa o hash não o diz", async () => {
    const vivo = novo("ao_vivo");
    const s = await gerarSituacaoDeLigacao(vivo.fake, vivo.ctx, "atendida", { gravar: true });
    const pronta = fatosDosAvisos(vivo.fake, s.avisos).find((f) => f.tipo === "gravacao_pronta");
    if (pronta?.tipo !== "gravacao_pronta") throw new Error("sem gravação pronta");
    const arq = await ler(vivo.fake, vivo.ctx, pronta.refGravacao);
    expect(arq.pedacos).toBeGreaterThan(1);
    expect(arq.sha256).toBe(pronta.sha256);
    expect(arq.sha256Esperado).toBe(arq.sha256);
    expect(arq.bytes.equals(vivo.fake.roteiro.bytesDaGravacao(pronta.refGravacao)!)).toBe(true);

    const so = novo("so_no_fim");
    const t = await gerarSituacaoDeLigacao(so.fake, so.ctx, "atendida", { gravar: true });
    const p2 = fatosDosAvisos(so.fake, t.avisos).find((f) => f.tipo === "gravacao_pronta");
    if (p2?.tipo !== "gravacao_pronta") throw new Error("sem gravação pronta");
    expect(p2.sha256).toBeUndefined();
    expect((await ler(so.fake, so.ctx, p2.refGravacao)).sha256Esperado).toBeNull();
  });

  it("some depois do prazo declarado (168 h) e não antes", async () => {
    const { fake, ctx } = novo("sem_consulta");
    const s = await gerarSituacaoDeLigacao(fake, ctx, "atendida", { gravar: true });
    const pronta = fatosDosAvisos(fake, s.avisos).find((f) => f.tipo === "gravacao_pronta");
    if (pronta?.tipo !== "gravacao_pronta") throw new Error("sem gravação pronta");
    expect(Date.parse(pronta.expiraEm!) - Date.parse(pronta.ocorridoEm)).toBe(168 * 3_600_000);
    fake.roteiro.avancar(167 * 3_600_000);
    await expect(fake.obterGravacao!(ctx, pronta.refGravacao)).resolves.toBeDefined();
    fake.roteiro.avancar(2 * 3_600_000);
    await expect(fake.obterGravacao!(ctx, pronta.refGravacao)).rejects.toBeInstanceOf(NaoEncontradoDeLigacao);
  });

  it("onde a gravação é apagável, apagar faz o arquivo sumir; apagar de novo lança nao_encontrado", async () => {
    const { fake, ctx } = novo("ao_vivo");
    const s = await gerarSituacaoDeLigacao(fake, ctx, "atendida", { gravar: true });
    const pronta = fatosDosAvisos(fake, s.avisos).find((f) => f.tipo === "gravacao_pronta");
    if (pronta?.tipo !== "gravacao_pronta") throw new Error("sem gravação pronta");
    await fake.apagarGravacao!(ctx, pronta.refGravacao);
    await expect(fake.obterGravacao!(ctx, pronta.refGravacao)).rejects.toBeInstanceOf(NaoEncontradoDeLigacao);
    await expect(fake.apagarGravacao!(ctx, pronta.refGravacao)).rejects.toBeInstanceOf(NaoEncontradoDeLigacao);
  });

  it("sem pedir a gravação, ou sem atender, não há gravação", async () => {
    const { fake, ctx } = novo("ao_vivo");
    const semPedir = await gerarSituacaoDeLigacao(fake, ctx, "atendida", { gravar: false });
    expect(fatosDosAvisos(fake, semPedir.avisos).some((f) => f.tipo === "gravacao_pronta")).toBe(false);
    const naoAtendeu = await gerarSituacaoDeLigacao(fake, ctx, "nao_atendeu", { gravar: true });
    expect(fatosDosAvisos(fake, naoAtendeu.avisos).some((f) => f.tipo === "gravacao_pronta")).toBe(false);
  });
});

describe("avisos", () => {
  it("em url_assinada o adaptador sozinho NUNCA autentica: quem prova a origem é o endereço", async () => {
    const { fake, ctx } = novo("so_no_fim");
    const s = await gerarSituacaoDeLigacao(fake, ctx, "atendida");
    expect(fake.verificarWebhook(ctx, s.avisos[0]!.req)).toEqual({ autentico: false, motivo: "sem_assinatura" });
    expect(s.avisos[0]!.req.cabecalhos["x-fake-assinatura"]).toBeUndefined();
  });

  it("na assinatura do provedor, o aviso sai assinado e a assinatura depende do segredo", async () => {
    const { fake, ctx } = novo("ao_vivo");
    const s = await gerarSituacaoDeLigacao(fake, ctx, "atendida");
    const req = s.avisos[0]!.req;
    expect(req.cabecalhos["x-fake-assinatura"]).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(fake.verificarWebhook(ctx, req).autentico).toBe(true);
    expect(fake.verificarWebhook({ ...ctx, segredoWebhook: { atual: "outro-segredo-qualquer-1234" } }, req)).toEqual({ autentico: false, motivo: "assinatura_invalida" });
    expect(fake.verificarWebhook({ ...ctx, segredoWebhook: null }, req)).toEqual({ autentico: false, motivo: "sem_assinatura" });
  });

  it("perfis com id próprio usam o id do aviso; o que não tem, fabrica por hash estável", async () => {
    const vivo = novo("ao_vivo");
    const s = await gerarSituacaoDeLigacao(vivo.fake, vivo.ctx, "atendida");
    const ids = fatosDosAvisos(vivo.fake, s.avisos).map((f) => f.idEvento);
    expect(ids.every((id) => id.startsWith("av_"))).toBe(true);
    const so = novo("so_no_fim");
    const t = await gerarSituacaoDeLigacao(so.fake, so.ctx, "atendida");
    const idsT = fatosDosAvisos(so.fake, t.avisos).map((f) => f.idEvento);
    expect(idsT.every((id) => /^h_[a-f0-9]{40}$/.test(id))).toBe(true);
  });

  it("a duração só vira conectada onde o provedor conta a partir do atendimento", async () => {
    const vivo = novo("ao_vivo");
    const a = fimDe(fatosDosAvisos(vivo.fake, (await gerarSituacaoDeLigacao(vivo.fake, vivo.ctx, "atendida")).avisos));
    expect(a).toMatchObject({ duracaoConectadaS: 75 });
    const so = novo("so_no_fim");
    const b = fimDe(fatosDosAvisos(so.fake, (await gerarSituacaoDeLigacao(so.fake, so.ctx, "atendida")).avisos));
    expect(b && "duracaoConectadaS" in b).toBe(false);
  });

  it("um corpo pode trazer vários avisos, e o evento desconhecido no meio é ignorado", async () => {
    const { fake, ctx } = novo("ao_vivo");
    const s = await gerarSituacaoDeLigacao(fake, ctx, "atendida");
    const corpos = s.avisos.map((a) => JSON.parse(a.req.corpo) as unknown);
    const r = fake.normalizarWebhook({ avisos: [corpos[0], { evento: "em_espera", ligacaoId: "pc_1", ocorridoEm: "2026-01-15T12:00:00.000Z" }, ...corpos.slice(1)] });
    expect(r.fatos.length).toBe(fatosDosAvisos(fake, s.avisos).length);
    expect(() => fake.normalizarWebhook({ avisos: [{ evento: "fim", ligacaoId: "pc_1" }] })).toThrow();
    expect(() => fake.normalizarWebhook({ evento: "fim", ligacaoId: "pc_1", ocorridoEm: "2026-01-15T12:00:00.000Z", causa: "atendida", telefone: "+5511977776666" })).toThrow();
  });

  it("o aperto de mão do GET existe só no perfil sem_consulta e não ecoa texto estranho", () => {
    expect(new FakeProvedorDeLigacao({ perfil: "ao_vivo" }).responderVerificacao).toBeUndefined();
    const { fake, ctx } = novo("sem_consulta");
    expect(fake.responderVerificacao!(ctx, fake.roteiro.queryDeVerificacao(ctx, "abc_123", true))).toBe("abc_123");
    expect(fake.responderVerificacao!(ctx, fake.roteiro.queryDeVerificacao(ctx, "abc_123", false))).toBeNull();
    expect(fake.responderVerificacao!(ctx, fake.roteiro.queryDeVerificacao(ctx, "<script>alert(1)</script>", true))).toBeNull();
    expect(fake.responderVerificacao!(ctx, { "hub.mode": "unsubscribe" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// As situações que os testes ponta a ponta usam
// ---------------------------------------------------------------------------------------------------

describe("situações geradas", () => {
  for (const perfil of PERFIS_DO_FAKE_DE_LIGACAO) {
    describe(`perfil ${perfil}`, () => {
      for (const nome of SITUACOES_DE_LIGACAO) {
        it(`${nome}: todo aviso é um aviso bem formado, sem telefone no fato, da mesma ligação`, async () => {
          const { fake, ctx } = novo(perfil);
          const s = await gerarSituacaoDeLigacao(fake, ctx, nome);
          expect(s.avisos.length).toBeGreaterThan(0);
          for (const a of s.avisos) {
            const r = fake.normalizarWebhook(JSON.parse(a.req.corpo));
            expect(ResultadoDaNormalizacaoDeLigacaoSchema.safeParse(r).success).toBe(true);
            expect(JSON.stringify(r.fatos)).not.toContain(s.destinoE164.slice(1));
            for (const f of r.fatos) expect(f.providerCallId).toBe(s.providerCallId);
          }
        });
      }

      it("atendida, não atendeu, ocupado, recusou, número inexistente e caixa postal terminam com a causa certa", async () => {
        const { fake, ctx } = novo(perfil);
        for (const nome of ["atendida", "nao_atendeu", "ocupado", "recusou", "numero_inexistente", "caixa_postal"] as const) {
          const s = await gerarSituacaoDeLigacao(fake, ctx, nome);
          expect(fimDe(fatosDosAvisos(fake, s.avisos)), nome).toMatchObject({ tipo: "encerrada", causa: nome === "nao_atendeu" ? "nao_atendeu" : nome });
          expect(s.real.causa).toBe(nome);
          expect(s.real.atendida).toBe(nome === "atendida");
        }
      });

      it("toque longo termina sem atender; falha ao originar vira falhou_ao_originar onde o perfil avisa ao vivo", async () => {
        const { fake, ctx } = novo(perfil);
        const longo = await gerarSituacaoDeLigacao(fake, ctx, "toque_longo");
        expect(fimDe(fatosDosAvisos(fake, longo.avisos))).toMatchObject({ causa: "nao_atendeu" });
        const falha = await gerarSituacaoDeLigacao(fake, ctx, "falha_ao_originar");
        expect(fimDe(fatosDosAvisos(fake, falha.avisos))).toMatchObject(fake.capacidades.eventosAoVivo ? { tipo: "falhou_ao_originar", causa: "falha_de_rede" } : { tipo: "encerrada", causa: "falha_de_rede" });
      });

      it("duplicata: o aviso de fim chega duas vezes, com os mesmos bytes e o mesmo idEvento", async () => {
        const { fake, ctx } = novo(perfil);
        const s = await gerarSituacaoDeLigacao(fake, ctx, "duplicata");
        const fins = s.avisos.filter((a) => a.evento === "fim");
        expect(fins).toHaveLength(2);
        expect(fins[0]!.req).toEqual(fins[1]!.req);
        expect(fins[0]!.req).not.toBe(fins[1]!.req);
        const ids = fins.map((a) => fake.normalizarWebhook(JSON.parse(a.req.corpo)).fatos[0]!.idEvento);
        expect(ids[0]).toBe(ids[1]);
      });

      it("ordem trocada: o aviso de fim chega primeiro (nos perfis que só avisam o fim, a ordem não muda)", async () => {
        const { fake, ctx } = novo(perfil);
        const s = await gerarSituacaoDeLigacao(fake, ctx, "ordem_trocada");
        expect(s.avisos[0]!.evento).toBe("fim");
        expect(s.avisos.length).toBe(fake.capacidades.eventosAoVivo ? 3 : 1);
        expect(s.avisos.map((a) => a.evento).sort()).toEqual(s.avisosReais.map((a) => a.evento).sort());
      });

      it("aviso forjado: assinatura válida, fim diferente do real, e idEvento diferente do aviso real da mesma ligação", async () => {
        const { fake, ctx } = novo(perfil);
        const s = await gerarSituacaoDeLigacao(fake, ctx, "aviso_forjado");
        const forjado = s.avisos[0]!;
        // A assinatura do forjado confere (onde há assinatura), e diz "atendida" quando a verdade é "não atendeu".
        if (fake.capacidades.webhook === "assinatura_do_provedor") expect(fake.verificarWebhook(ctx, forjado.req).autentico).toBe(true);
        const f = fake.normalizarWebhook(JSON.parse(forjado.req.corpo)).fatos[0]!;
        expect(f).toMatchObject({ tipo: "encerrada", causa: "atendida" });
        expect(s.real).toEqual({ causa: "nao_atendeu", atendida: false });
        const real = fake.normalizarWebhook(JSON.parse(s.avisosReais.find((a) => a.evento === "fim")!.req.corpo)).fatos[0]!;
        expect(real).toMatchObject({ tipo: "encerrada", causa: "nao_atendeu" });
        expect(f.idEvento).not.toBe(real.idEvento);
      });

      it("destino divergente: o aviso é autêntico, mas a ponta do destino é de outro número", async () => {
        const { fake, ctx } = novo(perfil);
        const s = await gerarSituacaoDeLigacao(fake, ctx, "destino_divergente");
        const fim = s.avisos.find((a) => a.evento === "fim")!;
        if (fake.capacidades.webhook === "assinatura_do_provedor") expect(fake.verificarWebhook(ctx, fim.req).autentico).toBe(true);
        expect(fim.ponta?.destinoE164).toBe(DESTINO_DO_AVISO_DIVERGENTE);
        expect(fim.ponta?.destinoE164).not.toBe(s.destinoE164);
        const r = fake.normalizarWebhook(JSON.parse(fim.req.corpo));
        expect(r.pontas).toEqual([expect.objectContaining({ idEvento: r.fatos[0]!.idEvento, destinoE164: DESTINO_DO_AVISO_DIVERGENTE })]);
      });

      it("aviso atrasado: o de fim chega 3 horas depois, os outros na hora", async () => {
        const { fake, ctx } = novo(perfil);
        const s = await gerarSituacaoDeLigacao(fake, ctx, "aviso_atrasado");
        for (const a of s.avisos) expect(a.entregarDepoisDeMs).toBe(a.evento === "fim" ? ATRASO_DO_AVISO_ATRASADO_MS : 0);
        expect(ATRASO_DO_AVISO_ATRASADO_MS).toBe(3 * 3_600_000);
      });

      it("sinal efêmero: a resposta SDP vira sinal e nunca fato", async () => {
        const { fake, ctx } = novo(perfil);
        const s = await gerarSituacaoDeLigacao(fake, ctx, "sinal_efemero");
        const sdp = s.avisos.find((a) => a.evento === "sdp")!;
        const r = fake.normalizarWebhook(JSON.parse(sdp.req.corpo));
        expect(r.fatos).toEqual([]);
        expect(r.pontas).toEqual([]);
        expect(r.sinais).toEqual([expect.objectContaining({ tipo: "sdp_resposta", providerCallId: s.providerCallId })]);
        expect(r.sinais[0]!.valor).toMatch(/^v=0/);
      });

      it("as pontas do aviso seguem a matriz do perfil", async () => {
        const { fake, ctx } = novo(perfil);
        const s = await gerarSituacaoDeLigacao(fake, ctx, "atendida");
        const fim = s.avisos.find((a) => a.evento === "fim")!;
        const cap = fake.capacidades.pontasNoAviso;
        expect(fim.ponta?.destinoE164 !== undefined).toBe(cap.destino);
        expect(fim.ponta?.origemExterna !== undefined).toBe(cap.origem);
      });
    });
  }

  it("o Fake nunca decide desfecho: o fato só traz a causa neutra (nada de status nem de resultado)", async () => {
    const { fake, ctx } = novo("ao_vivo");
    const s = await gerarSituacaoDeLigacao(fake, ctx, "ocupado");
    const fato = fimDe(fatosDosAvisos(fake, s.avisos))!;
    expect(Object.keys(fato)).not.toEqual(expect.arrayContaining(["status", "outcome", "resultado", "desfecho"]));
  });
});

// ---------------------------------------------------------------------------------------------------
// Registro: o Fake nunca entra em produção
// ---------------------------------------------------------------------------------------------------

describe("registro do Fake de ligação", () => {
  it("só entra com NODE_ENV=test, ou em desenvolvimento com LIGACAO_FAKE=on; em produção nunca", () => {
    expect(fakeDeLigacaoPermitido({ NODE_ENV: "test" })).toBe(true);
    expect(fakeDeLigacaoPermitido({ NODE_ENV: "development", LIGACAO_FAKE: "on" })).toBe(true);
    expect(fakeDeLigacaoPermitido({ NODE_ENV: "development" })).toBe(false);
    expect(fakeDeLigacaoPermitido({ NODE_ENV: "development", LIGACAO_FAKE: "off" })).toBe(false);
    expect(fakeDeLigacaoPermitido({ NODE_ENV: "production", LIGACAO_FAKE: "on" })).toBe(false);
    expect(fakeDeLigacaoPermitido({ LIGACAO_FAKE: "on" })).toBe(false);
    expect(fakeDeLigacaoPermitido({})).toBe(false);
  });

  it("com NODE_ENV=production o registro não tem o Fake, mesmo com LIGACAO_FAKE=on e comprovado pedido", () => {
    const r = criarRegistroDeLigacaoComFake({ env: { NODE_ENV: "production", LIGACAO_FAKE: "on" }, comprovado: true });
    expect(r.chaves()).toEqual([]);
    const registro = criarRegistroDeLigacao();
    expect(registrarFakeDeLigacao(registro, { env: { NODE_ENV: "production", LIGACAO_FAKE: "on" } })).toEqual([]);
    expect(registro.chaves()).toEqual([]);
  });

  it("o registro padrão do app não tem o Fake, e o Fake fica fora do barrel do contrato", () => {
    for (const chave of Object.values(CHAVES_DO_FAKE_DE_LIGACAO)) expect(registroPadraoDeLigacao.tem(chave)).toBe(false);
    const nomes = Object.keys(barrelDoContrato);
    expect(nomes.filter((n) => /Fake/i.test(n))).toEqual([]);
    expect(nomes).not.toContain("contratoDeProvedorDeLigacao");
  });

  it("em NODE_ENV=test registra os três perfis, coerentes, e o Fake NÃO é comprovado por padrão", () => {
    const r = criarRegistroDeLigacaoComFake({ env: { NODE_ENV: "test" } });
    expect(r.chaves()).toEqual(["fake_so_no_fim", "fake_ao_vivo", "fake_sem_consulta"]);
    for (const chave of r.chaves()) {
      expect(problemasDoRegistroDeLigacao(r.obter(chave)), chave).toEqual([]);
      expect(ehProvedorComprovado(chave, r), chave).toBe(false);
    }
  });

  it("o registro de teste pode marcar o Fake como comprovado, mas só em NODE_ENV=test", () => {
    const teste = criarRegistroDeLigacaoComFake({ env: { NODE_ENV: "test" }, comprovado: true, perfis: ["ao_vivo"] });
    expect(ehProvedorComprovado("fake_ao_vivo", teste)).toBe(true);
    const dev = criarRegistroDeLigacaoComFake({ env: { NODE_ENV: "development", LIGACAO_FAKE: "on" }, comprovado: true, perfis: ["ao_vivo"] });
    expect(dev.chaves()).toEqual(["fake_ao_vivo"]);
    expect(ehProvedorComprovado("fake_ao_vivo", dev)).toBe(false);
  });

  it("o registro pode devolver a MESMA instância, para o teste ponta a ponta enxergar o estado do Fake", async () => {
    const fake = new FakeProvedorDeLigacao({ perfil: "ao_vivo", chave: CHAVES_DO_FAKE_DE_LIGACAO.ao_vivo });
    const r = criarRegistroDeLigacaoComFake({ env: { NODE_ENV: "test" }, perfis: ["ao_vivo"], fakes: { ao_vivo: fake } });
    expect(r.obter("fake_ao_vivo").fabrica()).toBe(fake);
    expect(() => entradaDoFakeDeLigacao("ao_vivo", { fake: new FakeProvedorDeLigacao({ perfil: "ao_vivo" }) })).toThrow(/chave do perfil/);
  });

  it("nenhum erro do Fake é texto solto: todo erro que ele lança é neutro", async () => {
    const { fake, ctx } = novo("so_no_fim");
    const e = await fake.consultar!(ctx, "pc_que_nao_existe").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErroDeLigacao);
  });
});
