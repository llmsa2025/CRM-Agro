import { describe, expect, it } from "vitest";
import {
  acharNoCatalogo,
  chaveDeTag,
  comTagNoCatalogo,
  incluirTags,
  limparNomeDeTag,
  opcoesDeTags,
  separarTagsDigitadas,
  tagsDoCampo,
  type TagDoTime,
} from "./tags-input";

const tag = (nome: string, count = 0, cor: string | null = null): TagDoTime => ({ id: `id-${nome}`, nome, cor, count });
const CATALOGO = [tag("Soja", 12), tag("Sorgo", 3), tag("Café", 7), tag("Consoante", 1), tag("Milho", 20)];
const nomes = (r: ReturnType<typeof opcoesDeTags>) => r.opcoes.map((o) => (o.tipo === "tag" ? o.tag.nome : `criar:${o.nome}`));

describe("nome da tag", () => {
  it("colapsa espaços e corta em 40 caracteres, como o cadastro do servidor", () => {
    expect(limparNomeDeTag("  Soja   safra  ")).toBe("Soja safra");
    expect(limparNomeDeTag("x".repeat(60))).toBe("x".repeat(40));
  });

  it("a chave ignora acento e caixa", () => {
    expect(chaveDeTag("Café")).toBe(chaveDeTag(" cafe "));
    expect(chaveDeTag("SOJA")).toBe("soja");
  });
});

describe("opcoesDeTags (a lista de sugestões)", () => {
  it("campo vazio mostra todas as tags do time, as mais usadas primeiro, sem opção de criar", () => {
    expect(nomes(opcoesDeTags({ catalogo: CATALOGO, value: [], texto: "" }))).toEqual(["Milho", "Soja", "Café", "Sorgo", "Consoante"]);
  });

  it("não repete o que já está no campo (sem acento e sem caixa)", () => {
    expect(nomes(opcoesDeTags({ catalogo: CATALOGO, value: ["cafe", "SOJA"], texto: "" }))).toEqual(["Milho", "Sorgo", "Consoante"]);
  });

  it("ao digitar, o que COMEÇA com o texto vem antes do que só contém", () => {
    expect(nomes(opcoesDeTags({ catalogo: CATALOGO, value: [], texto: "so" }))).toEqual(["Soja", "Sorgo", "Consoante", "criar:so"]);
  });

  it("acha com ou sem acento e em qualquer caixa", () => {
    expect(nomes(opcoesDeTags({ catalogo: CATALOGO, value: [], texto: "CAFE" }))).toEqual(["Café"]);
    expect(nomes(opcoesDeTags({ catalogo: CATALOGO, value: [], texto: "café" }))).toEqual(["Café"]);
  });

  it("oferece criar só quando o texto ainda não existe", () => {
    expect(nomes(opcoesDeTags({ catalogo: CATALOGO, value: [], texto: "Algodão" }))).toEqual(["criar:Algodão"]);
    // Existe no catálogo (mesmo com outra caixa): não oferece criar.
    expect(nomes(opcoesDeTags({ catalogo: CATALOGO, value: [], texto: "soja" }))).not.toContain("criar:soja");
    // Já está no campo: não oferece criar nem repete a sugestão.
    expect(nomes(opcoesDeTags({ catalogo: CATALOGO, value: ["Algodão"], texto: "algodao" }))).toEqual([]);
  });

  describe("o que o Enter escolhe sem as setas (destaquePadrao)", () => {
    const outra = [tag("Soja safra 2025", 4), tag("Milho", 20)];

    it("a tag de nome IGUAL ao texto vem primeiro e é a escolhida, mesmo com outra caixa ou acento", () => {
      const r = opcoesDeTags({ catalogo: [...outra, tag("Soja", 9)], value: [], texto: "soja" });
      expect(nomes(r)).toEqual(["Soja", "Soja safra 2025"]);
      expect(r.destaquePadrao).toBe(0);
    });

    it('sem nome igual, escolhe "Criar tag" e nunca uma sugestão parecida (escolher a tag errada pode disparar o fluxo dela)', () => {
      const r = opcoesDeTags({ catalogo: outra, value: [], texto: "Soja" });
      expect(nomes(r)).toEqual(["Soja safra 2025", "criar:Soja"]);
      expect(r.destaquePadrao).toBe(1);
    });

    it("campo vazio não escolhe nada (o Enter envia o formulário)", () => {
      expect(opcoesDeTags({ catalogo: outra, value: [], texto: "" }).destaquePadrao).toBe(-1);
    });

    it("o nome igual já está no campo: não há o que escolher nem o que criar", () => {
      const r = opcoesDeTags({ catalogo: [tag("Soja", 9)], value: ["soja"], texto: "soja" });
      expect(r.opcoes).toEqual([]);
      expect(r.destaquePadrao).toBe(-1);
    });
  });

  it("limpa os espaços do nome que será criado", () => {
    expect(nomes(opcoesDeTags({ catalogo: [], value: [], texto: "  Safra   2025 " }))).toEqual(["criar:Safra 2025"]);
  });

  it("sem tags cadastradas e sem texto, não há o que sugerir", () => {
    expect(opcoesDeTags({ catalogo: [], value: [], texto: "" })).toEqual({ opcoes: [], restantes: 0, destaquePadrao: -1 });
  });

  it("passou do limite: mostra até `max` e diz quantas ficaram de fora", () => {
    const muitas = Array.from({ length: 7 }, (_, i) => tag(`Tag ${i}`, i));
    const r = opcoesDeTags({ catalogo: muitas, value: [], texto: "", max: 3 });
    expect(r.opcoes).toHaveLength(3);
    expect(r.restantes).toBe(4);
    // A opção de criar não fica de fora por causa do limite.
    expect(nomes(opcoesDeTags({ catalogo: muitas, value: [], texto: "tag", max: 3 }))).toContain("criar:tag");
  });
});

describe("incluirTags", () => {
  it("põe no fim, na ordem, sem repetir", () => {
    expect(incluirTags(["Soja"], ["Milho", "soja", "  ", "Algodão", "milho"], [])).toEqual(["Soja", "Milho", "Algodão"]);
  });

  it("usa a grafia do catálogo quando a tag já existe", () => {
    expect(incluirTags([], ["soja", "cafe"], CATALOGO)).toEqual(["Soja", "Café"]);
  });

  it("corta cada nome em 40 caracteres", () => {
    expect(incluirTags([], ["y".repeat(50)], [])).toEqual(["y".repeat(40)]);
  });

  it("devolve a MESMA lista quando nada mudou (para não disparar atualização à toa)", () => {
    const antes = ["Soja"];
    expect(incluirTags(antes, ["soja", ""], CATALOGO)).toBe(antes);
  });
});

describe("acharNoCatalogo (o seletor de uma tag só)", () => {
  it("acha pelo nome sem olhar acento nem caixa, e devolve a tag com a grafia do catálogo", () => {
    expect(acharNoCatalogo(CATALOGO, "cafe")?.nome).toBe("Café");
    expect(acharNoCatalogo(CATALOGO, "  SOJA ")?.id).toBe("id-Soja");
  });

  it("nome que não existe, ou vazio, não acha nada", () => {
    expect(acharNoCatalogo(CATALOGO, "trigo")).toBeUndefined();
    expect(acharNoCatalogo(CATALOGO, "   ")).toBeUndefined();
    expect(acharNoCatalogo([], "soja")).toBeUndefined();
  });

  it("parte do nome não é o nome (o passo do fluxo guarda o nome inteiro)", () => {
    expect(acharNoCatalogo(CATALOGO, "So")).toBeUndefined();
  });
});

describe("comTagNoCatalogo (a tag criada no seletor entra na lista da tela)", () => {
  it("soma a tag nova sem cor e sem contatos, no fim", () => {
    const depois = comTagNoCatalogo(CATALOGO, { id: "id-Trigo", nome: "Trigo" });
    expect(depois).toHaveLength(CATALOGO.length + 1);
    expect(depois.at(-1)).toEqual({ id: "id-Trigo", nome: "Trigo", cor: null, count: 0 });
  });

  it("não repete a tag que já está na lista (criar um nome que existe devolve a mesma tag) e devolve a MESMA lista", () => {
    expect(comTagNoCatalogo(CATALOGO, { id: "id-Soja", nome: "Soja" })).toBe(CATALOGO);
  });

  it("depois de somada, a tag aparece nas sugestões e o seletor não oferece criar de novo", () => {
    const depois = comTagNoCatalogo(CATALOGO, { id: "id-Trigo", nome: "Trigo" });
    const r = opcoesDeTags({ catalogo: depois, value: [], texto: "trigo" });
    expect(nomes(r)).toEqual(["Trigo"]);
  });
});

describe("separarTagsDigitadas", () => {
  it("texto sem separador não muda nada", () => {
    expect(separarTagsDigitadas("soja")).toBeNull();
  });

  it("vírgula fecha a tag e o que vem depois fica no campo", () => {
    expect(separarTagsDigitadas("soja,")).toEqual({ prontas: ["soja"], resto: "" });
    expect(separarTagsDigitadas("soja, mil")).toEqual({ prontas: ["soja"], resto: " mil" });
  });

  it("texto colado com várias tags fecha todas menos a última", () => {
    expect(separarTagsDigitadas("soja, milho; algodão\ncafé")).toEqual({ prontas: ["soja", " milho", " algodão"], resto: "café" });
  });
});

describe("tagsDoCampo (o que o servidor lê do formulário)", () => {
  it("formulário SEM o campo: undefined, ou seja, não mexe nas tags (edição rápida da lista)", () => {
    expect(tagsDoCampo(null)).toBeUndefined();
  });

  it("campo vazio: lista vazia, ou seja, tirou todas as tags", () => {
    expect(tagsDoCampo("")).toEqual([]);
    expect(tagsDoCampo("[]")).toEqual([]);
    expect(tagsDoCampo("   ")).toEqual([]);
  });

  it("lista em JSON aceita vírgula dentro do nome", () => {
    expect(tagsDoCampo('["Soja","Milho, safra","  Café "]')).toEqual(["Soja", "Milho, safra", "Café"]);
  });

  it("texto simples separado por vírgula também vale", () => {
    expect(tagsDoCampo("soja, milho,,  café ")).toEqual(["soja", "milho", "café"]);
  });

  it('texto que só começa com "[" cai na vírgula em vez de quebrar', () => {
    expect(tagsDoCampo("[urgente, soja")).toEqual(["[urgente", "soja"]);
  });
});
