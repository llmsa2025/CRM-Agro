/**
 * Cliente HTTP do LinkedIn oficial (entrar com LinkedIn e publicar): fetch puro, sem SDK.
 *
 * É o ÚNICO lugar que fala com o LinkedIn: os testes trocam este módulo por um LinkedIn
 * simulado (`vi.mock`), então nenhum teste publica de verdade (um post vai ao perfil público).
 *
 * Regras:
 * - Nunca loga token nem corpo de resposta: os erros levam só o status HTTP e um motivo curto.
 * - Timeout em toda chamada.
 * - O LinkedIn não dá refresh token no acesso aberto: o token vale ~60 dias e a pessoa reconecta.
 */

export const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const REVOKE_URL = "https://www.linkedin.com/oauth/v2/revoke";
const API = "https://api.linkedin.com";
const TIMEOUT_MS = 15_000;
/** Subir uma imagem pode demorar mais que uma chamada comum. */
const TIMEOUT_UPLOAD_MS = 60_000;

/** Entrar (identidade) e publicar no perfil da própria pessoa. Nada além disso é pedido. */
export const ESCOPOS_LINKEDIN = ["openid", "profile", "email", "w_member_social"] as const;
export const ESCOPO_PUBLICAR = "w_member_social";

/** Versão da API de posts (`LinkedIn-Version`, formato AAAAMM). O LinkedIn mantém cada versão por cerca de um ano. */
export const VERSAO_PADRAO_DA_API = "202606";

/** Erro de uma chamada ao LinkedIn: status HTTP + motivo curto (nunca o corpo). */
export class LinkedinApiErro extends Error {
  constructor(
    readonly status: number,
    readonly motivo: string | null,
  ) {
    super(`LinkedinApiErro: HTTP ${status}${motivo ? ` (${motivo})` : ""}`);
    this.name = "LinkedinApiErro";
  }
}

export type TokensLinkedin = {
  accessToken: string;
  /** Quando o token vence (o LinkedIn manda `expires_in`, ~60 dias). */
  expiraEm: Date;
  /** Escopos CONCEDIDOS (a pessoa pode desmarcar a permissão de publicar). */
  escopos: string[];
};

export type PerfilLinkedin = {
  /** Id estável da pessoa NESTE app (vira o `urn:li:person:<sub>` do autor do post). */
  sub: string;
  nome: string;
  email: string | null;
};

async function chamar(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** Motivo curto do erro, sem o corpo (pode ter dado da pessoa). */
async function motivoDoErro(res: Response): Promise<string | null> {
  try {
    const j = (await res.json()) as { error?: unknown; code?: unknown; message?: unknown; serviceErrorCode?: unknown };
    if (typeof j.error === "string") return j.error.slice(0, 80); // endpoint de token: "invalid_request"
    if (typeof j.serviceErrorCode === "number") return `servico_${j.serviceErrorCode}`;
    if (typeof j.code === "string") return j.code.slice(0, 80);
    return null;
  } catch {
    return null;
  }
}

/** Troca o `code` do retorno pelo token de acesso. */
export async function trocarCodigo(input: { code: string; redirectUri: string; clientId: string; clientSecret: string }): Promise<TokensLinkedin> {
  const res = await chamar(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }).toString(),
  });
  if (!res.ok) throw new LinkedinApiErro(res.status, await motivoDoErro(res));
  const j = (await res.json()) as { access_token?: string; expires_in?: number; scope?: string };
  if (!j.access_token) throw new LinkedinApiErro(res.status, "sem_access_token");
  return {
    accessToken: j.access_token,
    expiraEm: new Date(Date.now() + (j.expires_in && j.expires_in > 0 ? j.expires_in : 60 * 24 * 3600) * 1000),
    // O LinkedIn separa os escopos por vírgula (outros, por espaço): aceita os dois.
    escopos: (j.scope ?? "").split(/[\s,]+/).filter(Boolean),
  };
}

/** Quem é a pessoa do token (OpenID `userinfo`). */
export async function lerPerfil(accessToken: string): Promise<PerfilLinkedin> {
  const res = await chamar(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new LinkedinApiErro(res.status, await motivoDoErro(res));
  const j = (await res.json()) as { sub?: string; name?: string; given_name?: string; family_name?: string; email?: string };
  if (!j.sub) throw new LinkedinApiErro(res.status, "sem_sub");
  const nome = (j.name ?? [j.given_name, j.family_name].filter(Boolean).join(" ")).trim();
  return { sub: j.sub, nome: nome || "LinkedIn", email: j.email?.trim().toLowerCase() || null };
}

/** Revoga o token no LinkedIn (melhor esforço: ao desconectar). Token já inválido conta como revogado. */
export async function revogarToken(input: { token: string; clientId: string; clientSecret: string }): Promise<void> {
  const res = await chamar(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: input.token, client_id: input.clientId, client_secret: input.clientSecret }).toString(),
  });
  if (res.ok || res.status === 400 || res.status === 401) return;
  throw new LinkedinApiErro(res.status, await motivoDoErro(res));
}

// ---------------------------------------------------------------------------
// Publicar (Posts API)
// ---------------------------------------------------------------------------

function cabecalhosDaApi(accessToken: string, versao: string, json = true): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Restli-Protocol-Version": "2.0.0",
    "LinkedIn-Version": versao,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

/**
 * Pede ao LinkedIn um lugar para subir a imagem. Devolve a URL de envio (PUT) e o
 * `urn:li:image:...` que o post usa. O `owner` é a pessoa que publica.
 */
export async function iniciarEnvioDeImagem(input: { accessToken: string; versao: string; autorUrn: string }): Promise<{ uploadUrl: string; imagemUrn: string }> {
  const res = await chamar(`${API}/rest/images?action=initializeUpload`, {
    method: "POST",
    headers: cabecalhosDaApi(input.accessToken, input.versao),
    body: JSON.stringify({ initializeUploadRequest: { owner: input.autorUrn } }),
  });
  if (!res.ok) throw new LinkedinApiErro(res.status, await motivoDoErro(res));
  const j = (await res.json()) as { value?: { uploadUrl?: string; image?: string } };
  const uploadUrl = j.value?.uploadUrl;
  const imagemUrn = j.value?.image;
  if (!uploadUrl || !imagemUrn) throw new LinkedinApiErro(res.status, "sem_upload_url");
  // A URL de envio é do LinkedIn: só segue se for https (nunca manda o token a um endereço estranho).
  if (!uploadUrl.startsWith("https://")) throw new LinkedinApiErro(res.status, "upload_url_invalida");
  return { uploadUrl, imagemUrn };
}

/** Sobe os bytes da imagem na URL que o LinkedIn deu. */
export async function enviarImagem(input: { accessToken: string; uploadUrl: string; bytes: Uint8Array; contentType: string }): Promise<void> {
  const res = await chamar(
    input.uploadUrl,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": input.contentType },
      body: input.bytes as unknown as BodyInit,
    },
    TIMEOUT_UPLOAD_MS,
  );
  if (!res.ok) throw new LinkedinApiErro(res.status, await motivoDoErro(res));
}

/**
 * Cria o post no perfil. `commentary` já vem no "little text format" (caracteres reservados com
 * barra). Com `imagemUrn`, o post leva a imagem. Devolve o `urn` do post (cabeçalho `x-restli-id`).
 */
export async function criarPost(input: {
  accessToken: string;
  versao: string;
  autorUrn: string;
  commentary: string;
  imagemUrn?: string;
  textoAlternativo?: string;
}): Promise<{ postUrn: string }> {
  const corpo = {
    author: input.autorUrn,
    commentary: input.commentary,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
    ...(input.imagemUrn
      ? { content: { media: { id: input.imagemUrn, ...(input.textoAlternativo ? { altText: input.textoAlternativo } : {}) } } }
      : {}),
  };
  const res = await chamar(`${API}/rest/posts`, {
    method: "POST",
    headers: cabecalhosDaApi(input.accessToken, input.versao),
    body: JSON.stringify(corpo),
  });
  if (!res.ok) throw new LinkedinApiErro(res.status, await motivoDoErro(res));
  const postUrn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
  if (!postUrn) throw new LinkedinApiErro(res.status, "sem_id_do_post");
  return { postUrn };
}
