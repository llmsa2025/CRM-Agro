import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { ForbiddenError } from "../auth/authz";
import { lerPlanilha, montarRegistros, sugerirMapeamento } from "./planilha";
import { previewImport } from "./service";
import { MapeamentoInvalido, PlanilhaVazia } from "./errors";

/**
 * Importação em 4 passos (produto §C) — a PRÉVIA: sugere o mapeamento e conta
 * novos / já existem / repetidos / inválidos sem gravar nada. Planilha gerada
 * aqui (nada de arquivo real de cliente).
 */

const TEAM_A = "00000000-0000-0000-0000-0000000001a7";
const TEAM_B = "00000000-0000-0000-0000-0000000001a8";
const TIMES = [TEAM_A, TEAM_B];

async function limpar() {
  const where = { teamId: { in: TIMES } };
  await basePrisma.importJob.deleteMany({ where });
  await basePrisma.channelIdentifier.deleteMany({ where });
  await basePrisma.contact.deleteMany({ where });
}

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Time A (agente A — importação)"],
    [TEAM_B, "Time B (agente A — importação)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});
beforeEach(limpar);
afterAll(limpar);

async function contato(teamId: string, nome: string, idents: { whatsapp?: string; email?: string }) {
  const c = await basePrisma.contact.create({ data: { teamId, nome } });
  const rows = [
    ...(idents.whatsapp ? [{ teamId, contactId: c.id, canal: "whatsapp" as const, valor: idents.whatsapp, isPrimary: true }] : []),
    ...(idents.email ? [{ teamId, contactId: c.id, canal: "email" as const, valor: idents.email, isPrimary: true }] : []),
  ];
  if (rows.length) await basePrisma.channelIdentifier.createMany({ data: rows });
  return c.id;
}

/** Celular de teste no formato de planilha: (65) 9XXXX-XXXX. */
const cel = (n: number) => {
  const d = String(90_000_000 + n).padStart(8, "0");
  return `(65) 9${d.slice(0, 4)}-${d.slice(4)}`;
};
const e164 = (n: number) => `+55659${String(90_000_000 + n).padStart(8, "0")}`;

/**
 * A planilha do mockup: 236 linhas = 201 novos · 18 já existem · 9 repetidos ·
 * 8 inválidos, com `;`, BOM, uma linha em branco no meio e uma coluna que não
 * se importa ("Área (ha)").
 */
async function planilhaDoMockup() {
  // 18 que já existem no time A: 12 pelo celular, 6 pelo e-mail.
  for (let i = 0; i < 12; i++) await contato(TEAM_A, `Existente ${i}`, { whatsapp: e164(5000 + i) });
  for (let i = 0; i < 6; i++) await contato(TEAM_A, `Existente mail ${i}`, { email: `existe${i}@agro.com.br` });
  // O mesmo celular de 5 "novos" no time B: para o A continuam novos.
  for (let i = 0; i < 5; i++) await contato(TEAM_B, `Do B ${i}`, { whatsapp: e164(i) });

  const linhas: string[] = [];
  for (let i = 0; i < 201; i++) {
    // 10 novos só com e-mail.
    const tel = i < 191 ? cel(i) : "";
    const mail = i >= 191 ? `novo${i}@agro.com.br` : i % 3 === 0 ? `novo${i}@agro.com.br` : "";
    linhas.push(`Novo ${i};${tel};${mail};Fazenda ${i};Tapurah;MT;soja;${i * 10}`);
  }
  for (let i = 0; i < 12; i++) linhas.push(`Já ${i};${cel(5000 + i)};;;;;milho;`);
  for (let i = 0; i < 6; i++) linhas.push(`Já mail ${i};;EXISTE${i}@AGRO.COM.BR;;;;;`);
  // 9 repetidas do celular de "Novo 1".."Novo 9" (unidas: completam o e-mail).
  for (let i = 1; i <= 9; i++) linhas.push(`Novo ${i} de novo;${cel(i)};rep${i}@agro.com.br;;;;algodão;`);
  // 8 inválidas: 5 telefones quebrados, 2 sem nome, 1 e-mail inválido.
  for (let i = 0; i < 5; i++) linhas.push(`Quebrado ${i};(65) 3382-1${i};;;;;;`);
  linhas.push(`;${cel(7000)};;;;;;`, `;;sem-nome@agro.com.br;;;;;`, `E-mail ruim;;nao-e-email;;;;;`);
  linhas.splice(100, 0, ";;;;;;;"); // linha "vazia" (só separadores): não conta
  return String.fromCharCode(0xfeff) + ["Produtor;Celular;E-mail;Fazenda;Município;UF;Cultura;Área (ha)", ...linhas].join("\r\n") + "\r\n";
}

describe("planilha (puro)", () => {
  it("numeração igual à do Excel e linha vazia fora da conta", () => {
    const p = lerPlanilha("nome,telefone\nAna,1\n\n,\nBeto,2\n");
    expect(p.colunas).toEqual(["nome", "telefone"]);
    expect(p.linhas.map((l) => l.linha)).toEqual([2, 5]);
    expect(() => lerPlanilha("nome,telefone\n")).toThrow(PlanilhaVazia);
  });

  it("sugere pelo nome da coluna: nome exato primeiro, depois o mais específico", () => {
    expect(
      sugerirMapeamento(["Nome da fazenda", "Nome do produtor", "Telefone (WhatsApp)", "Celular", "Sobrenome", "E-mail", "Culturas", "Segmento", "Obs"]),
    ).toEqual(["empresa", "nome", null, "whatsapp", "sobrenome", "email", "tags", "tags", null]);
    expect(sugerirMapeamento(["Telefone (WhatsApp)", "Município"])).toEqual(["whatsapp", "cidade"]);
  });

  it("linha repetida une na 1ª: completa o que falta e soma as tags", () => {
    const p = lerPlanilha("nome,cel,email,cultura\nAna,(65) 99999-0001,,soja\nAna B,65999990001,ana@x.com,\"milho, soja\"\n");
    const { registros, repetidas } = montarRegistros(p, ["nome", "whatsapp", "email", "tags"]);
    expect(repetidas).toEqual([{ linha: 3, de: 2 }]);
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({ nome: "Ana", whatsapp: "+5565999990001", email: "ana@x.com", tags: ["soja", "milho"], unidas: [3] });
  });
});

describe("previewImport", () => {
  it("contagens do mockup (201 · 18 · 9 · 8), mapeamento sugerido e nada gravado", async () => {
    const texto = await planilhaDoMockup();
    const antes = await basePrisma.contact.count({ where: { teamId: TEAM_A } });

    const p = await runWithTeam(TEAM_A, async () => previewImport({ texto }));
    expect(p.mapeamentoSugerido).toEqual(["nome", "whatsapp", "email", "empresa", "cidade", "estado", "tags", null]);
    expect(p.ignoradas).toEqual(["Área (ha)"]);
    expect(p.total).toBe(236);
    expect(p.contagens).toEqual({ novos: 201, jaExistem: 18, repetidos: 9, invalidos: 8 });
    expect(p.amostra).toHaveLength(10);
    expect(p.amostra[0]).toMatchObject({ linha: 2, situacao: "novo", valores: ["Novo 0", cel(0), "novo0@agro.com.br", "Fazenda 0", "Tapurah", "MT", "soja", "0"] });
    expect(p.exemplos.repetido[0]).toMatchObject({ situacao: "repetido", repeteLinha: 3 }); // "Novo 1" está na linha 3
    expect(new Set(p.exemplos.invalido.map((l) => l.motivo))).toEqual(new Set(["Telefone inválido", "Sem nome", "E-mail inválido"]));
    expect(p.avisos).toEqual([]);

    // Prévia não grava: nem contato, nem job.
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(antes);
    expect(await basePrisma.importJob.count({ where: { teamId: { in: TIMES } } })).toBe(0);

    // Dois times: no B, os 18 "já existem" do A são novos, e os 5 do B já existem.
    const b = await runWithTeam(TEAM_B, async () => previewImport({ texto }));
    expect(b.contagens).toEqual({ novos: 201 + 18 - 5, jaExistem: 5, repetidos: 9, invalidos: 8 });
  });

  it("mapeamento escolhido pelo usuário muda a classificação; mapeamento inválido é recusado", async () => {
    const texto = await planilhaDoMockup();
    await runWithTeam(TEAM_A, async () => {
      // Celular fora: telefone quebrado deixa de ser erro, e não dá mais para achar repetido/existente pelo celular.
      const semCelular = await previewImport({ texto, mapeamento: ["nome", null, "email", "empresa", "cidade", "estado", "tags", null] });
      expect(semCelular.contagens.invalidos).toBe(3);
      expect(semCelular.contagens.jaExistem).toBe(6);
      expect(semCelular.ignoradas).toEqual(["Celular", "Área (ha)"]);

      await expect(previewImport({ texto, mapeamento: ["nome", "nome", null, null, null, null, null, null] })).rejects.toBeInstanceOf(MapeamentoInvalido);
      await expect(previewImport({ texto, mapeamento: ["nome"] })).rejects.toBeInstanceOf(MapeamentoInvalido);
      await expect(previewImport({ texto, mapeamento: ["telefone_fixo", null, null, null, null, null, null, null] })).rejects.toThrow();
      const semNome = await previewImport({ texto, mapeamento: [null, "whatsapp", "email", null, null, null, null, null] });
      expect(semNome.avisos[0]).toMatch(/Nome/);
    });
  });

  it("viewer não importa", async () => {
    await expect(
      runWithTeam(TEAM_A, async () => previewImport({ texto: "nome\nAna\n" }), { userId: randomUUID(), role: "viewer" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("10.000 linhas: a prévia responde (tudo em lote, sem uma consulta por linha)", async () => {
    const linhas = Array.from({ length: 10_000 }, (_, i) => `Pessoa ${i},${cel(20_000 + i)},p${i}@agro.com.br`);
    const t0 = Date.now();
    const p = await runWithTeam(TEAM_A, async () => previewImport({ texto: ["nome,celular,email", ...linhas].join("\n") }));
    expect(p.contagens).toEqual({ novos: 10_000, jaExistem: 0, repetidos: 0, invalidos: 0 });
    expect(Date.now() - t0).toBeLessThan(20_000);
  });
});

describe("colunas de CPF, CNPJ e IE", () => {
  const cab = "Nome;Sobrenome;CPF;Telefone;E-mail;Cidade;Estado;Empresa;CNPJ;Inscrição Estadual";

  it("sugere o mapeamento pelo nome da coluna (CNPJ da empresa não vira Empresa)", () => {
    const map = sugerirMapeamento([...cab.split(";"), "CNPJ da empresa"]);
    expect(map).toEqual(["nome", "sobrenome", "cpf", "whatsapp", "email", "cidade", "estado", "empresa", "cnpj", "ie", null]);
  });

  it("guarda só os dígitos conferidos e devolve os zeros que o Excel comeu", () => {
    const planilha = lerPlanilha([cab, "Ana;Lima;1234567890;65999990001;;Sorriso;MT;Agro Lima;1234567000195;123.456-7"].join("\n"));
    const { registros, invalidas } = montarRegistros(planilha, sugerirMapeamento(planilha.colunas));
    expect(invalidas).toEqual([]);
    expect(registros[0]).toMatchObject({ nome: "Ana", sobrenome: "Lima", cpf: "01234567890", empresa: "Agro Lima", empresas: [{ nome: "Agro Lima", cnpj: "01234567000195", ie: "123.456-7", cidade: "Sorriso", estado: "MT" }] });
  });

  it("CPF ou CNPJ que não passa nos dígitos verificadores recusa a linha", () => {
    const planilha = lerPlanilha([cab, "Ana;;111.111.111-11;65999990001;;;;;;", "Beto;;;65999990002;;;;Agro;12.345.678/0001-00;"].join("\n"));
    const { registros, invalidas } = montarRegistros(planilha, sugerirMapeamento(planilha.colunas));
    expect(registros).toEqual([]);
    expect(invalidas).toEqual([
      { linha: 2, motivo: "CPF inválido" },
      { linha: 3, motivo: "CNPJ inválido" },
    ]);
  });

  it("linha repetida completa o CPF e o CNPJ que faltavam", () => {
    const planilha = lerPlanilha([cab, "Ana;;;65999990001;;;;;;", "Ana;;01234567890;65999990001;;;;Agro;01234567000195;"].join("\n"));
    const { registros, repetidas } = montarRegistros(planilha, sugerirMapeamento(planilha.colunas));
    expect(repetidas).toHaveLength(1);
    expect(registros[0]).toMatchObject({ cpf: "01234567890", empresas: [{ cnpj: "01234567000195", nome: "Agro" }] });
  });

  it("a mesma pessoa em várias linhas (mesmo CPF) vira um contato só, com todas as empresas, telefones e e-mails", () => {
    const c = "Nome;CPF;Telefone;Email;Cidade;Estado;Empresa;IE";
    const planilha = lerPlanilha(
      [
        c,
        "PRODUTOR EXEMPLO;3456789157;55 33337703;financeiro@x.com;PEIXOTO DE AZEVEDO;MT;PRODUTOR EXEMPLO;10.000.001-1",
        "PRODUTOR EXEMPLO;3456789157;66 33337703;produtor2@x.com;SANTA CARMEM;MT;PRODUTOR EXEMPLO;10.000.002-2",
        "PRODUTOR EXEMPLO;3456789157;66 33337703;produtor@x.com;APIACAS;MT;PRODUTOR EXEMPLO;10.000.003-3",
        "PRODUTOR EXEMPLO;3456789157;66 33337703;produtor@x.com;APIACAS;MT;PRODUTOR EXEMPLO;10.000.003-3",
      ].join("\n"),
    );
    const { registros, repetidas } = montarRegistros(planilha, sugerirMapeamento(planilha.colunas));
    expect(registros).toHaveLength(1);
    expect(repetidas.map((r) => r.linha)).toEqual([3, 4, 5]);
    const r = registros[0]!;
    expect(r.cpf).toBe("03456789157");
    expect(r.whatsapps).toEqual(["+555533337703", "+556633337703"]);
    expect(r.emails).toEqual(["financeiro@x.com", "produtor2@x.com", "produtor@x.com"]);
    expect(r.cidade).toBe("PEIXOTO DE AZEVEDO"); // a da primeira linha
    expect(r.empresas.map((e) => [e.ie, e.cidade])).toEqual([
      ["10.000.001-1", "PEIXOTO DE AZEVEDO"],
      ["10.000.002-2", "SANTA CARMEM"],
      ["10.000.003-3", "APIACAS"],
    ]);
  });

  it("homônimo sem nada em comum (CPF, telefone, e-mail) continua sendo outro contato", () => {
    const planilha = lerPlanilha(["Nome;CPF;Telefone", "José da Silva;01234567890;65999990001", "José da Silva;;65999990002"].join("\n"));
    expect(montarRegistros(planilha, sugerirMapeamento(planilha.colunas)).registros).toHaveLength(2);
  });

  it("CPF e CNPJ misturados na mesma coluna: separa pelos dígitos, e o certo vai para o lugar certo mesmo na coluna errada", () => {
    const misto = lerPlanilha(["Nome;CPF/CNPJ", "Ana;012.345.678-90", "Fazenda Boa Vista;01.234.567/0001-95", "Beto;1234567000195"].join("\n"));
    expect(sugerirMapeamento(misto.colunas)).toEqual(["nome", "documento"]);
    const { registros } = montarRegistros(misto, ["nome", "documento"]);
    expect(registros[0]).toMatchObject({ cpf: "01234567890", empresas: [] });
    expect(registros[1]).toMatchObject({ empresas: [{ cnpj: "01234567000195" }] });
    expect(registros[1]!.cpf).toBeUndefined();
    expect(registros[2]).toMatchObject({ empresas: [{ cnpj: "01234567000195" }] }); // 13 dígitos: o Excel comeu o zero
    const trocado = lerPlanilha(["Nome;CPF;CNPJ", "Ana;01234567000195;01234567890"].join("\n"));
    expect(montarRegistros(trocado, ["nome", "cpf", "cnpj"]).registros[0]).toMatchObject({ cpf: "01234567890", empresas: [{ cnpj: "01234567000195" }] });
  });

  it("telefone 2 e e-mail 2 entram como extras; se não valem, a linha segue sem eles", () => {
    const planilha = lerPlanilha(["Nome;Telefone;Telefone 2;E-mail;E-mail 2", "Ana;65999990001;(66) 3333-7703;a@x.com;b@x.com", "Beto;65999990002;abc;b1@x.com;nao-e-email"].join("\n"));
    const map = sugerirMapeamento(planilha.colunas);
    expect(map).toEqual(["nome", "whatsapp", "whatsapp2", "email", "email2"]);
    const { registros, invalidas } = montarRegistros(planilha, map);
    expect(invalidas).toEqual([]);
    expect(registros[0]).toMatchObject({ whatsapps: ["+5565999990001", "+556633337703"], emails: ["a@x.com", "b@x.com"] });
    expect(registros[1]).toMatchObject({ whatsapps: ["+5565999990002"], emails: ["b1@x.com"] });
  });
});

