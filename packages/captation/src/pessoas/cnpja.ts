import { cpfMascaradoDe } from "../cnpj/fetch";

/**
 * Busca de PESSOAS por nome na API comercial do CNPJá (`GET /person`, base da Receita Federal).
 * É fonte PAGA: cada 10 registros lidos custam 1 crédito (documentação OpenAPI em
 * https://api.cnpja.com/docs/json, conferida em 05/10/2026). Só roda se o time configurou a
 * chave em Integrações; nenhum teste chama a API de verdade (o `fetch` entra por parâmetro).
 *
 * Devolve CANDIDATOS: nome, faixa de idade, CPF mascarado (só os 6 dígitos do meio) e as
 * sociedades em que a pessoa aparece. Quem escolhe o candidato certo é a pessoa que busca;
 * depois as empresas dele vêm da fonte gratuita (Minha Receita, por máscara + nome).
 *
 * Não validado contra a API real (sem chave no desenvolvimento): o mapeamento segue o OpenAPI.
 */

export const CNPJA_URL = "https://api.cnpja.com";
export const CNPJA_TIMEOUT_MS = 30_000;
/** Registros por crédito na pesquisa de pessoas (documentação: "1 crédito por cada 10 registros"). */
export const CNPJA_REGISTROS_POR_CREDITO = 10;

/** Créditos que uma pesquisa de `registros` pessoas custa (arredonda para cima). */
export const creditosDaPesquisa = (registros: number): number => Math.max(1, Math.ceil(registros / CNPJA_REGISTROS_POR_CREDITO));

export type EmpresaDoCandidato = { nome: string; capital: number | null; porte: string | null; qualificacao: string | null };
export type CandidatoDePessoa = {
  id: string;
  nome: string;
  cpfMascarado: string | null;
  faixaEtaria: string | null;
  empresas: EmpresaDoCandidato[];
};
export type PaginaDeCandidatos = {
  candidatos: CandidatoDePessoa[];
  /** Token da próxima página; null = foi a última. */
  proximo: string | null;
  /** Quantas pessoas a fonte diz ter para esse nome. */
  total: number | null;
};

/** 401/403: a chave não vale (errada, apagada ou sem permissão). */
export class FonteSemAcesso extends Error {
  constructor(public readonly status: number) {
    super("A chave da fonte de dados não foi aceita");
    this.name = "FonteSemAcesso";
  }
}
/** 429: créditos esgotados ou limite por minuto. */
export class FonteSemCredito extends Error {
  constructor() {
    super("A fonte de dados está sem créditos ou no limite por minuto");
    this.name = "FonteSemCredito";
  }
}
/** Qualquer outra falha (rede, tempo, 5xx, resposta que não entendemos). */
export class FonteFalhou extends Error {
  constructor(detalhe: string) {
    super(`A fonte de dados falhou: ${detalhe}`);
    this.name = "FonteFalhou";
  }
}

type Registro = {
  id?: string;
  type?: string;
  name?: string;
  taxId?: string;
  age?: string;
  membership?: { role?: { text?: string } | null; company?: { name?: string; equity?: number; size?: { text?: string } | null } | null }[] | null;
};

/** Resposta do `/person` → candidatos. Pura (testável com resposta de exemplo). */
export function candidatosDaResposta(corpo: { records?: Registro[] | null; next?: string | null; count?: number | null }): PaginaDeCandidatos {
  const candidatos: CandidatoDePessoa[] = [];
  for (const r of corpo.records ?? []) {
    if (r?.type && r.type !== "NATURAL") continue; // empresa e estrangeiro não são o que se procura
    const nome = (r?.name ?? "").trim();
    if (!r?.id || !nome) continue;
    candidatos.push({
      id: String(r.id),
      nome,
      cpfMascarado: cpfMascaradoDe(r.taxId) ?? null,
      faixaEtaria: r.age ? String(r.age) : null,
      empresas: (r.membership ?? [])
        .filter((m) => m?.company?.name)
        .map((m) => ({
          nome: String(m.company!.name).trim(),
          capital: typeof m.company!.equity === "number" ? m.company!.equity : null,
          porte: m.company!.size?.text ?? null,
          qualificacao: m.role?.text ?? null,
        })),
    });
  }
  return { candidatos, proximo: corpo.next ? String(corpo.next) : null, total: typeof corpo.count === "number" ? corpo.count : null };
}

/**
 * Pesquisa pessoas físicas por nome ("maria silva": as palavras têm de estar no mesmo nome).
 * CUSTA créditos: quem chama mostra a estimativa antes e respeita o teto. A chave vai só no
 * cabeçalho `Authorization` e nunca é registrada.
 */
export async function buscarPessoasCnpja(
  p: { chave: string; nome: string; limite: number; token?: string | null },
  chamar: typeof fetch = fetch,
): Promise<PaginaDeCandidatos> {
  const q = new URLSearchParams();
  if (p.token) q.set("token", p.token); // o token da próxima página é exclusivo: vai sozinho
  else {
    q.set("name.in", p.nome.trim());
    q.set("type.in", "NATURAL");
    q.set("limit", String(Math.min(Math.max(Math.floor(p.limite), 1), 100)));
  }
  let res: Response;
  try {
    res = await chamar(`${CNPJA_URL}/person?${q.toString()}`, {
      headers: { accept: "application/json", Authorization: p.chave },
      signal: AbortSignal.timeout(CNPJA_TIMEOUT_MS),
    });
  } catch (e) {
    const tempo = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new FonteFalhou(tempo ? `tempo esgotado (${CNPJA_TIMEOUT_MS / 1000}s)` : "erro de rede");
  }
  if (res.status === 401 || res.status === 403) throw new FonteSemAcesso(res.status);
  if (res.status === 429) throw new FonteSemCredito();
  if (!res.ok) throw new FonteFalhou(`HTTP ${res.status}`);
  try {
    return candidatosDaResposta((await res.json()) as Parameters<typeof candidatosDaResposta>[0]);
  } catch {
    throw new FonteFalhou("resposta que não é JSON");
  }
}
