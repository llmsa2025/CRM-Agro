import { describe, expect, it } from "vitest";
// Só o mapa de ids (puro). Que toda marca tem um componente é garantido pelo tipo
// `Record<MarcaId, Icone>` em components/brand-icons.tsx (o tsc acusa marca sem logo).
import { MARCAS, NOME_DA_MARCA, marcaDaFerramenta } from "./ferramentas";

describe("marcaDaFerramenta", () => {
  it("canais do CRM Agro viram a marca do próprio canal", () => {
    expect(marcaDaFerramenta("whatsapp")).toBe("whatsapp");
    expect(marcaDaFerramenta("email")).toBe("email");
    expect(marcaDaFerramenta("instagram")).toBe("instagram");
    expect(marcaDaFerramenta("linkedin")).toBe("linkedin");
  });

  it("integrações conhecidas: Google, Voopi, Nectar, webhooks e API", () => {
    expect(marcaDaFerramenta("google")).toBe("google");
    expect(marcaDaFerramenta("google-agenda")).toBe("google-agenda");
    expect(marcaDaFerramenta("google-meet")).toBe("google-meet");
    expect(marcaDaFerramenta("gmail")).toBe("gmail");
    expect(marcaDaFerramenta("voopi")).toBe("voopi");
    expect(marcaDaFerramenta("nectar")).toBe("nectar");
    expect(marcaDaFerramenta("webhook")).toBe("webhook");
    expect(marcaDaFerramenta("api")).toBe("api");
  });

  it("provedores de IA que o CRM Agro suporta", () => {
    expect(marcaDaFerramenta("anthropic")).toBe("anthropic");
    expect(marcaDaFerramenta("openai")).toBe("openai");
    expect(marcaDaFerramenta("glm")).toBe("glm");
  });

  it("aceita o nome que vem do banco (provider) e variações de escrita", () => {
    expect(marcaDaFerramenta("evolution")).toBe("whatsapp");
    expect(marcaDaFerramenta("smtp")).toBe("email");
    expect(marcaDaFerramenta("claude")).toBe("anthropic");
    expect(marcaDaFerramenta("NectarCRM")).toBe("nectar");
    expect(marcaDaFerramenta("  Google_Agenda ")).toBe("google-agenda");
    expect(marcaDaFerramenta("Webhooks")).toBe("webhook");
  });

  it("id desconhecido, vazio ou nulo cai no genérico", () => {
    expect(marcaDaFerramenta("pipedrive")).toBe("generico");
    expect(marcaDaFerramenta("")).toBe("generico");
    expect(marcaDaFerramenta(null)).toBe("generico");
    expect(marcaDaFerramenta(undefined)).toBe("generico");
  });

  it("provedor de IA desconhecido cai no ícone de IA quando o chamador pede", () => {
    expect(marcaDaFerramenta("mistral", "ia")).toBe("ia");
    expect(marcaDaFerramenta(undefined, "ia")).toBe("ia");
    // o padrão só vale para o que não é conhecido
    expect(marcaDaFerramenta("openai", "ia")).toBe("openai");
  });

  it("nomes herdados do objeto (constructor, toString) não viram marca", () => {
    expect(marcaDaFerramenta("constructor")).toBe("generico");
    expect(marcaDaFerramenta("__proto__")).toBe("generico");
    expect(marcaDaFerramenta("toString", "ia")).toBe("ia");
  });

  it("toda marca tem um nome legível", () => {
    for (const m of MARCAS) expect(NOME_DA_MARCA[m].length).toBeGreaterThan(0);
  });
});
