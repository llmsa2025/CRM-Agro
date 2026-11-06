import { z } from "zod";
import { db } from "@crmagro/db";
import { ForbiddenError, getActor, requireRole } from "../auth/authz";
import { assertOwned } from "../tenancy/assert-owned";
import { DEFAULT_TZ, zonedParts, zonedTimeToUtc } from "../motor-do-dia/tz";
import { distanciaKm } from "./endereco";

/**
 * Rota do dia (produto §B.3): os compromissos PENDENTES do dia (fuso de São
 * Paulo) com contato localizado, em ordem de vizinho mais próximo a partir da
 * posição do vendedor (ou do primeiro compromisso do dia), e o link do Google
 * Maps com as paradas. Sem serviço externo: distância em linha reta
 * (Haversine) — a ordem é sugestão, o trajeto real quem calcula é o Maps.
 *
 * A rota é de UMA pessoa (produto §E): os compromissos do usuário logado mais
 * os "do time" (sem responsável, criados pela automação). Antes juntava os
 * compromissos do time todo. Admin/owner pode pedir a rota de outro usuário
 * do time (`responsavelId`). A parada usa a coordenada atual do contato e,
 * sem ela, a copiada para a visita quando foi criada.
 */

/** O link de rotas do Google Maps aceita até 9 paradas intermediárias. */
export const ROTA_MAX_WAYPOINTS = 9;

export const rotaSchema = z.object({
  /** Dia no calendário de São Paulo (padrão: hoje). */
  data: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Posição do vendedor (navegador). Sem ela, parte do 1º compromisso do dia. */
  origem: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
  /** Rota de outro usuário do time (só admin/owner). Padrão: o usuário logado. */
  responsavelId: z.string().min(1).max(64).optional(),
});
export type RotaInput = z.infer<typeof rotaSchema>;

export type ParadaRota = {
  appointmentId: string;
  titulo: string;
  tipo: string;
  inicio: string;
  contactId: string;
  nome: string;
  cidade: string | null;
  lat: number;
  lng: number;
  /** Distância em linha reta desde a parada anterior (ou da origem). */
  km: number;
};

export type RotaDoDia = {
  data: string;
  paradas: ParadaRota[];
  /** Compromissos do dia que ficaram fora da rota (sem contato ou sem coordenada). */
  semLocal: { appointmentId: string; titulo: string; inicio: string; contactId: string | null }[];
  totalKm: number;
  linkGoogleMaps: string | null;
  /** Mais paradas do que o link comporta: o link cobre as primeiras. */
  linkParcial: boolean;
};

/** Vizinho mais próximo: a partir de `inicio`, sempre a parada mais perto ainda não visitada. */
export function ordenarPorVizinhoMaisProximo<T extends { lat: number; lng: number }>(
  pontos: T[],
  inicio: { lat: number; lng: number },
): (T & { km: number })[] {
  const resto = [...pontos];
  const ordem: (T & { km: number })[] = [];
  let atual = inicio;
  while (resto.length) {
    let melhor = 0;
    let melhorKm = Infinity;
    resto.forEach((p, i) => {
      const d = distanciaKm(atual, p);
      if (d < melhorKm) {
        melhorKm = d;
        melhor = i;
      }
    });
    const [p] = resto.splice(melhor, 1);
    ordem.push({ ...p!, km: Math.round(melhorKm * 10) / 10 });
    atual = p!;
  }
  return ordem;
}

/** Link do Google Maps (API de URLs, sem chave): origem → paradas → destino. */
export function linkGoogleMaps(origem: { lat: number; lng: number } | null, paradas: { lat: number; lng: number }[]): { url: string | null; parcial: boolean } {
  if (!paradas.length) return { url: null, parcial: false };
  const ponto = (p: { lat: number; lng: number }) => `${p.lat},${p.lng}`;
  const capacidade = ROTA_MAX_WAYPOINTS + (origem ? 1 : 2); // intermediárias + destino (+ origem se não veio)
  const usadas = paradas.slice(0, capacidade);
  const inicio = origem ?? usadas[0]!;
  const semOrigem = origem ? usadas : usadas.slice(1);
  const destino = semOrigem[semOrigem.length - 1] ?? inicio;
  const meio = semOrigem.slice(0, -1);
  const params = new URLSearchParams({ api: "1", origin: ponto(inicio), destination: ponto(destino), travelmode: "driving" });
  if (meio.length) params.set("waypoints", meio.map(ponto).join("|"));
  return { url: `https://www.google.com/maps/dir/?${params.toString()}`, parcial: paradas.length > usadas.length };
}

/** "Hoje" no calendário de São Paulo, como YYYY-MM-DD. */
function hojeSP(agora: Date): string {
  const p = zonedParts(agora, DEFAULT_TZ);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** De quem é a rota: o próprio usuário, ou outro do time se quem pede é admin. */
async function donoDaRota(pedido: string | undefined): Promise<string> {
  const ator = getActor();
  if (!ator || ator.system) throw new ForbiddenError(); // rota é de pessoa
  if (!pedido || pedido === ator.userId) return ator.userId;
  requireRole("admin");
  await assertOwned("user", pedido); // outro time → não encontrado
  return pedido;
}

export async function rotaDoDia(input: RotaInput = {}, agora: Date = new Date()): Promise<RotaDoDia> {
  const d0 = db();
  const { data, origem, responsavelId } = rotaSchema.parse(input);
  const dono = await donoDaRota(responsavelId);
  const dia = data ?? hojeSP(agora);
  const [y, m, d] = dia.split("-").map(Number) as [number, number, number];
  const de = zonedTimeToUtc(y, m, d, 0, 0);
  const ate = new Date(de.getTime() + 24 * 60 * 60_000);
  const compromissos = await d0.appointment.findMany({
    where: {
      inicio: { gte: de, lt: ate },
      status: "pendente",
      OR: [{ responsavelId: dono }, { responsavelId: null }],
      // A rota de OUTRA pessoa (o administrador pede a da Ana) não mostra o que
      // veio da Agenda Google dela e ela ainda não confirmou (só ela vê).
      ...(dono !== getActor()?.userId ? { privadoAteConfirmar: false } : {}),
    },
    orderBy: { inicio: "asc" },
    select: {
      id: true,
      titulo: true,
      tipo: true,
      inicio: true,
      contactId: true,
      latitude: true,
      longitude: true,
      contact: { select: { nome: true, cidade: true, latitude: true, longitude: true } },
    },
    take: 200,
  });
  const localizados: Omit<ParadaRota, "km">[] = [];
  const semLocal: RotaDoDia["semLocal"] = [];
  for (const a of compromissos) {
    const c = a.contact;
    // Coordenada ATUAL do contato primeiro: a geocodificação do Mapa é gradual
    // (centro da cidade na hora, endereço exato depois, pino manual), e a cópia
    // da visita é de quando ela foi criada. A cópia só vale se o contato ficou
    // sem coordenada.
    const doContato = c?.latitude != null && c?.longitude != null;
    const lat = doContato ? c!.latitude : a.latitude;
    const lng = doContato ? c!.longitude : a.longitude;
    if (a.contactId && c && lat != null && lng != null) {
      localizados.push({
        appointmentId: a.id,
        titulo: a.titulo,
        tipo: a.tipo,
        inicio: a.inicio.toISOString(),
        contactId: a.contactId,
        nome: c.nome,
        cidade: c.cidade,
        lat,
        lng,
      });
    } else {
      semLocal.push({ appointmentId: a.id, titulo: a.titulo, inicio: a.inicio.toISOString(), contactId: a.contactId });
    }
  }
  const inicio = origem ?? localizados[0] ?? null;
  const paradas = inicio ? ordenarPorVizinhoMaisProximo(localizados, inicio) : [];
  const link = linkGoogleMaps(origem ?? null, paradas);
  return {
    data: dia,
    paradas,
    semLocal,
    totalKm: Math.round(paradas.reduce((a, p) => a + p.km, 0) * 10) / 10,
    linkGoogleMaps: link.url,
    linkParcial: link.parcial,
  };
}
