#!/usr/bin/env node
/**
 * Tira os prints da demo (login com o usuário do seed demo e visita das telas principais).
 *
 * Pré-requisitos: o app rodando (BASE_URL, padrão http://localhost:3001), o seed demo aplicado
 * (`pnpm db:seed:demo`) e o Chromium do Playwright instalado:
 *   pnpm --filter @crmagro/worker exec playwright-core install chromium
 *
 * Uso: pnpm demo:screenshots            (grava em ./screenshots)
 *      OUT=/tmp/prints BASE_URL=http://localhost:3001 pnpm demo:screenshots
 *
 * Saída:
 *   screenshots/desktop/   1680x1050 (a 1,5x), para README e artigos
 *   screenshots/linkedin/  1600x838 (a 1,5x), proporção 1,91:1 de imagem de post do LinkedIn
 *   screenshots/dark/      tema escuro, telas principais
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = (process.env.BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
const OUT = path.resolve(process.env.OUT ?? "screenshots");
// SO="15-mapa-satelite-z1,07-editor-de-fluxo" tira só essas telas (vazio = todas).
const SO = (process.env.SO ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const EMAIL = process.env.DEMO_EMAIL ?? "demo@crmagro.example";
const SENHA = process.env.DEMO_SENHA ?? "DemoCrmAgro2026!";

// O Playwright vem como dependência do worker (pnpm não expõe pacotes de outros workspaces na raiz).
const require = createRequire(path.resolve("apps/worker/package.json"));
const { chromium } = require("playwright-core");

/** Cada tela: nome do arquivo, rota inicial e (opcional) um clique para chegar no detalhe. */
const TELAS = [
  { nome: "01-painel", rota: "/", espera: 1500 },
  { nome: "02-contatos", rota: "/contatos", espera: 1200 },
  { nome: "03-contato-ficha", rota: "/contatos", abrir: 'a[href^="/contatos/"]:has-text("Helena Duarte")', espera: 1500 },
  { nome: "04-conversas", rota: "/conversas", clicar: "Helena Duarte", espera: 1800 },
  { nome: "05-funil", rota: "/funis", abrir: 'a[href^="/funis/"]', espera: 1500 },
  { nome: "06-fluxos", rota: "/fluxos", espera: 1200 },
  { nome: "07-editor-de-fluxo", rota: "/fluxos", abrir: 'a:has-text("Boas-vindas ao lead novo")', espera: 2500 },
  { nome: "08-campanhas", rota: "/campanhas", espera: 1200 },
  { nome: "09-campanha-andamento", rota: "/campanhas", abrir: 'a[href^="/campanhas/"]', espera: 1800 },
  { nome: "10-agenda", rota: "/agenda", espera: 1800 },
  { nome: "11-mapa", rota: "/mapa", espera: 5000 },
  { nome: "12-captacao", rota: "/captacao", espera: 1200 },
  // Mapa em satélite, com os contatos soltos (modo Pontos) em vez de agrupados. O app guarda as duas escolhas no localStorage.
  { nome: "15-mapa-satelite", rota: "/mapa", espera: 9000, storage: { "crmagro:mapa:pontos": "pontos", "crmagro:mapa:estilo": "satelite" }, recolherFiltros: true },
  { nome: "13-integracoes", rota: "/integracoes", espera: 1200 },
  { nome: "14-atividades", rota: "/atividades", espera: 1200 },
];
const TELAS_ESCURO = ["01-painel", "02-contatos", "05-funil", "07-editor-de-fluxo", "04-conversas"];

const browser = await chromium.launch();

async function entrar(contexto) {
  const page = await contexto.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("#email", EMAIL);
  await page.fill("#senha", SENHA);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 }), page.press("#senha", "Enter")]);
  await page.close();
}

async function tirar(pasta, viewport, escala, esquema, filtro) {
  mkdirSync(pasta, { recursive: true });
  const contexto = await browser.newContext({ viewport, deviceScaleFactor: escala, colorScheme: esquema, locale: "pt-BR", timezoneId: "America/Sao_Paulo" });
  // O tema do app vem do localStorage (next-themes, padrão "light"), não da preferência do navegador.
  if (esquema === "dark") await contexto.addInitScript(() => { try { localStorage.setItem("theme", "dark"); } catch {} });
  await entrar(contexto);
  const falhas = [];
  for (const tela of TELAS.filter((t) => (!filtro || filtro.includes(t.nome)) && (!SO.length || SO.includes(t.nome)))) {
    const page = await contexto.newPage();
    try {
      if (tela.storage) await page.addInitScript((kv) => { try { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); } catch {} }, tela.storage);
      await page.goto(`${BASE}${tela.rota}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      if (tela.abrir) {
        const alvo = page.locator(tela.abrir).first();
        const href = await alvo.getAttribute("href", { timeout: 15_000 });
        await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      }
      if (tela.recolherFiltros) await page.getByLabel("Recolher filtros").click({ timeout: 8_000 }).catch(() => {});
      for (let i = 0; i < (tela.zoomIn ?? 0); i++) {
        await page.waitForTimeout(2500);
        await page.getByLabel("Aproximar").click({ timeout: 8_000 });
      }
      if (tela.clicar) await page.getByText(tela.clicar, { exact: false }).first().click({ timeout: 15_000 });
      await page.waitForTimeout(tela.espera);
      await page.screenshot({ path: path.join(pasta, `${tela.nome}.png`) });
      console.log("ok  ", path.relative(process.cwd(), path.join(pasta, `${tela.nome}.png`)));
    } catch (e) {
      falhas.push(tela.nome);
      console.error("FALHA", tela.nome, String(e.message ?? e).split("\n")[0]);
    }
    await page.close();
  }
  await contexto.close();
  return falhas;
}

const falhas = [
  ...(await tirar(path.join(OUT, "desktop"), { width: 1680, height: 1050 }, 1.5, "light")),
  ...(await tirar(path.join(OUT, "linkedin"), { width: 1600, height: 838 }, 1.5, "light")),
  ...(await tirar(path.join(OUT, "dark"), { width: 1680, height: 1050 }, 1.5, "dark", TELAS_ESCURO)),
];
await browser.close();
if (falhas.length) {
  console.error(`\n${falhas.length} tela(s) falharam: ${[...new Set(falhas)].join(", ")}`);
  process.exitCode = 1;
}
