import { describe, expect, it } from "vitest";
import { contatosMarcadosDeSaida, empresasMarcadasDeSaida, formatarCpf, iesMarcadasDeSaida, montarPedidoDaPessoa, textoDoAplicarPessoa, textoDoResultadoPessoa, type FormularioDaPessoa } from "./enriquecer-pessoa";

const vazio: FormularioDaPessoa = { cpf: "", nome: "", cidade: "", uf: "", email: "", telefone: "" };

describe("seleção de saída", () => {
  it("empresa de confiança baixa nunca vem marcada; a já vinculada também não", () => {
    const s = empresasMarcadasDeSaida([
      { id: "a", confianca: "alta", jaVinculada: false },
      { id: "b", confianca: "media", jaVinculada: false },
      { id: "c", confianca: "baixa", jaVinculada: false },
      { id: "d", confianca: "alta", jaVinculada: true },
    ]);
    expect([...s].sort()).toEqual(["a", "b"]);
    expect([...iesMarcadasDeSaida([{ id: "ie-1" }])]).toEqual(["ie-1"]);
  });
  it("empresa inativa nunca vem marcada, mesmo com confiança alta", () => {
    const s = empresasMarcadasDeSaida([
      { id: "a", confianca: "alta", jaVinculada: false, ativa: true },
      { id: "b", confianca: "alta", jaVinculada: false, ativa: false },
    ]);
    expect([...s]).toEqual(["a"]);
  });
  it("dado de contato: só vem marcado o de empresário individual ou MEI que o contato ainda não tem, e um endereço só", () => {
    const s = contatosMarcadosDeSaida([
      { id: "t1", tipo: "telefone", provavelPessoal: true, jaNoCadastro: false },
      { id: "t2", tipo: "telefone", provavelPessoal: false, jaNoCadastro: false },
      { id: "e1", tipo: "email", provavelPessoal: true, jaNoCadastro: true },
      { id: "d1", tipo: "endereco", provavelPessoal: true, jaNoCadastro: false },
      { id: "d2", tipo: "endereco", provavelPessoal: true, jaNoCadastro: false },
    ]);
    expect([...s]).toEqual(["t1", "d1"]);
  });
});

describe("pedido", () => {
  it("CPF formatado vira só dígitos; sem CPF e sem CPF no cadastro avisa", () => {
    expect(formatarCpf("52998224725999")).toBe("529.982.247-25");
    expect(montarPedidoDaPessoa({ ...vazio, cpf: "529.982.247-25", nome: "Maria Silva", uf: "MT" }, false)).toEqual({ ok: true, pedido: { cpf: "52998224725", nome: "Maria Silva", uf: "MT" } });
    expect(montarPedidoDaPessoa(vazio, false)).toMatchObject({ ok: false, erro: expect.stringMatching(/Informe o CPF/) });
    expect(montarPedidoDaPessoa(vazio, true)).toEqual({ ok: true, pedido: {} }); // usa o CPF do cadastro
  });
  it("recusa CPF curto, nome de uma palavra e cidade sem estado", () => {
    expect(montarPedidoDaPessoa({ ...vazio, cpf: "123" }, false)).toMatchObject({ ok: false, erro: expect.stringMatching(/11 dígitos/) });
    expect(montarPedidoDaPessoa({ ...vazio, nome: "Maria" }, true)).toMatchObject({ ok: false, erro: expect.stringMatching(/nome e sobrenome/) });
    expect(montarPedidoDaPessoa({ ...vazio, cidade: "Sorriso" }, true)).toMatchObject({ ok: false, erro: expect.stringMatching(/estado da cidade/) });
  });
  it("pede as inativas só quando a pessoa clica em mostrar", () => {
    expect(montarPedidoDaPessoa({ ...vazio, cpf: "529.982.247-25" }, false)).toEqual({ ok: true, pedido: { cpf: "52998224725" } });
    expect(montarPedidoDaPessoa({ ...vazio, cpf: "529.982.247-25" }, false, { incluirInativas: true })).toEqual({ ok: true, pedido: { cpf: "52998224725", incluirInativas: true } });
  });
  it("textos sem travessão", () => {
    expect(textoDoAplicarPessoa(0, 0)).toBe("Nada marcado");
    expect(textoDoAplicarPessoa(1, 0)).toBe("Vincular 1 empresa");
    expect(textoDoAplicarPessoa(2, 1)).toBe("Vincular 2 empresas e 1 inscrição");
    expect(textoDoAplicarPessoa(2, 1)).not.toMatch(/[—–]/);
    expect(textoDoAplicarPessoa(0, 0, 2)).toBe("Acrescentar 2 dados de contato");
    expect(textoDoAplicarPessoa(1, 0, 1)).toBe("Vincular 1 empresa e acrescentar 1 dado de contato");
    expect(textoDoResultadoPessoa({ empresasVinculadas: 2, iesGravadas: 0, contatosAdicionados: 1 })).toBe("2 empresas vinculadas, 1 dado de contato acrescentado");
    expect(textoDoResultadoPessoa({ empresasVinculadas: 0, iesGravadas: 0, contatosAdicionados: 0 })).toBe("Nada vinculado");
  });
});
