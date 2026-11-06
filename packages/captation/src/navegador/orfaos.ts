/**
 * Chromium órfão (item 3.2, INT-11). Todo Chromium que o worker lança leva na
 * linha de comando o marcador `--crmagro-worker-pid=<pid do worker>` (o Chromium
 * ignora switch desconhecido). No boot, o worker novo acha os que sobraram de
 * um processo que morreu (SIGKILL do pm2 com o navegador travado) e os encerra
 * — antes eles ficavam fora do teto de memória do pm2, comendo a RAM da VPS.
 *
 * Puro: recebe a lista de processos (lida de /proc pelo worker) e decide.
 * Conferido na VPS (Chromium 149 do Playwright 1.62):
 * - o processo principal lidera o PRÓPRIO grupo (o Playwright lança com
 *   `detached`), e zygote/gpu/renderer ficam no mesmo grupo, sem o marcador;
 * - o Chromium reescreve a linha de comando dos processos numa string só,
 *   separada por espaço (não por NUL) — por isso a busca é por regex.
 */

export const MARCADOR_PID_WORKER = "--crmagro-worker-pid=";

export type ProcessoInfo = { pid: number; ppid: number; pgid: number; cmdline: string };

export type ChromiumOrfao = {
  pid: number;
  /** Pid do worker que o lançou (já morto, ou o Chromium foi adotado por outro). */
  pidDono: number;
  /** Lidera o próprio grupo (e não é o grupo do worker): dá para derrubar a árvore toda. */
  lideraGrupo: boolean;
};

/** Pid do worker gravado no marcador, ou null se o processo não tem marcador. */
export function pidDoMarcador(cmdline: string): number | null {
  const m = cmdline.match(/--crmagro-worker-pid=(\d+)/);
  return m ? Number(m[1]) : null;
}

/** O executável (1º token) é um Chromium? Evita pegar `grep --crmagro-worker-pid=…`. */
function ehChromium(cmdline: string): boolean {
  const exe = cmdline.split(/[\0 ]/)[0] ?? "";
  return /(^|\/)(chrome|chromium|chromium-browser|headless_shell|chrome-headless-shell)$/.test(exe);
}

/**
 * Chromium do worker cujo dono não existe mais. Órfão = o pid marcado morreu,
 * OU o Chromium não é mais filho dele (o dono morreu e o pid foi reusado por
 * outro processo — o Chromium órfão é adotado pelo init).
 */
export function acharChromiumOrfaos(
  procs: ProcessoInfo[],
  opts: { meuPid: number; meuPgid: number; estaVivo: (pid: number) => boolean },
): ChromiumOrfao[] {
  const out: ChromiumOrfao[] = [];
  for (const p of procs) {
    if (p.pid === opts.meuPid) continue;
    const dono = pidDoMarcador(p.cmdline);
    if (dono == null || !ehChromium(p.cmdline)) continue;
    // Só o principal carrega o marcador; se um filho carregar, o grupo do principal o leva.
    if (/--type=/.test(p.cmdline)) continue;
    const orfao = !opts.estaVivo(dono) || p.ppid !== dono;
    if (!orfao) continue;
    out.push({ pid: p.pid, pidDono: dono, lideraGrupo: p.pgid === p.pid && p.pgid !== opts.meuPgid });
  }
  return out;
}
