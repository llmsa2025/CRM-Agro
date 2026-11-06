import { describe, expect, it } from "vitest";
import { avisoDaUrlLegada, avisoDaUrlNova, estadoDaUrl, fraseDaUrlGerada, urlDoWebhook } from "./webhook-url";

const TOKEN = "tokdaurl-tokdaurl-tokdaurl-tokdaur1";

describe("estado da URL do webhook na tela", () => {
  it("recém-gerada: mostra a URL (uma vez), mesmo que o fluxo seja antigo", () => {
    expect(estadoDaUrl({ urlNova: TOKEN, tokenLegado: null, webhookTem: true })).toBe("nova");
    expect(estadoDaUrl({ urlNova: TOKEN, tokenLegado: "antigo", webhookTem: true })).toBe("nova");
  });

  it("fluxo antigo (texto ainda no banco): mostra a URL de novo, com aviso", () => {
    expect(estadoDaUrl({ urlNova: null, tokenLegado: "antigo", webhookTem: true })).toBe("legado");
  });

  it("fluxo novo depois de gerada: só diz que existe (a URL completa não vem nunca mais)", () => {
    expect(estadoDaUrl({ urlNova: null, tokenLegado: null, webhookTem: true })).toBe("gerada");
  });

  it("sem URL ainda", () => {
    expect(estadoDaUrl({ urlNova: null, tokenLegado: null, webhookTem: false })).toBe("nenhuma");
  });

  it("a URL completa só existe nos estados 'nova' e 'legado' (nunca com os dados do estado 'gerada')", () => {
    const comUrl = (e: ReturnType<typeof estadoDaUrl>) => e === "nova" || e === "legado";
    expect(comUrl(estadoDaUrl({ urlNova: null, tokenLegado: null, webhookTem: true }))).toBe(false);
    expect(comUrl(estadoDaUrl({ urlNova: null, tokenLegado: null, webhookTem: false }))).toBe(false);
  });
});

describe("texto da URL", () => {
  it("monta a URL completa a partir da origem do app", () => {
    expect(urlDoWebhook("https://app.crmagro.example", TOKEN)).toBe(`https://app.crmagro.example/api/webhooks/flow/${TOKEN}`);
  });

  it("frase do estado 'gerada': com data e sem data, convidando a gerar outra, sem travessão", () => {
    const com = fraseDaUrlGerada("05/10/2026 14:18");
    expect(com).toContain("URL gerada em 05/10/2026 14:18, gere uma nova se perdeu");
    expect(fraseDaUrlGerada(null)).toContain("URL já gerada, gere uma nova se perdeu");
    for (const f of [com, fraseDaUrlGerada(null)]) expect(f).not.toMatch(/[—–]/);
  });
});

describe("avisos que dependem da chave FLOW_WEBHOOK_TOKEN_HASH", () => {
  it("só promete 'não será mostrada de novo' quando o servidor realmente não guarda o texto", () => {
    expect(avisoDaUrlNova(true)).toBe("Copie e guarde agora. Não será mostrada de novo.");
    expect(avisoDaUrlNova(false)).toBe("Copie e guarde agora.");
    expect(avisoDaUrlNova(false)).not.toMatch(/não será mostrada/i);
  });

  it("o aviso do fluxo antigo diz a verdade nos dois modos e sem travessão", () => {
    expect(avisoDaUrlLegada(true)).toContain("ainda está guardada em texto no banco");
    expect(avisoDaUrlLegada(false)).toBe("Esta URL está guardada em texto no banco.");
    for (const f of [avisoDaUrlNova(true), avisoDaUrlNova(false), avisoDaUrlLegada(true), avisoDaUrlLegada(false)]) expect(f).not.toMatch(/[—–]/);
  });
});
