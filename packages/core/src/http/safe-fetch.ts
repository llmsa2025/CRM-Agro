import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * `safeFetch` — requisição HTTP para URL que vem do USUÁRIO (auditoria S6/MF-22).
 *
 * O nó `http_request` do fluxo aceitava qualquer URL: `http://127.0.0.1:8081`
 * (Evolution), `localhost:<porta>` dos outros apps do VPS, `169.254.169.254`
 * (metadados da nuvem), IPs do Docker — e ainda seguia redirect. O status ia
 * para o histórico: dava para varrer portas internas.
 *
 * Aqui:
 * - só `https:` (`http:` só com `allowHttp` explícito);
 * - resolve o DNS ANTES e recusa se QUALQUER endereço for privado, loopback,
 *   link-local, CGNAT, ULA, multicast, documentação ou reservado (v4 e v6);
 * - FIXA o IP validado na conexão (`lookup` próprio): o DNS não pode trocar de
 *   resposta entre a checagem e o connect (DNS rebinding);
 * - redirect manual, revalidando cada salto (máx. 3);
 * - timeout (15 s) e limite de tamanho da resposta (1 MB por padrão).
 */

export class SafeFetchBlocked extends Error {
  /**
   * `validacao` = barrado ANTES de conectar (destino/protocolo proibido): nada
   * saiu. `transporte` = timeout/tamanho DEPOIS de conectar: pode ter chegado.
   */
  constructor(
    motivo: string,
    readonly fase: "validacao" | "transporte" = "validacao",
  ) {
    super(`SafeFetchBlocked: ${motivo}`);
    this.name = "SafeFetchBlocked";
  }
}

const bloqueados = new net.BlockList();
for (const [rede, bits] of [
  ["0.0.0.0", 8], // "esta rede"
  ["10.0.0.0", 8], // privada
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (metadados da nuvem)
  ["172.16.0.0", 12], // privada
  ["192.0.0.0", 24], // IETF
  ["192.0.2.0", 24], // documentação
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // privada
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // documentação
  ["203.0.113.0", 24], // documentação
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservada + broadcast
] as const) {
  bloqueados.addSubnet(rede, bits, "ipv4");
}
for (const [rede, bits] of [
  ["::", 128], // não especificado
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // NAT64 local
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentação
  ["fc00::", 7], // ULA
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  bloqueados.addSubnet(rede, bits, "ipv6");
}

/** IPv4 embutido num IPv6 (mapeado `::ffff:a.b.c.d` ou NAT64 `64:ff9b::a.b.c.d`). */
function ipv4Embutido(ip: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1]!;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const a = parseInt(hex[1]!, 16);
    const b = parseInt(hex[2]!, 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** true = endereço que uma URL de usuário NUNCA pode atingir. */
export function ipBloqueado(ip: string): boolean {
  const limpo = ip.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  const v = net.isIP(limpo);
  if (v === 4) return bloqueados.check(limpo, "ipv4");
  if (v === 6) {
    const v4 = ipv4Embutido(limpo);
    if (v4) return bloqueados.check(v4, "ipv4");
    return bloqueados.check(limpo, "ipv6");
  }
  return true; // não é IP: quem chamou errou — bloqueia
}

export type Resolvido = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<Resolvido[]>;

const resolverPadrao: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((r) => ({
    address: r.address,
    family: r.family === 6 ? 6 : 4,
  }));

/** Resolve o host e recusa se QUALQUER resposta for bloqueada. Devolve o IP a fixar. */
export async function resolverPublico(hostname: string, resolver: Resolver = resolverPadrao): Promise<Resolvido> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new SafeFetchBlocked(`host não permitido (${hostname})`);
  }
  const ipLiteral = net.isIP(host);
  const lista: Resolvido[] = ipLiteral ? [{ address: host, family: ipLiteral === 6 ? 6 : 4 }] : await resolver(host);
  if (lista.length === 0) throw new SafeFetchBlocked(`host sem endereço (${hostname})`);
  const ruim = lista.find((r) => ipBloqueado(r.address));
  if (ruim) throw new SafeFetchBlocked(`endereço interno ou reservado (${hostname})`);
  return lista[0]!;
}

export type SafeFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Padrão 15 s. */
  timeoutMs?: number;
  /** Padrão 1 MB. Estourou → SafeFetchBlocked. */
  maxBytes?: number;
  /** Padrão 3. */
  maxRedirects?: number;
  /** Permite `http:` (padrão: só https). */
  allowHttp?: boolean;
};

export type SafeResponse = {
  status: number;
  ok: boolean;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

/** Faz UMA requisição já com o IP fixado. Injetável nos testes. */
export type Transporte = (
  url: URL,
  ip: Resolvido,
  init: Required<Pick<SafeFetchInit, "method" | "timeoutMs" | "maxBytes">> & Pick<SafeFetchInit, "headers" | "body">,
) => Promise<SafeResponse>;

const transportePadrao: Transporte = (url, ip, init) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: init.method,
        headers: init.headers,
        // IP fixado: o connect usa o endereço VALIDADO, não uma nova consulta de
        // DNS. O TLS continua validando o certificado pelo hostname (SNI).
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          if (opts?.all) cb(null, [{ address: ip.address, family: ip.family }]);
          else cb(null, ip.address, ip.family);
        }) as never,
        timeout: init.timeoutMs,
      },
      (res) => {
        const partes: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > init.maxBytes) {
            req.destroy(new SafeFetchBlocked(`resposta maior que ${init.maxBytes} bytes`, "transporte"));
            return;
          }
          partes.push(c);
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300, headers: res.headers, body: Buffer.concat(partes) });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new SafeFetchBlocked(`tempo esgotado (${init.timeoutMs} ms)`, "transporte")));
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });

/**
 * Requisição segura para URL do usuário. Lança `SafeFetchBlocked` quando o
 * destino/limite não é permitido; erros de rede sobem como estão.
 */
export async function safeFetch(
  urlEntrada: string,
  init: SafeFetchInit = {},
  deps: { resolver?: Resolver; transporte?: Transporte } = {},
): Promise<SafeResponse> {
  const resolver = deps.resolver ?? resolverPadrao;
  const transporte = deps.transporte ?? transportePadrao;
  const maxRedirects = init.maxRedirects ?? 3;
  let metodo = (init.method ?? "GET").toUpperCase();
  let corpo = init.body;
  let url: URL;
  try {
    url = new URL(urlEntrada);
  } catch {
    throw new SafeFetchBlocked("URL inválida");
  }

  for (let salto = 0; ; salto++) {
    if (url.protocol !== "https:" && !(init.allowHttp && url.protocol === "http:")) {
      throw new SafeFetchBlocked(`protocolo não permitido (${url.protocol})`);
    }
    if (url.username || url.password) throw new SafeFetchBlocked("credenciais na URL não são permitidas");
    const ip = await resolverPublico(url.hostname, resolver);
    const res = await transporte(url, ip, {
      method: metodo,
      headers: init.headers,
      body: corpo,
      timeoutMs: Math.min(init.timeoutMs ?? 15_000, 30_000),
      maxBytes: init.maxBytes ?? 1024 * 1024,
    });
    const destino = res.headers.location;
    if (res.status >= 300 && res.status < 400 && destino) {
      if (salto >= maxRedirects) throw new SafeFetchBlocked(`redirecionamentos demais (> ${maxRedirects})`);
      url = new URL(Array.isArray(destino) ? destino[0]! : destino, url);
      // Semântica do fetch: 303 (e 301/302 de POST) viram GET sem corpo.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && metodo !== "GET" && metodo !== "HEAD")) {
        metodo = "GET";
        corpo = undefined;
      }
      continue; // o próximo salto passa por TODA a validação de novo
    }
    return res;
  }
}
