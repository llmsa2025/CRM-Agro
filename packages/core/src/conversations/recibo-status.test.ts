import { describe, it, expect } from "vitest";
import { ChannelSendFailed } from "@crmagro/channels";
import { statusAposRecibo } from "./recibo-status";
import {
  ENVIO_NAO_CONFIRMADO,
  JANELA_CONFIRMACAO_MS,
  STATUS_UI_NAO_CONFIRMADO,
  envioPodeTerSaido,
  impressaoDoArquivo,
  statusExibido,
} from "./envio-incerto";

/**
 * Regras PURAS (sem banco, sem rede) do bug "imagem com erro, mas entregue":
 * a transição de status por recibo e a classificação do erro de envio de mídia.
 */

const linha = (status: string, errorCode: string | null = null, statusAt: Date | null = null) => ({ status, errorCode, statusAt });
const recibo = (status: "sent" | "delivered" | "read" | "failed" | null, errorCode: string | null = null) => ({ status, errorCode });

describe("statusAposRecibo — transição por recibo do WhatsApp", () => {
  it("avança o tique e NUNCA regride (recibo atrasado não desfaz 'lida')", () => {
    expect(statusAposRecibo(linha("sent"), recibo("delivered"))).toBe("delivered");
    expect(statusAposRecibo(linha("delivered"), recibo("read"))).toBe("read");
    expect(statusAposRecibo(linha("read"), recibo("delivered"))).toBeNull();
    expect(statusAposRecibo(linha("delivered"), recibo("sent"))).toBeNull();
    expect(statusAposRecibo(linha("sent"), recibo(null))).toBeNull();
  });

  it("falha COM código do servidor vence sempre (inclusive sobre 'lida') — comportamento de antes", () => {
    expect(statusAposRecibo(linha("sent"), recibo("failed", "463"))).toBe("failed");
    expect(statusAposRecibo(linha("read"), recibo("failed", "463"))).toBe("failed");
  });

  it("ERROR sem código não desfaz entrega/leitura já confirmadas (evento fora de ordem)", () => {
    expect(statusAposRecibo(linha("delivered"), recibo("failed"))).toBeNull();
    expect(statusAposRecibo(linha("read"), recibo("failed"))).toBeNull();
    // ...mas vale sobre um simples ✓.
    expect(statusAposRecibo(linha("sent"), recibo("failed"))).toBe("failed");
  });

  it("REGRESSÃO: recibo de entrega/leitura depois de 'failed' promove a mensagem (antes ficava vermelha para sempre)", () => {
    // Falha sem código, marcada por um ERROR do próprio recibo (statusAt preenchido).
    const falhouPorRecibo = linha("failed", null, new Date());
    expect(statusAposRecibo(falhouPorRecibo, recibo("delivered"))).toBe("delivered");
    expect(statusAposRecibo(falhouPorRecibo, recibo("read"))).toBe("read");
    // Falha nossa (nunca recebeu recibo): até o ✓ simples já prova que saiu.
    expect(statusAposRecibo(linha("failed"), recibo("sent"))).toBe("sent");
    expect(statusAposRecibo(linha("failed"), recibo("delivered"))).toBe("delivered");
  });

  it("um ✓ atrasado NÃO desfaz um ERROR que o servidor mandou (só entrega/leitura desfaz)", () => {
    expect(statusAposRecibo(linha("failed", null, new Date()), recibo("sent"))).toBeNull();
  });

  it("recusa do servidor (com código, ex.: 463) é DEFINITIVA: nenhum recibo a promove", () => {
    const recusada = linha("failed", "463", new Date());
    expect(statusAposRecibo(recusada, recibo("delivered"))).toBeNull();
    expect(statusAposRecibo(recusada, recibo("read"))).toBeNull();
    expect(statusAposRecibo(recusada, recibo("sent"))).toBeNull();
  });

  it("falha que ninguém desmentiu continua falha (sem recibo, nada muda)", () => {
    expect(statusAposRecibo(linha("failed"), recibo(null))).toBeNull();
    expect(statusAposRecibo(linha("failed"), recibo("failed"))).toBe("failed");
  });
});

describe("envioPodeTerSaido — o erro de envio de mídia deixa a mensagem como 'talvez saiu'?", () => {
  it("timeout/queda depois de aberta a conexão (unknown) → incerto", () => {
    expect(envioPodeTerSaido(new ChannelSendFailed("Evolution sendMedia: timeout", "unknown", false))).toBe(true);
  });

  it("Evolution respondeu 5xx, ou 'Timed Out' do Baileys → incerto", () => {
    expect(envioPodeTerSaido(new ChannelSendFailed("Evolution sendMedia 500: erro", "not_sent", true, 500))).toBe(true);
    expect(envioPodeTerSaido(new ChannelSendFailed("Evolution sendMedia 400: Error: Timed Out", "not_sent", false, 400))).toBe(true);
  });

  it("falha DEFINITIVA continua definitiva: 4xx de validação, conexão recusada, erro qualquer", () => {
    expect(envioPodeTerSaido(new ChannelSendFailed("Evolution sendMedia 400: numero invalido", "not_sent", false, 400))).toBe(false);
    expect(envioPodeTerSaido(new ChannelSendFailed("ECONNREFUSED", "not_sent", true))).toBe(false);
    expect(envioPodeTerSaido(new Error("boom"))).toBe(false);
    expect(envioPodeTerSaido(null)).toBe(false);
  });
});

describe("statusExibido — o que a tela mostra", () => {
  const agora = Date.now();
  const marca = { envio: ENVIO_NAO_CONFIRMADO };

  it("failed com a marca de incerto, dentro da janela → 'não confirmado' (âmbar), não 'falhou'", () => {
    expect(statusExibido("failed", marca, new Date(agora - 60_000), agora)).toBe(STATUS_UI_NAO_CONFIRMADO);
  });

  it("passada a janela sem eco/recibo, a falha vale de verdade", () => {
    expect(statusExibido("failed", marca, new Date(agora - JANELA_CONFIRMACAO_MS - 1), agora)).toBe("failed");
  });

  it("failed SEM a marca (falha definitiva) e os demais status passam como estão", () => {
    expect(statusExibido("failed", null, new Date(agora), agora)).toBe("failed");
    expect(statusExibido("failed", { subject: "x" }, new Date(agora), agora)).toBe("failed");
    expect(statusExibido("sent", marca, new Date(agora), agora)).toBe("sent");
    expect(statusExibido("delivered", null, new Date(agora), agora)).toBe("delivered");
  });
});

describe("impressaoDoArquivo", () => {
  it("é estável para o mesmo arquivo e diferente para outro", () => {
    expect(impressaoDoArquivo("aGVsbG8=")).toBe(impressaoDoArquivo("aGVsbG8="));
    expect(impressaoDoArquivo("aGVsbG8=")).not.toBe(impressaoDoArquivo("d29ybGQ="));
  });
});
