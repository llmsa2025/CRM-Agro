/**
 * Formatos de telefone da conta do Nectar (plano §2.4). Ficha N1: a
 * classificação. Ficha N3: as variantes de busca de um mesmo número.
 *
 * O Nectar guarda o telefone como foi digitado, e importação, RD Station e a
 * extensão do WhatsApp gravam formatos diferentes na mesma conta. Por isso o
 * "Testar" lê uma amostra e guarda a DISTRIBUIÇÃO dos formatos.
 *
 * Regra da pasta `providers/nectarcrm/`: só importa `zod`, tipos e `node:crypto`.
 */
import type { DistribuicaoFormatos, FormatoTelefone } from "../../contract";

/** Classifica um telefone como o Nectar o guardou. Não valida o número: só o formato. */
export function formatoDoTelefone(txt: string): FormatoTelefone {
  const t = txt.trim();
  if (/^\+\d{8,15}$/.test(t)) return "e164"; // +5562999998888
  if (/^55\d{10,11}$/.test(t)) return "55"; // 5562999998888 (12 ou 13 dígitos)
  if (/^\d{11}$/.test(t)) return "ddd"; // 62999998888
  if (/^\(\d{2}\) \d{5}-\d{4}$/.test(t)) return "parenteses_hifen"; // (62) 99999-8888
  if (/^\(\d{2}\) \d{9}$/.test(t)) return "parenteses"; // (62) 999998888
  if (/^\d{10}$/.test(t)) return "sem_nono"; // 6299998888
  if (/^\(\d{2}\) \d{4}-\d{4}$/.test(t)) return "sem_nono_parenteses_hifen"; // (62) 9999-8888
  return "outro";
}

/** Conta quantos telefones da lista caem em cada formato. */
export function distribuicaoDeFormatos(lista: string[]): DistribuicaoFormatos {
  const dist: DistribuicaoFormatos = {};
  for (const tel of lista) {
    const f = formatoDoTelefone(tel);
    dist[f] = (dist[f] ?? 0) + 1;
  }
  return dist;
}

/**
 * Formato de cada uma das 7 variantes de um celular BR, na MESMA ordem de
 * `variantesDoTelefone` (que é a ordem da §2.4 do plano).
 */
export const FORMATO_DA_VARIANTE: readonly FormatoTelefone[] = [
  "e164",
  "55",
  "ddd",
  "parenteses_hifen",
  "parenteses",
  "sem_nono",
  "sem_nono_parenteses_hifen",
];

/**
 * Todas as formas em que o Nectar pode ter guardado o mesmo número, para a
 * busca exata (`GET /contatos/telefone/{tel}`, que não normaliza). Entrada em
 * E.164.
 * - celular BR (+55, DDD, 9 dígitos): as 7 variantes da §2.4, nesta ordem;
 * - fixo BR (8 dígitos): e164, 55, ddd e `(DD) XXXX-XXXX`;
 * - número de fora (ou fora do padrão): só o próprio E.164.
 */
export function variantesDoTelefone(e164: string): string[] {
  const celular = /^\+55(\d{2})(9\d{8})$/.exec(e164);
  if (celular) {
    const [, ddd, nove] = celular as unknown as [string, string, string];
    const oito = nove.slice(1); // sem o nono dígito
    return [
      `+55${ddd}${nove}`,
      `55${ddd}${nove}`,
      `${ddd}${nove}`,
      `(${ddd}) ${nove.slice(0, 5)}-${nove.slice(5)}`,
      `(${ddd}) ${nove}`,
      `${ddd}${oito}`,
      `(${ddd}) ${oito.slice(0, 4)}-${oito.slice(4)}`,
    ];
  }
  const fixo = /^\+55(\d{2})(\d{8})$/.exec(e164);
  if (fixo) {
    const [, ddd, oito] = fixo as unknown as [string, string, string];
    return [`+55${ddd}${oito}`, `55${ddd}${oito}`, `${ddd}${oito}`, `(${ddd}) ${oito.slice(0, 4)}-${oito.slice(4)}`];
  }
  return [e164];
}

/**
 * Ordena as variantes pela frequência do formato NA CONTA (do mais usado para o
 * menos usado): a busca para no primeiro achado, então a primeira tentativa é a
 * que mais provavelmente acerta. Empate mantém a ordem original.
 */
export function ordenarVariantes(variantes: string[], distribuicao: DistribuicaoFormatos): string[] {
  return variantes
    .map((v, i) => ({ v, i, peso: distribuicao[formatoDoTelefone(v)] ?? 0 }))
    .sort((a, b) => b.peso - a.peso || a.i - b.i)
    .map((x) => x.v);
}

/** O telefone digitado no formato pedido; sem variante nesse formato, o próprio E.164. */
export function telefoneNoFormato(e164: string, formato: FormatoTelefone): string {
  return variantesDoTelefone(e164).find((v) => formatoDoTelefone(v) === formato) ?? e164;
}

/** Só os dígitos (para comparar o mesmo número escrito de jeitos diferentes). */
export function soDigitos(txt: string): string {
  return txt.replace(/\D/g, "");
}

/** O telefone que está no Nectar é o mesmo número (em qualquer variante)? */
export function mesmoTelefone(remoto: string, variantes: string[]): boolean {
  const digitosRemoto = soDigitos(remoto);
  return variantes.some((v) => v === remoto.trim() || (digitosRemoto !== "" && soDigitos(v) === digitosRemoto));
}
