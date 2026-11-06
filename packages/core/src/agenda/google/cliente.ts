/**
 * Cliente HTTP do Google (OAuth + Calendar API v3) — fetch puro, sem SDK.
 *
 * É o ÚNICO lugar que fala com o Google: os testes trocam este módulo inteiro
 * por um Google simulado (`vi.mock`), então nenhum teste chama a API de verdade
 * (criar evento com convidado MANDA convite real).
 *
 * Regras:
 * - Nunca loga token nem corpo de resposta: os erros levam só o status HTTP e o
 *   `reason` do Google (ex.: `rateLimitExceeded`, `invalid_grant`).
 * - Timeout em toda chamada (o Google às vezes pendura).
 * - `sendUpdates` sempre explícito (o padrão do Google é NÃO avisar).
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";
const TIMEOUT_MS = 15_000;

/** Escopo mínimo da agenda (decisão 2): ver e editar eventos. */
export const ESCOPO_AGENDA = "https://www.googleapis.com/auth/calendar.events";
/**
 * Enviar e-mail pela conta Google da pessoa (E7). Escopo SENSÍVEL (não restrito):
 * só envia, não lê a caixa. Nunca pedir `gmail.readonly` nem `mail.google.com`
 * neste projeto (escopo restrito exige a auditoria CASA).
 */
export const ESCOPO_GMAIL_ENVIO = "https://www.googleapis.com/auth/gmail.send";
/** Só para saber QUAL conta Google foi conectada (`sub` e e-mail do id_token). */
export const ESCOPOS_IDENTIDADE = ["openid", "email"] as const;

/** Erro de uma chamada ao Google: status HTTP + motivo curto (nunca o corpo). */
export class GoogleApiErro extends Error {
  constructor(
    readonly status: number,
    readonly motivo: string | null,
  ) {
    super(`GoogleApiErro: HTTP ${status}${motivo ? ` (${motivo})` : ""}`);
    this.name = "GoogleApiErro";
  }
}

/**
 * O Google recusou a autorização de vez (`invalid_grant`: token revogado, 6
 * meses sem uso, 7 dias no modo de teste, conta desativada). Não adianta
 * tentar de novo: a pessoa precisa reconectar.
 */
export class GoogleAutorizacaoInvalida extends Error {
  constructor(readonly motivo: string) {
    super(`GoogleAutorizacaoInvalida: ${motivo}`);
    this.name = "GoogleAutorizacaoInvalida";
  }
}

export type TokensGoogle = {
  accessToken: string;
  expiraEm: Date;
  /** Só na troca do code com `access_type=offline` (e quando o Google manda um novo). */
  refreshToken?: string;
  /** Escopos CONCEDIDOS (a pessoa pode desmarcar a agenda na tela do Google). */
  escopos: string[];
  idToken?: string;
};

export type HorarioGoogle = { dateTime?: string; date?: string; timeZone?: string };
export type ConvidadoGoogle = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
  // Atributos que o CRM Agro não guarda, mas que o PATCH mantém para quem continua.
  optional?: boolean;
  comment?: string;
  additionalGuests?: number;
};

/** Recorte do recurso Events que o CRM Agro usa. */
export type EventoGoogle = {
  id: string;
  status?: string;
  etag?: string;
  updated?: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: HorarioGoogle;
  end?: HorarioGoogle;
  transparency?: string;
  eventType?: string;
  recurringEventId?: string;
  organizer?: { email?: string; self?: boolean };
  attendees?: ConvidadoGoogle[];
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: { requestId: string; conferenceSolutionKey: { type: string }; status?: { statusCode?: string } };
    conferenceId?: string;
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
};

/** Corpo que o CRM Agro manda no insert/patch (sem campos só de leitura). */
export type EventoParaGoogle = Omit<EventoGoogle, "id" | "etag" | "updated" | "iCalUID" | "hangoutLink"> & { id?: string };

export type PaginaDeEventos = {
  items: EventoGoogle[];
  nextPageToken?: string;
  nextSyncToken?: string;
  timeZone?: string;
};

export type OpcoesDeEscrita = { sendUpdates: "all" | "externalOnly" | "none"; conferenceDataVersion?: 0 | 1 };

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Motivo curto do erro do Google, sem o corpo (pode ter dado da pessoa). */
async function motivoDoErro(res: Response): Promise<string | null> {
  try {
    const j = (await res.json()) as { error?: unknown; error_description?: unknown };
    if (typeof j.error === "string") return j.error.slice(0, 80); // endpoint de token: "invalid_grant"
    const e = j.error as { errors?: { reason?: string }[]; status?: string } | undefined;
    return (e?.errors?.[0]?.reason ?? e?.status ?? null)?.slice(0, 80) ?? null;
  } catch {
    return null;
  }
}

async function chamar(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function chamarApi<T>(accessToken: string, metodo: string, caminho: string, corpo?: unknown): Promise<T> {
  const res = await chamar(`${API}${caminho}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  });
  if (!res.ok) throw new GoogleApiErro(res.status, await motivoDoErro(res));
  if (res.status === 204) return undefined as T;
  const texto = await res.text();
  return (texto ? JSON.parse(texto) : undefined) as T;
}

type RespostaToken = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
};

async function pedirToken(params: Record<string, string>): Promise<TokensGoogle> {
  const res = await chamar(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const motivo = await motivoDoErro(res);
    if (motivo === "invalid_grant") throw new GoogleAutorizacaoInvalida(motivo);
    throw new GoogleApiErro(res.status, motivo);
  }
  const j = (await res.json()) as RespostaToken;
  if (!j.access_token) throw new GoogleApiErro(res.status, "sem_access_token");
  return {
    accessToken: j.access_token,
    // Folga de 60 s: renova antes de o Google recusar.
    expiraEm: new Date(Date.now() + Math.max(0, (j.expires_in ?? 3600) - 60) * 1000),
    refreshToken: j.refresh_token,
    escopos: (j.scope ?? "").split(" ").filter(Boolean),
    idToken: j.id_token,
  };
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/** Troca o `code` do retorno pelos tokens (PKCE: manda o `code_verifier`). */
export function trocarCodigo(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokensGoogle> {
  return pedirToken({
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "authorization_code",
  });
}

/** Novo access token a partir do refresh token. `invalid_grant` → GoogleAutorizacaoInvalida. */
export function renovarAccessToken(input: { refreshToken: string; clientId: string; clientSecret: string }): Promise<TokensGoogle> {
  return pedirToken({
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
  });
}

/**
 * Revoga o token no Google. ATENÇÃO: derruba TODOS os escopos que a pessoa deu
 * ao PROJETO (o login "Entrar com Google" é do mesmo projeto e volta a pedir
 * consentimento no próximo login). Token já inválido (400) conta como revogado.
 */
export async function revogarToken(token: string): Promise<void> {
  const res = await chamar(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  if (res.ok || res.status === 400) return;
  throw new GoogleApiErro(res.status, await motivoDoErro(res));
}

// ---------------------------------------------------------------------------
// Calendar API v3
// ---------------------------------------------------------------------------

const cal = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}/events`;

function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function inserirEvento(accessToken: string, calendarId: string, evento: EventoParaGoogle, opts: OpcoesDeEscrita): Promise<EventoGoogle> {
  return chamarApi(accessToken, "POST", `${cal(calendarId)}${query({ sendUpdates: opts.sendUpdates, conferenceDataVersion: opts.conferenceDataVersion ?? 1 })}`, evento);
}

/** PATCH: campo omitido fica como está; array enviado (convidados) SUBSTITUI o de lá. */
export function atualizarEvento(
  accessToken: string,
  calendarId: string,
  eventId: string,
  evento: EventoParaGoogle,
  opts: OpcoesDeEscrita,
): Promise<EventoGoogle> {
  return chamarApi(
    accessToken,
    "PATCH",
    `${cal(calendarId)}/${encodeURIComponent(eventId)}${query({ sendUpdates: opts.sendUpdates, conferenceDataVersion: opts.conferenceDataVersion ?? 1 })}`,
    evento,
  );
}

/** Cancela (apaga) o evento; com `sendUpdates=all` os convidados recebem o cancelamento. 404/410 = já não existe. */
export async function cancelarEvento(accessToken: string, calendarId: string, eventId: string, opts: OpcoesDeEscrita): Promise<void> {
  try {
    await chamarApi(accessToken, "DELETE", `${cal(calendarId)}/${encodeURIComponent(eventId)}${query({ sendUpdates: opts.sendUpdates })}`);
  } catch (e) {
    if (e instanceof GoogleApiErro && (e.status === 404 || e.status === 410)) return;
    throw e;
  }
}

/** O evento COMPLETO (título, descrição, convidados). Só para evento do CRM Agro ou com contato. */
export function obterEvento(accessToken: string, calendarId: string, eventId: string): Promise<EventoGoogle> {
  return chamarApi(accessToken, "GET", `${cal(calendarId)}/${encodeURIComponent(eventId)}`);
}

/**
 * Uma página do events.list. `fields` restringe a resposta (privacidade: o
 * título, a descrição e o local dos eventos pessoais nem saem do Google).
 * `syncToken` não combina com `timeMin`/`timeMax` (o Google devolve 400).
 * `showDeleted` vai SEMPRE (na completa e na incremental, os mesmos
 * parâmetros): a completa depois de um 410 também traz o que foi apagado
 * no meio do caminho, para o compromisso ligado ser cancelado (decisão 6).
 */
export function listarEventos(
  accessToken: string,
  calendarId: string,
  params: { syncToken?: string; pageToken?: string; timeMin?: string; timeMax?: string; fields: string; maxResults?: number },
): Promise<PaginaDeEventos> {
  return chamarApi(
    accessToken,
    "GET",
    `${cal(calendarId)}${query({
      singleEvents: true,
      showDeleted: true,
      maxResults: params.maxResults ?? 250,
      syncToken: params.syncToken,
      pageToken: params.pageToken,
      timeMin: params.syncToken ? undefined : params.timeMin,
      timeMax: params.syncToken ? undefined : params.timeMax,
      fields: params.fields,
    })}`,
  );
}

/** Abre um canal de push (events.watch). O Google avisa na `address` quando a agenda muda. */
export async function assistirAgenda(
  accessToken: string,
  calendarId: string,
  canal: { id: string; token: string; address: string; ttlSeg: number },
): Promise<{ resourceId: string; expiraEm: Date }> {
  const r = await chamarApi<{ resourceId?: string; expiration?: string | number }>(accessToken, "POST", `${cal(calendarId)}/watch`, {
    id: canal.id,
    type: "web_hook",
    address: canal.address,
    token: canal.token,
    params: { ttl: String(canal.ttlSeg) },
  });
  if (!r?.resourceId) throw new GoogleApiErro(200, "watch_sem_resource");
  const exp = Number(r.expiration);
  return { resourceId: r.resourceId, expiraEm: new Date(Number.isFinite(exp) && exp > 0 ? exp : Date.now() + canal.ttlSeg * 1000) };
}

/** Para um canal de push (só com o token do MESMO usuário e do MESMO cliente OAuth). */
export async function pararCanal(accessToken: string, canal: { id: string; resourceId: string }): Promise<void> {
  try {
    await chamarApi(accessToken, "POST", "/channels/stop", { id: canal.id, resourceId: canal.resourceId });
  } catch (e) {
    if (e instanceof GoogleApiErro && (e.status === 404 || e.status === 410)) return;
    throw e;
  }
}
