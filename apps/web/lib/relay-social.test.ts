import { describe, expect, it } from "vitest";
import {
  ORIGENS_CRMAGRO,
  conferirIdentidadeEsperada,
  origemDoPedidoPermitida,
  origemDoCrmAgroPermitida,
} from "./relay-social";

describe("relay-social: origem da página", () => {
  it("aceita as origens do CRM Agro", () => {
    for (const o of ORIGENS_CRMAGRO) expect(origemDoCrmAgroPermitida(o, { producao: true }), o).toBe(true);
  });
  it("aceita as extras (host do pedido, AUTH_URL) e ignora extra vazia", () => {
    const opcoes = { producao: true, extras: ["https://crm.outra.com", "", undefined, null, "lixo"] };
    expect(origemDoCrmAgroPermitida("https://crm.outra.com", opcoes)).toBe(true);
    expect(origemDoCrmAgroPermitida("https://evil.com", opcoes)).toBe(false);
  });
  it("extra com caminho vale pela origem dela", () => {
    expect(origemDoCrmAgroPermitida("https://crm.outra.com", { producao: true, extras: ["https://crm.outra.com/painel"] })).toBe(true);
  });
  it("localhost só fora de produção", () => {
    expect(origemDoCrmAgroPermitida("http://localhost:3001", { producao: false })).toBe(true);
    expect(origemDoCrmAgroPermitida("http://localhost:3001", { producao: true })).toBe(false);
    expect(origemDoCrmAgroPermitida("https://localhost:3001", { producao: false })).toBe(false);
  });
  it("recusa parecidas, http, caminho e usuário@", () => {
    for (const o of [
      "https://evil.com",
      "https://app.crmagro.example.evil.com",
      "http://app.crmagro.example",
      "https://app.crmagro.example/x",
      "https://x@app.crmagro.example",
      "app.crmagro.example",
      "",
      "null",
    ]) {
      expect(origemDoCrmAgroPermitida(o, { producao: true }), o).toBe(false);
    }
    for (const o of [undefined, null]) expect(origemDoCrmAgroPermitida(o, { producao: true })).toBe(false);
  });
});

describe("relay-social: cabeçalho Origin do pedido", () => {
  const op = { producao: true };
  it("ausente, de extensão ou null passam (o serviço real é a extensão)", () => {
    expect(origemDoPedidoPermitida(undefined, op)).toBe(true);
    expect(origemDoPedidoPermitida(null, op)).toBe(true);
    expect(origemDoPedidoPermitida("", op)).toBe(true);
    expect(origemDoPedidoPermitida("chrome-extension://abcdefghijklmnop", op)).toBe(true);
    expect(origemDoPedidoPermitida("moz-extension://abcdefgh", op)).toBe(true);
    expect(origemDoPedidoPermitida("null", op)).toBe(true);
  });
  it("página do CRM Agro passa; página de outro site é recusada", () => {
    expect(origemDoPedidoPermitida("https://app.crmagro.example", op)).toBe(true);
    expect(origemDoPedidoPermitida("https://evil.com", op)).toBe(false);
    expect(origemDoPedidoPermitida("http://app.crmagro.example", op)).toBe(false);
  });
});

describe("relay-social: identidade esperada", () => {
  const dono = { teamId: "team_1", userId: "user_1" };
  it("ausente = ok (popup da extensão)", () => {
    expect(conferirIdentidadeEsperada(undefined, dono)).toBe("ok");
    expect(conferirIdentidadeEsperada(null, dono)).toBe("ok");
  });
  it("mesmo usuário e time = ok", () => {
    expect(conferirIdentidadeEsperada({ userId: "user_1", teamId: "team_1" }, dono)).toBe("ok");
  });
  it("outro usuário do mesmo time = diferente (token do admin na extensão do vendedor)", () => {
    expect(conferirIdentidadeEsperada({ userId: "user_2", teamId: "team_1" }, dono)).toBe("diferente");
  });
  it("outro time = diferente", () => {
    expect(conferirIdentidadeEsperada({ userId: "user_1", teamId: "team_2" }, dono)).toBe("diferente");
  });
  it("token sem dono (antigo/dev): só o time é conferido", () => {
    const semDono = { teamId: "team_1", userId: null };
    expect(conferirIdentidadeEsperada({ userId: "user_9", teamId: "team_1" }, semDono)).toBe("ok");
    expect(conferirIdentidadeEsperada({ userId: "user_9", teamId: "team_2" }, semDono)).toBe("diferente");
  });
  it("malformado = inválida", () => {
    for (const e of ["user_1", 5, [], { userId: "user_1" }, { teamId: "team_1" }, { userId: "", teamId: "team_1" }, { userId: 1, teamId: "team_1" }]) {
      expect(conferirIdentidadeEsperada(e, dono), JSON.stringify(e)).toBe("invalida");
    }
  });
});
