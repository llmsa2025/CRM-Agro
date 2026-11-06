import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { Channel, SendInput, SendOutput, SocialNetwork, BrowserProxy } from "../types";
import { ChannelSendFailed, SessaoSocialInvalida, isChannelSendFailed } from "../errors";
import { exigirDestinoSocial, mesmoDestinatario, trechoParaConferir } from "../social/destino";

/**
 * Provider de NAVEGADOR (não-oficial) para Instagram/LinkedIn: usa a sessão
 * logada do usuário (cookie) via Playwright headless no servidor. Implementa a
 * mesma interface `Channel`, então o motor não muda.
 *
 * ⚠️ Pode contrariar os termos das plataformas e levar à restrição da conta.
 * Enviamos com limites de ritmo; a decisão de usar é do usuário.
 *
 * Item 1.8 (INT-09/INT-10/MF-10):
 * - UM navegador por envio (verifica a sessão e envia no mesmo contexto; antes
 *   eram dois Chromium por DM);
 * - Instagram abre o PERFIL do @ e clica "Enviar mensagem" no cabeçalho (antes
 *   buscava na caixa "Nova mensagem" e clicava no 1º resultado, com o erro
 *   engolido); LinkedIn só aceita o botão do cartão do perfil e confere o nome
 *   no cabeçalho da conversa;
 * - só devolve sucesso depois de ver a BOLHA do texto na conversa;
 * - erros classificados: antes de enviar = `not_sent`; depois = `unknown`;
 *   deslogado = `SessaoSocialInvalida`; falha de rede ≠ sessão inválida.
 */

export type VerificacaoSessao = { ok: true } | { ok: false; motivo: "deslogado" | "rede"; error: string };

/** Verifica um cookie de sessão (com proxy opcional) — usado ao conectar a conta. */
export async function verifySocialSession(
  network: SocialNetwork,
  cookie: string,
  proxy?: { server: string; username?: string; password?: string },
): Promise<{ ok: boolean; error?: string }> {
  return new BrowserProvider(network, cookie, proxy).verify();
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** Acha o Chromium já baixado pelo Playwright na VPS (sem baixar de novo). */
function chromeExecutable(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(base)) return undefined;
  const dir = readdirSync(base).find((d) => d.startsWith("chromium-") && !d.includes("headless"));
  if (!dir) return undefined;
  for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
    const p = join(base, dir, sub);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function cookieSpec(network: SocialNetwork, value: string) {
  // O usuário cola só o valor do cookie de sessão.
  if (network === "linkedin") {
    return { name: "li_at", value, domain: ".linkedin.com", path: "/", httpOnly: true, secure: true };
  }
  return { name: "sessionid", value, domain: ".instagram.com", path: "/", httpOnly: true, secure: true };
}

async function humanDelay(min = 600, max = 1800) {
  await new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

// Redirecionou para login/authwall/checkpoint = sessão morta (não é erro de rede).
const URL_DESLOGADO = /\/accounts\/login|\/login|authwall|signup|uas\/login|checkpoint|challenge/i;

async function estaDeslogado(page: Page, network: SocialNetwork): Promise<boolean> {
  if (URL_DESLOGADO.test(page.url())) return true;
  // Instagram deslogado pode ficar na raiz mostrando o formulário de login.
  if (network === "instagram") return (await page.locator('input[name="username"]').count()) > 0;
  return false;
}

/** Digita como gente; quebra de linha vira Shift+Enter (Enter sozinho ENVIA). */
async function digitar(page: Page, caixa: Locator, texto: string) {
  await caixa.click({ timeout: 15_000 });
  const linhas = texto.split("\n");
  for (let i = 0; i < linhas.length; i++) {
    if (linhas[i]) await caixa.pressSequentially(linhas[i]!, { delay: 30 + Math.random() * 40 });
    if (i < linhas.length - 1) await page.keyboard.press("Shift+Enter");
  }
}

/** Erro antes de apertar enviar: certeza de que não saiu. */
function naoSaiu(e: unknown, retryable = true): ChannelSendFailed {
  if (isChannelSendFailed(e)) return e;
  return new ChannelSendFailed(`social: ${e instanceof Error ? e.message : String(e)}`, "not_sent", retryable);
}

export class BrowserProvider implements Channel {
  constructor(
    private network: SocialNetwork,
    private cookie: string,
    private proxy?: BrowserProxy,
  ) {}

  private async open(): Promise<{ browser: Browser; context: BrowserContext }> {
    const browser = await chromium.launch({
      headless: true,
      executablePath: chromeExecutable(),
      args: ["--no-sandbox", `--crmagro-worker-pid=${process.pid}`],
      // Proxy por conta: faz o tráfego "sair" pelo IP do proxy (residencial da
      // região do usuário, ou túnel pro wifi/celular dele) — reduz flag de local.
      ...(this.proxy?.server
        ? { proxy: { server: this.proxy.server, username: this.proxy.username, password: this.proxy.password } }
        : {}),
    });
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    await context.addCookies([cookieSpec(this.network, this.cookie)]);
    return { browser, context };
  }

  /** Abre a home e diz se a sessão está logada (no MESMO contexto do envio). */
  private async conferirSessao(page: Page): Promise<VerificacaoSessao> {
    const home = this.network === "linkedin" ? "https://www.linkedin.com/feed/" : "https://www.instagram.com/";
    try {
      await page.goto(home, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await humanDelay(1500, 2500);
      if (await estaDeslogado(page, this.network)) {
        return { ok: false, motivo: "deslogado", error: "sessão inválida ou expirada (refaça o cookie)" };
      }
      return { ok: true };
    } catch (e) {
      // Timeout, proxy fora, ERR_TOO_MANY_REDIRECTS: NÃO é sessão morta.
      return { ok: false, motivo: "rede", error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Confirma que o cookie está logado. `motivo` separa "deslogado" (pausa a
   * conta) de erro de rede (mantém o status e tenta depois) — INT-10.
   */
  async verify(): Promise<VerificacaoSessao> {
    let browser: Browser | null = null;
    try {
      const { browser: b, context } = await this.open();
      browser = b;
      return await this.conferirSessao(await context.newPage());
    } catch (e) {
      return { ok: false, motivo: "rede", error: e instanceof Error ? e.message : String(e) };
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  /** Envio sem a checagem prévia da sessão (a interface `Channel`). */
  async send(input: SendInput): Promise<SendOutput> {
    return this.enviar(input, false);
  }

  /** Verifica a sessão e envia no MESMO navegador (um Chromium por job). */
  async verificarEEnviar(input: SendInput): Promise<SendOutput> {
    return this.enviar(input, true);
  }

  private async enviar(input: SendInput, conferir: boolean): Promise<SendOutput> {
    const destino = exigirDestinoSocial(this.network, input.to);
    const texto = input.content.text ?? "";
    if (!texto.trim()) throw new ChannelSendFailed("social: texto vazio", "not_sent", false);
    let browser: Browser | null = null;
    try {
      let page: Page;
      try {
        const aberto = await this.open();
        browser = aberto.browser;
        page = await aberto.context.newPage();
      } catch (e) {
        throw naoSaiu(e);
      }
      if (conferir) {
        const s = await this.conferirSessao(page);
        if (!s.ok && s.motivo === "deslogado") throw new SessaoSocialInvalida(`sessão ${this.network} inválida: ${s.error}`);
        if (!s.ok) throw new ChannelSendFailed(`social: rede ao abrir ${this.network}: ${s.error}`, "not_sent", true);
      }
      if (destino.network === "linkedin") await this.enviarLinkedIn(page, destino.url, texto);
      else await this.enviarInstagram(page, destino.username, destino.url, texto);
      return { providerMessageId: `browser-${Date.now()}` };
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  /** Instagram: perfil do @ → "Enviar mensagem" do cabeçalho → digita → Enter → bolha. */
  private async enviarInstagram(page: Page, username: string, url: string, texto: string): Promise<void> {
    let caixa: Locator;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await humanDelay(1500, 2500);
      if (await estaDeslogado(page, "instagram")) throw new SessaoSocialInvalida("sessão instagram inválida (login)");
      const cabecalho = page.locator("header").first();
      await cabecalho.waitFor({ timeout: 15_000 }).catch(() => {});
      // Perfil inexistente não tem cabeçalho com o @; a página certa tem.
      if ((await cabecalho.getByText(username, { exact: true }).count()) === 0) {
        throw new ChannelSendFailed(`instagram: perfil @${username} não encontrado`, "not_sent", false);
      }
      const botao = cabecalho.getByRole("button", { name: /^(enviar mensagem|mensagem|message)$/i }).first();
      if ((await botao.count()) === 0) {
        throw new ChannelSendFailed(`instagram: @${username} sem botão "Enviar mensagem"`, "not_sent", false);
      }
      await botao.click({ timeout: 15_000 });
      await humanDelay(1500, 2500);
      caixa = page.locator('div[role="textbox"][contenteditable="true"], textarea[placeholder]').first();
      await caixa.waitFor({ timeout: 20_000 });
      await digitar(page, caixa, texto);
      await humanDelay(500, 1000);
    } catch (e) {
      throw naoSaiu(e);
    }
    // A partir daqui o Enter pode ter enviado: qualquer falha é INCERTA.
    await page.keyboard.press("Enter");
    await this.confirmarBolha(page, texto, 'div[role="textbox"], textarea');
  }

  /** LinkedIn: botão Mensagem do CARTÃO do perfil → confere o nome na conversa → envia → bolha. */
  private async enviarLinkedIn(page: Page, url: string, texto: string): Promise<void> {
    let conversa: Locator;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await humanDelay();
      if (await estaDeslogado(page, "linkedin")) throw new SessaoSocialInvalida("sessão linkedin inválida (authwall)");
      const cartao = page.locator("main .pv-top-card, main .pvs-profile-actions, main section.artdeco-card").first();
      await cartao.waitFor({ timeout: 20_000 });
      const nome = ((await page.locator("main h1").first().textContent({ timeout: 10_000 })) ?? "").trim();
      // Só o botão do cartão: fora dele, "Mensagens" é o overlay global com a
      // conversa que estiver aberta. `\b` barra "Messaging"/"Mensagens".
      const botao = cartao.getByRole("button", { name: /^(message|mensagem|enviar mensagem)\b/i }).first();
      if ((await botao.count()) === 0) {
        throw new ChannelSendFailed("linkedin: perfil sem botão Mensagem (fora da sua rede?)", "not_sent", false);
      }
      await botao.click({ timeout: 15_000 });
      await humanDelay(1200, 2000);
      conversa = page.locator(".msg-overlay-conversation-bubble, .msg-convo-wrapper").last();
      await conversa.waitFor({ timeout: 15_000 });
      const titulo = await conversa
        .locator(".msg-overlay-bubble-header__title, .msg-entity-lockup__entity-title, h2")
        .first()
        .textContent({ timeout: 10_000 })
        .catch(() => "");
      if (!mesmoDestinatario(nome, titulo)) {
        throw new ChannelSendFailed(`linkedin: a conversa aberta ("${(titulo ?? "").trim().slice(0, 60)}") não é de "${nome.slice(0, 60)}"`, "not_sent", false);
      }
      const caixa = conversa.locator('.msg-form__contenteditable, div[role="textbox"]').first();
      await digitar(page, caixa, texto);
      await humanDelay();
    } catch (e) {
      throw naoSaiu(e);
    }
    // Clique em enviar: daqui em diante, falha = incerta.
    try {
      await conversa.locator("button.msg-form__send-button, button[type='submit']").first().click({ timeout: 10_000 });
    } catch (e) {
      throw new ChannelSendFailed(`linkedin: clique em enviar falhou: ${e instanceof Error ? e.message : String(e)}`, "unknown", false);
    }
    await this.confirmarBolha(page, texto, '.msg-form__contenteditable, div[role="textbox"]');
  }

  /**
   * Sucesso só com a BOLHA na conversa: o trecho aparece fora da caixa de texto
   * e a caixa esvaziou. Sem isso, o resultado é INCERTO (pode ter saído).
   */
  private async confirmarBolha(page: Page, texto: string, seletorCaixa: string): Promise<void> {
    const trecho = trechoParaConferir(texto);
    try {
      await page.waitForFunction(
        ({ trecho, seletorCaixa }) => {
          const caixas = Array.from(document.querySelectorAll(seletorCaixa));
          const caixaVazia = caixas.every((c) => !(c.textContent ?? "").includes(trecho) && !((c as HTMLTextAreaElement).value ?? "").includes(trecho));
          const bolha = Array.from(document.querySelectorAll("div[dir='auto'], span[dir='auto'], p, .msg-s-event-listitem__body")).some(
            (el) => !el.closest(seletorCaixa) && (el.textContent ?? "").includes(trecho),
          );
          return caixaVazia && bolha;
        },
        { trecho, seletorCaixa },
        { timeout: 15_000 },
      );
    } catch {
      throw new ChannelSendFailed(`${this.network}: não confirmei a mensagem na conversa (pode ter saído)`, "unknown", false);
    }
    await humanDelay(800, 1500);
  }
}
