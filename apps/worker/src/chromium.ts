import { homedir } from "node:os";
/**
 * Chromium do worker (item 3.2, INT-11) — lançamento marcado, fechamento com
 * prazo e limpeza de órfãos no boot. Roda SÓ no worker (Playwright).
 *
 * Todo Chromium lançado aqui leva dois marcadores na linha de comando (o
 * Chromium ignora switch desconhecido):
 * - `--crmagro-worker-pid=<pid>`: de qual processo worker ele é. O provider
 *   social (`packages/channels/src/browser`) passa o mesmo marcador;
 * - `--crmagro-lancamento=<uuid>`: qual lançamento, para matar ESTE navegador
 *   (e não o do DM social que roda em paralelo) quando o `close()` trava.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type LaunchOptions } from "playwright-core";
import { logger } from "@crmagro/core";
import { comPrazo } from "../../../packages/captation/src/navegador/prazo";
import {
  acharChromiumOrfaos,
  MARCADOR_PID_WORKER,
  type ProcessoInfo,
} from "../../../packages/captation/src/navegador/orfaos";

const MARCADOR_LANCAMENTO = "--crmagro-lancamento=";
const FECHAR_PRAZO_MS = 10_000;

/** Acha o Chromium já baixado pelo Playwright na VPS (sem baixar de novo). */
export function chromeExecutable(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(base)) return undefined;
  const dir = readdirSync(base).find((d) => d.startsWith("chromium-") && !d.includes("headless"));
  if (!dir) return undefined;
  for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
    const p = join(base, dir, sub);
    if (existsSync(p)) return p;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// /proc
// ---------------------------------------------------------------------------

function lerProcesso(pid: number): ProcessoInfo | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // O nome (2º campo) vem entre parênteses e pode ter espaço: parte depois do último ")".
    const campos = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+$/, "");
    return { pid, ppid: Number(campos[1]), pgid: Number(campos[2]), cmdline };
  } catch {
    return null; // o processo saiu entre o readdir e a leitura
  }
}

function listarProcessos(): ProcessoInfo[] {
  const out: ProcessoInfo[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const p = lerProcesso(Number(d));
    if (p) out.push(p);
  }
  return out;
}

function estaVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // existe, só não é nosso
  }
}

function sinalizar(pid: number, grupo: boolean, sinal: NodeJS.Signals): void {
  try {
    process.kill(grupo ? -pid : pid, sinal);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") logger.warn({ pid, grupo, sinal, err: code }, "[chromium] não consegui sinalizar o processo");
  }
}

/** SIGTERM no principal (o Chromium derruba os filhos); quem não sair em 5 s leva SIGKILL no grupo. */
async function encerrarProcessos(alvos: { pid: number; lideraGrupo: boolean }[]): Promise<void> {
  for (const a of alvos) sinalizar(a.pid, false, "SIGTERM");
  const limite = Date.now() + 5_000;
  while (Date.now() < limite && alvos.some((a) => estaVivo(a.pid))) {
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const a of alvos) if (estaVivo(a.pid)) sinalizar(a.pid, a.lideraGrupo, "SIGKILL");
}

// ---------------------------------------------------------------------------
// Lançar / fechar
// ---------------------------------------------------------------------------

export type ChromiumDoJob = {
  browser: Browser;
  /** Fecha o navegador com prazo; travou → mata a árvore DESTE lançamento. Idempotente. */
  encerrar: () => Promise<void>;
};

/** Lança um Chromium headless marcado (pid do worker + id do lançamento). */
export async function lancarChromium(opts: { args?: string[]; proxy?: LaunchOptions["proxy"] } = {}): Promise<ChromiumDoJob> {
  const lancamento = randomUUID();
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromeExecutable(),
    args: [
      "--no-sandbox",
      ...(opts.args ?? []),
      `${MARCADOR_PID_WORKER}${process.pid}`,
      `${MARCADOR_LANCAMENTO}${lancamento}`,
    ],
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  });

  let fechando: Promise<void> | null = null;
  const encerrar = () =>
    (fechando ??= (async () => {
      try {
        await comPrazo(browser.close(), FECHAR_PRAZO_MS, "fechar o Chromium");
      } catch (e) {
        logger.warn(
          { lancamento, err: e instanceof Error ? e.message : String(e) },
          "[chromium] close() travou — matando a árvore deste lançamento",
        );
        const meuPgid = lerProcesso(process.pid)?.pgid ?? -1;
        const alvos = listarProcessos()
          .filter((p) => p.cmdline.includes(`${MARCADOR_LANCAMENTO}${lancamento}`) && !/--type=/.test(p.cmdline))
          .map((p) => ({ pid: p.pid, lideraGrupo: p.pgid === p.pid && p.pgid !== meuPgid }));
        await encerrarProcessos(alvos);
      }
    })());
  return { browser, encerrar };
}

/**
 * No boot: encerra Chromium que sobrou de um worker morto (SIGKILL do pm2 com o
 * navegador travado). Só toca em Chromium com o marcador de pid cujo dono não
 * existe mais (ou não é mais o pai dele). Nunca lança.
 *
 * Roda no boot de TODO worker (primário e secundários) de propósito, e é
 * seguro assim: o Chromium vivo de outro worker tem o pai certo
 * (`ppid === dono`) e não é tocado. Não precisa "otimizar" para só o primário.
 */
export async function matarChromiumOrfao(): Promise<number> {
  try {
    const meuPgid = lerProcesso(process.pid)?.pgid ?? -1;
    const orfaos = acharChromiumOrfaos(listarProcessos(), { meuPid: process.pid, meuPgid, estaVivo });
    if (!orfaos.length) return 0;
    await encerrarProcessos(orfaos);
    logger.warn(
      { n: orfaos.length, orfaos: orfaos.map((o) => ({ pid: o.pid, dono: o.pidDono })) },
      "[chromium] Chromium órfão de um worker anterior encerrado",
    );
    return orfaos.length;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[chromium] falha ao procurar Chromium órfão");
    return 0;
  }
}
