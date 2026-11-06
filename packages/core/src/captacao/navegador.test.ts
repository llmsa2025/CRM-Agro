import { describe, it, expect, vi, afterEach } from "vitest";
import {
  comPrazo,
  comTeto,
  PrazoEsgotado,
  detectarBloqueioGoogle,
  acharChromiumOrfaos,
  pidDoMarcador,
  type ProcessoInfo,
} from "@crmagro/captation";

/**
 * Utilitários puros da automação de navegador (item 3.2, INT-11). O worker não
 * tem vitest: a lógica que decide (prazo, teto do job, bloqueio do Google,
 * Chromium órfão) mora em `packages/captation` e é provada aqui. Nada de
 * navegador nem rede.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("comPrazo — evaluate que trava não prende a fila", () => {
  it("devolve o valor quando termina antes do prazo", async () => {
    await expect(comPrazo(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
  });

  it("rejeita com PrazoEsgotado quando a chamada nunca volta", async () => {
    vi.useFakeTimers();
    const nunca = new Promise<number>(() => {});
    const p = comPrazo(nunca, 15_000, "ler a ficha");
    const esperado = expect(p).rejects.toBeInstanceOf(PrazoEsgotado);
    await vi.advanceTimersByTimeAsync(15_000);
    await esperado;
    await expect(p).rejects.toThrow(/ler a ficha: sem resposta em 15s/);
  });

  it("repassa o erro da chamada", async () => {
    await expect(comPrazo(Promise.reject(new Error("Target closed")), 1000, "x")).rejects.toThrow("Target closed");
  });
});

describe("comTeto — teto do job", () => {
  it("terminou antes: devolve o valor e NÃO chama o aoEstourar", async () => {
    const aoEstourar = vi.fn();
    await expect(comTeto(Promise.resolve("ok"), 1000, aoEstourar)).resolves.toEqual({ estourou: false, valor: "ok" });
    expect(aoEstourar).not.toHaveBeenCalled();
  });

  it("estourou: chama o aoEstourar (fecha o navegador) e devolve sem esperar o trabalho travado", async () => {
    vi.useFakeTimers();
    const aoEstourar = vi.fn(async () => {});
    const p = comTeto(new Promise(() => {}), 15 * 60_000, aoEstourar);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await expect(p).resolves.toEqual({ estourou: true });
    expect(aoEstourar).toHaveBeenCalledTimes(1);
  });

  it("erro antes do teto sobe para quem chamou", async () => {
    await expect(comTeto(Promise.reject(new Error("goto falhou")), 1000, () => {})).rejects.toThrow("goto falhou");
  });
});

describe("detectarBloqueioGoogle — 0 lead não é 'concluído'", () => {
  it("URL /sorry/ do Google", () => {
    expect(detectarBloqueioGoogle({ url: "https://www.google.com/sorry/index?continue=https://www.google.com/maps" })).toBe("sorry");
  });

  it("texto de tráfego incomum (pt e en)", () => {
    const url = "https://www.google.com/maps/search/x";
    expect(detectarBloqueioGoogle({ url, texto: "Nossos sistemas detectaram tráfego incomum na sua rede." })).toBe("trafego_incomum");
    expect(detectarBloqueioGoogle({ url, texto: "Our systems have detected unusual traffic from your computer network." })).toBe(
      "trafego_incomum",
    );
  });

  it("captcha pelo DOM ou pelo texto", () => {
    const url = "https://www.google.com/maps/search/x";
    expect(detectarBloqueioGoogle({ url, texto: "", temCaptcha: true })).toBe("captcha");
    expect(detectarBloqueioGoogle({ url, texto: "Não sou um robô" })).toBe("captcha");
  });

  it("página normal do Maps não é bloqueio (nem busca que contém 'sorry' no termo)", () => {
    expect(detectarBloqueioGoogle({ url: "https://www.google.com/maps/search/sorry+burger?hl=pt-BR", texto: "Resultados" })).toBeNull();
    expect(
      detectarBloqueioGoogle({
        url: "https://www.google.com/maps/place/Fazenda+X/@-12.5,-55.7,17z",
        texto: "Fazenda X · Endereço: Rod. BR-163, Sorriso - MT",
      }),
    ).toBeNull();
  });
});

describe("acharChromiumOrfaos — só o Chromium do worker morto", () => {
  const CHROME = "/home/user/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";
  // Formato real: o Chromium reescreve a linha de comando numa string só, com espaço.
  const principal = (pid: number, ppid: number, dono: number): ProcessoInfo => ({
    pid,
    ppid,
    pgid: pid,
    cmdline: `${CHROME} --disable-field-trial-config --headless --no-sandbox --crmagro-worker-pid=${dono} --crmagro-lancamento=abc --user-data-dir=/tmp/playwright_chromiumdev_profile-X`,
  });
  const filho = (pid: number, ppid: number, pgid: number): ProcessoInfo => ({
    pid,
    ppid,
    pgid,
    cmdline: `${CHROME} --type=renderer --user-data-dir=/tmp/playwright_chromiumdev_profile-X`,
  });
  const vivos = (pids: number[]) => (pid: number) => pids.includes(pid);

  it("lê o pid do marcador", () => {
    expect(pidDoMarcador(principal(10, 1, 4242).cmdline)).toBe(4242);
    expect(pidDoMarcador("node dist/index.js")).toBeNull();
  });

  it("dono morto → órfão (derruba o grupo inteiro); filhos sem marcador não entram na lista", () => {
    const procs = [principal(500, 1, 4242), filho(501, 500, 500), filho(502, 500, 500)];
    expect(acharChromiumOrfaos(procs, { meuPid: 9000, meuPgid: 9000, estaVivo: vivos([9000]) })).toEqual([
      { pid: 500, pidDono: 4242, lideraGrupo: true },
    ]);
  });

  it("Chromium do worker vivo (inclusive o meu e o do DM social em curso) não é tocado", () => {
    const procs = [principal(600, 9000, 9000), principal(700, 8000, 8000)];
    expect(acharChromiumOrfaos(procs, { meuPid: 9000, meuPgid: 9000, estaVivo: vivos([9000, 8000]) })).toEqual([]);
  });

  it("pid do dono reusado por outro processo: o Chromium foi adotado pelo init → órfão", () => {
    const procs = [principal(800, 1, 7777)];
    expect(acharChromiumOrfaos(procs, { meuPid: 9000, meuPgid: 9000, estaVivo: vivos([7777, 9000]) })).toHaveLength(1);
  });

  it("não confunde grep/ps com o marcador na linha de comando", () => {
    const grep: ProcessoInfo = { pid: 900, ppid: 1, pgid: 900, cmdline: "grep\0--crmagro-worker-pid=4242" };
    const bash: ProcessoInfo = { pid: 901, ppid: 1, pgid: 901, cmdline: "bash -c ps aux | grep crmagro-worker-pid=4242" };
    expect(acharChromiumOrfaos([grep, bash], { meuPid: 9000, meuPgid: 9000, estaVivo: vivos([9000]) })).toEqual([]);
  });

  it("nunca mata o grupo do próprio worker (só o pid)", () => {
    const noMeuGrupo: ProcessoInfo = { ...principal(950, 1, 4242), pgid: 9000 };
    expect(acharChromiumOrfaos([noMeuGrupo], { meuPid: 9000, meuPgid: 9000, estaVivo: vivos([9000]) })).toEqual([
      { pid: 950, pidDono: 4242, lideraGrupo: false },
    ]);
  });
});
