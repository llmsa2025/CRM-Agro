import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma, decryptCredentials } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { connectSocialAccount, contaSoPelaExtensao } from "./service";
import { verificarSessoesSociais, type ContaParaVerificar, type ResultadoVerificacao } from "./verificacao";

/**
 * Conta conectada pela EXTENSÃO: o servidor não valida nem abre navegador com o
 * cookie dela. Banco de
 * TESTE real; o "navegador" do worker é um verificador falso que só anota o que
 * recebeu. Nada é aberto nem enviado.
 */
const TEAM = "00000000-0000-0000-0000-0000000ec701";
const onde = { teamId: TEAM };

const cfgDe = async (id: string) => {
  const conta = await basePrisma.channelAccount.findUniqueOrThrow({ where: { id } });
  return decryptCredentials(conta.credentials) as { cookie: string; origem?: string; username?: string };
};
const contas = () => basePrisma.channelAccount.findMany({ where: { teamId: TEAM }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Origem Social (test)" } });
});
beforeEach(async () => {
  await basePrisma.channelAccount.deleteMany({ where: { teamId: TEAM } });
});

/** Verificador falso: anota as contas que recebeu e devolve o que o teste mandar. */
function verificadorFalso(resposta: ResultadoVerificacao | Error = { ok: true }) {
  const recebidas: ContaParaVerificar[] = [];
  const verificar = async (c: ContaParaVerificar) => {
    recebidas.push(c);
    if (resposta instanceof Error) throw resposta;
    return resposta;
  };
  return { verificar, recebidas };
}

describe("marca de origem", () => {
  it("só o valor exato 'extensao' vale", () => {
    expect(contaSoPelaExtensao({ origem: "extensao" })).toBe(true);
    for (const cfg of [null, undefined, {}, { origem: "" }, { origem: "Extensao" }, { origem: "manual" }, { origem: true }, { origem: ["extensao"] }]) {
      expect(contaSoPelaExtensao(cfg as never), JSON.stringify(cfg)).toBe(false);
    }
  });

  it("conexão pela extensão grava a marca, cifrada junto com o cookie", async () => {
    await runWithTeam(TEAM, () =>
      connectSocialAccount({ canal: "instagram", label: "@ana", cookie: "cookie-ext", username: "ana" }, { origem: "extensao" }),
    );
    const [conta] = await contas();
    expect(await cfgDe(conta!.id)).toMatchObject({ cookie: "cookie-ext", origem: "extensao", username: "ana" });
    // a marca não fica em claro no banco
    expect(JSON.stringify(conta!.credentials)).not.toContain("extensao");
  });

  it("cookie colado à mão NÃO leva a marca (continua validado pelo worker)", async () => {
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "linkedin", label: "Manual", cookie: "cookie-manual" }));
    const [conta] = await contas();
    expect(await cfgDe(conta!.id)).toEqual({ cookie: "cookie-manual" });
  });

  it("o cliente não escolhe a origem: campo estranho no input do formulário é ignorado", async () => {
    const inputDoNavegador = { canal: "linkedin", label: "Manual", cookie: "c", origem: "extensao" } as never;
    await runWithTeam(TEAM, () => connectSocialAccount(inputDoNavegador));
    const [conta] = await contas();
    expect((await cfgDe(conta!.id)).origem).toBeUndefined();
  });

  it("reconectar à mão uma conta da extensão tira a marca; reconectar pela extensão volta a pôr", async () => {
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "instagram", label: "@ana", cookie: "c1", username: "ana" }, { origem: "extensao" }));
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "instagram", label: "Instagram", cookie: "c2" }));
    let [conta] = await contas();
    expect(await cfgDe(conta!.id)).toEqual({ cookie: "c2" });
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "instagram", label: "@ana", cookie: "c3", username: "ana" }, { origem: "extensao" }));
    [conta] = await contas();
    expect(await cfgDe(conta!.id)).toMatchObject({ cookie: "c3", origem: "extensao" });
    expect(await contas()).toHaveLength(1);
  });
});

describe("verificação periódica de sessões (worker)", () => {
  async function criarContas() {
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "linkedin", label: "Manual", cookie: "cookie-manual" }));
    await runWithTeam(TEAM, () =>
      connectSocialAccount({ canal: "instagram", label: "@ana", cookie: "cookie-da-extensao", username: "ana" }, { origem: "extensao" }),
    );
  }

  it("o servidor NÃO verifica nem usa o cookie da conta da extensão; a manual continua verificada", async () => {
    await criarContas();
    const { verificar, recebidas } = verificadorFalso({ ok: true });
    const r = await verificarSessoesSociais(verificar, { onde });
    expect(r).toEqual({ verificadas: 1, puladasPelaExtensao: 1 });
    expect(recebidas.map((c) => c.cookie)).toEqual(["cookie-manual"]);
    expect(JSON.stringify(recebidas)).not.toContain("cookie-da-extensao");
  });

  it("sessão manual deslogada: conta pausada com erro; a da extensão não é tocada", async () => {
    await criarContas();
    const { verificar } = verificadorFalso({ ok: false, motivo: "deslogado", error: "sessão inválida" });
    await verificarSessoesSociais(verificar, { onde });
    const todas = await contas();
    const manual = todas.find((c) => c.canal === "linkedin")!;
    const daExtensao = todas.find((c) => c.canal === "instagram")!;
    expect(manual).toMatchObject({ status: "error", paused: true });
    expect(daExtensao).toMatchObject({ status: "connected", paused: false });
  });

  it("falha de rede na verificação mantém o status (não é sessão morta)", async () => {
    await criarContas();
    const { verificar } = verificadorFalso({ ok: false, motivo: "rede", error: "timeout" });
    await verificarSessoesSociais(verificar, { onde });
    for (const c of await contas()) expect(c).toMatchObject({ status: "connected", paused: false });
  });

  it("verificador que estoura não derruba a rodada", async () => {
    await criarContas();
    const { verificar } = verificadorFalso(new Error("chromium caiu"));
    await expect(verificarSessoesSociais(verificar, { onde })).resolves.toEqual({ verificadas: 1, puladasPelaExtensao: 1 });
    for (const c of await contas()) expect(c.status).toBe("connected");
  });

  it("só extensão no time: o verificador nunca é chamado", async () => {
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "instagram", label: "@ana", cookie: "c", username: "ana" }, { origem: "extensao" }));
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "linkedin", label: "@bia", cookie: "c2", username: "bia" }, { origem: "extensao" }));
    const { verificar, recebidas } = verificadorFalso();
    expect(await verificarSessoesSociais(verificar, { onde })).toEqual({ verificadas: 0, puladasPelaExtensao: 2 });
    expect(recebidas).toHaveLength(0);
  });

  it("conta antiga (sem marca) segue verificada até ser reconectada pela extensão", async () => {
    await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "instagram", label: "@antiga", provider: "instagram_browser", status: "connected", credentials: (await import("@crmagro/db")).encryptCredentials({ cookie: "cookie-antigo", username: "antiga" }) as never },
    });
    const { verificar, recebidas } = verificadorFalso();
    await verificarSessoesSociais(verificar, { onde });
    expect(recebidas.map((c) => c.cookie)).toEqual(["cookie-antigo"]);
  });

  it("conta já em erro não é reverificada (comportamento de sempre)", async () => {
    await runWithTeam(TEAM, () => connectSocialAccount({ canal: "linkedin", label: "Manual", cookie: "c" }));
    await basePrisma.channelAccount.updateMany({ where: { teamId: TEAM }, data: { status: "error", paused: true } });
    const { verificar, recebidas } = verificadorFalso();
    expect(await verificarSessoesSociais(verificar, { onde })).toEqual({ verificadas: 0, puladasPelaExtensao: 0 });
    expect(recebidas).toHaveLength(0);
  });
});
