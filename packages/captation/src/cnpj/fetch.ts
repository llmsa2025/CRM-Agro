import { normalizeCnpj } from "./normalize";
import { CnpjInvalid, CnpjNotFound, CnpjLookupFailed, CnpjaLimite } from "./errors";

/** Um CNAE (código + descrição). Código no formato só-dígitos (ex.: "0115600"). */
export type CnaeItem = { codigo: string; descricao: string | null };

/**
 * Uma inscrição estadual (IE) com metadados. O `tipo` é o sinal MAIS FORTE para
 * identificar produtor rural (IE de "produtor rural" atrelada ao imóvel) — antes
 * era descartado §0/§2.
 */
export type IeItem = {
  numero: string;
  tipo: string | null; // ex.: "IE Normal", "Produtor Rural" (quando a fonte expõe)
  uf: string | null;
  habilitada: boolean;
};

/**
 * Um sócio do QSA (quadro de sócios e administradores). `cpfMascarado` é o CPF como a Receita
 * publica ("***456789**": só os 6 dígitos do meio; uma máscara serve a cerca de mil pessoas) e
 * só aparece quando a fonte o traz. CNPJ de sócio pessoa jurídica não entra aqui.
 */
export type SocioItem = { nome: string; qualificacao: string | null; cpfMascarado?: string; faixaEtaria?: string };

/** Máscara de CPF da Receita ("***456789**"). Qualquer outra coisa (CNPJ de sócio, vazio) volta undefined. */
export function cpfMascaradoDe(v: unknown): string | undefined {
  const t = typeof v === "string" ? v.trim() : "";
  return /^\*{3}\d{6}\*{2}$/.test(t) ? t : undefined;
}

/**
 * De onde veio o dado: CNPJá (rico: e-mail, telefone, sócio, IEs), OpenCNPJ (e-mail, telefone e sócios,
 * sem IEs), BrasilAPI (só Receita) ou Minha Receita (busca por filtro: telefone e sócios, sem e-mail).
 */
export type FonteCnpj = "cnpja" | "opencnpj" | "brasilapi" | "minhareceita";

/** Dados normalizados de uma empresa consultada por CNPJ (para virar ProspectDraft). */
export type CnpjResult = {
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  nome: string; // melhor nome disponível (sócio > fantasia > razão)
  nomeSocio: string | null;
  ie: string | null; // inscrição estadual (1ª habilitada) — compat legado
  situacao: string | null;
  cnae: string | null;
  cnaeDescricao: string | null;
  // NÃO descartar mais o sinal do agro (doc de produtor §0): CNAEs secundários e
  // a lista completa de IEs com tipo/uf/habilitada alimentam o classificador.
  cnaesSecundarios: CnaeItem[];
  ies: IeItem[];
  cidade: string | null;
  uf: string | null;
  endereco: string | null;
  telefone: string | null;
  email: string | null;
  dataAbertura: string | null;
  // Item 3.2 (INT-13): origem marcada no rascunho. `parcial` = veio só da
  // BrasilAPI (geralmente sem e-mail/sócio) — o CNPJá completa depois.
  fonte: FonteCnpj;
  parcial: boolean;
  socios: SocioItem[];
  porte: string | null;
  capitalSocial: number | null;
  /** Natureza jurídica por extenso ("Sociedade Empresária Limitada"), quando a fonte traz. */
  naturezaJuridica?: string | null;
  /** Todos os telefones da empresa na fonte, formatados (o 1º é `telefone`). */
  telefones?: string[];
  /**
   * Todos os e-mails da empresa na fonte. `tipo`: "empresa" (da própria empresa), "contador" (do escritório
   * de contabilidade, comum no cadastro da Receita) ou "pessoal"; "desconhecido" quando a fonte não diz.
   */
  emails?: { valor: string; tipo: "empresa" | "contador" | "pessoal" | "desconhecido" }[];
  /** Quando a fonte foi consultada (ISO). O cache guarda: mostra a idade real do dado. */
  consultadoEm?: string;
};

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export function fmtPhone(digits: string): string | null {
  const d = digits.replace(/\D/g, "");
  if (d.length < 10) return d || null;
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  return rest.length === 9 ? `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}` : `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
}

/** Formato (parcial) da resposta da CNPJá Open API — só o que lemos. */
type CnpjaAtividade = { id?: number | string; text?: string };
type CnpjaRegistro = { number?: string | number; enabled?: boolean; type?: { text?: string } | string; state?: string };
type CnpjaResposta = {
  company?: {
    name?: string;
    nature?: { text?: string };
    equity?: number;
    size?: { text?: string; acronym?: string };
    members?: { person?: { name?: string; taxId?: string; age?: string }; role?: { text?: string } }[];
  };
  alias?: string;
  address?: { street?: string; number?: string; district?: string; details?: string; city?: string; state?: string };
  phones?: { area?: string; number?: string }[];
  emails?: { address?: string; ownership?: string }[];
  registrations?: CnpjaRegistro[];
  sideActivities?: CnpjaAtividade[];
  status?: { text?: string };
  mainActivity?: CnpjaAtividade;
  founded?: string;
};

/** Itens (parciais) de listas da BrasilAPI. */
type BrasilApiIe = { ativo?: boolean; inscricao_estadual?: string | number; tipo?: string; estado?: string; uf?: string };
type BrasilApiCnae = { codigo?: number | string; descricao?: string };
type BrasilApiSocio = { nome_socio?: string; qualificacao_socio?: string; cnpj_cpf_do_socio?: string; faixa_etaria?: string };

/** Teto de cada consulta (INT-13/INT-15): fonte lenta não segura o lote. */
export const CNPJ_TIMEOUT_MS = 10_000;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET com teto de 10 s (item 3.1) e UMA nova tentativa, com espera, quando a
 * fonte devolve 5xx (instabilidade passageira; item 3.2). 404/429/4xx voltam na
 * hora para quem chamou decidir; tempo esgotado e erro de rede viram
 * `CnpjLookupFailed` com a causa.
 */
export async function pedir(url: string, cnpj: string): Promise<Response> {
  for (let tentativa = 1; ; tentativa++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": UA },
        signal: AbortSignal.timeout(CNPJ_TIMEOUT_MS),
      });
    } catch (e) {
      const tempo = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new CnpjLookupFailed(cnpj, tempo ? `tempo esgotado (${CNPJ_TIMEOUT_MS / 1000}s)` : `erro de rede: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status >= 500 && tentativa === 1) {
      await esperar(1_000 + Math.random() * 500);
      continue;
    }
    return res;
  }
}

/**
 * CNPJá Open API — mais rica (e-mail, telefone, sócios). Grátis, 5/min POR IP.
 * Quem chama deve passar pelo balde global do core (`consultarCnpj`): chamar
 * direto gasta o limite de todos os times.
 */
export async function fetchViaCnpja(input: string): Promise<CnpjResult> {
  const cnpj = normalizeCnpj(input);
  if (!cnpj) throw new CnpjInvalid(input);
  const res = await pedir(`https://open.cnpja.com/office/${cnpj}`, cnpj);
  if (res.status === 404) throw new CnpjNotFound(cnpj);
  if (res.status === 429) throw new CnpjaLimite(cnpj);
  if (!res.ok) throw new CnpjLookupFailed(cnpj, `HTTP ${res.status}`);
  const d = (await res.json()) as CnpjaResposta;

  const razao = d?.company?.name ?? null;
  const fantasia = d?.alias ?? null;
  const socio = d?.company?.members?.[0]?.person?.name ?? null;
  const addr: NonNullable<CnpjaResposta["address"]> = d?.address ?? {};
  const enderecoParts = [
    [addr.street, addr.number].filter(Boolean).join(", "),
    addr.district,
    addr.details,
  ].filter(Boolean);
  const ph = d?.phones?.[0];
  const tipoDoEmail = (o?: string): "empresa" | "contador" | "pessoal" | "desconhecido" =>
    o === "CORPORATE" ? "empresa" : o === "ACCOUNTING" ? "contador" : o === "PERSONAL" ? "pessoal" : "desconhecido";
  const emailsDaFonte = (d?.emails ?? [])
    .filter((e) => e?.address)
    .map((e) => ({ valor: String(e.address).trim().toLowerCase(), tipo: tipoDoEmail(e.ownership) }));
  // O 1º e-mail da lista era o único guardado; agora o da PRÓPRIA empresa vem antes do do contador.
  const emailPrincipal =
    emailsDaFonte.find((e) => e.tipo === "empresa") ?? emailsDaFonte.find((e) => e.tipo !== "contador") ?? emailsDaFonte[0] ?? null;
  const email = emailPrincipal?.valor ?? null;
  const regs = Array.isArray(d?.registrations) ? d.registrations : [];
  const ieReg = regs.find((r) => r?.enabled && r?.number) ?? regs.find((r) => r?.number);
  // Todas as IEs com tipo/uf/habilitada (antes só a 1ª habilitada era guardada).
  const ies: IeItem[] = regs
    .filter((r) => r?.number)
    .map((r) => ({
      numero: String(r.number),
      tipo: typeof r.type === "string" ? r.type : (r.type?.text ?? null),
      uf: r?.state ?? null,
      habilitada: Boolean(r?.enabled),
    }));
  // CNAEs secundários (antes descartados) — código só-dígitos + descrição.
  const sides = Array.isArray(d?.sideActivities) ? d.sideActivities : [];
  const cnaesSecundarios: CnaeItem[] = sides
    .filter((a) => a?.id != null)
    .map((a) => ({ codigo: String(a.id).replace(/\D/g, ""), descricao: a?.text ?? null }));
  const socios: SocioItem[] = (d?.company?.members ?? [])
    .filter((m) => m?.person?.name)
    .map((m) => ({
      nome: String(m.person!.name),
      qualificacao: m?.role?.text ?? null,
      ...(cpfMascaradoDe(m.person?.taxId) ? { cpfMascarado: cpfMascaradoDe(m.person?.taxId) } : {}),
      ...(m.person?.age ? { faixaEtaria: String(m.person.age) } : {}),
    }));

  return {
    cnpj,
    razaoSocial: razao,
    nomeFantasia: fantasia,
    nomeSocio: socio,
    ie: ieReg?.number ? String(ieReg.number) : null,
    nome: socio || fantasia || razao || cnpj,
    situacao: d?.status?.text ?? null,
    cnae: d?.mainActivity?.id ? String(d.mainActivity.id) : null,
    cnaeDescricao: d?.mainActivity?.text ?? null,
    cnaesSecundarios,
    ies,
    cidade: addr.city ?? null,
    uf: addr.state ?? null,
    endereco: enderecoParts.length ? enderecoParts.join(" - ") : null,
    telefone: ph ? fmtPhone(`${ph.area ?? ""}${ph.number ?? ""}`) : null,
    telefones: (d?.phones ?? [])
      .map((t) => fmtPhone(`${t?.area ?? ""}${t?.number ?? ""}`))
      .filter((t): t is string => Boolean(t)),
    email: email ? String(email).toLowerCase() : null,
    emails: emailsDaFonte,
    naturezaJuridica: d?.company?.nature?.text ?? null,
    consultadoEm: new Date().toISOString(),
    dataAbertura: d?.founded ?? null,
    fonte: "cnpja",
    parcial: false,
    socios,
    porte: d?.company?.size?.text ?? d?.company?.size?.acronym ?? null,
    capitalSocial: typeof d?.company?.equity === "number" ? d.company.equity : null,
  };
}

/** BrasilAPI (fallback) — só Receita, geralmente sem e-mail/sócio. */
export async function fetchViaBrasilApi(input: string): Promise<CnpjResult> {
  const cnpj = normalizeCnpj(input);
  if (!cnpj) throw new CnpjInvalid(input);
  const res = await pedir(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, cnpj);
  if (res.status === 404) throw new CnpjNotFound(cnpj);
  if (!res.ok) throw new CnpjLookupFailed(cnpj, `HTTP ${res.status}`);
  const raw = (await res.json()) as Record<string, unknown>;
  const s = (k: string) => {
    const v = raw[k];
    return v === null || v === undefined || v === "" ? undefined : String(v);
  };
  const razao = s("razao_social") ?? s("nome_empresarial") ?? null;
  const fantasia = s("nome_fantasia") ?? null;
  const iesRaw = raw["inscricoes_estaduais"];
  const iesArr: BrasilApiIe[] = Array.isArray(iesRaw) ? iesRaw : [];
  const ie =
    iesArr.length
      ? String(
          (iesArr.find((x) => x?.ativo && x?.inscricao_estadual) ?? iesArr[0])?.inscricao_estadual ?? "",
        ).trim() || null
      : null;
  // Lista completa de IEs (BrasilAPI raramente expõe o TIPO — fica null; o sinal
  // forte de IE-produtor depende do CNPJá).
  const ies: IeItem[] = iesArr
    .filter((x) => x?.inscricao_estadual)
    .map((x) => ({
      numero: String(x.inscricao_estadual).trim(),
      tipo: x?.tipo ?? null,
      uf: x?.estado ?? x?.uf ?? null,
      habilitada: Boolean(x?.ativo),
    }));
  // CNAEs secundários da BrasilAPI (campo `cnaes_secundarios: [{codigo, descricao}]`).
  const sidesRaw = raw["cnaes_secundarios"];
  const cnaesSecundarios: CnaeItem[] = Array.isArray(sidesRaw)
    ? (sidesRaw as BrasilApiCnae[])
        .filter((c) => c?.codigo != null)
        .map((c) => ({ codigo: String(c.codigo).replace(/\D/g, ""), descricao: c?.descricao ?? null }))
    : [];
  const qsaRaw = raw["qsa"];
  const socios: SocioItem[] = Array.isArray(qsaRaw)
    ? (qsaRaw as BrasilApiSocio[])
        .filter((q) => q?.nome_socio)
        .map((q) => ({
          nome: String(q.nome_socio),
          qualificacao: q?.qualificacao_socio ?? null,
          ...(cpfMascaradoDe(q?.cnpj_cpf_do_socio) ? { cpfMascarado: cpfMascaradoDe(q?.cnpj_cpf_do_socio) } : {}),
          ...(q?.faixa_etaria ? { faixaEtaria: String(q.faixa_etaria) } : {}),
        }))
    : [];
  const capital = Number(raw["capital_social"]);
  const enderecoParts = [
    [s("tipo_logradouro"), s("logradouro")].filter(Boolean).join(" "),
    s("numero"),
    s("bairro"),
  ].filter(Boolean);
  return {
    cnpj,
    razaoSocial: razao,
    nomeFantasia: fantasia,
    nomeSocio: null,
    ie,
    nome: fantasia || razao || cnpj,
    situacao: s("descricao_situacao_cadastral") ?? s("situacao_cadastral") ?? null,
    cnae: s("cnae_fiscal") ?? null,
    cnaeDescricao: s("cnae_fiscal_descricao") ?? null,
    cnaesSecundarios,
    ies,
    cidade: s("municipio") ?? null,
    uf: s("uf") ?? null,
    endereco: enderecoParts.length ? enderecoParts.join(", ") : null,
    telefone: s("ddd_telefone_1") ? fmtPhone(s("ddd_telefone_1")!) : s("ddd_telefone_2") ? fmtPhone(s("ddd_telefone_2")!) : null,
    telefones: [s("ddd_telefone_1"), s("ddd_telefone_2")].filter((t): t is string => Boolean(t)).map((t) => fmtPhone(t)).filter((t): t is string => Boolean(t)),
    email: s("email") ? s("email")!.toLowerCase() : null,
    emails: s("email") ? [{ valor: s("email")!.toLowerCase(), tipo: "desconhecido" as const }] : [],
    naturezaJuridica: s("natureza_juridica") ?? null,
    consultadoEm: new Date().toISOString(),
    dataAbertura: s("data_inicio_atividade") ?? null,
    fonte: "brasilapi",
    parcial: true,
    socios,
    porte: s("porte") ?? s("descricao_porte") ?? null,
    capitalSocial: raw["capital_social"] != null && Number.isFinite(capital) ? capital : null,
  };
}

/**
 * Consulta um CNPJ: CNPJá (rico) primeiro; se falhar/limite, BrasilAPI.
 * Sem cache nem balde: no app use `consultarCnpj` do core (item 3.2, INT-13).
 */
export async function fetchCnpj(input: string): Promise<CnpjResult> {
  const cnpj = normalizeCnpj(input);
  if (!cnpj) throw new CnpjInvalid(input);
  try {
    return await fetchViaCnpja(cnpj);
  } catch (e) {
    if (e instanceof CnpjNotFound) throw e;
    // 429/erro do CNPJá → tenta a BrasilAPI.
    return await fetchViaBrasilApi(cnpj);
  }
}
