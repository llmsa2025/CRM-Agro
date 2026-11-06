import { z } from "zod";
import { db } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";
import { geoHashDe } from "./endereco";
import { GeocodificadorIndisponivel } from "./geocodificador";
import { NominatimGeocodificador } from "./nominatim";

/**
 * Pino colocado pela pessoa (produto §B: criar contato clicando no mapa, ou
 * corrigir a posição). `geoPrecisao = "manual"` nunca é regeocodificado pelo
 * backfill, e a coordenada não vai para o GeoCache (é dado do time, não do
 * provedor).
 */

/** Marca no geoHash: "posição manual" (o backfill ignora `manual` de qualquer jeito). */
export const HASH_MANUAL = geoHashDe("manual");

export const pontoSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type Ponto = z.infer<typeof pontoSchema>;

export class ContatoNaoLocalizavel extends Error {
  constructor(id: string) {
    super(`ContatoNaoLocalizavel: contato ${id} não encontrado no time.`);
    this.name = "ContatoNaoLocalizavel";
  }
}

/** Grava a posição escolhida no mapa para um contato do time. */
export async function definirLocalizacaoManual(contactId: string, ponto: Ponto): Promise<void> {
  requireCan("contacts.write");
  const p = pontoSchema.parse(ponto);
  const prisma = db();
  const c = await prisma.contact.findUnique({ where: { id: contactId }, select: { id: true } });
  if (!c) throw new ContatoNaoLocalizavel(contactId);
  await prisma.contact.update({
    where: { id: contactId },
    data: {
      latitude: p.latitude,
      longitude: p.longitude,
      geoPrecisao: "manual",
      geoFonte: "manual",
      geoHash: HASH_MANUAL,
      geoAtualizadoEm: new Date(),
    },
  });
}

export type LugarDoPonto = { cidade: string | null; estado: string | null };

/**
 * Cidade/UF de um ponto (Nominatim `reverse`) — MELHOR ESFORÇO: sem
 * `GEO_CONTATO`, sem rede ou sem resultado devolve `null` e o contato é
 * criado só com a coordenada. Nunca derruba a criação.
 */
export async function cidadeDoPonto(ponto: Ponto, provedor: NominatimGeocodificador = new NominatimGeocodificador()): Promise<LugarDoPonto | null> {
  const p = pontoSchema.parse(ponto);
  try {
    return await provedor.reverso(p);
  } catch (err) {
    if (err instanceof GeocodificadorIndisponivel) {
      logger.info({ motivo: err.message }, "[geo] reverso indisponível — contato fica sem cidade/UF");
      return null;
    }
    throw err;
  }
}
