import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { adicionarIdentificadorSeNovo, completarEnderecoDoContato } from "./complemento";

const TEAM = "00000000-0000-0000-0000-0000000005f4";
const adm = { userId: "ana", role: "admin" };
let contatoId: string;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Complemento (test)" } });
});
beforeEach(async () => {
  await basePrisma.channelIdentifier.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.contact.deleteMany({ where: { teamId: TEAM } });
  contatoId = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Maria" } })).id;
});
const add = (canal: "whatsapp" | "email", valor: string, id = contatoId) => runWithTeam(TEAM, () => adicionarIdentificadorSeNovo(id, canal, valor), adm);

describe("adicionarIdentificadorSeNovo", () => {
  it("o primeiro do canal vira o principal; os seguintes entram como extra", async () => {
    expect(await add("whatsapp", "(66) 99988-1234")).toBe("adicionado");
    expect(await add("whatsapp", "(11) 98888-7777")).toBe("adicionado");
    const linhas = await basePrisma.channelIdentifier.findMany({ where: { contactId: contatoId }, orderBy: { createdAt: "asc" } });
    expect(linhas.map((l) => [l.valor, l.isPrimary])).toEqual([["+5566999881234", true], ["+5511988887777", false]]);
  });

  it("não repete o que o contato já tem, mesmo escrito de outro jeito ou sem o nono dígito", async () => {
    await add("whatsapp", "+5566999881234");
    expect(await add("whatsapp", "66 99988-1234")).toBe("ja_tem");
    expect(await add("whatsapp", "(66) 9988-1234")).toBe("ja_tem");
    await add("email", "maria@fazenda.com.br");
    expect(await add("email", "MARIA@Fazenda.com.br")).toBe("ja_tem");
    expect(await basePrisma.channelIdentifier.count({ where: { contactId: contatoId } })).toBe(2);
  });

  it("número ou e-mail que é de outro contato do time não é gravado", async () => {
    const outro = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Outro" } })).id;
    await add("whatsapp", "+5566999881234", outro);
    expect(await add("whatsapp", "(66) 99988-1234")).toBe("de_outro_contato");
    expect(await basePrisma.channelIdentifier.count({ where: { contactId: contatoId } })).toBe(0);
  });

  it("valor inválido é recusado sem gravar; viewer não escreve", async () => {
    expect(await add("whatsapp", "123")).toBe("invalido");
    expect(await add("email", "sem-arroba")).toBe("invalido");
    await expect(runWithTeam(TEAM, () => adicionarIdentificadorSeNovo(contatoId, "email", "a@b.com.br"), { userId: "v", role: "viewer" })).rejects.toThrow();
  });
});

describe("completarEnderecoDoContato", () => {
  const completar = (e: Parameters<typeof completarEnderecoDoContato>[1]) => runWithTeam(TEAM, () => completarEnderecoDoContato(contatoId, e), adm);

  it("preenche só o que está vazio e põe o estado em maiúsculas", async () => {
    expect(await completar({ endereco: "Rua A, 1", cidade: "Sorriso", estado: "mt" })).toBe(true);
    expect(await basePrisma.contact.findUniqueOrThrow({ where: { id: contatoId } })).toMatchObject({ endereco: "Rua A, 1", cidade: "Sorriso", estado: "MT" });
  });

  it("não troca o que já existe e diz que nada mudou", async () => {
    await basePrisma.contact.update({ where: { id: contatoId }, data: { endereco: "Fazenda Boa Vista", cidade: "Sinop", estado: "MT" } });
    expect(await completar({ endereco: "Rua A, 1", cidade: "Sorriso", estado: "GO" })).toBe(false);
    expect(await basePrisma.contact.findUniqueOrThrow({ where: { id: contatoId } })).toMatchObject({ endereco: "Fazenda Boa Vista", cidade: "Sinop", estado: "MT" });
  });
});
