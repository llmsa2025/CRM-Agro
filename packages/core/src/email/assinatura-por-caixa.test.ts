import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { ForbiddenError } from "../auth/authz";
import {
  ASSINATURA_PADRAO_DA_CAIXA,
  CaixaDeEmailNaoEncontrada,
  adotarAssinaturasSemCaixa,
  assinaturaDoEnvio,
  createSignature,
  deleteSignature,
  listSignatures,
  updateSignature,
} from "./signatures";

/**
 * Assinatura de e-mail POR CAIXA (ajuste do dono, 28/09): cada caixa tem as
 * suas assinaturas e a sua padrão; o envio usa a da caixa que envia; quem vê
 * a caixa (escopo F3) vê as assinaturas dela.
 */
const TEAM = "00000000-0000-0000-0000-0000000a5510";
const OUTRO = "00000000-0000-0000-0000-0000000a5511";
const sufixo = Math.random().toString(36).slice(2, 7);
let master = "", vendedor = "";
let caixa1 = "", caixa2 = "", whatsapp = "", caixaDeOutroTime = "";

const comoMaster = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: master, role: "owner" });
const comoVendedor = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: vendedor, role: "member" });

async function limpar() {
  for (const teamId of [TEAM, OUTRO]) {
    await basePrisma.emailSignature.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
    await basePrisma.user.deleteMany({ where: { teamId } });
  }
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Assinatura por caixa (test)"], [OUTRO, "Outro time (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await limpar();
  const mk = (n: string, role: string) =>
    basePrisma.user.create({ data: { teamId: TEAM, name: n, email: `${n}-${sufixo}@assinatura.dev`, role } });
  master = (await mk("master", "owner")).id;
  vendedor = (await mk("vendedor", "member")).id;
  const conta = (teamId: string, canal: "email" | "whatsapp", label: string, ownerId: string | null) =>
    basePrisma.channelAccount.create({ data: { teamId, canal, label, provider: canal === "email" ? "smtp" : "evolution", ownerId } });
  caixa1 = (await conta(TEAM, "email", "Caixa do master", master)).id;
  caixa2 = (await conta(TEAM, "email", "Caixa do vendedor", vendedor)).id;
  whatsapp = (await conta(TEAM, "whatsapp", "WhatsApp", master)).id;
  caixaDeOutroTime = (await conta(OUTRO, "email", "Caixa alheia", null)).id;
});

beforeEach(async () => {
  await basePrisma.emailSignature.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
});

afterAll(async () => {
  await limpar();
});

describe("assinaturas por caixa", () => {
  it("cada caixa tem as suas e a sua padrão; marcar padrão só mexe na mesma caixa", async () => {
    const comercial = await comoMaster(() => createSignature({ channelAccountId: caixa1, nome: "Comercial", html: "<b>1</b>" }));
    expect(comercial.isDefault).toBe(true); // a primeira da caixa vira a padrão
    const suporte = await comoMaster(() => createSignature({ channelAccountId: caixa1, nome: "Suporte", html: "<i>1</i>" }));
    expect(suporte.isDefault).toBe(false);
    const doVendedor = await comoMaster(() => createSignature({ channelAccountId: caixa2, nome: "Vendedor", html: "<b>2</b>" }));
    expect(doVendedor.isDefault).toBe(true); // a padrão da caixa 2 não derruba a da caixa 1

    const daCaixa1 = await comoMaster(() => listSignatures({ channelAccountId: caixa1 }));
    expect(daCaixa1.map((s) => s.nome)).toEqual(["Comercial", "Suporte"]);
    expect(daCaixa1.every((s) => s.channelAccountId === caixa1 && s.caixa === "Caixa do master")).toBe(true);

    await comoMaster(() => updateSignature(suporte.id, { isDefault: true }));
    const padroes = await basePrisma.emailSignature.findMany({ where: { teamId: TEAM, isDefault: true }, select: { id: true } });
    expect(padroes.map((p) => p.id).sort()).toEqual([suporte.id, doVendedor.id].sort());
  });

  it("apagar a padrão passa a padrão para a que sobrou na caixa", async () => {
    const a = await comoMaster(() => createSignature({ channelAccountId: caixa1, nome: "A", html: "a" }));
    const b = await comoMaster(() => createSignature({ channelAccountId: caixa1, nome: "B", html: "b" }));
    await comoMaster(() => deleteSignature(a.id));
    expect((await basePrisma.emailSignature.findUniqueOrThrow({ where: { id: b.id } })).isDefault).toBe(true);
  });

  it("caixa de outro time ou conta que não é de e-mail é recusada", async () => {
    await expect(comoMaster(() => createSignature({ channelAccountId: caixaDeOutroTime, nome: "X", html: "x" }))).rejects.toBeInstanceOf(
      CaixaDeEmailNaoEncontrada,
    );
    await expect(comoMaster(() => createSignature({ channelAccountId: whatsapp, nome: "X", html: "x" }))).rejects.toBeInstanceOf(
      CaixaDeEmailNaoEncontrada,
    );
    expect(await basePrisma.emailSignature.count({ where: { teamId: { in: [TEAM, OUTRO] } } })).toBe(0);
  });

  it("vendedor vê só as assinaturas da caixa dele e não gerencia assinatura", async () => {
    await comoMaster(() => createSignature({ channelAccountId: caixa1, nome: "Do master", html: "m" }));
    await comoMaster(() => createSignature({ channelAccountId: caixa2, nome: "Do vendedor", html: "v" }));
    const vistas = await comoVendedor(() => listSignatures());
    expect(vistas.map((s) => s.nome)).toEqual(["Do vendedor"]);
    expect(await comoVendedor(() => listSignatures({ channelAccountId: caixa1 }))).toEqual([]);
    await expect(comoVendedor(() => createSignature({ channelAccountId: caixa2, nome: "Y", html: "y" }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a caixa conectada adota as assinaturas antigas sem caixa", async () => {
    const antiga = await basePrisma.emailSignature.create({ data: { teamId: TEAM, nome: "Antiga", html: "old", isDefault: true } });
    await comoMaster(() => adotarAssinaturasSemCaixa(caixa1));
    expect((await basePrisma.emailSignature.findUniqueOrThrow({ where: { id: antiga.id } })).channelAccountId).toBe(caixa1);
  });
});

describe("assinatura do envio", () => {
  it("usa a escolhida se for da caixa que envia; senão, a padrão dessa caixa; sem escolha, nenhuma", async () => {
    const padrao1 = await comoMaster(() => createSignature({ channelAccountId: caixa1, nome: "Padrão 1", html: "P1" }));
    const outra1 = await comoMaster(() => createSignature({ channelAccountId: caixa1, nome: "Outra 1", html: "O1" }));
    await comoMaster(() => createSignature({ channelAccountId: caixa2, nome: "Padrão 2", html: "P2" }));
    expect(padrao1.isDefault).toBe(true);

    const envio = (sig: string | undefined, caixa: string) => comoMaster(() => assinaturaDoEnvio(sig, caixa));
    expect(await envio(outra1.id, caixa1)).toBe("O1");
    // Escolhida de OUTRA caixa: nunca sai; vale a padrão da caixa que envia.
    expect(await envio(outra1.id, caixa2)).toBe("P2");
    expect(await envio(ASSINATURA_PADRAO_DA_CAIXA, caixa1)).toBe("P1");
    expect(await envio("nao-existe", caixa2)).toBe("P2");
    expect(await envio(undefined, caixa1)).toBe("");
  });
});
