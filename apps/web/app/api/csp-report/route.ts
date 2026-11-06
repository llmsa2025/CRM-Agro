import { logger, rateLimit } from "@crmagro/core";
import { normalizarRelatorios, type RelatorioSaneado } from "@/lib/csp-relatorio";

/**
 * POST /api/csp-report
 *
 * Recebe os relatórios de violação da política de segurança de conteúdo (CSP). É PÚBLICO e anônimo de
 * propósito: o navegador manda o relatório sem cookie e também a partir da tela de login. Por isso:
 *  - limite por IP e corpo máximo pequeno (qualquer um pode postar aqui);
 *  - aceita só `application/csp-report` (report-uri) e `application/reports+json` (report-to);
 *  - não grava no banco e não responde nada além de 204: só escreve no log (pino, no pm2) os campos
 *    saneados por `normalizarRelatorios` (diretiva, host bloqueado, página e arquivo SEM query string,
 *    ids no caminho trocados por `:id`, sem IP, sem user-agent, sem trecho de código);
 *  - repetição idêntica dentro de 1 minuto é descartada (uma página com defeito dispara dezenas de
 *    relatórios iguais por carga).
 *
 * Como ler: `grep csp-violacao ~/.pm2/logs/crmagro-web-out.log`
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMITE_CORPO_BYTES = 8 * 1024;
const POR_IP = { max: 60, janelaMs: 60_000 };
const JANELA_REPETIDOS_MS = 60_000;
const MAX_CHAVES_REPETIDOS = 1000;
const TIPOS_ACEITOS = ["application/csp-report", "application/reports+json", "application/json"];

/** Último registro de cada violação, para não repetir a mesma linha no log a cada carga de página. */
const vistos = new Map<string, number>();

function repetido(r: RelatorioSaneado, agora: number): boolean {
  const chave = `${r.disposicao}|${r.diretiva}|${r.bloqueado}|${r.pagina}|${r.arquivo ?? ""}`;
  const ultima = vistos.get(chave);
  if (ultima !== undefined && agora - ultima < JANELA_REPETIDOS_MS) return true;
  if (vistos.size >= MAX_CHAVES_REPETIDOS) vistos.clear();
  vistos.set(chave, agora);
  return false;
}

function ipDoCliente(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
}

/** Lê o corpo até o limite; null se passar dele (o resto nem é lido). */
async function lerCorpoLimitado(req: Request): Promise<string | null> {
  const declarado = Number(req.headers.get("content-length"));
  if (Number.isFinite(declarado) && declarado > LIMITE_CORPO_BYTES) return null;
  if (!req.body) return "";
  const leitor = req.body.getReader();
  const pedacos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITE_CORPO_BYTES) {
      await leitor.cancel().catch(() => undefined);
      return null;
    }
    pedacos.push(value);
  }
  return Buffer.concat(pedacos).toString("utf8");
}

const semConteudo = () => new Response(null, { status: 204 });

export async function POST(req: Request) {
  try {
    const rl = await rateLimit(`csp-report:${ipDoCliente(req) ?? "sem-ip"}`, POR_IP.max, POR_IP.janelaMs);
    if (!rl.allowed) {
      return new Response(null, { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } });
    }

    const tipo = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!TIPOS_ACEITOS.includes(tipo)) return new Response(null, { status: 415 });

    const texto = await lerCorpoLimitado(req);
    if (texto === null) return new Response(null, { status: 413 });

    let corpo: unknown;
    try {
      corpo = JSON.parse(texto);
    } catch {
      return semConteudo();
    }

    const agora = Date.now();
    for (const relatorio of normalizarRelatorios(corpo)) {
      if (repetido(relatorio, agora)) continue;
      logger.warn(relatorio, "csp-violacao");
    }
  } catch {
    // Relatório é telemetria: qualquer falha aqui NUNCA vira erro 5xx para o navegador.
  }
  return semConteudo();
}
