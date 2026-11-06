#!/usr/bin/env node
/**
 * Copia o worker do MapLibre (e o chunk que ele importa) para `public/maplibre/`.
 *
 * Desde a v6 o MapLibre é ESM puro e, com bundler, o worker precisa ser servido
 * pela própria origem via `setWorkerUrl()` (guia de migração v5→v6). O worker
 * importa `./maplibre-gl-shared.mjs` relativo a si mesmo, então os DOIS
 * arquivos vão juntos. Roda antes de `next build`/`dev`; a pasta é ignorada
 * pelo git e refeita a cada build, sempre na versão instalada.
 */
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dist = join(dirname(require.resolve("maplibre-gl/package.json")), "dist");
const destino = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "maplibre");
mkdirSync(destino, { recursive: true });
for (const nome of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(join(dist, nome), join(destino, nome));
}
console.log(`[maplibre] worker copiado para public/maplibre (${require("maplibre-gl/package.json").version})`);
