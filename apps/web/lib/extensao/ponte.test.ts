import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODIGOS_DA_EXTENSAO,
  REGEX_ID_DE_PEDIDO,
  conectarPelaExtensao,
  interpretarPong,
  interpretarResultado,
  mensagemDoResultado,
  montarConectar,
  montarPing,
  novoIdDePedido,
  pingarExtensao,
  type CodigoDeErro,
  type EventoDeMensagem,
  type JanelaPonte,
} from "./ponte";

const IDENT = { userId: "user_1", teamId: "team_1" };
const ORIGEM = "https://app.crmagro.example";

/** Janela falsa: guarda os ouvintes e as mensagens postadas (sem DOM). */
function janelaFalsa() {
  const ouvintes = new Set<(ev: EventoDeMensagem) => void>();
  const postadas: { mensagem: unknown; origemAlvo: string }[] = [];
  const win: JanelaPonte = {
    location: { origin: ORIGEM },
    postMessage(mensagem, origemAlvo) {
      postadas.push({ mensagem, origemAlvo });
    },
    addEventListener(_t, fn) {
      ouvintes.add(fn);
    },
    removeEventListener(_t, fn) {
      ouvintes.delete(fn);
    },
  };
  return {
    win,
    postadas,
    ouvintes,
    /** Simula um evento `message` chegando na janela. */
    receber(ev: Partial<EventoDeMensagem>) {
      const completo: EventoDeMensagem = { source: win, origin: ORIGEM, data: null, ...ev };
      for (const fn of [...ouvintes]) fn(completo);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ponte (página): id e mensagens", () => {
  it("o id do pedido tem o formato que a extensão aceita e não se repete", () => {
    const ids = new Set(Array.from({ length: 50 }, () => novoIdDePedido()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(REGEX_ID_DE_PEDIDO);
  });
  it("id sem crypto (página sem HTTPS em navegador antigo) ainda vale", () => {
    vi.stubGlobal("crypto", undefined);
    try {
      expect(novoIdDePedido()).toMatch(REGEX_ID_DE_PEDIDO);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("monta ping e conectar, e conectar só leva usuário e time", () => {
    expect(montarPing("abcdef01")).toEqual({ tipo: "crmagro:ext:ping", id: "abcdef01" });
    const m = montarConectar("abcdef01", "linkedin", { ...IDENT, extra: "x" } as typeof IDENT);
    expect(m).toEqual({ tipo: "crmagro:ext:conectar", id: "abcdef01", canal: "linkedin", identidade: IDENT });
  });
});

describe("ponte (página): interpretar respostas", () => {
  it("pong do mesmo id", () => {
    expect(interpretarPong({ tipo: "crmagro:ext:pong", id: "a1", versao: "0.3.0", protocolo: 1, configurada: true }, "a1")).toEqual({
      versao: "0.3.0",
      protocolo: 1,
      configurada: true,
    });
  });
  it("pong de outro id, de outro tipo ou torto é ignorado", () => {
    for (const d of [null, "x", [], { tipo: "crmagro:ext:pong", id: "outro" }, { tipo: "crmagro:ext:resultado", id: "a1" }, { id: "a1" }]) {
      expect(interpretarPong(d, "a1")).toBeNull();
    }
  });
  it("pong: configurada só com true", () => {
    expect(interpretarPong({ tipo: "crmagro:ext:pong", id: "a1", configurada: "sim" }, "a1")).toMatchObject({ configurada: false });
  });
  it("resultado ok, com e sem @", () => {
    expect(interpretarResultado({ tipo: "crmagro:ext:resultado", id: "a1", ok: true, usuario: "maria", conectado: true }, "a1")).toEqual({
      ok: true,
      usuario: "maria",
      conectado: true,
    });
    expect(interpretarResultado({ tipo: "crmagro:ext:resultado", id: "a1", ok: true, usuario: null }, "a1")).toEqual({
      ok: true,
      usuario: null,
      conectado: true,
    });
  });
  it("resultado de erro: código conhecido passa, desconhecido vira 'erro'", () => {
    expect(interpretarResultado({ tipo: "crmagro:ext:resultado", id: "a1", ok: false, codigo: "sem_sessao" }, "a1")).toEqual({
      ok: false,
      codigo: "sem_sessao",
    });
    expect(interpretarResultado({ tipo: "crmagro:ext:resultado", id: "a1", ok: false, codigo: "sem_resposta" }, "a1")).toEqual({
      ok: false,
      codigo: "erro",
    });
    expect(interpretarResultado({ tipo: "crmagro:ext:resultado", id: "a1", ok: false }, "a1")).toEqual({ ok: false, codigo: "erro" });
  });
  it("resultado de outro id é ignorado", () => {
    expect(interpretarResultado({ tipo: "crmagro:ext:resultado", id: "b2", ok: true }, "a1")).toBeNull();
  });
});

describe("ponte (página): pingar a extensão", () => {
  it("posta o ping SÓ para a própria origem (nunca '*') e resolve com o pong", async () => {
    const j = janelaFalsa();
    const p = pingarExtensao(j.win);
    expect(j.postadas).toHaveLength(1);
    expect(j.postadas[0]!.origemAlvo).toBe(ORIGEM);
    const ping = j.postadas[0]!.mensagem as { tipo: string; id: string };
    expect(ping.tipo).toBe("crmagro:ext:ping");
    j.receber({ data: { tipo: "crmagro:ext:pong", id: ping.id, versao: "0.3.0", protocolo: 1, configurada: true } });
    await expect(p).resolves.toEqual({ versao: "0.3.0", protocolo: 1, configurada: true });
    expect(j.ouvintes.size).toBe(0); // tirou o ouvinte
  });
  it("sem resposta no prazo: null (extensão ausente ou antiga) e limpa o ouvinte", async () => {
    const j = janelaFalsa();
    const p = pingarExtensao(j.win, 1500);
    await vi.advanceTimersByTimeAsync(1499);
    expect(j.ouvintes.size).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    await expect(p).resolves.toBeNull();
    expect(j.ouvintes.size).toBe(0);
  });
  it("ignora resposta de outra janela, de outra origem ou de outro pedido", async () => {
    const j = janelaFalsa();
    const p = pingarExtensao(j.win, 1000);
    const id = (j.postadas[0]!.mensagem as { id: string }).id;
    const pong = { tipo: "crmagro:ext:pong", id, versao: "9.9.9", protocolo: 1, configurada: true };
    j.receber({ source: {}, data: pong }); // iframe / outra janela
    j.receber({ origin: "https://evil.com", data: pong }); // outra origem
    j.receber({ data: { ...pong, id: "outroidqualquer" } }); // outro pedido
    j.receber({ data: "lixo" });
    expect(j.ouvintes.size).toBe(1); // ainda esperando
    await vi.advanceTimersByTimeAsync(1001);
    await expect(p).resolves.toBeNull();
  });
});

describe("ponte (página): conectar pela extensão", () => {
  it("posta conectar com a identidade e devolve o resultado", async () => {
    const j = janelaFalsa();
    const p = conectarPelaExtensao(j.win, "instagram", IDENT);
    const pedido = j.postadas[0]!.mensagem as { tipo: string; id: string; canal: string; identidade: unknown };
    expect(pedido).toMatchObject({ tipo: "crmagro:ext:conectar", canal: "instagram", identidade: IDENT });
    expect(j.postadas[0]!.origemAlvo).toBe(ORIGEM);
    j.receber({ data: { tipo: "crmagro:ext:resultado", id: pedido.id, ok: true, usuario: "maria", conectado: true } });
    await expect(p).resolves.toEqual({ ok: true, usuario: "maria", conectado: true });
  });
  it("o eco do próprio pedido (mesma janela) não é tomado por resposta", async () => {
    const j = janelaFalsa();
    const p = conectarPelaExtensao(j.win, "linkedin", IDENT, 1000);
    j.receber({ data: j.postadas[0]!.mensagem }); // o postMessage volta como evento message
    await vi.advanceTimersByTimeAsync(1001);
    await expect(p).resolves.toEqual({ ok: false, codigo: "sem_resposta" });
  });
  it("estourou o prazo: sem_resposta", async () => {
    const j = janelaFalsa();
    const p = conectarPelaExtensao(j.win, "instagram", IDENT, 5000);
    await vi.advanceTimersByTimeAsync(5001);
    await expect(p).resolves.toEqual({ ok: false, codigo: "sem_resposta" });
  });
  it("erro da extensão chega como código", async () => {
    const j = janelaFalsa();
    const p = conectarPelaExtensao(j.win, "instagram", IDENT);
    const id = (j.postadas[0]!.mensagem as { id: string }).id;
    j.receber({ data: { tipo: "crmagro:ext:resultado", id, ok: false, codigo: "sem_sessao" } });
    await expect(p).resolves.toEqual({ ok: false, codigo: "sem_sessao" });
  });
});

describe("ponte (página): textos do resultado", () => {
  it("conectado com @ e sem @", () => {
    expect(mensagemDoResultado({ ok: true, usuario: "maria", conectado: true }, "instagram")).toEqual({
      tipo: "ok",
      texto: "Conectado como @maria",
    });
    const aviso = mensagemDoResultado({ ok: true, usuario: null, conectado: true }, "linkedin");
    expect(aviso.tipo).toBe("aviso");
    expect(aviso.texto).toContain("LinkedIn");
    expect(aviso.texto).toContain("renomear");
  });
  it("os motivos pedidos pelo dono aparecem com o nome da rede", () => {
    expect(mensagemDoResultado({ ok: false, codigo: "sem_sessao" }, "instagram").texto).toContain(
      "Você não está logado no Instagram neste navegador",
    );
    expect(mensagemDoResultado({ ok: false, codigo: "sem_sessao" }, "linkedin").texto).toContain("LinkedIn");
    expect(mensagemDoResultado({ ok: false, codigo: "sessao_expirada" }, "instagram").texto).toContain("expirou");
  });
  it("todo código tem texto próprio, em português, sem travessão nem chave solta", () => {
    const todos: CodigoDeErro[] = [...CODIGOS_DA_EXTENSAO, "sem_resposta"];
    const textos = new Set<string>();
    for (const c of todos) {
      const m = mensagemDoResultado({ ok: false, codigo: c }, "instagram");
      expect(m.tipo).toBe("erro");
      expect(m.texto.length, c).toBeGreaterThan(10);
      expect(m.texto, c).not.toMatch(/[—–]|\{|\}|undefined/);
      textos.add(m.texto);
    }
    expect(textos.size).toBeGreaterThan(todos.length - 3); // só os genéricos podem se parecer
  });
});
