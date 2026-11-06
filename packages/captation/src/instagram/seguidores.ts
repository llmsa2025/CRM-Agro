import { z } from "zod";

/**
 * Captação de seguidores no Instagram — usa a API privada `api/v1` com o cookie
 * de sessão da conta conectada. Só
 * fetch, sem Playwright: por isso mora aqui e é testável com fetch falso.
 *
 * ⚠️ ALTO RISCO: trata dado pessoal de terceiro (LGPD arts. 7º/11) e pode contrariar os
 * termos da Meta. Uso e responsabilidade são do operador. O ritmo é lento por respeito
 * aos limites da plataforma.
 *
 * Item 3.2 (INT-12): antes um 429 na página 30 descartava ~1.450 seguidores já
 * coletados (o `throw` subia antes do `insertDrafts` do fim) e o usuário
 * reenviava, batendo de novo no Instagram desde o começo. Agora:
 * - cada página vai para `aoPagina` ASSIM que chega (quem chama grava o
 *   rascunho) — o que já veio nunca se perde;
 * - 429 (ou "espere alguns minutos") PARA na hora e devolve o parcial; sessão
 *   caída (401/403/checkpoint) também para — insistir é pedir ban;
 * - toda requisição tem teto (`AbortSignal.timeout`).
 *
 * Bio (produto §H.5): opcional (`bios.max`), porque custa 1 requisição POR
 * seguidor ao `web_profile_info` — o mesmo JSON do perfil, campo `biography`.
 * Com teto por job (o worker passa `INSTAGRAM_BIO_MAX`, validado no
 * `@crmagro/config`), pausa humana entre uma e outra e as
 * mesmas regras de parada: 429/sessão caída na bio PARAM a coleta inteira (a
 * sessão é a mesma) e o que já veio é entregue; perfil sumido ou erro de rede
 * numa bio só deixam aquela bio vazia.
 */

const APP_ID = "936619743392459";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** Teto de cada requisição ao Instagram. */
export const INSTAGRAM_TIMEOUT_MS = 20_000;
/** Seguidores por página pedidos à API (o Instagram costuma respeitar 50). */
const POR_PAGINA = 50;
/** Trava de segurança: nunca pagina mais que isto num job. */
const MAX_PAGINAS = 40;
/** Tamanho máximo guardado de uma bio (o Instagram limita a 150; folga para emoji). */
const BIO_MAX_CHARS = 300;

export type SeguidorInstagram = {
  username: string;
  nome: string;
  email: string | null;
  telefone: string | null;
  /** Bio do perfil; null = sem bio, não buscada (fora do teto) ou não deu para ler. */
  bio: string | null;
};

/** Motivo de uma coleta interrompida no meio (o que já veio foi entregue). */
export type InterrupcaoInstagram = "limite_instagram" | "sessao_instagram" | "erro";

export type ResultadoSeguidores = {
  lidos: number;
  paginas: number;
  interrupcao: { motivo: InterrupcaoInstagram; detalhe: string } | null;
};

/** Sessão (cookie) recusada: deslogado, checkpoint ou conta bloqueada. */
export class InstagramSessaoInvalida extends Error {
  constructor(detalhe: string) {
    super(`sessão do Instagram recusada (${detalhe}). Reconecte a conta`);
    this.name = "InstagramSessaoInvalida";
  }
}

/** O Instagram limitou as requisições (429 ou "espere alguns minutos"). */
export class InstagramLimite extends Error {
  constructor(detalhe: string) {
    super(`o Instagram limitou as requisições (${detalhe})`);
    this.name = "InstagramLimite";
  }
}

export class InstagramPerfilNaoEncontrado extends Error {
  constructor(public readonly perfil: string) {
    super(`perfil @${perfil} não encontrado`);
    this.name = "InstagramPerfilNaoEncontrado";
  }
}

// Respostas (parciais) da API — zod na borda. `passthrough`: só validamos o
// que lemos; o Instagram devolve dezenas de campos.
const perfilSchema = z
  .object({
    data: z
      .object({ user: z.object({ id: z.string(), biography: z.string().nullish() }).passthrough().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const paginaSchema = z
  .object({
    users: z.array(z.object({ username: z.string(), full_name: z.string().nullish() }).passthrough()).nullish(),
    next_max_id: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

/** Corpo de recusa que o Instagram manda até com HTTP 200/400. */
const recusaSchema = z
  .object({ message: z.string().nullish(), require_login: z.boolean().nullish(), status: z.string().nullish() })
  .passthrough();

type Fetch = typeof fetch;

function headers(cookie: string): Record<string, string> {
  return {
    "user-agent": UA,
    "x-ig-app-id": APP_ID,
    accept: "*/*",
    cookie: cookie.startsWith("sessionid=") ? cookie : `sessionid=${cookie}`,
  };
}

/**
 * Classifica uma resposta de recusa. `null` = não é recusa conhecida.
 * O Instagram às vezes responde 200/400 com `{"message":"Please wait a few
 * minutes..."}` (é um 429 disfarçado) ou `{"require_login":true}`.
 */
export function classificarRecusaInstagram(status: number, corpo: unknown): InterrupcaoInstagram | null {
  if (status === 429) return "limite_instagram";
  if (status === 401 || status === 403) return "sessao_instagram";
  const r = recusaSchema.safeParse(corpo);
  if (!r.success) return null;
  const msg = (r.data.message ?? "").toLowerCase();
  if (r.data.require_login || /checkpoint|login_required|challenge/.test(msg)) return "sessao_instagram";
  if (/wait a few minutes|tente novamente mais tarde|try again later|rate limit/.test(msg)) return "limite_instagram";
  return null;
}

async function lerJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return null; // corpo não-JSON (HTML de login, por exemplo) — quem chama decide pelo status
  }
}

async function buscarUserId(f: Fetch, cookie: string, perfil: string, timeoutMs: number): Promise<string> {
  const r = await f(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(perfil)}`,
    { headers: headers(cookie), signal: AbortSignal.timeout(timeoutMs) },
  );
  const corpo = await lerJson(r);
  if (r.status === 404) throw new InstagramPerfilNaoEncontrado(perfil);
  const recusa = classificarRecusaInstagram(r.status, corpo);
  if (recusa === "limite_instagram") throw new InstagramLimite(`HTTP ${r.status}`);
  if (recusa === "sessao_instagram") throw new InstagramSessaoInvalida(`HTTP ${r.status}`);
  if (!r.ok) throw new Error(`perfil não acessível (HTTP ${r.status})`);
  const p = perfilSchema.safeParse(corpo);
  const id = p.success ? p.data.data?.user?.id : null;
  if (!id) throw new InstagramPerfilNaoEncontrado(perfil);
  return id;
}

/** Resultado da busca de UMA bio: o texto, ou a recusa que manda parar tudo. */
type BioLida = { bio: string | null; recusa: { motivo: InterrupcaoInstagram; detalhe: string } | null };

/**
 * Bio de um perfil (`biography` do `web_profile_info`). 429/sessão → `recusa`
 * (quem chama para a coleta); 404, timeout, formato estranho → bio null e segue.
 */
export async function buscarBioInstagram(f: Fetch, cookie: string, username: string, timeoutMs: number): Promise<BioLida> {
  let r: Response;
  try {
    r = await f(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      { headers: headers(cookie), signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch {
    return { bio: null, recusa: null };
  }
  const corpo = await lerJson(r);
  const recusa = classificarRecusaInstagram(r.status, corpo);
  if (recusa) return { bio: null, recusa: { motivo: recusa, detalhe: `bio de @${username}: HTTP ${r.status}` } };
  if (!r.ok) return { bio: null, recusa: null };
  const p = perfilSchema.safeParse(corpo);
  const bio = p.success ? p.data.data?.user?.biography?.trim() : null;
  return { bio: bio ? bio.slice(0, BIO_MAX_CHARS) : null, recusa: null };
}

/**
 * Pagina os seguidores de um perfil e entrega cada página a `aoPagina` (que
 * grava o rascunho). Com `bios.max > 0`, busca a bio dos primeiros `max`
 * seguidores (1 requisição cada, com pausa). E-mail/telefone continuam de fora;
 * o username já é "contato" para o DM.
 *
 * Erros ANTES da 1ª página (perfil, sessão, limite) sobem como exceção nomeada;
 * depois dela, a coleta para e devolve o parcial em `interrupcao`.
 */
export async function coletarSeguidoresInstagram(opts: {
  cookie: string;
  perfil: string;
  limite: number;
  aoPagina: (itens: SeguidorInstagram[]) => Promise<void>;
  /** Bio dos primeiros `max` seguidores (padrão: nenhuma). */
  bios?: { max: number };
  /** Injetáveis para teste. */
  fetchImpl?: Fetch;
  esperar?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<ResultadoSeguidores> {
  const f = opts.fetchImpl ?? fetch;
  const esperar = opts.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? INSTAGRAM_TIMEOUT_MS;
  const alvo = opts.perfil.replace(/^@/, "").trim();
  const userId = await buscarUserId(f, opts.cookie, alvo, timeoutMs);

  let biosRestantes = Math.max(0, Math.floor(opts.bios?.max ?? 0));
  const vistos = new Set<string>();
  let lidos = 0;
  let paginas = 0;
  let maxId: string | null = null;
  for (let pagina = 0; pagina < MAX_PAGINAS && lidos < opts.limite; pagina++) {
    const url =
      `https://www.instagram.com/api/v1/friendships/${userId}/followers/?count=${POR_PAGINA}&search_surface=follow_list_page` +
      (maxId ? `&max_id=${encodeURIComponent(maxId)}` : "");
    let r: Response;
    try {
      r = await f(url, { headers: headers(opts.cookie), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const causa = e instanceof Error && e.name === "TimeoutError" ? `sem resposta em ${timeoutMs / 1000}s` : e instanceof Error ? e.message : String(e);
      return { lidos, paginas, interrupcao: { motivo: "erro", detalhe: `página ${pagina + 1}: ${causa}` } };
    }
    const corpo = await lerJson(r);
    const recusa = classificarRecusaInstagram(r.status, corpo);
    if (recusa) return { lidos, paginas, interrupcao: { motivo: recusa, detalhe: `página ${pagina + 1}: HTTP ${r.status}` } };
    if (!r.ok) return { lidos, paginas, interrupcao: { motivo: "erro", detalhe: `página ${pagina + 1}: HTTP ${r.status}` } };
    const p = paginaSchema.safeParse(corpo);
    if (!p.success) return { lidos, paginas, interrupcao: { motivo: "erro", detalhe: `página ${pagina + 1}: resposta fora do formato` } };

    const novos: SeguidorInstagram[] = [];
    for (const u of p.data.users ?? []) {
      if (lidos + novos.length >= opts.limite) break;
      if (vistos.has(u.username)) continue; // a API repete gente entre páginas
      vistos.add(u.username);
      novos.push({ username: u.username, nome: u.full_name?.trim() || u.username, email: null, telefone: null, bio: null });
    }
    paginas++;
    // Bios da página, uma a uma e com pausa. Recusa (429/sessão) para TUDO,
    // mas a página vai para `aoPagina` antes — nada do que veio se perde.
    let paradaNaBio: ResultadoSeguidores["interrupcao"] = null;
    for (const u of novos) {
      if (biosRestantes <= 0) break;
      biosRestantes--;
      await esperar(1500 + Math.random() * 1500); // ritmo humano entre perfis
      const b = await buscarBioInstagram(f, opts.cookie, u.username, timeoutMs);
      if (b.recusa) {
        paradaNaBio = b.recusa;
        break;
      }
      u.bio = b.bio;
    }
    if (novos.length) {
      await opts.aoPagina(novos);
      lidos += novos.length;
    }
    if (paradaNaBio) return { lidos, paginas, interrupcao: paradaNaBio };
    const proximo = p.data.next_max_id;
    if (proximo == null || proximo === "") break;
    maxId = String(proximo);
    await esperar(2000 + Math.random() * 1500); // ritmo humano entre páginas
  }
  return { lidos, paginas, interrupcao: null };
}
