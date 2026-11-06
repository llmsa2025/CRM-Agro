/**
 * Pixel de abertura sem falso positivo (item 3.4 — INT-21, S19).
 *
 * Antes o PRIMEIRO carregamento do pixel virava "lido" (✓✓ verde): scanner de
 * segurança (Mimecast, Proofpoint, Safe Links...), pré-visualização de link e
 * até o próprio envio (servidores que buscam as imagens ao receber) marcavam
 * "aberto" sem ninguém ter lido.
 *
 * Agora um hit só conta se:
 * - chegou 60 s ou mais depois do envio (antes disso é a entrega, não a leitura);
 * - tem user-agent, e não é de scanner/robô/biblioteca HTTP.
 * Proxy de imagem de webmail (Gmail, Yahoo) busca a imagem quando a pessoa abre,
 * mas pela própria rede: conta como abertura PROVÁVEL (`proxy_*`). O Apple Mail
 * (Privacy Protection) pré-carrega com user-agent comum — não dá para separar
 * pelo cabeçalho; por isso o front mostra "provável", nunca "lido com certeza".
 */

export const PIXEL_ESPERA_MIN_MS = 60_000;

const SCANNERS =
  /\b(bot|crawler|spider|slurp|preview|scanner)\b|python-requests|python-urllib|curl\/|wget\/|go-http-client|java\/|okhttp|axios|node-fetch|undici|libwww-perl|httpclient|headlesschrome|phantomjs|proofpoint|mimecast|barracuda|messagelabs|symantec|forcepoint|trendmicro|sophos|fortiguard|ironport|zscaler|safelinks|facebookexternalhit|slackbot|twitterbot|discordbot|telegrambot|skypeuripreview|whatsapp/i;

export type AberturaDoPixel =
  | { conta: true; fonte: "cliente" | "proxy_google" | "proxy_yahoo" }
  | { conta: false; motivo: "cedo_demais" | "sem_user_agent" | "scanner" };

export function classificarAbertura(hit: {
  userAgent: string | null | undefined;
  enviadoEm: Date;
  agora: Date;
}): AberturaDoPixel {
  if (hit.agora.getTime() - hit.enviadoEm.getTime() < PIXEL_ESPERA_MIN_MS) return { conta: false, motivo: "cedo_demais" };
  const ua = (hit.userAgent ?? "").trim();
  if (!ua) return { conta: false, motivo: "sem_user_agent" };
  if (/GoogleImageProxy/i.test(ua)) return { conta: true, fonte: "proxy_google" };
  if (/YahooMailProxy/i.test(ua)) return { conta: true, fonte: "proxy_yahoo" };
  if (SCANNERS.test(ua)) return { conta: false, motivo: "scanner" };
  return { conta: true, fonte: "cliente" };
}
