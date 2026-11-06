import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import JSZip from "jszip";
import { basePrisma, runAsSystem } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { ForbiddenError } from "../auth/authz";
import {
  CARACTERES_MAX_BASE,
  ConhecimentoInvalido,
  MAX_DOCUMENTOS,
  adicionarArquivo,
  adicionarLinkDoGoogle,
  adicionarTexto,
  atualizarDocumento,
  consultarBase,
  excluirDocumento,
  lerDocumento,
  listarDocumentos,
  resumoDaBase,
} from "./service";

/** Base de conhecimento (Integrações → IA): CRUD, limites, papéis, isolamento entre times e consulta pela IA. */

const TEAM = "00000000-0000-0000-0000-0000000000b1";
const OUTRO = "00000000-0000-0000-0000-0000000000b2";
const comPapel = <T>(role: string, fn: () => Promise<T>, time = TEAM) => runWithTeam(time, fn, { userId: `u-${role}`, role });
const admin = <T>(fn: () => Promise<T>, time = TEAM) => comPapel("admin", fn, time);

beforeAll(async () => {
  for (const id of [TEAM, OUTRO]) await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: `Team base de conhecimento (${id.slice(-2)})` } });
});

beforeEach(async () => {
  await basePrisma.knowledgeDoc.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
});

async function docxCom(texto: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${texto}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

describe("adicionar e listar", () => {
  it("texto colado vira documento ativo, com título e tamanho", async () => {
    const d = await admin(() => adicionarTexto({ titulo: "  Sobre a empresa ", conteudo: "Somos a Agro Sul, de Sorriso, MT." }));
    expect(d).toMatchObject({ titulo: "Sobre a empresa", fonte: "texto", ativo: true, caracteres: 33, nomeArquivo: null, linkOrigem: null });
    const lista = await admin(() => listarDocumentos());
    expect(lista.map((x) => x.titulo)).toEqual(["Sobre a empresa"]);
    expect((await admin(() => lerDocumento(d.id))).conteudo).toBe("Somos a Agro Sul, de Sorriso, MT.");
  });

  it("texto sem título ou sem conteúdo é recusado com frase clara", async () => {
    await expect(admin(() => adicionarTexto({ titulo: "  ", conteudo: "algo" }))).rejects.toThrow(/título/);
    await expect(admin(() => adicionarTexto({ titulo: "Vazio", conteudo: "   " }))).rejects.toThrow(/Não achei texto/);
  });

  it("arquivo: guarda só o texto extraído e o nome; o título padrão é o nome sem extensão", async () => {
    const d = await admin(async () => adicionarArquivo({ nome: "Proposta comercial.docx", bytes: await docxCom("Garantia de 12 meses") }));
    expect(d).toMatchObject({ titulo: "Proposta comercial", fonte: "word", nomeArquivo: "Proposta comercial.docx" });
    expect((await admin(() => lerDocumento(d.id))).conteudo).toBe("Garantia de 12 meses");
  });

  it("arquivo ilegível não cria nada", async () => {
    await expect(admin(() => adicionarArquivo({ nome: "quebrado.pdf", bytes: new TextEncoder().encode("não é pdf") }))).rejects.toThrow(/PDF/);
    expect(await admin(() => listarDocumentos())).toHaveLength(0);
  });

  it("link que não é do Google é recusado antes de qualquer rede", async () => {
    await expect(admin(() => adicionarLinkDoGoogle({ url: "https://exemplo.com/doc" }))).rejects.toThrow(ConhecimentoInvalido);
  });
});

describe("editar, ligar e desligar, excluir", () => {
  it("renomeia, desliga e troca o conteúdo de um texto", async () => {
    const d = await admin(() => adicionarTexto({ titulo: "Preços", conteudo: "Saco de 50 kg: R$ 120." }));
    const r = await admin(() => atualizarDocumento(d.id, { titulo: "Tabela de preços", ativo: false, conteudo: "Saco de 50 kg: R$ 130." }));
    expect(r).toMatchObject({ titulo: "Tabela de preços", ativo: false, caracteres: 22 });
    expect((await admin(() => lerDocumento(d.id))).conteudo).toBe("Saco de 50 kg: R$ 130.");
  });

  it("conteúdo de arquivo não se edita; título não pode ficar vazio", async () => {
    const d = await admin(async () => adicionarArquivo({ nome: "a.docx", bytes: await docxCom("Texto") }));
    await expect(admin(() => atualizarDocumento(d.id, { conteudo: "outro" }))).rejects.toThrow(/Só dá para editar o conteúdo de um texto/);
    await expect(admin(() => atualizarDocumento(d.id, { titulo: " " }))).rejects.toThrow(/título/);
  });

  it("exclui; excluir de novo avisa que não achou", async () => {
    const d = await admin(() => adicionarTexto({ titulo: "X", conteudo: "texto" }));
    await admin(() => excluirDocumento(d.id));
    expect(await admin(() => listarDocumentos())).toHaveLength(0);
    await expect(admin(() => excluirDocumento(d.id))).rejects.toThrow(/Não achei/);
  });
});

describe("limites da base", () => {
  it(`no máximo ${MAX_DOCUMENTOS} documentos`, async () => {
    await basePrisma.knowledgeDoc.createMany({
      data: Array.from({ length: MAX_DOCUMENTOS }, (_, i) => ({ teamId: TEAM, titulo: `D${i}`, fonte: "texto", conteudo: "x", caracteres: 1 })),
    });
    await expect(admin(() => adicionarTexto({ titulo: "Mais um", conteudo: "texto" }))).rejects.toThrow(/já tem 60 documentos/);
  });

  it("o total de texto tem teto", async () => {
    await basePrisma.knowledgeDoc.create({ data: { teamId: TEAM, titulo: "Enorme", fonte: "texto", conteudo: "x", caracteres: CARACTERES_MAX_BASE - 5 } });
    await expect(admin(() => adicionarTexto({ titulo: "Passa do teto", conteudo: "dez letras" }))).rejects.toThrow(/limite de texto/);
    const r = await admin(() => resumoDaBase());
    expect(r).toMatchObject({ documentos: 1, ativos: 1, caracteres: CARACTERES_MAX_BASE - 5 });
  });
});

describe("papéis e isolamento entre times", () => {
  it("só administrador escreve; membro e leitor são negados, mas a leitura segue", async () => {
    const d = await admin(() => adicionarTexto({ titulo: "Sobre", conteudo: "texto da base" }));
    for (const papel of ["member", "viewer"]) {
      await expect(comPapel(papel, () => adicionarTexto({ titulo: "X", conteudo: "y" }))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(comPapel(papel, () => atualizarDocumento(d.id, { ativo: false }))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(comPapel(papel, () => excluirDocumento(d.id))).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await comPapel("viewer", () => listarDocumentos())).toHaveLength(1);
  });

  it("dois times: um não vê, não edita e não exclui o documento do outro", async () => {
    const d = await admin(() => adicionarTexto({ titulo: "Do time A", conteudo: "segredo do A" }));
    expect(await admin(() => listarDocumentos(), OUTRO)).toHaveLength(0);
    await expect(admin(() => lerDocumento(d.id), OUTRO)).rejects.toThrow(/Não achei/);
    await expect(admin(() => atualizarDocumento(d.id, { titulo: "Roubado" }), OUTRO)).rejects.toThrow(/Não achei/);
    await expect(admin(() => excluirDocumento(d.id), OUTRO)).rejects.toThrow(/Não achei/);
    expect((await admin(() => lerDocumento(d.id))).titulo).toBe("Do time A");
    expect((await consultarComo(OUTRO, "segredo")).texto).toBe("");
  });
});

/** A IA consulta pelo motor (sistema) ou pelo assistente (usuário): aqui, como sistema do time. */
const consultarComo = (time: string, pergunta: string) => runAsSystem(time, () => consultarBase(pergunta));

describe("consulta pela IA", () => {
  it("sem nada cadastrado, devolve vazio (a IA segue como antes)", async () => {
    expect(await consultarComo(TEAM, "preço")).toEqual({ texto: "", documentos: [], completa: true });
  });

  it("base pequena entra inteira; documento desligado não entra", async () => {
    await admin(() => adicionarTexto({ titulo: "Sobre", conteudo: "Somos a Agro Sul." }));
    const preco = await admin(() => adicionarTexto({ titulo: "Preços", conteudo: "Saco de 50 kg: R$ 120." }));
    const r = await consultarComo(TEAM, "qualquer coisa");
    expect(r.completa).toBe(true);
    expect(r.texto).toContain("Somos a Agro Sul.");
    expect(r.texto).toContain("R$ 120");
    expect(r.documentos.sort()).toEqual(["Preços", "Sobre"]);

    await admin(() => atualizarDocumento(preco.id, { ativo: false }));
    // O cache de 60 s é invalidado pela escrita no mesmo processo.
    const depois = await consultarComo(TEAM, "qualquer coisa");
    expect(depois.texto).not.toContain("R$ 120");
  });

  it("sem time no contexto, devolve vazio (fail-closed)", async () => {
    await admin(() => adicionarTexto({ titulo: "Sobre", conteudo: "Somos a Agro Sul." }));
    expect((await consultarBase("agro")).texto).toBe("");
  });
});
