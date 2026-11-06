import { normalizeCnpj } from "./normalize";
import { CnpjInvalid, CnpjNotFound, CnpjLookupFailed, OpenCnpjLimite } from "./errors";
import { cpfMascaradoDe, fmtPhone, pedir, type CnaeItem, type CnpjResult, type SocioItem } from "./fetch";

/**
 * OpenCNPJ (api.opencnpj.org): API gratuita, sem chave e sem cadastro, que publica
 * os dados abertos da Receita Federal (projeto sem fins lucrativos, licença MIT,
 * https://github.com/Hitmasu/opencnpj). Traz e-mail, telefones, sócios (CPF mascarado)
 * e CNAEs. NÃO traz inscrição estadual: por isso o resultado é `parcial` (o CNPJá
 * completa quando houver ficha).
 *
 * O e-mail é o que a empresa declarou à Receita e muitas vezes é o do contador:
 * quem usa deve tratá-lo como "do cadastro", não como e-mail do dono.
 * Limites não são publicados: o consultor do core usa ritmo baixo e para no 429.
 */

type OpenCnpjCnae = { codigo?: string | number; descricao?: string | null; is_principal?: boolean };
type OpenCnpjResposta = {
  razao_social?: string | null;
  nome_fantasia?: string | null;
  situacao_cadastral?: string | null;
  data_inicio_atividade?: string | null;
  cnae_principal?: string | number | null;
  cnaes?: OpenCnpjCnae[] | null;
  tipo_logradouro?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  bairro?: string | null;
  uf?: string | null;
  municipio?: string | null;
  email?: string | null;
  telefones?: { ddd?: string | null; numero?: string | null; is_fax?: boolean }[] | null;
  capital_social?: string | number | null;
  natureza_juridica?: string | null;
  porte_empresa?: string | null;
  QSA?: { nome_socio?: string | null; qualificacao_socio?: string | null; cnpj_cpf_socio?: string | null; faixa_etaria?: string | null }[] | null;
};

const texto = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};
const cnae7 = (v: unknown) => String(v ?? "").replace(/\D/g, "").padStart(7, "0");

/** "80000,00" ou "80000.00" ou 80000 → número. */
function capital(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  // "1.234.567,89" (pt-BR) ou "1234567.89"
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  return Number.isFinite(n) ? n : null;
}

/** Resposta da OpenCNPJ → o formato comum de consulta de CNPJ. Pura (testável sem rede). */
export function resultadoDoOpenCnpj(cnpj: string, d: OpenCnpjResposta): CnpjResult {
  const razao = texto(d.razao_social);
  const fantasia = texto(d.nome_fantasia);
  const socios: SocioItem[] = (d.QSA ?? [])
    .filter((q) => texto(q?.nome_socio))
    .map((q) => ({
      nome: String(q.nome_socio).trim(),
      qualificacao: texto(q?.qualificacao_socio),
      ...(cpfMascaradoDe(q?.cnpj_cpf_socio) ? { cpfMascarado: cpfMascaradoDe(q?.cnpj_cpf_socio) } : {}),
      ...(texto(q?.faixa_etaria) ? { faixaEtaria: texto(q?.faixa_etaria)! } : {}),
    }));
  const socio = socios[0]?.nome ?? null;
  const cnaes = d.cnaes ?? [];
  const principal = cnaes.find((c) => c?.is_principal) ?? null;
  const cnaePrincipal = d.cnae_principal != null ? cnae7(d.cnae_principal) : principal?.codigo != null ? cnae7(principal.codigo) : null;
  const cnaesSecundarios: CnaeItem[] = cnaes
    .filter((c) => c?.codigo != null && !c.is_principal)
    .map((c) => ({ codigo: cnae7(c.codigo), descricao: texto(c.descricao) }));
  const fone = (d.telefones ?? []).find((t) => !t?.is_fax && `${t?.ddd ?? ""}${t?.numero ?? ""}`.replace(/\D/g, "").length >= 8);
  const endereco = [
    [texto(d.tipo_logradouro), texto(d.logradouro)].filter(Boolean).join(" "),
    texto(d.numero),
    texto(d.bairro),
  ]
    .filter(Boolean)
    .join(", ");
  const email = texto(d.email);
  return {
    cnpj,
    razaoSocial: razao,
    nomeFantasia: fantasia,
    nomeSocio: socio,
    ie: null,
    nome: socio || fantasia || razao || cnpj,
    situacao: texto(d.situacao_cadastral),
    cnae: cnaePrincipal,
    cnaeDescricao: texto(principal?.descricao),
    cnaesSecundarios,
    ies: [],
    cidade: texto(d.municipio),
    uf: texto(d.uf),
    endereco: endereco || null,
    telefone: fone ? fmtPhone(`${fone.ddd ?? ""}${fone.numero ?? ""}`) : null,
    telefones: (d.telefones ?? [])
      .filter((t) => !t?.is_fax && `${t?.ddd ?? ""}${t?.numero ?? ""}`.replace(/\D/g, "").length >= 8)
      .map((t) => fmtPhone(`${t.ddd ?? ""}${t.numero ?? ""}`))
      .filter((t): t is string => Boolean(t)),
    email: email ? email.toLowerCase() : null,
    emails: email ? [{ valor: email.toLowerCase(), tipo: "desconhecido" as const }] : [],
    naturezaJuridica: texto(d.natureza_juridica),
    consultadoEm: new Date().toISOString(),
    dataAbertura: texto(d.data_inicio_atividade),
    fonte: "opencnpj",
    parcial: true,
    socios,
    porte: texto(d.porte_empresa),
    capitalSocial: capital(d.capital_social),
  };
}

/** Consulta um CNPJ na OpenCNPJ. 404 → `CnpjNotFound`; 429/5xx/rede → `CnpjLookupFailed`. */
export async function fetchViaOpenCnpj(input: string): Promise<CnpjResult> {
  const cnpj = normalizeCnpj(input);
  if (!cnpj) throw new CnpjInvalid(input);
  const res = await pedir(`https://api.opencnpj.org/${cnpj}`, cnpj);
  if (res.status === 404) throw new CnpjNotFound(cnpj);
  if (res.status === 429) throw new OpenCnpjLimite(cnpj);
  if (!res.ok) throw new CnpjLookupFailed(cnpj, `HTTP ${res.status}`);
  let corpo: OpenCnpjResposta;
  try {
    corpo = (await res.json()) as OpenCnpjResposta;
  } catch {
    throw new CnpjLookupFailed(cnpj, "a fonte respondeu algo que não é JSON");
  }
  return resultadoDoOpenCnpj(cnpj, corpo);
}
