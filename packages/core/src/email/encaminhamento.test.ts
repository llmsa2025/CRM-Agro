import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { env } from "@crmagro/config";
import { basePrisma, encryptCredentials, estaCifrado, runWithTeam } from "@crmagro/db";
import { ForbiddenError } from "../auth/authz";
import { OwnedNotFound } from "../tenancy/assert-owned";
import { deleteEmailAccount } from "./service";
import {
  EntradaDeEmailDesligada,
  acharEncaminhamentoPeloToken,
  desligarEncaminhamento,
  entradaDeEmailLigada,
  estadoDoEncaminhamento,
  garantirEncaminhamento,
  gerarEncaminhamento,
  obterEncaminhamento,
} from "./encaminhamento";
import { CABECALHOS_ENTRADA, assinaturaDaEntrada, conferirAssinaturaDaEntrada, hashDoToken, tokenDoEndereco } from "./entrada-assinatura";

/**
 * Endereço de encaminhamento por caixa (ficha E2). Dois times (A e B) e, no A,
 * cinco pessoas: dono (owner), adm (admin), ana e bia (member) e leitor (viewer).
 * A caixa de e-mail é da Ana.
 */
const A = "00000000-0000-0000-0000-0000000e2a01";
const B = "00000000-0000-0000-0000-0000000e2a02";
const DOMINIO = "in.crmagro.example";
const sufixo = Math.random().toString(36).slice(2, 7);

let dono = "", adm = "", ana = "", bia = "", leitor = "";
let caixaDaAna = "", caixaDeB = "";

const comoAna = <T>(fn: () => Promise<T>) => runWithTeam(A, fn, { userId: ana, role: "member" });
const comoBia = <T>(fn: () => Promise<T>) => runWithTeam(A, fn, { userId: bia, role: "member" });
const comoAdm = <T>(fn: () => Promise<T>) => runWithTeam(A, fn, { userId: adm, role: "admin" });
const comoDono = <T>(fn: () => Promise<T>) => runWithTeam(A, fn, { userId: dono, role: "owner" });
const comoLeitor = <T>(fn: () => Promise<T>) => runWithTeam(A, fn, { userId: leitor, role: "viewer" });
const comoDeB = <T>(fn: () => Promise<T>) => runWithTeam(B, fn, { userId: "usuario-do-time-b", role: "owner" });

const envAntes = { dominio: env.EMAIL_ENTRADA_DOMINIO, segredo: env.EMAIL_ENTRADA_SEGREDO };

async function limpar() {
  for (const teamId of [A, B]) {
    await basePrisma.emailEncaminhamento.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
    await basePrisma.user.deleteMany({ where: { teamId } });
  }
}

const credenciaisDeCaixa = (usuario: string) =>
  encryptCredentials({ host: "smtp.teste.invalid", port: 465, user: usuario, pass: "x", from: usuario }) as unknown as object;

beforeAll(async () => {
  Object.assign(env, { EMAIL_ENTRADA_DOMINIO: DOMINIO, EMAIL_ENTRADA_SEGREDO: "s".repeat(40) });
  for (const [id, name] of [[A, "Encaminhamento A (test)"], [B, "Encaminhamento B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await limpar();
  const pessoa = async (nome: string, role: string) =>
    (await basePrisma.user.create({ data: { teamId: A, name: nome, email: `${nome}-${sufixo}@encaminhamento.dev`, role } })).id;
  dono = await pessoa("dono", "owner");
  adm = await pessoa("adm", "admin");
  ana = await pessoa("ana", "member");
  bia = await pessoa("bia", "member");
  leitor = await pessoa("leitor", "viewer");
  caixaDaAna = (
    await basePrisma.channelAccount.create({
      data: { teamId: A, canal: "email", label: "Caixa da Ana", provider: "smtp", ownerId: ana, credentials: credenciaisDeCaixa("ana@gmail.com") as never },
    })
  ).id;
  caixaDeB = (
    await basePrisma.channelAccount.create({
      data: { teamId: B, canal: "email", label: "Caixa de B", provider: "smtp", credentials: credenciaisDeCaixa("b@gmail.com") as never },
    })
  ).id;
});

afterAll(async () => {
  Object.assign(env, { EMAIL_ENTRADA_DOMINIO: envAntes.dominio, EMAIL_ENTRADA_SEGREDO: envAntes.segredo });
  await limpar();
});

describe("assinatura da entrega (contrato da E1)", () => {
  const segredo = "segredo-de-teste";
  const campos = {
    carimbo: "1790000000",
    chegada: "1790000000000",
    para: "r+abc123@in.crmagro.example",
    de: "ana+caf_=r+abc123=in.crmagro.example@gmail.com",
    tamanho: "5",
    truncado: "0",
  };
  const corpo = Buffer.from("Oi!\r\n");
  const assinatura = "885c5f9bee832e18642aa30cb8264ca7e1d4db9238e9ab858b877c54805899b8";

  it("bate com o vetor de teste do Worker", () => {
    expect(createHash("sha256").update(corpo).digest("hex")).toBe("46bd072a166223a64d5e43ce01a42ff41ceec92d4abc2db613a7ea7175780e78");
    expect(assinaturaDaEntrada(segredo, campos, corpo)).toBe(assinatura);
    expect(conferirAssinaturaDaEntrada(segredo, { ...campos, assinatura }, corpo, 1790000000000)).toBe(true);
    // Com o relógio de hoje, o carimbo de 21/09 está fora da tolerância.
    expect(conferirAssinaturaDaEntrada(segredo, { ...campos, assinatura }, corpo)).toBe(false);
  });

  it("recusa corpo alterado, carimbo velho, segredo errado e assinatura de outro tamanho", () => {
    expect(conferirAssinaturaDaEntrada(segredo, { ...campos, assinatura }, Buffer.from("Oi?\r\n"), 1790000000000)).toBe(false);
    expect(conferirAssinaturaDaEntrada(segredo, { ...campos, assinatura }, corpo, 1790000000000 + 301_000)).toBe(false);
    expect(conferirAssinaturaDaEntrada(segredo, { ...campos, assinatura }, corpo, 1790000000000 + 300_000)).toBe(true);
    expect(conferirAssinaturaDaEntrada("outro-segredo", { ...campos, assinatura }, corpo, 1790000000000)).toBe(false);
    expect(() => conferirAssinaturaDaEntrada(segredo, { ...campos, assinatura: "abc" }, corpo, 1790000000000)).not.toThrow();
    expect(conferirAssinaturaDaEntrada(segredo, { ...campos, assinatura: "abc" }, corpo, 1790000000000)).toBe(false);
    expect(conferirAssinaturaDaEntrada(segredo, { ...campos, assinatura: "" }, corpo, 1790000000000)).toBe(false);
    expect(conferirAssinaturaDaEntrada(segredo, { ...campos, carimbo: "", assinatura }, corpo, 1790000000000)).toBe(false);
  });

  it("os nomes dos cabeçalhos são os do contrato", () => {
    expect(Object.values(CABECALHOS_ENTRADA)).toEqual([
      "x-crmagro-carimbo",
      "x-crmagro-chegada",
      "x-crmagro-para",
      "x-crmagro-de",
      "x-crmagro-tamanho",
      "x-crmagro-truncado",
      "x-crmagro-assinatura",
    ]);
  });
});

describe("tokenDoEndereco", () => {
  const token = "0123456789abcdef0123456789abcdef";

  it("devolve o código do endereço certo, sem ligar para maiúsculas nem espaços", () => {
    expect(tokenDoEndereco(`r+${token}@${DOMINIO}`, DOMINIO)).toBe(token);
    expect(tokenDoEndereco(`  R+${token.toUpperCase()}@IN.CRMAGRO.EXAMPLE `, DOMINIO)).toBe(token);
  });

  it("recusa outro domínio, código curto, outro prefixo e domínio com sufixo", () => {
    expect(tokenDoEndereco(`r+${token}@outro.com`, DOMINIO)).toBeNull();
    expect(tokenDoEndereco(`r+abc@${DOMINIO}`, DOMINIO)).toBeNull();
    expect(tokenDoEndereco(`x+${token}@${DOMINIO}`, DOMINIO)).toBeNull();
    expect(tokenDoEndereco(`r+${token}@${DOMINIO}.evil.com`, DOMINIO)).toBeNull();
    expect(tokenDoEndereco(`r+${token}@inXcrmagro.example`, DOMINIO)).toBeNull(); // o ponto do domínio é literal
    expect(tokenDoEndereco(`r+${token}@${DOMINIO}`, "")).toBeNull();
  });
});

describe("entradaDeEmailLigada", () => {
  it("só liga com domínio válido e segredo de 32 caracteres ou mais", () => {
    expect(entradaDeEmailLigada()).toEqual({ dominio: DOMINIO, segredo: "s".repeat(40) });
    const antes = { d: env.EMAIL_ENTRADA_DOMINIO, s: env.EMAIL_ENTRADA_SEGREDO };
    try {
      Object.assign(env, { EMAIL_ENTRADA_SEGREDO: "curto" });
      expect(entradaDeEmailLigada()).toBeNull();
      Object.assign(env, { EMAIL_ENTRADA_SEGREDO: "s".repeat(40), EMAIL_ENTRADA_DOMINIO: "sem-ponto" });
      expect(entradaDeEmailLigada()).toBeNull();
      Object.assign(env, { EMAIL_ENTRADA_DOMINIO: "" });
      expect(entradaDeEmailLigada()).toBeNull();
      Object.assign(env, { EMAIL_ENTRADA_DOMINIO: DOMINIO, EMAIL_ENTRADA_SEGREDO: "" });
      expect(entradaDeEmailLigada()).toBeNull();
    } finally {
      Object.assign(env, { EMAIL_ENTRADA_DOMINIO: antes.d, EMAIL_ENTRADA_SEGREDO: antes.s });
    }
  });
});

describe("gerar o endereço", () => {
  it("a Ana gera na caixa dela: endereço certo, hash para achar, token só cifrado", async () => {
    const dto = await comoAna(() => gerarEncaminhamento(caixaDaAna));
    expect(dto.endereco).toMatch(new RegExp(`^r\\+[0-9a-f]{32}@${DOMINIO.replace(/\./g, "\\.")}$`));
    expect(dto.estado).toBe("aguardando_confirmacao");
    expect(dto.linkConfirmacao).toBeNull();
    expect(dto.recusados).toBe(0);

    const token = tokenDoEndereco(dto.endereco!, DOMINIO)!;
    const linha = await basePrisma.emailEncaminhamento.findUniqueOrThrow({ where: { channelAccountId: caixaDaAna } });
    expect(linha.teamId).toBe(A);
    expect(linha.tokenHash).toBe(hashDoToken(token));
    expect(estaCifrado(linha.tokenCifrado)).toBe(true);
    expect(JSON.stringify(linha)).not.toContain(token);
  });

  it("obter devolve o mesmo endereço (decifra de novo)", async () => {
    const gerado = await comoAna(() => gerarEncaminhamento(caixaDaAna));
    const lido = await comoAna(() => obterEncaminhamento(caixaDaAna));
    expect(lido?.endereco).toBe(gerado.endereco);
  });

  it("gerar de novo troca o endereço, zera o estado e mata o antigo", async () => {
    const primeiro = await comoAna(() => gerarEncaminhamento(caixaDaAna));
    const tokenAntigo = tokenDoEndereco(primeiro.endereco!, DOMINIO)!;
    await basePrisma.emailEncaminhamento.update({
      where: { channelAccountId: caixaDaAna },
      data: { confirmadoEm: new Date(), ultimoRecebidoEm: new Date(), recusados: 3, ultimoRecusadoEm: new Date(), confirmacaoEm: new Date() },
    });

    const segundo = await comoAna(() => gerarEncaminhamento(caixaDaAna));
    expect(segundo.endereco).not.toBe(primeiro.endereco);
    expect(segundo.estado).toBe("aguardando_confirmacao");
    expect(segundo.recusados).toBe(0);
    expect(segundo.confirmadoEm).toBeNull();
    expect(await acharEncaminhamentoPeloToken(tokenAntigo)).toBeNull();
    expect(await basePrisma.emailEncaminhamento.count({ where: { channelAccountId: caixaDaAna } })).toBe(1);
  });

  it("acharEncaminhamentoPeloToken devolve só ids", async () => {
    const dto = await comoAna(() => gerarEncaminhamento(caixaDaAna));
    const achou = await acharEncaminhamentoPeloToken(tokenDoEndereco(dto.endereco!, DOMINIO)!);
    expect(achou).toEqual({ id: expect.any(String), teamId: A, channelAccountId: caixaDaAna });
    expect(await acharEncaminhamentoPeloToken("0".repeat(32))).toBeNull();
  });
});

describe("garantir o endereço (o que o assistente chama ao abrir)", () => {
  it("cria quando a caixa não tem e devolve o mesmo endereço nas próximas chamadas", async () => {
    await basePrisma.emailEncaminhamento.deleteMany({ where: { channelAccountId: caixaDaAna } });
    expect(await comoAna(() => obterEncaminhamento(caixaDaAna))).toBeNull();
    const primeiro = await comoAna(() => garantirEncaminhamento(caixaDaAna));
    expect(primeiro.endereco).toMatch(/^r\+[0-9a-f]{32}@/);
    expect(primeiro.estado).toBe("aguardando_confirmacao");
    const segundo = await comoAna(() => garantirEncaminhamento(caixaDaAna));
    expect(segundo.endereco).toBe(primeiro.endereco);
    expect(await basePrisma.emailEncaminhamento.count({ where: { channelAccountId: caixaDaAna } })).toBe(1);
  });

  it("★ NUNCA troca o endereço que já existe, nem mexe no estado (quem já colou no Gmail não perde nada)", async () => {
    const gerado = await comoAna(() => gerarEncaminhamento(caixaDaAna));
    await basePrisma.emailEncaminhamento.update({
      where: { channelAccountId: caixaDaAna },
      data: { confirmadoEm: new Date(), ultimoRecebidoEm: new Date(), confirmacaoEm: new Date(), recusados: 2 },
    });
    const garantido = await comoAna(() => garantirEncaminhamento(caixaDaAna));
    expect(garantido.endereco).toBe(gerado.endereco);
    expect(garantido.estado).toBe("funcionando");
    expect(garantido.recusados).toBe(2);
    expect(await acharEncaminhamentoPeloToken(tokenDoEndereco(gerado.endereco!, DOMINIO)!)).not.toBeNull();
  });

  it("★ duas aberturas ao mesmo tempo terminam com o MESMO endereço (uma linha só)", async () => {
    for (let rodada = 0; rodada < 5; rodada++) {
      await basePrisma.emailEncaminhamento.deleteMany({ where: { channelAccountId: caixaDaAna } });
      const [a, b, c] = await Promise.all([
        comoAna(() => garantirEncaminhamento(caixaDaAna)),
        comoAna(() => garantirEncaminhamento(caixaDaAna)),
        comoAna(() => garantirEncaminhamento(caixaDaAna)),
      ]);
      expect(b.endereco, `rodada ${rodada}`).toBe(a.endereco);
      expect(c.endereco, `rodada ${rodada}`).toBe(a.endereco);
      expect(await basePrisma.emailEncaminhamento.count({ where: { channelAccountId: caixaDaAna } })).toBe(1);
      // O endereço mostrado a todas as telas é o que ficou valendo.
      const noBanco = await comoAna(() => obterEncaminhamento(caixaDaAna));
      expect(noBanco?.endereco).toBe(a.endereco);
    }
  });

  it("segue as mesmas regras de quem pode: a Bia não, o leitor não, o time B não; entrada desligada lança", async () => {
    await basePrisma.emailEncaminhamento.deleteMany({ where: { channelAccountId: caixaDaAna } });
    await expect(comoBia(() => garantirEncaminhamento(caixaDaAna))).rejects.toBeInstanceOf(OwnedNotFound);
    await expect(comoLeitor(() => garantirEncaminhamento(caixaDaAna))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(comoDeB(() => garantirEncaminhamento(caixaDaAna))).rejects.toBeInstanceOf(OwnedNotFound);
    expect(await basePrisma.emailEncaminhamento.count({ where: { channelAccountId: caixaDaAna } })).toBe(0);
    const antes = { dominio: env.EMAIL_ENTRADA_DOMINIO, segredo: env.EMAIL_ENTRADA_SEGREDO };
    Object.assign(env, { EMAIL_ENTRADA_DOMINIO: undefined, EMAIL_ENTRADA_SEGREDO: undefined });
    try {
      await expect(comoAna(() => garantirEncaminhamento(caixaDaAna))).rejects.toBeInstanceOf(EntradaDeEmailDesligada);
    } finally {
      Object.assign(env, { EMAIL_ENTRADA_DOMINIO: antes.dominio, EMAIL_ENTRADA_SEGREDO: antes.segredo });
    }
  });
});

describe("duas pessoas no mesmo time", () => {
  it("a Bia (membro, sem ver tudo) não gera na caixa da Ana; o administrador gera; o leitor não pode", async () => {
    await expect(comoBia(() => gerarEncaminhamento(caixaDaAna))).rejects.toBeInstanceOf(OwnedNotFound);
    expect(await comoBia(() => obterEncaminhamento(caixaDaAna))).toBeNull();
    await expect(comoBia(() => desligarEncaminhamento(caixaDaAna))).rejects.toBeInstanceOf(OwnedNotFound);

    const doAdm = await comoAdm(() => gerarEncaminhamento(caixaDaAna));
    expect(doAdm.endereco).toMatch(/^r\+[0-9a-f]{32}@/);

    await expect(comoLeitor(() => gerarEncaminhamento(caixaDaAna))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(comoLeitor(() => desligarEncaminhamento(caixaDaAna))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("quem vê a caixa mas não é o dono nem administrador não gera (D8)", async () => {
    // A Bia ganha "ver e editar de todos" em Conversas: vê a caixa da Ana, mas não é dona nem admin.
    const comoBiaVendoTudo = <T>(fn: () => Promise<T>) =>
      runWithTeam(A, fn, { userId: bia, role: "member", verTudoEm: ["conversas"], editarTudoEm: ["conversas"] });
    await expect(comoBiaVendoTudo(() => gerarEncaminhamento(caixaDaAna))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("desligar apaga o endereço e o antigo deixa de valer", async () => {
    const dto = await comoAna(() => gerarEncaminhamento(caixaDaAna));
    const token = tokenDoEndereco(dto.endereco!, DOMINIO)!;
    await comoAna(() => desligarEncaminhamento(caixaDaAna));
    expect(await comoAna(() => obterEncaminhamento(caixaDaAna))).toBeNull();
    expect(await acharEncaminhamentoPeloToken(token)).toBeNull();
  });
});

describe("dois times", () => {
  it("o time B não gera, não lê e não desliga o endereço da caixa do time A", async () => {
    const dto = await comoAna(() => gerarEncaminhamento(caixaDaAna));
    const token = tokenDoEndereco(dto.endereco!, DOMINIO)!;

    await expect(comoDeB(() => gerarEncaminhamento(caixaDaAna))).rejects.toBeInstanceOf(OwnedNotFound);
    await expect(comoDeB(() => desligarEncaminhamento(caixaDaAna))).rejects.toBeInstanceOf(OwnedNotFound);
    expect(await comoDeB(() => obterEncaminhamento(caixaDaAna))).toBeNull();

    // O webhook (sem time no contexto) acha o time certo pelo código.
    expect((await acharEncaminhamentoPeloToken(token))?.teamId).toBe(A);
    // E o endereço do A continua de pé.
    expect((await comoAna(() => obterEncaminhamento(caixaDaAna)))?.endereco).toBe(dto.endereco);
  });

  it("a caixa do time B gera o endereço dela sem mexer no do A", async () => {
    const doA = await comoAna(() => gerarEncaminhamento(caixaDaAna));
    const doB = await comoDeB(() => gerarEncaminhamento(caixaDeB));
    expect(doB.endereco).not.toBe(doA.endereco);
    expect((await acharEncaminhamentoPeloToken(tokenDoEndereco(doB.endereco!, DOMINIO)!))?.teamId).toBe(B);
    await comoDeB(() => desligarEncaminhamento(caixaDeB));
    expect((await comoAna(() => obterEncaminhamento(caixaDaAna)))?.endereco).toBe(doA.endereco);
  });
});

describe("entrada desligada", () => {
  it("sem domínio no .env, gerar lança e obter devolve null", async () => {
    const antes = env.EMAIL_ENTRADA_DOMINIO;
    try {
      Object.assign(env, { EMAIL_ENTRADA_DOMINIO: "" });
      await expect(comoAna(() => gerarEncaminhamento(caixaDaAna))).rejects.toBeInstanceOf(EntradaDeEmailDesligada);
      expect(await comoAna(() => obterEncaminhamento(caixaDaAna))).toBeNull();
    } finally {
      Object.assign(env, { EMAIL_ENTRADA_DOMINIO: antes });
    }
  });
});

describe("apagar a caixa", () => {
  it("a linha do encaminhamento some junto (cascade)", async () => {
    const caixa = (
      await basePrisma.channelAccount.create({
        data: { teamId: A, canal: "email", label: "Caixa que vai sumir", provider: "smtp", ownerId: ana, credentials: credenciaisDeCaixa("sumir@gmail.com") as never },
      })
    ).id;
    await comoAna(() => gerarEncaminhamento(caixa));
    expect(await basePrisma.emailEncaminhamento.count({ where: { channelAccountId: caixa } })).toBe(1);

    await comoDono(() => deleteEmailAccount(caixa));
    expect(await basePrisma.emailEncaminhamento.count({ where: { channelAccountId: caixa } })).toBe(0);
  });
});

describe("estadoDoEncaminhamento", () => {
  const agora = new Date("2026-10-01T12:00:00Z");
  const dia = (d: string) => new Date(`${d}Z`);

  it.each([
    ["sem confirmação e sem link", { confirmadoEm: null, temLink: false, ultimoRecebidoEm: null }, "aguardando_confirmacao"],
    ["sem confirmação e com link", { confirmadoEm: null, temLink: true, ultimoRecebidoEm: null }, "confirmar"],
    ["recebeu há 2 dias", { confirmadoEm: dia("2026-09-20T10:00:00"), temLink: true, ultimoRecebidoEm: dia("2026-09-29T12:00:00") }, "funcionando"],
    ["recebeu há exatamente 3 dias", { confirmadoEm: dia("2026-09-20T10:00:00"), temLink: false, ultimoRecebidoEm: dia("2026-09-28T12:00:00") }, "funcionando"],
    ["recebeu há mais de 3 dias", { confirmadoEm: dia("2026-09-20T10:00:00"), temLink: false, ultimoRecebidoEm: dia("2026-09-28T11:59:00") }, "sem_email_recente"],
    ["confirmou há mais de 3 dias e nunca mais recebeu", { confirmadoEm: dia("2026-09-20T10:00:00"), temLink: false, ultimoRecebidoEm: null }, "sem_email_recente"],
  ] as const)("%s", (_nome, base, esperado) => {
    expect(estadoDoEncaminhamento(base, agora)).toBe(esperado);
  });
});

describe("não deu para decifrar", () => {
  it("chave desconhecida: devolve o DTO com endereco null, sem lançar", async () => {
    await comoAna(() => gerarEncaminhamento(caixaDaAna));
    await basePrisma.emailEncaminhamento.update({
      where: { channelAccountId: caixaDaAna },
      data: { tokenCifrado: { v: 2, kid: "ffffffff", iv: "AAAA", tag: "AAAA", data: "AAAA" } },
    });
    const dto = await comoAna(() => obterEncaminhamento(caixaDaAna));
    expect(dto).not.toBeNull();
    expect(dto?.endereco).toBeNull();
    expect(dto?.estado).toBe("aguardando_confirmacao");
  });
});
