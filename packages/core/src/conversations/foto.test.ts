import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";

const evolution = vi.hoisted(() => ({ url: vi.fn(), baixar: vi.fn() }));
vi.mock("@crmagro/channels", async (orig) => ({
  ...(await orig<typeof import("@crmagro/channels")>()),
  fetchEvolutionProfilePictureUrl: evolution.url,
  baixarFotoDePerfil: evolution.baixar,
}));

import { runWithTeam } from "../test-support/identidade";
import { fotoDaConversa } from "./foto";

const TEAM = "00000000-0000-0000-0000-0000000f0701";
const OUTRO_TIME = "00000000-0000-0000-0000-0000000f0702";
const NUMERO = "+5566999881234";
const ENDERECO = "https://pps.whatsapp.net/v/foto.jpg";
const FOTO = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), tipo: "image/jpeg" as const };

const dono = { userId: "dono-foto", role: "owner" };
let vendedorA = "";
let vendedorB = "";
let contaA = "";
let contaB = "";

const como = <T>(fn: () => Promise<T>, id: { userId: string; role: string } = dono, time = TEAM) => runWithTeam(time, fn, id);

async function conversa(accountId: string | null, dados: Record<string, unknown> = {}) {
  return (
    await basePrisma.conversation.create({
      data: { teamId: TEAM, canal: "whatsapp", channelAccountId: accountId, externalNumber: NUMERO, ...dados },
    })
  ).id;
}

beforeAll(async () => {
  for (const id of [TEAM, OUTRO_TIME]) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: `Team Foto (test) ${id.slice(-4)}` } });
  }
});

beforeEach(async () => {
  evolution.url.mockReset().mockResolvedValue(ENDERECO);
  evolution.baixar.mockReset().mockResolvedValue(FOTO);
  for (const t of [TEAM, OUTRO_TIME]) {
    await basePrisma.conversation.deleteMany({ where: { teamId: t } });
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId: t } });
    await basePrisma.contact.deleteMany({ where: { teamId: t } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId: t } });
    await basePrisma.user.deleteMany({ where: { teamId: t } });
  }
  const sufixo = Math.random().toString(36).slice(2, 7);
  const mk = (nome: string) => basePrisma.user.create({ data: { teamId: TEAM, name: nome, email: `${nome}-${sufixo}@foto.dev`, role: "member" } });
  vendedorA = (await mk("a")).id;
  vendedorB = (await mk("b")).id;
  const conta = (ownerId: string, externalId: string, extra: Record<string, unknown> = {}) =>
    basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "whatsapp", label: "WhatsApp (teste)", provider: "evolution", externalId, status: "connected", ownerId, ...extra },
    });
  contaA = (await conta(vendedorA, "foto-test-a")).id;
  contaB = (await conta(vendedorB, "foto-test-b")).id;
});

describe("fotoDaConversa", () => {
  it("devolve a foto do contato, buscada pela instância da conta da conversa", async () => {
    const id = await conversa(contaA);
    const r = await como(() => fotoDaConversa(id));
    expect(r).toEqual({ estado: "ok", foto: FOTO });
    expect(evolution.url).toHaveBeenCalledWith(expect.objectContaining({ instance: "foto-test-a", numero: NUMERO }));
    expect(evolution.baixar).toHaveBeenCalledWith(ENDERECO);
  });

  it("usa o telefone do cadastro do contato quando a conversa está vinculada", async () => {
    const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Maria" } });
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contato.id, canal: "whatsapp", valor: "+5511988887777", isPrimary: true } });
    const id = await conversa(contaA, { contactId: contato.id, externalNumber: null });
    const r = await como(() => fotoDaConversa(id));
    expect(r.estado).toBe("ok");
    expect(evolution.url).toHaveBeenCalledWith(expect.objectContaining({ numero: "+5511988887777" }));
  });

  it("sem_foto quando a pessoa não tem foto ou a esconde", async () => {
    evolution.url.mockResolvedValue(null);
    const id = await conversa(contaA);
    expect(await como(() => fotoDaConversa(id))).toEqual({ estado: "sem_foto" });
    expect(evolution.baixar).not.toHaveBeenCalled();
  });

  it("sem_foto quando o endereço não vira uma imagem aceita", async () => {
    evolution.baixar.mockResolvedValue(null);
    const id = await conversa(contaA);
    expect(await como(() => fotoDaConversa(id))).toEqual({ estado: "sem_foto" });
  });

  it("indisponivel quando o WhatsApp não responde, sem derrubar a tela", async () => {
    evolution.url.mockRejectedValue(new Error("timeout"));
    const id = await conversa(contaA);
    expect(await como(() => fotoDaConversa(id))).toEqual({ estado: "indisponivel" });
  });

  it("indisponivel quando o número está desconectado, sem perguntar à Evolution", async () => {
    await basePrisma.channelAccount.update({ where: { id: contaA }, data: { status: "disconnected" } });
    const id = await conversa(contaA);
    expect(await como(() => fotoDaConversa(id))).toEqual({ estado: "indisponivel" });
    expect(evolution.url).not.toHaveBeenCalled();
  });

  it("sem_foto para conversa antiga só com @lid (não há telefone para perguntar)", async () => {
    const id = await conversa(contaA, { externalNumber: "123456789@lid" });
    expect(await como(() => fotoDaConversa(id))).toEqual({ estado: "sem_foto" });
    expect(evolution.url).not.toHaveBeenCalled();
  });

  it("sem_foto para canal que não é WhatsApp e para provedor que não sabe buscar foto", async () => {
    const email = await conversa(contaA, { canal: "email", externalNumber: "alguem@exemplo.com" });
    expect(await como(() => fotoDaConversa(email))).toEqual({ estado: "sem_foto" });
    await basePrisma.channelAccount.update({ where: { id: contaB }, data: { provider: "cloud_api" } });
    const oficial = await conversa(contaB);
    expect(await como(() => fotoDaConversa(oficial))).toEqual({ estado: "sem_foto" });
    expect(evolution.url).not.toHaveBeenCalled();
  });

  it("sem_foto para conversa que não existe", async () => {
    expect(await como(() => fotoDaConversa("00000000-0000-0000-0000-000000000000"))).toEqual({ estado: "sem_foto" });
  });

  it("não entrega a foto de uma conversa de outro time", async () => {
    const id = await conversa(contaA);
    expect(await como(() => fotoDaConversa(id), dono, OUTRO_TIME)).toEqual({ estado: "sem_foto" });
    expect(evolution.url).not.toHaveBeenCalled();
  });

  it("vendedor só vê a foto das conversas do número que conectou", async () => {
    const doA = await conversa(contaA);
    const doB = await conversa(contaB, { externalNumber: "+5566988776655" });
    const a = { userId: vendedorA, role: "member" };
    expect((await como(() => fotoDaConversa(doA), a)).estado).toBe("ok");
    expect(await como(() => fotoDaConversa(doB), a)).toEqual({ estado: "sem_foto" });
    // O dono do time vê as duas.
    expect((await como(() => fotoDaConversa(doB))).estado).toBe("ok");
  });

  it("segura o excesso de buscas simultâneas ao WhatsApp", async () => {
    let ativas = 0;
    let pico = 0;
    evolution.url.mockImplementation(async () => {
      ativas++;
      pico = Math.max(pico, ativas);
      await new Promise((r) => setTimeout(r, 15));
      ativas--;
      return ENDERECO;
    });
    const ids = await Promise.all(Array.from({ length: 12 }, (_, i) => conversa(contaA, { externalNumber: `+556699900${String(i).padStart(4, "0")}` })));
    const r = await como(() => Promise.all(ids.map((id) => fotoDaConversa(id))));
    expect(r.every((x) => x.estado === "ok")).toBe(true);
    expect(pico).toBeLessThanOrEqual(4);
    expect(evolution.url).toHaveBeenCalledTimes(12);
  });
});
