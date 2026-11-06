import { describe, expect, it } from "vitest";
import { TELAS, telaDoCaminho } from "./telas";

describe("telaDoCaminho", () => {
  it.each([
    ["/conversas", "conversas"],
    ["/conversas/abc-123", "conversas"],
    ["/contatos", "contatos"],
    ["/contatos/3f2a-uuid/editar", "contatos"],
    ["/contatos/importar", "contatos"],
    ["/campanhas/5", "campanhas"],
    ["/funis", "funis"],
    ["/fluxos/9", "fluxos"],
    ["/agenda", "agenda"],
    ["/mapa", "mapa"],
    ["/captacao", "captacao"],
    ["/integracoes/crm/nectarcrm", "integracoes"],
    ["/ligacoes", "ligacoes"],
    ["/atividades", "atividades"],
    ["/configuracoes/equipe", "configuracoes"],
  ])("%s é %s", (caminho, tela) => expect(telaDoCaminho(caminho)).toBe(tela));

  it.each(["/assistente", "/sem-acesso", "/login", "/inexistente", "/contatosx", "/api/health"])("%s não é tela do menu", (c) => {
    expect(telaDoCaminho(c)).toBeNull();
  });

  it("toda tela devolvida está na lista do menu", () => {
    const ids = new Set(TELAS.map((t) => t.id));
    for (const c of ["/conversas/1", "/contatos/2", "/campanhas", "/funis", "/fluxos", "/agenda", "/mapa", "/captacao", "/integracoes", "/ligacoes", "/atividades", "/configuracoes"]) {
      expect(ids.has(telaDoCaminho(c)!)).toBe(true);
    }
  });

  it("não devolve parâmetro nem id: nada além do nome da tela", () => {
    expect(telaDoCaminho("/contatos/3f2a")).toBe("contatos");
  });
});
