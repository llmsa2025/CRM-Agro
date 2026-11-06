#!/usr/bin/env node
/**
 * Reaplica a coordenada da ficha do Google Maps nos contatos que foram
 * importados ANTES de a importação gravar lat/long (27/09/2026). Casa o
 * rascunho (`ProspectDraft` origem "maps", com `extra.lat/lng`) com o contato
 * pelo telefone (E.164) e, sem telefone, por nome + cidade. Só mexe em contato
 * SEM pino manual e cuja precisão atual é "cidade"/"nenhuma"/vazia (nunca
 * rebaixa um ponto de endereço).
 *
 * Uso (produção):
 *   cd /srv/crmagro/packages/db
 *   pnpm exec dotenv -e ../../.env -- node scripts/reaplicar-coordenadas-maps.mjs            # só mostra
 *   pnpm exec dotenv -e ../../.env -- node scripts/reaplicar-coordenadas-maps.mjs --aplicar  # grava
 */
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const APLICAR = process.argv.includes("--aplicar");
const prisma = new PrismaClient();

// Mesma normalização do core (geo/endereco.ts): chave "endereco|cidade|uf" em minúsculas sem acento.
const limpa = (s) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const geoHash = (endereco, cidade, uf) => createHash("sha1").update(`${limpa(endereco)}|${limpa(cidade)}|${(uf ?? "").toLowerCase()}`).digest("hex");
const e164 = (t) => {
  const d = (t ?? "").replace(/\D/g, "");
  if (!d) return null;
  return d.startsWith("55") ? `+${d}` : `+55${d}`;
};

const drafts = await prisma.prospectDraft.findMany({
  where: { origem: "maps", status: "importado" },
  select: { teamId: true, nome: true, telefone: true, cidade: true, uf: true, extra: true },
});
let vistos = 0, casados = 0, atualizados = 0;
for (const d of drafts) {
  const e = d.extra ?? {};
  if (typeof e.lat !== "number" || typeof e.lng !== "number") continue;
  vistos++;
  let contato = null;
  const tel = e164(d.telefone);
  if (tel) {
    const ident = await prisma.channelIdentifier.findFirst({ where: { teamId: d.teamId, canal: "whatsapp", valor: tel }, select: { contactId: true } });
    if (ident) contato = await prisma.contact.findUnique({ where: { id: ident.contactId }, select: { id: true, nome: true, geoPrecisao: true } });
  }
  if (!contato) {
    contato = await prisma.contact.findFirst({
      where: { teamId: d.teamId, nome: d.nome, origem: "captacao_maps", ...(d.cidade ? { cidade: d.cidade } : {}) },
      select: { id: true, nome: true, geoPrecisao: true },
    });
  }
  if (!contato) continue;
  casados++;
  if (contato.geoPrecisao === "manual" || contato.geoPrecisao === "endereco") continue;
  console.log(`${APLICAR ? "grava" : "gravaria"}: ${contato.nome} → ${e.lat}, ${e.lng} (antes: ${contato.geoPrecisao ?? "vazio"})`);
  if (APLICAR) {
    await prisma.contact.update({
      where: { id: contato.id },
      data: { latitude: e.lat, longitude: e.lng, geoPrecisao: "endereco", geoFonte: "maps", geoHash: geoHash(e.endereco, d.cidade, d.uf), geoAtualizadoEm: new Date() },
    });
    atualizados++;
  }
}
console.log(`rascunhos do Maps com coordenada: ${vistos} · contatos casados: ${casados} · ${APLICAR ? "atualizados" : "a atualizar"}: ${APLICAR ? atualizados : "(rode com --aplicar)"}`);
await prisma.$disconnect();
