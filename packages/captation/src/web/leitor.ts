import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";

/**
 * Leitor do SITE PÚBLICO de uma empresa: acha e-mail, telefone, WhatsApp e redes sociais que a
 * própria empresa publica. Roda direto do servidor do CRM Agro, sem terceiro no meio.
 *
 * Ideia de engenharia inspirada no Agent-Reach (https://github.com/Panniantong/Agent-Reach, MIT,
 * Copyright (c) 2025 Agent Eyes): ler página pública com teto de tamanho, reconhecer página de
 * captcha/bloqueio e recusar URL que não seja pública. Nenhum trecho de código foi copiado. Aqui a
 * proteção é mais forte: o DNS é resolvido e o IP conferido NA HORA DE CONECTAR (e a cada
 * redirecionamento), porque conferir só o texto do endereço deixa passar um nome público que
 * aponta para uma máquina interna.
 *
 * Segurança:
 *  - só http/https nas portas 80 e 443, sem usuário e senha, sem IP no endereço, sem nome interno;
 *  - IP privado, de loopback, de nuvem (169.254.x.x) ou reservado é recusado, inclusive em IPv6;
 *  - no máximo 4 redirecionamentos, cada um conferido de novo; 1,5 MB por página; 10 s;
 *  - respeita o `robots.txt` do site;
 *  - o texto da página NUNCA vai para um modelo de IA: a extração é por regra fixa (expressões
 *    regulares) e devolve só os valores achados. Não há prompt injection por este caminho. Os
 *    valores achados são sugestões: viram dado do cadastro só quando a pessoa confirma.
 */

export const SITE_TIMEOUT_MS = 10_000;
export const SITE_MAX_BYTES = 1_500_000;
export const SITE_MAX_REDIRECTS = 4;
export const SITE_USER_AGENT = "Mozilla/5.0 (compatible; CrmAgro/1.0; +https://crmagro.example)";

/** O site não pôde ser lido (com o motivo, em frase pronta para a tela). */
export class SiteIndisponivel extends Error {
  constructor(public readonly motivo: "url_invalida" | "endereco_nao_publico" | "robots" | "bloqueio" | "tempo" | "http" | "rede" | "tipo" | "grande" | "redirecionamentos") {
    super(MENSAGEM[motivo]);
    this.name = "SiteIndisponivel";
  }
}
const MENSAGEM: Record<SiteIndisponivel["motivo"], string> = {
  url_invalida: "O endereço do site não parece válido.",
  endereco_nao_publico: "O endereço do site não é público e não foi aberto.",
  robots: "O site pede que robôs não leiam esta página.",
  bloqueio: "O site bloqueou a leitura (captcha ou proteção contra robô).",
  tempo: "O site demorou demais para responder.",
  http: "O site respondeu com erro.",
  rede: "Não deu para abrir o site.",
  tipo: "O endereço não é uma página de site.",
  grande: "A página do site é grande demais.",
  redirecionamentos: "O site redirecionou demais.",
};

// ---------------------------------------------------------------------------
// Endereço público
// ---------------------------------------------------------------------------

const bloqueados = new BlockList();
for (const [rede, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  bloqueados.addSubnet(rede, bits, "ipv4");
}
for (const [rede, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4: embute um IPv4 qualquer
  ["64:ff9b::", 96], // NAT64: idem
  ["100::", 64],
] as const) {
  bloqueados.addSubnet(rede, bits, "ipv6");
}

/** O IP (v4 ou v6) é um endereço público da internet? Texto que não é IP → false. */
export function ipEhPublico(ip: string): boolean {
  const v = isIP(ip);
  if (!v) return false;
  return !bloqueados.check(ip, v === 4 ? "ipv4" : "ipv6");
}

const NOMES_INTERNOS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal", "instance-data", "ip6-localhost", "ip6-loopback"]);
const SUFIXOS_INTERNOS = [".local", ".localhost", ".internal", ".lan", ".home", ".home.arpa", ".localdomain", ".intranet", ".corp"];

/**
 * Endereço digitado → URL pública http(s) ou `SiteIndisponivel`. Pura (sem rede). Sem esquema vira
 * https. Recusa usuário e senha, porta fora de 80/443, IP no lugar do nome e nome interno.
 */
export function validarUrlPublica(entrada: string): URL {
  const texto = String(entrada ?? "").trim();
  // Espaço, barra invertida e caractere de controle (código abaixo de 32) nunca aparecem num endereço de site.
  if (!texto || texto.length > 2000 || /[\s\\]/.test(texto) || [...texto].some((c) => c.charCodeAt(0) < 32)) throw new SiteIndisponivel("url_invalida");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(texto) ? texto : `https://${texto}`);
  } catch {
    throw new SiteIndisponivel("url_invalida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SiteIndisponivel("url_invalida");
  if (url.username || url.password) throw new SiteIndisponivel("endereco_nao_publico");
  if (url.port && url.port !== "80" && url.port !== "443") throw new SiteIndisponivel("endereco_nao_publico");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || isIP(host.replace(/^\[|\]$/g, "")) || host.includes("%")) throw new SiteIndisponivel("endereco_nao_publico");
  if (!host.includes(".") || NOMES_INTERNOS.has(host) || SUFIXOS_INTERNOS.some((s) => host.endsWith(s))) throw new SiteIndisponivel("endereco_nao_publico");
  // Formas antigas de IPv4 ("2130706433", "0x7f.1") que o `URL` normaliza para dígitos: já viraram IP acima.
  return url;
}

type Resolvedor = (host: string) => Promise<{ address: string; family: number }[]>;
const resolverDoSistema: Resolvedor = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * `lookup` para o `http(s).request`: resolve o nome e RECUSA se qualquer endereço não for público.
 * É chamado pelo próprio Node na hora de conectar, então não há janela entre "conferir" e "usar".
 */
export function criarLookupSeguro(resolver: Resolvedor = resolverDoSistema) {
  return (
    host: string,
    opcoes: { all?: boolean; family?: number },
    cb: (err: Error | null, address?: string | { address: string; family: number }[], family?: number) => void,
  ): void => {
    resolver(host)
      .then((todos) => {
        if (!todos.length || todos.some((a) => !ipEhPublico(a.address))) return cb(new SiteIndisponivel("endereco_nao_publico"));
        if (opcoes?.all) return cb(null, todos);
        const a = todos[0]!;
        return cb(null, a.address, a.family);
      })
      .catch(() => cb(new SiteIndisponivel("rede")));
  };
}

// ---------------------------------------------------------------------------
// Rede
// ---------------------------------------------------------------------------

export type RespostaDeSite = { status: number; location: string | null; tipo: string; corpo: string };
/** Uma ida à rede: UMA url, sem seguir redirecionamento (quem segue é `lerPagina`, conferindo cada um). */
export type Transporte = (url: URL) => Promise<RespostaDeSite>;

/** Transporte real: `http(s).request` com o `lookup` seguro, teto de tempo e de tamanho. */
export function criarTransporte(opts: { resolver?: Resolvedor; maxBytes?: number; timeoutMs?: number } = {}): Transporte {
  const lookup = criarLookupSeguro(opts.resolver);
  const maxBytes = opts.maxBytes ?? SITE_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? SITE_TIMEOUT_MS;
  return (url) =>
    new Promise<RespostaDeSite>((resolve, reject) => {
      // IP no lugar do nome não passa pelo `lookup`: confere aqui também (defesa em profundidade).
      const literal = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(literal) && !ipEhPublico(literal)) return reject(new SiteIndisponivel("endereco_nao_publico"));
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        url,
        { method: "GET", lookup: lookup as unknown as http.RequestOptions["lookup"], timeout: timeoutMs, headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.8", "user-agent": SITE_USER_AGENT, "accept-language": "pt-BR,pt;q=0.9" } },
        (res) => {
          const status = res.statusCode ?? 0;
          const tipo = String(res.headers["content-type"] ?? "").toLowerCase();
          const location = typeof res.headers.location === "string" ? res.headers.location : null;
          if (status >= 300 && status < 400) {
            res.resume();
            return resolve({ status, location, tipo, corpo: "" });
          }
          const pedacos: Buffer[] = [];
          let total = 0;
          res.on("data", (c: Buffer) => {
            total += c.length;
            if (total > maxBytes) {
              req.destroy(new SiteIndisponivel("grande"));
              return;
            }
            pedacos.push(c);
          });
          res.on("end", () => resolve({ status, location: null, tipo, corpo: Buffer.concat(pedacos).toString("utf8") }));
          res.on("error", (e) => reject(e));
        },
      );
      req.on("timeout", () => req.destroy(new SiteIndisponivel("tempo")));
      req.on("error", (e) => reject(e instanceof SiteIndisponivel ? e : new SiteIndisponivel("rede")));
      req.end();
    });
}

/** Página de captcha ou de proteção contra robô (Cloudflare e parecidas). */
export function paginaDeBloqueio(corpo: string): boolean {
  const amostra = corpo.slice(0, 6000).toLowerCase();
  return (
    /<title>\s*(just a moment|attention required|access denied|verifying you are human|um momento)/.test(amostra) ||
    amostra.includes("/cdn-cgi/challenge-platform/") ||
    amostra.includes("cf-browser-verification") ||
    (amostra.includes("captcha") && amostra.includes("robot"))
  );
}

/** Lê uma URL seguindo no máximo `SITE_MAX_REDIRECTS` redirecionamentos, conferindo cada um. */
export async function lerPagina(entrada: string | URL, transporte: Transporte): Promise<{ url: URL; corpo: string }> {
  let url = typeof entrada === "string" ? validarUrlPublica(entrada) : validarUrlPublica(entrada.toString());
  for (let i = 0; i <= SITE_MAX_REDIRECTS; i++) {
    const r = await transporte(url);
    if (r.status >= 300 && r.status < 400 && r.location) {
      if (i === SITE_MAX_REDIRECTS) throw new SiteIndisponivel("redirecionamentos");
      let prox: URL;
      try {
        prox = new URL(r.location, url);
      } catch {
        throw new SiteIndisponivel("url_invalida");
      }
      url = validarUrlPublica(prox.toString()); // cada salto é conferido como se fosse o primeiro
      continue;
    }
    if (r.status === 403 || r.status === 429 || r.status === 503) {
      if (paginaDeBloqueio(r.corpo) || r.status !== 503) throw new SiteIndisponivel("bloqueio");
    }
    if (r.status < 200 || r.status >= 300) throw new SiteIndisponivel("http");
    if (r.tipo && !/text\/html|application\/xhtml|text\/plain/.test(r.tipo)) throw new SiteIndisponivel("tipo");
    if (paginaDeBloqueio(r.corpo)) throw new SiteIndisponivel("bloqueio");
    return { url, corpo: r.corpo };
  }
  throw new SiteIndisponivel("redirecionamentos");
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/** O caminho é permitido para o nosso robô? Leitura mínima do robots.txt (grupos `*` e `crmagro`). */
export function robotsPermite(robots: string, caminho: string): boolean {
  let grupoAtual: string[] = [];
  let lendoAgentes = false;
  const regras: { agentes: string[]; disallow: string[]; allow: string[] }[] = [];
  let corrente: { agentes: string[]; disallow: string[]; allow: string[] } | null = null;
  for (const bruta of robots.split(/\r?\n/)) {
    const linha = bruta.replace(/#.*$/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(linha);
    if (!m) continue;
    const chave = m[1]!.toLowerCase();
    const valor = m[2]!.trim();
    if (chave === "user-agent") {
      if (!lendoAgentes) {
        grupoAtual = [];
        corrente = { agentes: grupoAtual, disallow: [], allow: [] };
        regras.push(corrente);
      }
      grupoAtual.push(valor.toLowerCase());
      lendoAgentes = true;
    } else if ((chave === "disallow" || chave === "allow") && corrente) {
      lendoAgentes = false;
      if (valor) corrente[chave].push(valor);
    } else {
      lendoAgentes = false;
    }
  }
  const nosso = regras.filter((r) => r.agentes.some((a) => a.includes("crmagro")));
  const grupos = nosso.length ? nosso : regras.filter((r) => r.agentes.includes("*"));
  const casa = (padrao: string) => {
    const re = new RegExp("^" + padrao.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    return re.test(caminho);
  };
  let melhor: { tamanho: number; permite: boolean } | null = null;
  for (const g of grupos) {
    for (const p of g.disallow) if (casa(p) && (!melhor || p.length > melhor.tamanho)) melhor = { tamanho: p.length, permite: false };
    for (const p of g.allow) if (casa(p) && (!melhor || p.length >= melhor.tamanho)) melhor = { tamanho: p.length, permite: true };
  }
  return melhor ? melhor.permite : true;
}

// ---------------------------------------------------------------------------
// Extração (regra fixa, sem IA)
// ---------------------------------------------------------------------------

export type EmailDoSite = { valor: string; doDominioDoSite: boolean; generico: boolean };
export type TelefoneDoSite = { valor: string; whatsapp: boolean };
export type ContatosDoSite = {
  emails: EmailDoSite[];
  telefones: TelefoneDoSite[];
  instagram: string | null;
  linkedin: string | null;
  facebook: string | null;
};

const WEBMAIL = /(^|\.)(gmail|hotmail|outlook|yahoo|live|icloud|uol|bol|terra|ig|msn)\.(com|com\.br|net|br)$/;
const EMAIL_LIXO = /(^|\.)(example|exemplo|domain|email|sentry|wixpress|sentry-next|wordpress|schema|w3|yoursite|seusite)\.(com|org|net|io|com\.br)$/;
const EXTENSAO_DE_ARQUIVO = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|eot|pdf|mp4|map)$/i;

function limparHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
}

function decodificar(t: string): string {
  return t
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&commat;|&#64;/g, "@")
    .replace(/&period;/g, ".");
}

/** decodeURIComponent que não estoura em "%" solto. */
function decodificarUrl(t: string): string {
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

/** DDD válido (11 a 99, sem os que não existem) + 8 ou 9 dígitos. Devolve só dígitos com o 55 na frente; null se não for telefone do Brasil. */
export function telefoneBrasileiro(bruto: string): string | null {
  let d = bruto.replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length === 11 && d[2] !== "9") return null; // celular tem 9 na frente
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99 || ddd % 10 === 0) return null;
  if (/^(\d)\1+$/.test(d.slice(2))) return null; // 99999999
  if (d.length === 10 && !/^[2-5]/.test(d[2]!)) return null; // fixo começa com 2 a 5
  return `55${d}`;
}

/** Acha e-mail, telefone, WhatsApp e redes no HTML. Pura: o mesmo HTML dá sempre o mesmo resultado. */
export function extrairContatosDoHtml(html: string, hostDoSite: string): ContatosDoSite {
  const base = decodificar(limparHtml(html));
  const textoVisivel = base.replace(/<[^>]+>/g, " ");
  const host = hostDoSite.toLowerCase().replace(/^www\./, "");

  const emails = new Map<string, EmailDoSite>();
  const achaEmail = (bruto: string) => {
    const v = bruto.trim().toLowerCase().replace(/^mailto:/, "").replace(/[?&].*$/, "").replace(/[.,;:)>\]]+$/, "");
    if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) || v.length > 120) return;
    const dominio = v.split("@")[1]!;
    if (EXTENSAO_DE_ARQUIVO.test(v) || EMAIL_LIXO.test(dominio) || /^(\d+x|@)/.test(v) || /@\d+x\./.test(v)) return;
    if (!emails.has(v)) emails.set(v, { valor: v, doDominioDoSite: dominio === host || dominio.endsWith(`.${host}`) || host.endsWith(`.${dominio}`), generico: WEBMAIL.test(dominio) });
  };
  for (const m of base.matchAll(/mailto:([^"'\s>]+)/gi)) achaEmail(decodificarUrl(m[1]!));
  for (const m of textoVisivel.matchAll(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi)) achaEmail(m[0]);

  const telefones = new Map<string, TelefoneDoSite>();
  const achaTelefone = (bruto: string, whatsapp: boolean) => {
    const v = telefoneBrasileiro(bruto);
    if (!v) return;
    const antes = telefones.get(v);
    telefones.set(v, { valor: v, whatsapp: whatsapp || Boolean(antes?.whatsapp) });
  };
  for (const m of base.matchAll(/(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?(?:[^"'\s>]*&)?phone=|web\.whatsapp\.com\/send\?phone=|whatsapp:\/\/send\?phone=)\+?(\d{10,13})/gi)) achaTelefone(m[1]!, true);
  for (const m of base.matchAll(/tel:\s*([+\d()\s.-]{8,20})/gi)) achaTelefone(m[1]!, false);
  for (const m of textoVisivel.matchAll(/(?:\+?55\s?)?\(?\b[1-9]\d\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g)) achaTelefone(m[0], false);

  const rede = (re: RegExp, invalidos: RegExp): string | null => {
    for (const m of base.matchAll(re)) {
      const nome = decodificarUrl(m[1]!).replace(/\/$/, "");
      if (nome && !invalidos.test(nome)) return nome;
    }
    return null;
  };
  const instagram = rede(/instagram\.com\/([a-z0-9._]{2,30})(?=[/?"'\s<]|$)/gi, /^(p|reel|reels|explore|accounts|stories|tv|share|about|legal|direct|developer)$/i);
  const linkedin = rede(/linkedin\.com\/((?:company|in)\/[a-z0-9._%-]{2,100})(?=[/?"'\s<]|$)/gi, /^$/);
  const facebook = rede(/facebook\.com\/([a-z0-9._-]{3,60})(?=[/?"'\s<]|$)/gi, /^(sharer|share|tr|plugins|dialog|login|pages|policies|help|groups|events|watch)(\.php)?$/i);

  return {
    emails: [...emails.values()].slice(0, 10),
    telefones: [...telefones.values()].slice(0, 10),
    instagram: instagram ? `https://www.instagram.com/${instagram}` : null,
    linkedin: linkedin ? `https://www.linkedin.com/${linkedin}` : null,
    facebook: facebook ? `https://www.facebook.com/${facebook}` : null,
  };
}

/** Procura, na página inicial, um link para a página de contato do MESMO site. */
export function linkDeContato(html: string, base: URL): URL | null {
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    if (!/contato|contact|fale-?conosco|atendimento|quem-?somos|sobre/i.test(m[1]!)) continue;
    try {
      const u = new URL(decodificar(m[1]!), base);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "") && u.pathname !== base.pathname) return u;
    } catch {
      /* link quebrado: ignora */
    }
  }
  return null;
}

export type SiteLido = { url: string; paginas: string[]; lidoEm: string; contatos: ContatosDoSite };

function juntar(a: ContatosDoSite, b: ContatosDoSite): ContatosDoSite {
  const emails = new Map(a.emails.map((e) => [e.valor, e]));
  for (const e of b.emails) if (!emails.has(e.valor)) emails.set(e.valor, e);
  const tels = new Map(a.telefones.map((t) => [t.valor, t]));
  for (const t of b.telefones) tels.set(t.valor, { valor: t.valor, whatsapp: t.whatsapp || Boolean(tels.get(t.valor)?.whatsapp) });
  return {
    emails: [...emails.values()].slice(0, 10),
    telefones: [...tels.values()].slice(0, 10),
    instagram: a.instagram ?? b.instagram,
    linkedin: a.linkedin ?? b.linkedin,
    facebook: a.facebook ?? b.facebook,
  };
}

/**
 * Lê a página inicial do site da empresa e, se houver, a de contato (no máximo 2 páginas), e devolve
 * o que a empresa publica. `transporte` entra por parâmetro só nos testes (o padrão é o real, com a
 * proteção de DNS). Lança `SiteIndisponivel` com o motivo.
 */
export async function lerSiteDaEmpresa(entrada: string, deps: { transporte?: Transporte; agora?: () => Date } = {}): Promise<SiteLido> {
  const transporte = deps.transporte ?? criarTransporte();
  const inicio = validarUrlPublica(entrada);

  // robots.txt: se não der para ler, segue (é o costume); se proibir a raiz, para.
  try {
    const r = await lerPagina(new URL("/robots.txt", inicio), transporte);
    if (!robotsPermite(r.corpo, inicio.pathname || "/")) throw new SiteIndisponivel("robots");
  } catch (e) {
    if (e instanceof SiteIndisponivel && e.motivo === "robots") throw e;
  }

  const home = await lerPagina(inicio, transporte);
  let contatos = extrairContatosDoHtml(home.corpo, home.url.hostname);
  const paginas = [home.url.toString()];
  const contato = linkDeContato(home.corpo, home.url);
  if (contato) {
    try {
      const r = await lerPagina(contato, transporte);
      contatos = juntar(contatos, extrairContatosDoHtml(r.corpo, r.url.hostname));
      paginas.push(r.url.toString());
    } catch {
      /* a página de contato é um extra: sem ela, vale a inicial */
    }
  }
  return { url: home.url.toString(), paginas, lidoEm: (deps.agora?.() ?? new Date()).toISOString(), contatos };
}
