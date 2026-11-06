import { describe, it, expect } from "vitest";
import { atividadeDoCnae, verificarAgro, type EmpresaParaAgro, type EntradaDaVerificacao } from "./regras";

const base: EntradaDaVerificacao = { nome: "Contato", nomeWhatsapp: null, nomeAgenda: null, empresaTexto: null, empresas: [], foto: null };
const entrada = (p: Partial<EntradaDaVerificacao>): EntradaDaVerificacao => ({ ...base, ...p });

const fazendaSoja: EmpresaParaAgro = {
  nome: "Agropecuária Boa Terra Ltda",
  cnae: "0115-6/00",
  cnaesSecundarios: [],
  iesTipos: [],
  socios: ["JOAO CARLOS DA SILVA", "MARIA APARECIDA PEREIRA"],
};

describe("verificarAgro: nome", () => {
  it("fazenda no nome do WhatsApp entra sozinha (sinal forte)", () => {
    const r = verificarAgro(entrada({ nomeWhatsapp: "Fazenda Santa Maria 🌾" }));
    expect(r.tipos).toEqual(["fazenda"]);
    expect(r.evidencias[0]?.texto).toContain("nome no WhatsApp");
  });

  it("ignora acento e caixa", () => {
    expect(verificarAgro(entrada({ nome: "SÍTIO Boa Vista" })).tipos).toEqual(["fazenda"]);
    expect(verificarAgro(entrada({ nomeAgenda: "Descaroçadora Ouro Branco" })).tipos).toEqual(["algodoeira"]);
  });

  it("'Armazém' sozinho é mercearia: não entra", () => {
    const r = verificarAgro(entrada({ nomeWhatsapp: "Armazém do Zé" }));
    expect(r.tipos).toEqual([]);
    expect(r.evidencias[0]).toMatchObject({ tipo: "armazem", peso: 1 });
  });

  it("armazém geral, silo e cerealista entram", () => {
    expect(verificarAgro(entrada({ nome: "Armazéns Gerais Cerrado" })).tipos).toEqual(["armazem"]);
    expect(verificarAgro(entrada({ nome: "Silos Rio Verde" })).tipos).toEqual(["armazem"]);
    expect(verificarAgro(entrada({ nome: "Cerealista Dois Irmãos" })).tipos).toEqual(["armazem"]);
  });

  it("'Faz' sem ponto não é fazenda (é o verbo)", () => {
    expect(verificarAgro(entrada({ nome: "Faz Tudo Reformas" })).tipos).toEqual([]);
    expect(verificarAgro(entrada({ nome: "Faz. Esperança" })).tipos).toEqual(["fazenda"]);
  });

  it("dois sinais fracos do mesmo lugar não somam; de fontes diferentes somam", () => {
    // "Agro" e "Rural" no mesmo nome: uma fonte só, vale a maior (1).
    expect(verificarAgro(entrada({ nome: "Agro Rural Silva" })).tipos).toEqual([]);
    // Fraco no nome do WhatsApp + fraco no campo empresa do cadastro: ainda é a fonte "nome".
    expect(verificarAgro(entrada({ nomeWhatsapp: "Agro Silva", empresaTexto: "Rural Silva" })).tipos).toEqual([]);
  });
});

describe("verificarAgro: empresa e sócios (produtor)", () => {
  it("nome do WhatsApp igual a um sócio de empresa rural = produtor", () => {
    const r = verificarAgro(entrada({ nome: "João", nomeWhatsapp: "João Carlos da Silva", empresas: [fazendaSoja] }));
    expect(r.tipos).toContain("produtor");
    const ev = r.evidencias.find((e) => e.fonte === "socio" && e.tipo === "produtor");
    expect(ev?.peso).toBe(2);
    expect(ev?.texto).toContain("nome no WhatsApp");
    expect(ev?.texto).toContain("CNAE 0115-6/00");
  });

  it("nome com parte do nome do sócio (mesmo primeiro e último) também vale, avisando para conferir", () => {
    const r = verificarAgro(entrada({ nomeWhatsapp: "João Silva", empresas: [fazendaSoja] }));
    expect(r.tipos).toContain("produtor");
    expect(r.evidencias.find((e) => e.fonte === "socio")?.texto).toContain("Confira");
  });

  it("nome só com o primeiro nome não prova nada", () => {
    const r = verificarAgro(entrada({ nome: "João", nomeWhatsapp: "João", empresas: [fazendaSoja] }));
    expect(r.tipos).not.toContain("produtor");
    expect(r.evidencias.find((e) => e.fonte === "socio")?.texto).toContain("Nenhum dos 2 sócio(s)");
  });

  it("sócio de empresa sem atividade rural não é produtor", () => {
    const loja: EmpresaParaAgro = { ...fazendaSoja, nome: "Loja de Roupas Ltda", cnae: "4781-4/00" };
    const r = verificarAgro(entrada({ nomeWhatsapp: "João Carlos da Silva", empresas: [loja] }));
    expect(r.tipos).not.toContain("produtor");
    expect(r.evidencias.find((e) => e.fonte === "socio")?.texto).toContain("não tem atividade rural");
  });

  it("IE de produtor rural conta como atividade rural mesmo sem CNAE de lavoura", () => {
    const e: EmpresaParaAgro = { ...fazendaSoja, cnae: "6821-8/01", iesTipos: ["Produtor Rural"] };
    expect(verificarAgro(entrada({ nomeWhatsapp: "Maria Aparecida Pereira", empresas: [e] })).tipos).toContain("produtor");
  });

  it("empresa rural sem lista de sócios avisa que falta enriquecer, sem marcar produtor", () => {
    const r = verificarAgro(entrada({ nomeWhatsapp: "João Carlos da Silva", empresas: [{ ...fazendaSoja, socios: [] }] }));
    expect(r.tipos).not.toContain("produtor");
    expect(r.evidencias.find((e) => e.fonte === "socio")?.texto).toContain("Enriqueça a empresa");
  });

  it("empresa com nome de fazenda não faz da pessoa uma fazenda; o produtor é quem é sócio", () => {
    // "Agropecuária" no nome da empresa vinculada vale só como sinal fraco para fazenda.
    const r = verificarAgro(entrada({ nomeWhatsapp: "João Carlos da Silva", empresas: [fazendaSoja] }));
    expect(r.tipos).toEqual(["produtor"]);
    expect(verificarAgro(entrada({ empresaTexto: "Fazenda Santa Maria" })).tipos).toEqual([]);
    // Já o nome da PRÓPRIA pessoa no WhatsApp com "Fazenda" é a propriedade.
    expect(verificarAgro(entrada({ nomeWhatsapp: "Fazenda Santa Maria" })).tipos).toEqual(["fazenda"]);
  });

  it("empresa com nome de armazém ou algodoeira define o tipo (não existe tipo 'pessoa' para eles)", () => {
    const silo: EmpresaParaAgro = { nome: "Armazéns Gerais Rio Verde", cnae: null, cnaesSecundarios: [], iesTipos: [], socios: [] };
    expect(verificarAgro(entrada({ empresas: [silo] })).tipos).toEqual(["armazem"]);
  });

  it("CNAE de armazém geral como atividade principal entra como armazém", () => {
    const e: EmpresaParaAgro = { nome: "Silo Norte SA", cnae: "5211-7/01", cnaesSecundarios: [], iesTipos: [], socios: [] };
    expect(verificarAgro(entrada({ empresas: [e] })).tipos).toEqual(["armazem"]);
  });

  it("CNAE de pós-colheita sozinho é fraco; com 'algodão' no nome vira algodoeira", () => {
    const e: EmpresaParaAgro = { nome: "Beneficiamento Cerrado", cnae: "0163-6/00", cnaesSecundarios: [], iesTipos: [], socios: [] };
    expect(verificarAgro(entrada({ empresas: [e] })).tipos).toEqual([]);
    expect(verificarAgro(entrada({ nomeWhatsapp: "Algodão Cerrado", empresas: [e] })).tipos).toEqual(["algodoeira"]);
  });
});

describe("verificarAgro: foto", () => {
  it("foto de lavoura com confiança alta conta como fazenda", () => {
    const r = verificarAgro(entrada({ foto: { categoria: "lavoura", confianca: "alta", motivo: "Soja em fileiras, colheitadeira ao fundo" } }));
    expect(r.tipos).toEqual(["fazenda"]);
    expect(r.evidencias[0]?.texto).toContain("lavoura");
  });

  it("confiança média precisa de outro sinal", () => {
    const foto = { categoria: "armazem", confianca: "media", motivo: "Silos metálicos" } as const;
    expect(verificarAgro(entrada({ foto })).tipos).toEqual([]);
    expect(verificarAgro(entrada({ nomeWhatsapp: "Armazém Santa Fé", foto })).tipos).toEqual(["armazem"]);
  });

  it("confiança baixa e 'outra' só informam", () => {
    expect(verificarAgro(entrada({ foto: { categoria: "fazenda", confianca: "baixa", motivo: "Campo aberto" } })).tipos).toEqual([]);
    const r = verificarAgro(entrada({ foto: { categoria: "outra", confianca: "alta", motivo: "Pessoa de camiseta" } }));
    expect(r.tipos).toEqual([]);
    expect(r.evidencias[0]).toMatchObject({ tipo: null, fonte: "foto", peso: 0 });
  });

  it("um contato pode ter vários tipos", () => {
    const r = verificarAgro(
      entrada({
        nomeWhatsapp: "Fazenda Três Lagoas",
        empresas: [{ ...fazendaSoja, cnae: "5211-7/01", cnaesSecundarios: ["0115-6/00"] }],
        foto: { categoria: "algodoeira", confianca: "alta", motivo: "Fardos de pluma no pátio" },
      }),
    );
    expect(r.tipos).toEqual(["fazenda", "armazem", "algodoeira"]);
  });
});

describe("verificarAgro: pecuária", () => {
  it("'pecuária', 'pecuarista' e 'gado' no nome entram sozinhos", () => {
    expect(verificarAgro(entrada({ nomeWhatsapp: "Pecuária Boa Vista" })).tipos).toEqual(["pecuaria"]);
    expect(verificarAgro(entrada({ nome: "Zé Pecuarista" })).tipos).toEqual(["pecuaria"]);
    expect(verificarAgro(entrada({ nomeAgenda: "Gado Bravo Leilões" })).tipos).toEqual(["pecuaria"]);
  });

  it("'agropecuária' continua sendo fazenda, não pecuária", () => {
    expect(verificarAgro(entrada({ nomeWhatsapp: "Agropecuária Santa Rita" })).tipos).toEqual(["fazenda"]);
  });

  it("'boi', 'bezerro' e 'nelore' sozinhos são fracos", () => {
    const r = verificarAgro(entrada({ nomeWhatsapp: "Boi Gordo do Zé" }));
    expect(r.tipos).toEqual([]);
    expect(r.evidencias[0]).toMatchObject({ tipo: "pecuaria", peso: 1 });
  });

  it("foto de gado com confiança alta é pecuária, e não fazenda", () => {
    const r = verificarAgro(entrada({ foto: { categoria: "pecuaria", confianca: "alta", motivo: "Rebanho nelore no pasto" } }));
    expect(r.tipos).toEqual(["pecuaria"]);
    expect(r.evidencias[0]?.texto).toContain("gado");
  });

  it("foto de gado com confiança média precisa de outro sinal", () => {
    const foto = { categoria: "pecuaria", confianca: "media", motivo: "Vacas num curral" } as const;
    expect(verificarAgro(entrada({ foto })).tipos).toEqual([]);
    expect(verificarAgro(entrada({ nomeWhatsapp: "Boi Gordo do Zé", foto })).tipos).toEqual(["pecuaria"]);
  });

  it("CNAE de pecuária da empresa é fraco: sozinho não classifica, com a foto de gado entra", () => {
    const e: EmpresaParaAgro = { nome: "Criatório Silva Ltda", cnae: "0151-2/01", cnaesSecundarios: [], iesTipos: [], socios: [] };
    expect(verificarAgro(entrada({ empresas: [e] })).tipos).toEqual([]);
    const foto = { categoria: "pecuaria", confianca: "media", motivo: "Gado no pasto" } as const;
    expect(verificarAgro(entrada({ empresas: [e], foto })).tipos).toEqual(["pecuaria"]);
  });
});

describe("verificarAgro: transportadora", () => {
  it("'transportadora' e 'transportes' no nome entram sozinhos", () => {
    expect(verificarAgro(entrada({ nomeWhatsapp: "Silva Transportadora" })).tipos).toEqual(["transportadora"]);
    expect(verificarAgro(entrada({ nome: "Transportes Rodoviários Cerrado" })).tipos).toEqual(["transportadora"]);
  });

  it("'transporte', 'frete' e 'logística' sozinhos são fracos", () => {
    for (const nome of ["Transporte escolar Maria", "Frete Veloz", "Logística Centro"]) {
      const r = verificarAgro(entrada({ nomeWhatsapp: nome }));
      expect(r.tipos).toEqual([]);
      expect(r.evidencias[0]).toMatchObject({ tipo: "transportadora", peso: 1 });
    }
  });

  it("CNAE de transporte rodoviário de carga como principal da empresa entra", () => {
    const e: EmpresaParaAgro = { nome: "Rota Sul Ltda", cnae: "4930-2/02", cnaesSecundarios: [], iesTipos: [], socios: [] };
    const r = verificarAgro(entrada({ empresas: [e] }));
    expect(r.tipos).toEqual(["transportadora"]);
    expect(r.evidencias[0]?.texto).toContain("CNAE 4930-2/02");
  });

  it("CNAE de transporte só entre os secundários é fraco; com 'frete' no nome entra", () => {
    const e: EmpresaParaAgro = { nome: "Comércio Silva Ltda", cnae: "4781-4/00", cnaesSecundarios: ["4930-2/01"], iesTipos: [], socios: [] };
    expect(verificarAgro(entrada({ empresas: [e] })).tipos).toEqual([]);
    expect(verificarAgro(entrada({ nomeWhatsapp: "Frete Silva", empresas: [e] })).tipos).toEqual(["transportadora"]);
  });

  it("fazenda e transportadora no mesmo contato: vários tipos", () => {
    expect(verificarAgro(entrada({ nomeWhatsapp: "Fazenda Santa Luzia Transportes" })).tipos).toEqual(["fazenda", "transportadora"]);
  });
});

describe("atividadeDoCnae", () => {
  it("diz a atividade em palavras", () => {
    expect(atividadeDoCnae("0115-6/00")).toBe("lavoura");
    expect(atividadeDoCnae("4930-2/02")).toBe("transporte de carga");
    expect(atividadeDoCnae("4781-4/00")).toBeNull();
    expect(atividadeDoCnae(null)).toBeNull();
  });
});

describe("verificarAgro: saída", () => {
  it("ordena as evidências que decidem primeiro", () => {
    const r = verificarAgro(entrada({ nome: "Agro Silva", nomeWhatsapp: "Fazenda Silva" }));
    expect(r.evidencias[0]?.peso).toBe(2);
  });

  it("sem nada do agro, devolve vazio", () => {
    expect(verificarAgro(entrada({ nome: "Carlos Souza", nomeWhatsapp: "Carlos" }))).toEqual({ tipos: [], evidencias: [] });
  });

  it("não escreve travessão nas evidências (regra de texto da interface)", () => {
    const r = verificarAgro(entrada({ nomeWhatsapp: "João Carlos da Silva", empresas: [fazendaSoja], foto: { categoria: "fazenda", confianca: "alta", motivo: "Sede e curral" } }));
    for (const e of r.evidencias) expect(e.texto).not.toMatch(/[—–]|\s-\s/);
  });
});
