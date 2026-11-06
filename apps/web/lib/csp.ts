import { modoCsp, type ModoCsp } from "@crmagro/config/csp-modo";

/**
 * Política de segurança de conteúdo (CSP) do app web. Módulo PURO e seguro para o Edge Runtime do
 * middleware: só Web Crypto e `URL`, sem `node:crypto`, sem banco, sem ler `process.env` (quem lê é o
 * middleware, que passa os valores). Inventário e decisões: a documentação interna.
 *
 * O que a política faz, por diretiva:
 *  - `script-src` com nonce por requisição e `'strict-dynamic'`: só roda script que o servidor marcou.
 *    Sem `'unsafe-inline'` e (fora do dev) sem `'unsafe-eval'`. É a diretiva que barra XSS.
 *  - `style-src 'self' 'unsafe-inline'`: INEVITÁVEL hoje. O sonner (toasts), o react-style-singleton
 *    (travamento de rolagem de todo modal Radix), o next-themes e ~30 usos de `style={}` injetam estilo
 *    sem nonce, e nonce não cobre atributo `style`. Estilo em linha não executa script; o risco que
 *    sobra é só visual (esconder ou sobrepor elementos). Endurecer isso é etapa futura.
 *  - `img-src` e `media-src` com a origem do Supabase Storage (URL assinada direto no navegador).
 *  - `connect-src` com a mesma origem (fetch, SSE da IA, Socket.IO), o wss do próprio host e os hosts
 *    de tiles do mapa.
 *  - `worker-src` com `'self'` e `blob:`: o worker do MapLibre (/maplibre/...) e o service worker de push.
 *  - `object-src 'none'`, `frame-src 'none'`, `base-uri 'self'`, `form-action` (o login com Google
 *    redireciona para accounts.google.com), `frame-ancestors 'none'` (só quando aplicada).
 *
 * O Caddy já manda HSTS, nosniff, X-Frame-Options e Referrer-Policy: nada disso se repete aqui, e a CSP
 * NÃO deve ir também no Caddyfile (o navegador aplicaria as duas e valeria a interseção).
 */

export type { ModoCsp };
export { modoCsp };

/** Caminho do endpoint público que recebe os relatórios de violação (app/api/csp-report). */
export const ENDPOINT_RELATORIO = "/api/csp-report";

/** Tiles do mapa (MapaClient.tsx): estilo/fontes/vetores do OpenFreeMap e a imagem de satélite da Esri. */
export const HOSTS_DO_MAPA: readonly string[] = ["https://tiles.openfreemap.org", "https://server.arcgisonline.com"];
/** O login com Google (server action) responde 303 para cá; o Chrome aplica `form-action` ao redirect. */
export const HOSTS_DO_LOGIN: readonly string[] = ["https://accounts.google.com"];

export type HostsDaCsp = {
  /** Origem pública do app (de AUTH_URL ou do Host do pedido): vira o `wss://` explícito do Socket.IO. */
  publico?: string | null;
  /** Origem do Supabase Storage (de SUPABASE_URL). Ausente ou inválida = sem mídia externa. */
  supabase?: string | null;
  /** Hosts dos tiles do mapa. Padrão: `HOSTS_DO_MAPA`. */
  mapa?: readonly string[];
  /** Destinos de redirect do `form-action`. Padrão: `HOSTS_DO_LOGIN`. */
  login?: readonly string[];
  /** Extras que entram em `connect-src` e `img-src` (ex.: geoserver.car.gov.br quando a camada CAR entrar). */
  extras?: readonly string[];
};

export type OpcoesDaCsp = {
  /** Nonce da requisição (`novoNonce()`). */
  nonce: string;
  modo: ModoCsp;
  hosts?: HostsDaCsp;
  /** Dev: `'unsafe-eval'` (o React em dev exige) e `ws:`/`wss:` (HMR). Nunca em produção. */
  dev?: boolean;
};

/** Nonce de 128 bits em base64 (Web Crypto, vale no Edge). Um por requisição. */
export function novoNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let texto = "";
  for (const b of bytes) texto += String.fromCharCode(b);
  return btoa(texto);
}

/** Mesmo formato que o Next aceita ao ler o nonce do cabeçalho (get-script-nonce-from-header). */
const FORMATO_NONCE = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

/** Host (sem esquema): letras, dígitos, ponto e hífen. Nada que pareça separador de diretiva. */
const FORMATO_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/** Loopback: o único lugar onde `http:` é aceito fora do dev (o teste local do build de produção). */
const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

/**
 * Valida um endereço e devolve só a ORIGEM (`https://host[:porta]`, sem caminho), ou null se não servir.
 * Nada que venha do ambiente ou do cabeçalho Host entra na política sem passar por aqui: um valor com
 * espaço, `;`, aspas ou `*` nunca vira diretiva. `http:` só com `permitirHttp` (dev) ou em loopback.
 */
export function origemSegura(valor: string | null | undefined, permitirHttp = false): string | null {
  if (!valor) return null;
  let url: URL;
  try {
    url = new URL(valor.trim());
  } catch {
    return null;
  }
  const http = url.protocol === "http:" && (permitirHttp || LOOPBACK.has(url.hostname));
  if (url.protocol !== "https:" && !http) return null;
  if (url.username || url.password || !FORMATO_HOST.test(url.hostname)) return null;
  return url.origin;
}

/** `wss://host` (ou `ws://host` num app em http) para a origem do app; null se não houver origem. */
function origemDoWebSocket(origem: string | null | undefined): string | null {
  if (!origem) return null;
  return origem.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

/** Lista de origens válidas, sem repetição, na ordem em que vieram. */
function origensValidas(lista: readonly string[] | undefined, permitirHttp: boolean): string[] {
  const vistas = new Set<string>();
  for (const item of lista ?? []) {
    const origem = origemSegura(item, permitirHttp);
    if (origem) vistas.add(origem);
  }
  return [...vistas];
}

/**
 * Monta o texto do cabeçalho de CSP. Lança erro se o nonce não tiver o formato esperado (nunca monta uma
 * política com texto solto) e devolve "" para o modo `desligada`.
 *
 * ORDEM: `script-src` vem antes de qualquer `script-src-elem`/`script-src-attr` (o Next lê o nonce da
 * primeira diretiva que COMEÇA com "script-src"). No modo `relatorio` ficam de fora as diretivas que o
 * navegador ignora em política só de relatório (`frame-ancestors`): sem elas o console não enche de aviso.
 */
export function montarCsp({ nonce, modo, hosts = {}, dev = false }: OpcoesDaCsp): string {
  if (modo === "desligada") return "";
  if (!FORMATO_NONCE.test(nonce)) throw new Error("nonce da CSP em formato inválido");

  const permitirHttp = dev;
  const supabase = origemSegura(hosts.supabase, permitirHttp);
  const publico = origemSegura(hosts.publico, permitirHttp);
  const websocket = origemDoWebSocket(publico);
  const mapa = origensValidas(hosts.mapa ?? HOSTS_DO_MAPA, permitirHttp);
  const login = origensValidas(hosts.login ?? HOSTS_DO_LOGIN, permitirHttp);
  const extras = origensValidas(hosts.extras, permitirHttp);

  const script = [`'nonce-${nonce}'`, "'strict-dynamic'", "'self'"];
  if (dev) script.push("'unsafe-eval'");

  const conexao = ["'self'", ...(websocket ? [websocket] : []), ...mapa, ...extras];
  if (dev) conexao.push("ws:", "wss:");

  const diretivas: string[][] = [
    ["default-src", "'self'"],
    ["script-src", ...script],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:", ...(supabase ? [supabase] : []), ...extras],
    ["media-src", "'self'", "blob:", ...(supabase ? [supabase] : [])],
    ["font-src", "'self'"],
    ["connect-src", ...conexao],
    ["worker-src", "'self'", "blob:"],
    ["manifest-src", "'self'"],
    ["frame-src", "'none'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'", ...login],
  ];
  // frame-ancestors só vale em política APLICADA: em relatório o navegador ignora e avisa no console.
  if (modo === "aplicada") diretivas.push(["frame-ancestors", "'none'"]);
  // Só `report-uri`: o Chromium, o Firefox e o Safari entregam na hora, em application/csp-report. O `report-to`
  // (Reporting API) ficou de fora: não consegui provar a entrega no Chromium de teste, e com ele presente o
  // Chrome ignora o `report-uri`, o que deixaria o relatório mudo sem aviso. O endpoint já aceita reports+json.
  diretivas.push(["report-uri", ENDPOINT_RELATORIO]);

  return diretivas.map((d) => d.join(" ")).join("; ");
}

/** Nome do cabeçalho de CSP por modo (o mesmo na requisição, para o Next achar o nonce, e na resposta). */
export function nomeDoCabecalhoCsp(modo: ModoCsp): "Content-Security-Policy" | "Content-Security-Policy-Report-Only" | null {
  if (modo === "aplicada") return "Content-Security-Policy";
  if (modo === "relatorio") return "Content-Security-Policy-Report-Only";
  return null;
}

type Ambiente = Record<string, string | undefined>;

/**
 * Hosts da política a partir do ambiente. O Supabase vem de `SUPABASE_URL` EM TEMPO DE EXECUÇÃO (a mesma
 * fonte que assina as URLs de mídia): trocar de projeto Supabase muda a política sem mexer no código.
 * A origem pública vem de `AUTH_URL`/`APP_PUBLIC_URL` e, sem elas, da origem do pedido (validada).
 */
export function hostsDoAmbiente(env: Ambiente, origemDoPedido: string | null | undefined, dev: boolean): HostsDaCsp {
  return {
    publico: origemSegura(env.AUTH_URL, dev) ?? origemSegura(env.APP_PUBLIC_URL, dev) ?? origemSegura(origemDoPedido, dev),
    supabase: origemSegura(env.SUPABASE_URL, dev),
  };
}

/**
 * Esta requisição pede um DOCUMENTO (página HTML)? Só ela leva CSP: o navegador ignora o cabeçalho nas
 * respostas de fetch, de worker e de arquivo, e dar nonce a elas seria só custo. `Sec-Fetch-Dest` é a
 * fonte (todo navegador atual manda); sem ele (curl, Safari antigo), vale o `Accept: text/html`.
 * API e requisições RSC do Next (navegação do lado do cliente) ficam de fora.
 */
export function pedidoDeDocumento(cabecalhos: Pick<Headers, "get">, caminho: string): boolean {
  if (caminho === "/api" || caminho.startsWith("/api/")) return false;
  if (cabecalhos.get("rsc")) return false;
  const destino = cabecalhos.get("sec-fetch-dest");
  if (destino) return destino === "document";
  return (cabecalhos.get("accept") ?? "").includes("text/html");
}
