import { createHash } from "node:crypto";
import { nomeBuscaLugar } from "@crmagro/db";

/**
 * Normalização de endereço para a geocodificação (produto §B.2).
 *
 * - `chave`: identifica o endereço no `GeoCache` (global) e gera o `geoHash`
 *   do contato. Sem acento, caixa ou pontuação: "Rua X, 100" e "rua x 100"
 *   caem na mesma chave.
 * - `nivel`: `endereco` quando há logradouro; `cidade` quando só cidade (com
 *   ou sem UF); `nenhum` quando não há nada para localizar.
 * - `consulta`: o texto ORIGINAL (com acento) para o provedor — o Nominatim
 *   acha melhor "São Paulo" do que "sao paulo".
 */

export type NivelEndereco = "endereco" | "cidade" | "nenhum";

export type EnderecoNormalizado = {
  nivel: NivelEndereco;
  chave: string;
  /** Cidade para o centroide do IBGE (nome de busca) — "" se não há. */
  cidadeBusca: string;
  uf: string | null;
  consulta: string;
};

const UFS: Record<string, string> = {
  acre: "AC", alagoas: "AL", amapa: "AP", amazonas: "AM", bahia: "BA", ceara: "CE",
  "distrito federal": "DF", "espirito santo": "ES", goias: "GO", maranhao: "MA",
  "mato grosso": "MT", "mato grosso do sul": "MS", "minas gerais": "MG", para: "PA",
  paraiba: "PB", parana: "PR", pernambuco: "PE", piaui: "PI", "rio de janeiro": "RJ",
  "rio grande do norte": "RN", "rio grande do sul": "RS", rondonia: "RO", roraima: "RR",
  "santa catarina": "SC", "sao paulo": "SP", sergipe: "SE", tocantins: "TO",
};
const SIGLAS = new Set(Object.values(UFS));

/** "mt", "MT", "Mato Grosso" → "MT"; o resto → null. */
export function ufDe(estado: string | null | undefined): string | null {
  const t = (estado ?? "").trim();
  if (/^[a-z]{2}$/i.test(t)) return SIGLAS.has(t.toUpperCase()) ? t.toUpperCase() : null;
  return UFS[nomeBuscaLugar(t)] ?? null;
}

/** "Rua X, 100 - Centro, Sorriso - MT, 78890-000" → "MT" (o Maps grava assim). */
function ufNoEndereco(endereco: string): string | null {
  const m = endereco.match(/-\s*([A-Z]{2})\b(?![a-z])/g);
  if (!m) return null;
  for (let i = m.length - 1; i >= 0; i--) {
    const uf = ufDe(m[i]!.replace(/[-\s]/g, ""));
    if (uf) return uf;
  }
  return null;
}

/**
 * Teto do texto usado: um endereço colado com lixo (milhares de caracteres)
 * estouraria o limite de tamanho da chave no índice do GeoCache e o provedor
 * recusaria a consulta. Endereço real cabe folgado.
 */
const MAX_TEXTO = 200;

export function normalizarEndereco(input: {
  endereco?: string | null;
  cidade?: string | null;
  estado?: string | null;
}): EnderecoNormalizado {
  const endereco = (input.endereco ?? "").trim().slice(0, MAX_TEXTO);
  const cidade = (input.cidade ?? "").trim().slice(0, MAX_TEXTO);
  const uf = ufDe(input.estado) ?? (endereco ? ufNoEndereco(endereco) : null);
  const enderecoBusca = nomeBuscaLugar(endereco);
  const cidadeBusca = nomeBuscaLugar(cidade);
  const ufBusca = (uf ?? "").toLowerCase();

  if (enderecoBusca) {
    return {
      nivel: "endereco",
      chave: `${enderecoBusca}|${cidadeBusca}|${ufBusca}`,
      cidadeBusca,
      uf,
      consulta: [endereco, cidade, uf, "Brasil"].filter(Boolean).join(", "),
    };
  }
  if (cidadeBusca) {
    return { nivel: "cidade", chave: `${cidadeBusca}|${ufBusca}`, cidadeBusca, uf, consulta: [cidade, uf, "Brasil"].filter(Boolean).join(", ") };
  }
  return { nivel: "nenhum", chave: "", cidadeBusca: "", uf, consulta: "" };
}

/** `geoHash`: sha1 da chave — mudou o endereço, muda o hash. */
export function geoHashDe(chave: string): string {
  return createHash("sha1").update(chave).digest("hex");
}

/** Distância em km entre dois pontos (Haversine). */
export function distanciaKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
