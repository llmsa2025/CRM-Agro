/**
 * Automação social (Instagram/LinkedIn) — roda SÓ no worker. Importa o
 * BrowserProvider (Playwright) por caminho RELATIVO, nunca pelo barrel
 * `@crmagro/channels` — o barrel entra no bundle do web e o playwright-core
 * quebra o build (ver memória crmagro-social-browser-automacao).
 */
import { basePrisma, decryptCredentials } from "@crmagro/db";
import { enviarDmSocial, verificarSessoesSociais, type EnviarDmSocial } from "@crmagro/core";
import { BrowserProvider } from "../../../packages/channels/src/browser/index";
import type { SocialNetwork } from "../../../packages/channels/src/types";

const SOCIAL_PROVIDERS = ["instagram_browser", "linkedin_browser"];

type SocialCfg = { cookie?: string; proxy?: { server: string; username?: string; password?: string } };

function netOf(canal: string): SocialNetwork {
  return canal === "instagram" ? "instagram" : "linkedin";
}

/**
 * UM Chromium por vez no processo (item 1.8, MF-10). A fila `social` roda só no
 * worker primário, então isto vale para a plataforma inteira: o VPS é o da
 * produção (~250 MB por navegador). Esperar a extensão NÃO ocupa esta vez.
 */
let fila: Promise<unknown> = Promise.resolve();
function umNavegadorPorVez<T>(fn: () => Promise<T>): Promise<T> {
  const vez = fila.then(fn, fn);
  fila = vez.catch(() => undefined);
  return vez;
}

/**
 * Verifica a sessão (cookie) das contas sociais e ajusta o status (item 1.8,
 * INT-10). Roda a cada 6 h — antes eram 30 min, 48 logins/dia por conta a partir
 * do IP do datacenter, justamente o padrão que leva a checkpoint. A decisão de
 * quem verificar e o que fazer com o resultado está em `verificarSessoesSociais`
 * (core): contas conectadas pela extensão (`origem: "extensao"`) ficam de fora,
 * o servidor não abre Playwright com o cookie delas. Aqui só entra o ato de
 * verificar (um Chromium por vez).
 */
export async function verifySocialAccountsOnce(): Promise<void> {
  await verificarSessoesSociais(({ canal, cookie, proxy }) =>
    umNavegadorPorVez(() => new BrowserProvider(netOf(canal), cookie, proxy).verify()),
  );
}

/**
 * Envio pelo Playwright no worker (IP do datacenter): verifica a sessão e envia
 * no MESMO navegador. Erros já saem classificados (ChannelSendFailed /
 * SessaoSocialInvalida) — o core decide repetir, pular, segurar ou pausar.
 */
async function enviarPeloNavegador(p: { accountId: string; to: string; text: string }): Promise<{ providerMessageId: string }> {
  const acc = await basePrisma.channelAccount.findUnique({
    where: { id: p.accountId },
    select: { canal: true, provider: true, credentials: true },
  });
  if (!acc || !SOCIAL_PROVIDERS.includes(acc.provider)) throw new Error("conta social não encontrada");
  const cfg = decryptCredentials(acc.credentials) as SocialCfg | null;
  if (!cfg?.cookie) throw new Error("conta social sem cookie");
  const provider = new BrowserProvider(netOf(acc.canal), cfg.cookie, cfg.proxy);
  return umNavegadorPorVez(() => provider.verificarEEnviar({ to: p.to, content: { text: p.text } }));
}

/**
 * Quem manda o DM da fila `social`: a EXTENSÃO logada na conta (IP residencial)
 * e, só quando é certo que ela não pegou o job, o Playwright. Ver
 * `enviarDmSocial` no core.
 */
export const sendSocialDM: EnviarDmSocial = (p) => enviarDmSocial(p, enviarPeloNavegador);
