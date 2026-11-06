import { z } from "zod";
import { env } from "@crmagro/config";
import type { Channel } from "./types";
import { EvolutionProvider } from "./whatsapp/evolution";
import { InstagramProvider } from "./instagram/index";
import { LinkedInProvider } from "./linkedin/index";
import { EmailProvider } from "./email/index";
import { GmailApiProvider } from "./email/gmail-api";

/**
 * Factory de providers por conta conectada (§3/§7 da arquitetura). Substitui o
 * `new EvolutionProvider()` direto: o service de conversas resolve a conta e
 * pede o provider aqui. Trocar/ adicionar canais é estender este switch + criar
 * um provider que implemente `Channel` — o motor não muda.
 *
 * IG/LinkedIn/Email já têm provider placeholder que implementa `Channel` (mas
 * `send` lança "ainda não implementado"). O factory devolve a instância: quem
 * chama recebe um canal "vivo" e obtém o erro explícito ao tentar enviar. O
 * guard de `canal` garante que, p. ex., um provider `instagram_official` só
 * responda por conta `canal = instagram` (mesma defesa do case evolution).
 */

/** Shape mínimo de uma ChannelAccount — o service passa só o necessário. */
export type ChannelAccountRef = {
  canal: string; // Canal enum
  provider: string;
  credentials: unknown;
};

/**
 * Credentials da Evolution API. Guardamos só a `instance` (identidade da conta);
 * `apiUrl`/`apiKey` vêm do env em tempo de build do provider — NÃO são
 * congelados no banco. Isso: (a) tira a apikey admin global do Json plaintext;
 * (b) faz trocar o transporte (ex.: URL do Cloudflare Tunnel) ser uma variável
 * de ambiente, curando contas antigas automaticamente. `.passthrough()` tolera
 * contas legadas que ainda tenham apiUrl/apiKey salvos (ignorados).
 */
const evolutionCredentialsSchema = z
  .object({
    instance: z.string().min(1),
  })
  .passthrough();

/**
 * Credentials SMTP do canal de email. Chegam DECIFRADAS (o core decifra a
 * `ChannelAccount.credentials` antes de chamar o factory — a senha nunca sai em
 * claro do banco). `secure` = TLS direto (porta 465) vs STARTTLS (587).
 */
const smtpCredentialsSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive(),
  secure: z.coerce.boolean().optional().default(false),
  user: z.string().min(1),
  pass: z.string().min(1),
  from: z.string().optional().default(""),
});

/**
 * Credentials do envio pela API do Gmail (`provider: "gmail_api"`, não confundir com
 * `"gmail"`, que é SMTP com senha de app). O `accessToken` NÃO fica no banco: quem
 * resolve a conta (o core) renova o token da conexão OAuth e o passa aqui já pronto.
 * `.passthrough()` tolera campos a mais (ex.: `oauthConnectionId`), que são ignorados.
 */
const gmailApiCredentialsSchema = z
  .object({
    accessToken: z.string().min(1),
    from: z.string().min(1),
    replyTo: z.string().optional(),
  })
  .passthrough();

export function getChannelProvider(account: ChannelAccountRef): Channel | null {
  switch (account.provider) {
    case "evolution": {
      if (account.canal !== "whatsapp") return null;
      const c = evolutionCredentialsSchema.safeParse(account.credentials ?? {});
      if (!c.success) return null;
      return new EvolutionProvider(c.data.instance, env.EVOLUTION_API_URL, env.EVOLUTION_API_KEY);
    }
    // case "cloud_api": return new CloudApiProvider(...)
    case "instagram_official": {
      if (account.canal !== "instagram") return null;
      return new InstagramProvider();
    }
    case "linkedin_official": {
      if (account.canal !== "linkedin") return null;
      return new LinkedInProvider();
    }
    // instagram_browser / linkedin_browser: o provider de navegador (Playwright)
    // roda SÓ no worker (não pode entrar no bundle do web) — construído lá direto.
    case "smtp":
    case "gmail": {
      if (account.canal !== "email") return null;
      const c = smtpCredentialsSchema.safeParse(account.credentials ?? {});
      if (!c.success) return null;
      return new EmailProvider(c.data);
    }
    case "gmail_api": {
      if (account.canal !== "email") return null;
      const c = gmailApiCredentialsSchema.safeParse(account.credentials ?? {});
      if (!c.success) return null;
      return new GmailApiProvider({ accessToken: c.data.accessToken, from: c.data.from, replyTo: c.data.replyTo });
    }
    default:
      return null;
  }
}

/**
 * Provider Evolution fallback (env) — usado quando a conta não resolve
 * credentials (ex.: conta dev legada, ou inbound sem match de instância).
 */
export function defaultEvolutionProvider(): EvolutionProvider {
  return new EvolutionProvider(env.EVOLUTION_INSTANCE, env.EVOLUTION_API_URL, env.EVOLUTION_API_KEY);
}
