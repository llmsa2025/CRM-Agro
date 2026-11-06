/**
 * Scraper do Google Maps — roda SÓ no worker (Playwright headless). Rola o
 * feed de resultados, coleta os cards, abre cada ficha e raspa nome/telefone/endereço + lat,lng.
 * ⚠️ Pode contrariar os termos de uso do Google — best-effort, frágil (seletores mudam).
 *
 * Item 3.2 (INT-11):
 * - teto do JOB (15 min, `CAPTURE_MAPS_TETO_MS`): estourou → fecha o navegador
 *   e devolve o parcial (antes um renderer travado prendia a fila `capture`,
 *   concorrência 1, até o próximo restart);
 * - `setDefaultTimeout(30 s)` e prazo em todo `evaluate`/`$$eval` (esses NÃO
 *   respeitam o default do Playwright);
 * - `/sorry/`, "tráfego incomum" ou captcha → para e o job falha com o motivo
 *   visível (antes voltava 0 leads "concluído");
 * - entrega as fichas aos poucos (`aoColetar`, de 10 em 10): uma queda no meio
 *   não perde o que já veio;
 * - busca com resultado único (o Maps abre a ficha direto, sem feed) vira 1 lead.
 */
import type { Browser, BrowserContext, Page } from "playwright-core";
import { logger, normalize } from "@crmagro/core";
import { normalizePhoneDetailed } from "@crmagro/channels";
import { lancarChromium } from "./chromium";
import { comPrazo, comTeto, PrazoEsgotado } from "../../../packages/captation/src/navegador/prazo";
import { detectarBloqueioGoogle } from "../../../packages/captation/src/navegador/bloqueio";
import { extrairAvaliacaoMaps } from "../../../packages/captation/src/maps/avaliacao";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export type MapsItem = {
  nome: string;
  telefone: string | null;
  endereco: string | null;
  cidade: string | null;
  uf: string | null;
  site: string | null;
  lat: number | null;
  lng: number | null;
  /** Nota (1,0–5,0) e nº de avaliações do lugar (produto §H.4); null = sem avaliação ou não lida. */
  avaliacao: number | null;
  avaliacoes: number | null;
};

export type InterrupcaoMaps = { motivo: "bloqueio_google" | "tempo_esgotado"; detalhe: string };

export type ResultadoMaps = {
  /** Fichas lidas (inclui as puladas). */
  lidos: number;
  /** Fichas entregues a `aoColetar`. */
  coletados: number;
  /** Fichas sem nome nem no card — não viram lead. */
  pulados: number;
  interrupcao: InterrupcaoMaps | null;
};

/** Teto do job inteiro. */
export const MAPS_TETO_MS = Number(process.env.CAPTURE_MAPS_TETO_MS ?? 15 * 60_000);
const PRAZO_AVALIAR_MS = 15_000;
const LOTE_GRAVACAO = 10;

// Seletores com plano B: a classe ofuscada (`hfpxzc`, `DUwDvf`) muda sem aviso;
// o papel/estrutura (`role="feed"`, `role="main"`, `href*="/maps/place/"`) é estável.
const SELETOR_CARD = 'a.hfpxzc[href*="/maps/place/"], div[role="feed"] a[href*="/maps/place/"]';
const SELETOR_NOME = 'h1.DUwDvf, div[role="main"] h1';
// Textos candidatos a avaliação (produto §H.4): todo `aria-label` do card
// ("4,8 estrelas 61 avaliações"), e na ficha os `aria-label` de estrela/avaliação
// mais o bloco visível "4,8(61)". O parse é puro, no Node (captation/maps).
const MAX_ROTULOS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseLatLng(url: string): { lat: number | null; lng: number | null } {
  let m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (!m) m = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : { lat: null, lng: null };
}

/** "Rua X, 100 - Bairro, Cidade - UF, CEP" → tenta cidade + UF. */
function parseCidadeUf(addr: string | null): { cidade: string | null; uf: string | null } {
  if (!addr) return { cidade: null, uf: null };
  const uf = addr.match(/-\s*([A-Z]{2})\b/)?.[1] ?? null;
  const cidade = addr.match(/,\s*([^,-]+?)\s*-\s*[A-Z]{2}\b/)?.[1]?.trim() ?? null;
  return { cidade, uf };
}

/** Confere se a página atual é o bloqueio do Google (URL + texto visível + captcha). */
async function verificarBloqueio(page: Page): Promise<string | null> {
  const url = page.url();
  let texto: string | null = null;
  let temCaptcha = false;
  try {
    const r = await comPrazo(
      page.evaluate(() => ({
        texto: (document.body?.innerText ?? "").slice(0, 4000),
        captcha: !!document.querySelector('form#captcha-form, iframe[src*="recaptcha"], #recaptcha'),
      })),
      5_000,
      "ler a página",
    );
    texto = r.texto;
    temCaptcha = r.captcha;
  } catch (e) {
    // Sem o texto, decide só pela URL.
    logger.debug({ url, err: e instanceof Error ? e.message : String(e) }, "[maps] não li o texto da página");
  }
  return detectarBloqueioGoogle({ url, texto, temCaptcha });
}

type Estado = { parar: boolean; interrupcao: InterrupcaoMaps | null; lidos: number; pulados: number };

async function coletar(
  browser: Browser,
  termo: string,
  limite: number,
  estado: Estado,
  entregar: (item: MapsItem) => Promise<void>,
  aoLer?: (lidos: number) => void,
  rotear?: (ctx: BrowserContext) => Promise<void>,
): Promise<void> {
  const ctx = await browser.newContext({ userAgent: UA, locale: "pt-BR", viewport: { width: 1400, height: 1000 } });
  if (rotear) await rotear(ctx);
  // No CONTEXTO (não na aba): vale também para a aba nova aberta depois de um
  // renderer travado.
  ctx.setDefaultTimeout(30_000);
  // O worker roda sob tsx/esbuild com `keepNames`, que injeta chamadas ao
  // helper `__name(...)` em torno de funções nomeadas — inclusive nas funções
  // passadas a page.evaluate. Esse helper NÃO existe no contexto do navegador,
  // então TODO page.evaluate com função nomeada interna lançava
  // "ReferenceError: __name is not defined", caía no catch silencioso da ficha
  // e o lote inteiro voltava vazio (n:0). Definir __name no browser resolve
  // para toda navegação (addInitScript roda a cada documento).
  await ctx.addInitScript(() => {
    const w = window as unknown as { __name?: (fn: unknown) => unknown };
    if (!w.__name) w.__name = (fn) => fn;
  });
  let page = await ctx.newPage();
  await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(termo)}?hl=pt-BR`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  // Consentimento de cookies (quando aparece). Não aparecer é o normal.
  await page
    .getByRole("button", { name: /aceitar tudo|aceito|accept all|concordo/i })
    .first()
    .click({ timeout: 6000 })
    .catch(() => logger.debug({ termo }, "[maps] sem tela de consentimento"));

  const bloqueioInicial = await verificarBloqueio(page);
  if (bloqueioInicial) {
    estado.interrupcao = { motivo: "bloqueio_google", detalhe: bloqueioInicial };
    logger.warn({ termo, url: page.url(), bloqueio: bloqueioInicial }, "[maps] Google bloqueou a busca");
    return;
  }

  const feed = page.locator('div[role="feed"]').first();
  const temFeed = await feed
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);

  let cards: { href: string; nome: string | null; rotulos: string[] }[] = [];
  if (temFeed) {
    // Auto-scroll até estabilizar ou juntar links suficientes.
    let stable = 0;
    let lastCount = 0;
    for (let i = 0; i < 40 && stable < 6 && !estado.parar; i++) {
      await comPrazo(feed.evaluate((el: Element) => el.scrollBy(0, el.scrollHeight)), PRAZO_AVALIAR_MS, "rolar o feed").catch(
        (e) => logger.debug({ termo, err: e instanceof Error ? e.message : String(e) }, "[maps] falha ao rolar o feed"),
      );
      await sleep(1200 + Math.random() * 600);
      const count = await page.locator(SELETOR_CARD).count();
      if (count >= limite) break;
      if (count === lastCount) stable++;
      else stable = 0;
      lastCount = count;
    }
    if (estado.parar) return;

    // Coleta href + nome do card (aria-label do link do feed). O nome do card
    // serve de fallback quando a ficha não abre/extrai — assim uma ficha frágil
    // ainda vira um lead com nome (o resto fica null) em vez de sumir.
    // Os `aria-label` do CARD (o contêiner do link) trazem a avaliação
    // ("4,8 estrelas 61 avaliações") — lidos aqui, interpretados no Node.
    cards = await comPrazo(
      page.$$eval(
        SELETOR_CARD,
        (as: Element[], max: number) => {
          const seen = new Map<string, { nome: string | null; rotulos: string[] }>();
          for (const a of as) {
            const href = (a as HTMLAnchorElement).href;
            const nome = (a.getAttribute("aria-label") || "").trim() || null;
            const caixa = a.closest('div[role="article"], div.Nv2PK') ?? a.parentElement;
            const rotulos = caixa
              ? Array.from(caixa.querySelectorAll("[aria-label]"))
                  .map((e) => e.getAttribute("aria-label") || "")
                  .filter(Boolean)
                  .slice(0, max)
              : [];
            const antes = seen.get(href);
            if (!antes || (!antes.nome && nome)) seen.set(href, { nome, rotulos });
          }
          return Array.from(seen, ([href, v]) => ({ href, nome: v.nome, rotulos: v.rotulos }));
        },
        MAX_ROTULOS,
      ),
      PRAZO_AVALIAR_MS,
      "ler os cards do feed",
    );
  } else if (page.url().includes("/maps/place/")) {
    // Resultado único: o Maps abre a ficha direto, sem feed.
    cards = [{ href: page.url(), nome: null, rotulos: [] }];
  }

  const alvo = cards.slice(0, limite);
  if (alvo.length === 0) {
    const bloqueio = await verificarBloqueio(page);
    if (bloqueio) {
      estado.interrupcao = { motivo: "bloqueio_google", detalhe: bloqueio };
      logger.warn({ termo, url: page.url(), bloqueio }, "[maps] Google bloqueou a busca");
      return;
    }
    const titulo = await page.title().catch(() => null);
    logger.warn({ termo, url: page.url(), titulo, temFeed }, "[maps] nenhum card — termo sem resultados ou seletor mudou");
    return;
  }

  for (const card of alvo) {
    if (estado.parar) return;
    const href = card.href;
    try {
      if (page.url() !== href) await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (/\/sorry\//.test(new URL(page.url()).pathname)) {
        estado.interrupcao = { motivo: "bloqueio_google", detalhe: "sorry" };
        logger.warn({ termo, lidos: estado.lidos }, "[maps] Google bloqueou no meio da coleta — parando com o parcial");
        return;
      }
      await page.locator(SELETOR_NOME).first().waitFor({ timeout: 12_000 }).catch(() => {
        /* sem h1: a extração abaixo cai no nome do card */
      });
      // O nome (h1) carrega ANTES do painel de contato — esperar o telefone/
      // endereço aparecer para não ler cedo demais e perder o número (bug real:
      // "Fazenda guardalupe" tinha telefone no Maps mas veio sem). Best-effort.
      await page
        .locator('button[data-item-id^="phone"], a[href^="tel:"], button[data-item-id="address"]')
        .first()
        .waitFor({ timeout: 8_000 })
        .catch(() => {
          /* lugar sem telefone/endereço é comum */
        });
      await sleep(600 + Math.random() * 500);
      const data = await comPrazo(
        page.evaluate(({ seletorNome, maxRotulos }: { seletorNome: string; maxRotulos: number }) => {
          const t = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? null;
          const nome = t(seletorNome);
          // Telefone em CASCATA — o Google renderiza de formas diferentes.
          const telSources: (string | null | undefined)[] = [
            // 1) data-item-id="phone:tel:0DD..." (o mais comum)
            document.querySelector('button[data-item-id^="phone:tel:"]')?.getAttribute("data-item-id")?.split(":").pop(),
            document.querySelector('button[data-item-id^="phone"]')?.getAttribute("data-item-id")?.split(":").pop(),
            // 2) aria-label "Telefone: ..." / "Phone: ..." (botão ou qualquer nó)
            document.querySelector('button[aria-label^="Telefone"], button[aria-label^="Phone"]')?.getAttribute("aria-label"),
            document.querySelector('[aria-label^="Telefone:"], [aria-label^="Phone:"]')?.getAttribute("aria-label"),
            // 3) link tel:
            (document.querySelector('a[href^="tel:"]') as HTMLAnchorElement | null)?.getAttribute("href")?.replace(/^tel:/, ""),
            // 4) último recurso: varre o texto por um padrão BR
            document.body.innerText.match(/\(?\d{2}\)?\s*\d{4,5}-?\d{4}/)?.[0],
          ];
          // Primeira fonte que contenha >= 10 dígitos vence (deixa a normalização
          // E.164 para o normalizador no Node — aqui NÃO formatamos).
          let telefone: string | null = null;
          for (const s of telSources) {
            const dig = (s || "").replace(/\D/g, "");
            if (dig.length >= 10) {
              telefone = dig;
              break;
            }
          }
          const endereco =
            document.querySelector('button[data-item-id="address"]')?.getAttribute("aria-label")?.replace(/^Endereço:\s*/i, "") ??
            t('button[data-item-id="address"]');
          const site = (document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null)?.href ?? null;
          // Avaliação na ficha: "4,8(61)" visível e os aria-label de estrela/avaliação.
          const principal = document.querySelector('div[role="main"]') ?? document.body;
          const rotulosAvaliacao = [
            (principal.querySelector("div.F7nice") as HTMLElement | null)?.innerText?.replace(/\s+/g, " ") ?? null,
            ...Array.from(principal.querySelectorAll('[aria-label*="estrela" i], [aria-label*="avalia" i], [aria-label*="star" i], [aria-label*="review" i]'))
              .map((e) => e.getAttribute("aria-label"))
              .slice(0, maxRotulos),
          ].filter((v): v is string => !!v);
          return { nome, telefone, endereco, site, rotulosAvaliacao };
        }, { seletorNome: SELETOR_NOME, maxRotulos: MAX_ROTULOS }),
        PRAZO_AVALIAR_MS,
        "ler a ficha",
      );
      estado.lidos++;
      aoLer?.(estado.lidos);
      const nome = data.nome ?? card.nome;
      if (!nome) {
        // Sem nome nem no card: confere se não é o bloqueio antes de pular.
        const bloqueio = await verificarBloqueio(page);
        if (bloqueio) {
          estado.interrupcao = { motivo: "bloqueio_google", detalhe: bloqueio };
          logger.warn({ termo, lidos: estado.lidos, bloqueio }, "[maps] Google bloqueou no meio da coleta — parando com o parcial");
          return;
        }
        estado.pulados++;
        logger.warn({ href }, "[maps] ficha sem nome — pulada");
        continue;
      }
      const raw = parseLatLng(page.url());
      // Fonte única: valida faixa (-90..90 / -180..180) e arredonda a ~6 casas.
      const geo = normalize.normalizeLatLng(raw.lat, raw.lng);
      const lat = geo.canonical?.lat ?? null;
      const lng = geo.canonical?.lng ?? null;
      const { cidade, uf } = parseCidadeUf(data.endereco);
      // Fonte ÚNICA de normalização: entrega o número CRU (com "0" de tronco do
      // Google, DDI, etc.) e deixa o normalizador (libphonenumber) resolver.
      const det = normalizePhoneDetailed(data.telefone);
      const tel = det.canonical; // E.164 ou null
      if (data.telefone && !det.canonical) {
        logger.warn({ href, nome, raw: data.telefone, reason: det.reason }, "[maps] telefone extraído mas inválido");
      } else if (!data.telefone) {
        // A ficha abriu mas nenhum seletor achou telefone — pode ser miss de
        // extração (o lugar TEM telefone no Maps), não ausência real.
        logger.warn({ href, nome }, "[maps] ficha sem telefone (miss de extração ou lugar sem número)");
      }
      // Card primeiro (o rótulo completo "4,8 estrelas 61 avaliações"), ficha de reserva.
      // Rótulo que é (ou contém) o nome do lugar não conta: "Pousada 5.0 Estrelas".
      const { avaliacao, avaliacoes } = extrairAvaliacaoMaps([...card.rotulos, ...data.rotulosAvaliacao], { nome });
      await entregar({ nome, telefone: tel, endereco: data.endereco, cidade, uf, site: data.site, lat, lng, avaliacao, avaliacoes });
    } catch (err) {
      if (estado.parar) return; // navegador fechado pelo teto: o erro é esperado
      // Uma ficha que falha não derruba o lote — mas registra a causa (antes
      // era engolida em silêncio, mascarando o bug do __name que zerava tudo).
      // Fallback: aproveita o nome do card do feed para não perder o lead.
      estado.lidos++;
      aoLer?.(estado.lidos);
      logger.warn(
        { href, err: err instanceof Error ? err.message.split("\n")[0] : String(err) },
        "[maps] falha ao extrair ficha; usando fallback do card",
      );
      if (err instanceof PrazoEsgotado) {
        // Renderer travado: a próxima navegação nessa aba travaria também
        // (visto na validação: 30 s de goto perdidos por ficha). Aba nova.
        const travada = page;
        page = await ctx.newPage();
        void travada.close().catch((e) =>
          logger.debug({ err: e instanceof Error ? e.message : String(e) }, "[maps] aba travada não fechou (o navegador fecha no fim)"),
        );
      }
      if (card.nome) {
        const { avaliacao, avaliacoes } = extrairAvaliacaoMaps(card.rotulos, { nome: card.nome });
        await entregar({ nome: card.nome, telefone: null, endereco: null, cidade: null, uf: null, site: null, lat: null, lng: null, avaliacao, avaliacoes });
      } else {
        estado.pulados++;
      }
    }
  }
}

export async function scrapeGoogleMaps(
  termo: string,
  limite: number,
  opts: {
    /** Recebe as fichas aos poucos (de 10 em 10 e o resto no fim). */
    aoColetar: (itens: MapsItem[]) => Promise<void>;
    aoLer?: (lidos: number) => void;
    tetoMs?: number;
    /**
     * SÓ para validação local: intercepta as requisições do contexto (páginas
     * de fixture no lugar do Google). O job de produção nunca passa isto.
     */
    rotear?: (ctx: BrowserContext) => Promise<void>;
  },
): Promise<ResultadoMaps> {
  const tetoMs = opts.tetoMs ?? MAPS_TETO_MS;
  const estado: Estado = { parar: false, interrupcao: null, lidos: 0, pulados: 0 };
  const buffer: MapsItem[] = [];
  let coletados = 0;
  const descarregar = async () => {
    if (!buffer.length) return;
    const bloco = buffer.splice(0, buffer.length);
    coletados += bloco.length;
    await opts.aoColetar(bloco);
  };
  const entregar = async (item: MapsItem) => {
    buffer.push(item);
    if (buffer.length >= LOTE_GRAVACAO) await descarregar();
  };

  const { browser, encerrar } = await lancarChromium({ args: ["--lang=pt-BR"] });
  let erro: unknown = null;
  try {
    const trabalho = coletar(browser, termo, limite, estado, entregar, opts.aoLer, opts.rotear);
    await comTeto(trabalho, tetoMs, async () => {
      estado.parar = true;
      estado.interrupcao ??= {
        motivo: "tempo_esgotado",
        detalhe: tetoMs >= 60_000 ? `${Math.round(tetoMs / 60_000)} min` : `${Math.round(tetoMs / 1000)} s`,
      };
      logger.warn({ termo, tetoMs, lidos: estado.lidos }, "[maps] teto do job estourou — fechando o navegador e salvando o parcial");
      await encerrar();
      // Com o navegador fechado as chamadas pendentes falham rápido; espera o
      // laço sair (e uma gravação em curso terminar) antes de descarregar.
      await comPrazo(trabalho, 30_000, "encerrar a coleta").catch((e) =>
        logger.debug({ termo, err: e instanceof Error ? e.message : String(e) }, "[maps] coleta encerrada pelo teto"),
      );
    });
  } catch (e) {
    erro = e;
  } finally {
    await encerrar();
  }
  // O que ficou no buffer (menos de 10, ou o parcial do teto/bloqueio).
  await descarregar();
  if (erro) throw erro;
  return { lidos: estado.lidos, coletados, pulados: estado.pulados, interrupcao: estado.interrupcao };
}
