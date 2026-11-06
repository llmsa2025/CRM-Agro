#!/usr/bin/env tsx
/**
 * Semeia `Municipio` (produto §B.1): centroides dos 5.571 municípios, usados
 * pelo Mapa para geocodificar "cidade/UF" sem chamar provedor nenhum.
 *
 * Fonte: kelvins/municipios-brasileiros (licença MIT), versão FIXADA no commit
 * abaixo — o conteúdo não muda sem alguém trocar o hash aqui.
 *
 * - Sem `--aplicar` só baixa, confere e conta (não grava).
 * - `--aplicar` troca a tabela inteira numa transação (nenhuma FK aponta para
 *   `Municipio`); rodar de novo é seguro.
 * - `--municipios=<csv> --estados=<csv>` usa arquivos locais em vez de baixar.
 *
 * Uso (produção; depois da migration 20260927130000_geolocalizacao):
 *   cd /srv/crmagro/packages/db
 *   pnpm exec dotenv -e ../../.env -- tsx scripts/seed-municipios.ts            # só confere
 *   pnpm exec dotenv -e ../../.env -- tsx scripts/seed-municipios.ts --aplicar  # grava
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { nomeBuscaLugar } from "../src/municipio";

const VERSAO = "503e2f70bbf1b4b7ec0b1f68b09086ccc38fe861";
const BASE = `https://raw.githubusercontent.com/kelvins/municipios-brasileiros/${VERSAO}/csv`;

const arg = (nome: string) => process.argv.find((a) => a.startsWith(`--${nome}=`))?.slice(nome.length + 3) ?? null;
const aplicar = process.argv.includes("--aplicar");

async function ler(nome: "municipios" | "estados"): Promise<string> {
  const local = arg(nome);
  if (local) return readFileSync(local, "utf8");
  const r = await fetch(`${BASE}/${nome}.csv`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`download de ${nome}.csv falhou: HTTP ${r.status}`);
  return r.text();
}

/** CSV simples (a fonte não usa aspas nem vírgula dentro de campo — conferido). */
function linhas(csv: string): Record<string, string>[] {
  const [cab, ...resto] = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const campos = cab!.split(",");
  return resto.map((l) => {
    const v = l.split(",");
    if (v.length !== campos.length) throw new Error(`linha fora do formato: ${l}`);
    return Object.fromEntries(campos.map((c, i) => [c, v[i]!]));
  });
}

async function main() {
  const ufPorCodigo = new Map(linhas(await ler("estados")).map((e) => [e.codigo_uf!, e.uf!]));
  const rows = linhas(await ler("municipios")).map((m) => {
    const uf = ufPorCodigo.get(m.codigo_uf!);
    const latitude = Number(m.latitude);
    const longitude = Number(m.longitude);
    if (!uf || !Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error(`município inválido: ${JSON.stringify(m)}`);
    return { codigoIbge: Number(m.codigo_ibge), nome: m.nome!, nomeBusca: nomeBuscaLugar(m.nome), uf, latitude, longitude };
  });

  // Conferências antes de gravar: base inteira, 27 UFs, chave de busca única por UF.
  const ufs = new Set(rows.map((r) => r.uf));
  const chaves = new Set(rows.map((r) => `${r.uf}|${r.nomeBusca}`));
  if (rows.length < 5500 || ufs.size !== 27 || chaves.size !== rows.length) {
    throw new Error(`base inesperada: ${rows.length} municípios, ${ufs.size} UFs, ${chaves.size} chaves únicas`);
  }
  const exemplo = rows.find((r) => r.nome === "Sorriso");
  console.log(`${rows.length} municípios, ${ufs.size} UFs. Ex.: ${JSON.stringify(exemplo)}`);
  if (!aplicar) {
    console.log("Só conferência (use --aplicar para gravar).");
    return;
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.municipio.deleteMany({});
        for (let i = 0; i < rows.length; i += 1000) await tx.municipio.createMany({ data: rows.slice(i, i + 1000) });
      },
      { timeout: 120_000 },
    );
    console.log(`Municipio: ${await prisma.municipio.count()} linhas gravadas.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
