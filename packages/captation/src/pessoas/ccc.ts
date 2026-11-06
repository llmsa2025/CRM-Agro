import { CNPJA_TIMEOUT_MS, CNPJA_URL, FonteFalhou, FonteSemAcesso, FonteSemCredito } from "./cnpja";

/**
 * IE de PRODUTOR RURAL por CPF e UF, no Cadastro Centralizado de Contribuintes, pela API comercial do
 * CNPJá (`GET /ccc`, documentação OpenAPI conferida em 05/10/2026). FONTE PAGA: 1 crédito por consulta
 * online e 0 por consulta em cache. Para CPF a UF é obrigatória: produtor com IE em dois estados são
 * duas consultas.
 *
 * LGPD: o CPF INTEIRO vai para o fornecedor (é o que a consulta exige). Por isso só roda com a chave
 * do time, com motivo, com o custo confirmado e com registro (ver `core/enrichment/pessoa.ts`).
 *
 * Não validado contra a API real (sem chave no desenvolvimento): o mapeamento segue o OpenAPI e o
 * `fetch` entra por parâmetro nos testes.
 */

export const CNPJA_CREDITOS_POR_CONSULTA_CCC = 1;
/** Aceita dado em cache de até 30 dias (consulta em cache não gasta crédito). */
export const CNPJA_CCC_IDADE_MAXIMA_DIAS = 30;

export type IeDoProdutor = {
  numero: string;
  uf: string;
  habilitada: boolean;
  situacao: string | null;
  /** Tipo da inscrição quando a fonte diz ("Produtor rural", "Normal"...). */
  tipo: string | null;
  /** Data da situação cadastral. */
  situacaoEm: string | null;
};

export type ResultadoCcc = {
  nome: string | null;
  ufDeOrigem: string | null;
  ies: IeDoProdutor[];
  /** Quando o dado foi atualizado na fonte (ISO), se ela informa. */
  atualizadoEm: string | null;
};

/** 404: o CPF não tem inscrição nessa UF. Não é erro de quem consultou. */
export class ProdutorSemInscricao extends Error {
  constructor(public readonly uf: string) {
    super(`Nenhuma inscrição de produtor rural encontrada em ${uf}.`);
    this.name = "ProdutorSemInscricao";
  }
}

type RespostaCcc = {
  name?: string;
  originState?: string;
  updated?: string;
  registrations?: { number?: string; state?: string; enabled?: boolean; statusDate?: string; status?: { text?: string } | null; type?: { text?: string } | null }[] | null;
};

/** Resposta do `/ccc` → resultado. Pura. */
export function resultadoDoCcc(corpo: RespostaCcc): ResultadoCcc {
  return {
    nome: corpo.name?.trim() || null,
    ufDeOrigem: corpo.originState ?? null,
    atualizadoEm: corpo.updated ?? null,
    ies: (corpo.registrations ?? [])
      .filter((r) => r?.number && r?.state)
      .map((r) => ({
        numero: String(r.number).trim(),
        uf: String(r.state),
        habilitada: Boolean(r.enabled),
        situacao: r.status?.text ?? null,
        tipo: r.type?.text ?? null,
        situacaoEm: r.statusDate ?? null,
      })),
  };
}

/** Consulta as IEs de produtor rural de um CPF numa UF. A chave vai só no cabeçalho; o CPF só aqui, em memória. */
export async function consultarIeProdutorCnpja(
  p: { chave: string; cpf: string; uf: string },
  chamar: typeof fetch = fetch,
): Promise<ResultadoCcc> {
  const cpf = p.cpf.replace(/\D/g, "");
  if (cpf.length !== 11) throw new FonteFalhou("CPF inválido");
  if (!/^[A-Z]{2}$/.test(p.uf)) throw new FonteFalhou("UF inválida");
  const q = new URLSearchParams({ taxId: cpf, states: p.uf, source: "CCC", strategy: "CACHE_IF_FRESH", maxAge: String(CNPJA_CCC_IDADE_MAXIMA_DIAS) });
  let res: Response;
  try {
    res = await chamar(`${CNPJA_URL}/ccc?${q.toString()}`, {
      headers: { accept: "application/json", Authorization: p.chave },
      signal: AbortSignal.timeout(CNPJA_TIMEOUT_MS * 2), // a consulta espera o site do órgão
    });
  } catch (e) {
    const tempo = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new FonteFalhou(tempo ? "tempo esgotado" : "erro de rede");
  }
  if (res.status === 401 || res.status === 403) throw new FonteSemAcesso(res.status);
  if (res.status === 404) throw new ProdutorSemInscricao(p.uf);
  if (res.status === 429) throw new FonteSemCredito();
  if (!res.ok) throw new FonteFalhou(`HTTP ${res.status}`);
  try {
    return resultadoDoCcc((await res.json()) as RespostaCcc);
  } catch {
    throw new FonteFalhou("resposta que não é JSON");
  }
}
