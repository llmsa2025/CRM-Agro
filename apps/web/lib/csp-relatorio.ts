/**
 * Saneamento dos relatórios de violação da CSP (POST /api/csp-report). Módulo PURO: recebe o JSON que o
 * navegador mandou (não confiável, qualquer um pode postar) e devolve só o que pode ir para o log.
 *
 * O que NUNCA sai daqui: query string e fragmento (URLs como /redefinir-senha?token=... levam segredo),
 * o trecho de código da violação (`script-sample`: a política não pede `report-sample`, e se vier é
 * descartado), o `original-policy`, o user-agent, o IP e qualquer id de contato, de conversa ou de time
 * que apareça no caminho (viram `:id`). O que sai: a diretiva violada, o host bloqueado (ou a palavra
 * `inline`/`eval`), a página sem query e o arquivo de origem sem query.
 *
 * Ruído de extensão do navegador (chrome-extension:, moz-extension:...) é descartado por inteiro: o
 * relatório não diz nada sobre o app.
 */

export type RelatorioSaneado = {
  /** Diretiva efetivamente violada (ex.: `script-src-elem`, `img-src`). */
  diretiva: string;
  /** Host bloqueado (`https://x.com`), caminho do próprio app, ou a palavra `inline`, `eval`, `data`, `blob`. */
  bloqueado: string;
  /** Caminho da página, sem query nem fragmento, com ids trocados por `:id`. */
  pagina: string;
  /** Arquivo de onde veio a violação (caminho sem query), quando houver. */
  arquivo?: string;
  /** `report` (política só de relatório) ou `enforce` (política aplicada). */
  disposicao: "report" | "enforce";
};

const MAX_RELATORIOS_POR_PEDIDO = 10;
const MAX_TEXTO = 200;

const ESQUEMAS_DE_EXTENSAO = new Set([
  "chrome-extension:",
  "moz-extension:",
  "safari-extension:",
  "safari-web-extension:",
  "ms-browser-extension:",
  "webkit-masked-url:",
]);

/** Palavras que a CSP usa no lugar de uma URL. */
const PALAVRAS = new Set(["inline", "eval", "wasm-eval", "wasm-unsafe-eval", "data", "blob", "self", "about", "trusted-types-policy", "trusted-types-sink"]);

const FORMATO_DIRETIVA = /^[a-z][a-z-]{1,40}$/;
const SEGMENTO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Segmento de caminho que parece identificador (uuid, número, cuid, token longo): não vai para o log. */
function pareceId(segmento: string): boolean {
  if (SEGMENTO_UUID.test(segmento)) return true;
  if (/^\d{3,}$/.test(segmento)) return true;
  return segmento.length >= 20 && /^[A-Za-z0-9_-]+$/.test(segmento);
}

/** Só o caminho, sem query nem fragmento, com os ids trocados por `:id` e tamanho limitado. */
export function caminhoSaneado(caminho: string): string {
  const limpo = caminho.split(/[?#]/)[0] ?? "";
  const partes = limpo.split("/").map((p) => {
    let seg = p;
    try {
      seg = decodeURIComponent(p);
    } catch {
      /* segmento com % inválido: segue como veio */
    }
    return pareceId(seg) ? ":id" : p;
  });
  const junto = partes.join("/") || "/";
  return junto.length > MAX_TEXTO ? `${junto.slice(0, MAX_TEXTO)}...` : junto;
}

function comoTexto(valor: unknown): string | null {
  return typeof valor === "string" ? valor : null;
}

type Alvo = { tipo: "extensao" } | { tipo: "vazio" } | { tipo: "palavra"; texto: string } | { tipo: "url"; host: string; protocolo: string; caminho: string };

/** Classifica um `blocked-uri` ou `source-file`. */
function classificar(bruto: string | null): Alvo {
  const texto = (bruto ?? "").trim();
  if (!texto) return { tipo: "vazio" };
  const minusculo = texto.toLowerCase();
  if (PALAVRAS.has(minusculo)) return { tipo: "palavra", texto: minusculo };
  // `data:image/svg+xml,...` e `blob:https://x/uuid` viram só a palavra (o resto pode ter conteúdo).
  if (minusculo.startsWith("data:")) return { tipo: "palavra", texto: "data" };
  if (minusculo.startsWith("blob:")) return { tipo: "palavra", texto: "blob" };
  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    return { tipo: "palavra", texto: "invalido" };
  }
  if (ESQUEMAS_DE_EXTENSAO.has(url.protocol)) return { tipo: "extensao" };
  if (url.protocol === "about:" || url.protocol === "javascript:") return { tipo: "palavra", texto: url.protocol.slice(0, -1) };
  return { tipo: "url", host: url.host, protocolo: url.protocol, caminho: url.pathname };
}

/** Normaliza um relatório (formato antigo `csp-report` ou novo `reports+json`) ou devolve null se for ruído. */
function sanear(campos: Record<string, unknown>): RelatorioSaneado | null {
  // Os dois formatos usam nomes diferentes para os mesmos campos.
  const pegar = (...nomes: string[]) => {
    for (const n of nomes) {
      const v = comoTexto(campos[n]);
      if (v !== null) return v;
    }
    return null;
  };

  const bloqueado = classificar(pegar("blocked-uri", "blockedURL", "blockedUrl"));
  const origem = classificar(pegar("source-file", "sourceFile"));
  if (bloqueado.tipo === "extensao" || origem.tipo === "extensao") return null;

  const efetiva = pegar("effective-directive", "effectiveDirective") ?? pegar("violated-directive")?.split(/\s+/)[0] ?? "";
  const diretiva = FORMATO_DIRETIVA.test(efetiva) ? efetiva : "desconhecida";

  const documento = classificar(pegar("document-uri", "documentURL", "documentUrl"));
  const pagina = documento.tipo === "url" ? caminhoSaneado(documento.caminho) : "(sem página)";
  const hostDaPagina = documento.tipo === "url" ? documento.host : null;

  // Bloqueado: URL de OUTRO host vira só `protocolo//host` (o caminho de uma URL assinada do Supabase
  // leva id de time e nome de arquivo). URL do próprio app mantém o caminho (ex.: /maplibre/...).
  let alvo: string;
  if (bloqueado.tipo === "url") {
    alvo = bloqueado.host === hostDaPagina ? caminhoSaneado(bloqueado.caminho) : `${bloqueado.protocolo}//${bloqueado.host}`.slice(0, MAX_TEXTO);
  } else if (bloqueado.tipo === "palavra") {
    alvo = bloqueado.texto;
  } else {
    // `blocked-uri` vazio é violação de `inline` em alguns navegadores.
    alvo = "(vazio)";
  }

  const resultado: RelatorioSaneado = {
    diretiva,
    bloqueado: alvo,
    pagina,
    disposicao: pegar("disposition") === "enforce" ? "enforce" : "report",
  };
  if (origem.tipo === "url") {
    resultado.arquivo = origem.host === hostDaPagina ? caminhoSaneado(origem.caminho) : `${origem.protocolo}//${origem.host}`.slice(0, MAX_TEXTO);
  }
  return resultado;
}

function comoObjeto(valor: unknown): Record<string, unknown> | null {
  return valor && typeof valor === "object" && !Array.isArray(valor) ? (valor as Record<string, unknown>) : null;
}

/**
 * Aceita os dois formatos de corpo:
 *  - `application/csp-report` (`report-uri`): `{ "csp-report": { ... } }`;
 *  - `application/reports+json` (`report-to`): `[ { type: "csp-violation", url, body: { ... } } ]`.
 * Devolve só os relatórios de violação válidos e que não sejam ruído de extensão (no máximo 10 por pedido).
 */
export function normalizarRelatorios(corpo: unknown): RelatorioSaneado[] {
  const saida: RelatorioSaneado[] = [];
  const candidatos: Record<string, unknown>[] = [];

  const legado = comoObjeto(corpo)?.["csp-report"];
  if (comoObjeto(legado)) candidatos.push(legado as Record<string, unknown>);

  if (Array.isArray(corpo)) {
    for (const item of corpo.slice(0, MAX_RELATORIOS_POR_PEDIDO)) {
      const relatorio = comoObjeto(item);
      if (!relatorio || relatorio.type !== "csp-violation") continue;
      const dentro = comoObjeto(relatorio.body);
      if (!dentro) continue;
      // O `url` do envelope é a página; o corpo também traz `documentURL`. Vale o do corpo, senão o do envelope.
      candidatos.push({ "document-uri": relatorio.url, ...dentro });
    }
  }

  for (const campos of candidatos.slice(0, MAX_RELATORIOS_POR_PEDIDO)) {
    const limpo = sanear(campos);
    if (limpo) saida.push(limpo);
  }
  return saida;
}
