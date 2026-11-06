import { describe, expect, it } from "vitest";
import { decidirCliqueFora, decidirEsc, estadoAoLimpar } from "./contato-combobox";

describe("combobox de contato da Agenda", () => {
  describe("Esc", () => {
    it("com a lista aberta fecha só a lista e segura o diálogo", () => {
      expect(decidirEsc(true)).toEqual({ fecharLista: true, impedirFecharDialogo: true });
    });
    it("com a lista fechada deixa o Esc fechar o diálogo normalmente", () => {
      expect(decidirEsc(false)).toEqual({ fecharLista: false, impedirFecharDialogo: false });
    });
  });

  describe("clique fora", () => {
    it("fora do combobox com a lista aberta fecha a lista sem fechar o diálogo", () => {
      expect(decidirCliqueFora(true, false)).toEqual({ fecharLista: true, impedirFecharDialogo: true });
    });
    it("dentro do combobox (campo, opção, limpar) não fecha nada", () => {
      expect(decidirCliqueFora(true, true)).toEqual({ fecharLista: false, impedirFecharDialogo: false });
    });
    it("com a lista fechada o clique no fundo segue o comportamento do diálogo", () => {
      expect(decidirCliqueFora(false, false)).toEqual({ fecharLista: false, impedirFecharDialogo: false });
    });
  });

  describe("limpar", () => {
    it("remove o contato, zera a busca e fecha a lista", () => {
      expect(estadoAoLimpar()).toEqual({ contact: null, search: "", showList: false });
    });
  });
});
