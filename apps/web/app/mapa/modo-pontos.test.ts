import { describe, expect, it } from "vitest";
import {
  CHAVE_MODO_PONTOS,
  MODOS_PONTOS,
  MODO_PONTOS_PADRAO,
  configFonteContatos,
  modoSalvo,
  proximoIndiceRadio,
  visibilidadeCamadas,
} from "./modo-pontos";

describe("modo dos pontos do Mapa", () => {
  describe("padrão e valor guardado", () => {
    it("o padrão é agrupar (como o mapa sempre foi)", () => {
      expect(MODO_PONTOS_PADRAO).toBe("agrupar");
      expect(MODOS_PONTOS).toEqual(["agrupar", "pontos"]);
    });
    it("usa a mesma família de chaves do estilo e do painel", () => {
      expect(CHAVE_MODO_PONTOS).toBe("crmagro:mapa:pontos");
    });
    it("lê 'pontos' e 'agrupar' como estão", () => {
      expect(modoSalvo("pontos")).toBe("pontos");
      expect(modoSalvo("agrupar")).toBe("agrupar");
    });
    it("sem valor guardado ou com lixo cai no padrão", () => {
      expect(modoSalvo(null)).toBe("agrupar");
      expect(modoSalvo(undefined)).toBe("agrupar");
      expect(modoSalvo("")).toBe("agrupar");
      expect(modoSalvo("PONTOS")).toBe("agrupar");
      expect(modoSalvo("cluster")).toBe("agrupar");
      expect(modoSalvo(42)).toBe("agrupar");
    });
  });

  describe("config da fonte GeoJSON", () => {
    it("agrupar liga o cluster com o raio e o zoom de sempre (44 px, até o zoom 12)", () => {
      expect(configFonteContatos("agrupar")).toEqual({ cluster: true, clusterRadius: 44, clusterMaxZoom: 12 });
    });
    it("pontos desliga o cluster e mantém o restante igual (a troca de volta não muda o agrupamento)", () => {
      expect(configFonteContatos("pontos")).toEqual({ cluster: false, clusterRadius: 44, clusterMaxZoom: 12 });
    });
  });

  describe("visibilidade das camadas", () => {
    it("agrupar mostra os círculos numerados e os pinos", () => {
      expect(visibilidadeCamadas("agrupar")).toEqual({ grupo: "visible", "grupo-n": "visible", ponto: "visible" });
    });
    it("pontos mostra todo contato como pino: sem círculo numerado (nem o rótulo)", () => {
      expect(visibilidadeCamadas("pontos")).toEqual({ grupo: "none", "grupo-n": "none", ponto: "visible" });
    });
    it("não mexe nas camadas de seleção, do servidor e da rota (valem nos dois modos)", () => {
      for (const modo of MODOS_PONTOS) {
        const ids = Object.keys(visibilidadeCamadas(modo));
        for (const fora of ["ponto-sel", "grupo-srv", "grupo-srv-n", "rota-linha", "rota-parada", "rota-parada-n"]) {
          expect(ids).not.toContain(fora);
        }
      }
    });
  });

  describe("setas do teclado no seletor", () => {
    it("direita/baixo avança e dá a volta no fim", () => {
      expect(proximoIndiceRadio(0, 2, "ArrowRight")).toBe(1);
      expect(proximoIndiceRadio(1, 2, "ArrowRight")).toBe(0);
      expect(proximoIndiceRadio(0, 2, "ArrowDown")).toBe(1);
    });
    it("esquerda/cima volta e dá a volta no começo", () => {
      expect(proximoIndiceRadio(1, 2, "ArrowLeft")).toBe(0);
      expect(proximoIndiceRadio(0, 2, "ArrowLeft")).toBe(1);
      expect(proximoIndiceRadio(0, 3, "ArrowUp")).toBe(2);
    });
    it("Home e End vão às pontas", () => {
      expect(proximoIndiceRadio(1, 3, "Home")).toBe(0);
      expect(proximoIndiceRadio(0, 3, "End")).toBe(2);
    });
    it("outras teclas (Tab, Enter, letras) e lista vazia não fazem nada", () => {
      expect(proximoIndiceRadio(0, 2, "Tab")).toBeNull();
      expect(proximoIndiceRadio(0, 2, "Enter")).toBeNull();
      expect(proximoIndiceRadio(0, 2, "a")).toBeNull();
      expect(proximoIndiceRadio(0, 0, "ArrowRight")).toBeNull();
    });
  });
});
