import { z } from "zod";
import { evolutionHeaders, evolutionFetch, exigirOk } from "./http";
import { lerCorpoComLimite } from "./media";

/**
 * Foto de perfil do WhatsApp de um número (SÓ leitura), para o verificador do agro.
 *
 * - `POST /chat/fetchProfilePictureUrl/{instância}` devolve o endereço da foto, ou nada quando a pessoa a esconde
 *   (privacidade) ou não tem. O endereço é do CDN do WhatsApp e EXPIRA em horas: baixe na hora de usar e não guarde.
 * - O download só aceita https de hosts do WhatsApp/Meta, sem seguir redirecionamento (o endereço vem de um serviço
 *   externo, então não pode virar um jeito de chamar a rede interna), com teto de tamanho e conferência do tipo.
 *
 * O número só serve para esta chamada: quem usa a foto (a IA, a tela, o log) nunca recebe o número nem o endereço.
 */

const TIMEOUT_MS = 15_000;
/** Foto de perfil do WhatsApp tem algumas dezenas de KB; 2 MB já é folga. */
export const MAX_FOTO_PERFIL_BYTES = 2 * 1024 * 1024;

const respostaSchema = z.object({ profilePictureUrl: z.string().nullish() }).passthrough();

/** Endereço da foto de perfil do número, ou null (sem foto, escondida, número fora do WhatsApp). Erro de rede ou HTTP inesperado lança. */
export async function fetchEvolutionProfilePictureUrl(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
  /** Telefone em E.164 (com ou sem "+"). */
  numero: string;
}): Promise<string | null> {
  const res = await evolutionFetch(
    `${input.apiUrl.replace(/\/$/, "")}/chat/fetchProfilePictureUrl/${encodeURIComponent(input.instance)}`,
    {
      method: "POST",
      headers: evolutionHeaders(input.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({ number: input.numero.replace(/\D/g, "") }),
      cache: "no-store",
    },
    TIMEOUT_MS,
    "Evolution fetchProfilePictureUrl",
  );
  // A Evolution responde 400/404 quando o número não existe no WhatsApp ou a foto não está disponível: é "sem foto".
  if (res.status === 400 || res.status === 404) return null;
  await exigirOk(res, "Evolution fetchProfilePictureUrl");
  const p = respostaSchema.safeParse(await res.json().catch(() => null));
  const url = p.success ? p.data.profilePictureUrl?.trim() : "";
  return url ? url : null;
}

const HOSTS_DA_FOTO = [/(^|\.)whatsapp\.net$/, /(^|\.)whatsapp\.com$/, /(^|\.)fbcdn\.net$/];

/** Só https e só o CDN do WhatsApp/Meta. Qualquer outra coisa → null. */
export function urlDeFotoPermitida(bruta: string): URL | null {
  let u: URL;
  try {
    u = new URL(bruta);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
  return HOSTS_DA_FOTO.some((re) => re.test(u.hostname.toLowerCase())) ? u : null;
}

export type TipoDeImagem = "image/jpeg" | "image/png" | "image/webp";

/** Tipo pelo começo do arquivo (não confia no cabeçalho do servidor). */
export function tipoDaImagem(b: Buffer): TipoDeImagem | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export type FotoBaixada = { bytes: Buffer; tipo: TipoDeImagem };

/** Baixa a foto. null = endereço fora da lista, resposta não é imagem, passou do teto ou o CDN recusou. Erro de rede lança. */
export async function baixarFotoDePerfil(url: string): Promise<FotoBaixada | null> {
  const alvo = urlDeFotoPermitida(url);
  if (!alvo) return null;
  const res = await fetch(alvo, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const bytes = await lerCorpoComLimite(res, MAX_FOTO_PERFIL_BYTES);
  if (!bytes || bytes.length === 0) return null;
  const tipo = tipoDaImagem(bytes);
  return tipo ? { bytes, tipo } : null;
}
