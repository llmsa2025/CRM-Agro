/**
 * Lê `Company.enrichment` (JSON livre no banco) para a ficha: a fonte e a data de cada campo preenchido pelo
 * Enriquecer, os dados públicos da Receita e os sócios. Defensivo: JSON de outra forma (ou de outra versão)
 * nunca derruba a tela, só some da ficha.
 */

type Origem = { fonteRotulo: string; consultadoEm: string };

export type ProvenienciaDaEmpresa = {
  proveniencia: Record<string, Origem>;
  dadosPublicos: { rotulo: string; valor: string; fonteRotulo: string; consultadoEm: string }[];
  socios: { nome: string; qualificacao: string | null; cpfExibicao: string | null }[];
  /** Situação cadastral na Receita, quando o CRM Agro já consultou. Null = ainda não se sabe. */
  situacao: { ativa: boolean; descricao: string | null; consultadoEm: string } | null;
};

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function proveniencia(enrichment: unknown): ProvenienciaDaEmpresa {
  const vazio: ProvenienciaDaEmpresa = { proveniencia: {}, dadosPublicos: [], socios: [], situacao: null };
  if (!enrichment || typeof enrichment !== "object") return vazio;
  const e = enrichment as Record<string, unknown>;
  const out: ProvenienciaDaEmpresa = { proveniencia: {}, dadosPublicos: [], socios: [], situacao: null };

  if (e.campos && typeof e.campos === "object") {
    for (const [campo, v] of Object.entries(e.campos as Record<string, unknown>)) {
      const o = v as Record<string, unknown> | null;
      const fonteRotulo = texto(o?.fonteRotulo);
      const consultadoEm = texto(o?.consultadoEm);
      if (fonteRotulo && consultadoEm) out.proveniencia[campo] = { fonteRotulo, consultadoEm };
    }
  }
  if (Array.isArray(e.publico)) {
    for (const d of e.publico as Record<string, unknown>[]) {
      const rotulo = texto(d?.rotulo);
      const valor = texto(d?.valor);
      const fonteRotulo = texto(d?.fonteRotulo);
      const consultadoEm = texto(d?.consultadoEm);
      if (rotulo && valor && fonteRotulo && consultadoEm) out.dadosPublicos.push({ rotulo, valor, fonteRotulo, consultadoEm });
    }
  }
  if (Array.isArray(e.socios)) {
    for (const s of e.socios as Record<string, unknown>[]) {
      const nome = texto(s?.nome);
      if (nome) out.socios.push({ nome, qualificacao: texto(s?.qualificacao), cpfExibicao: texto(s?.cpfExibicao) });
    }
  }
  const s = e.situacao as Record<string, unknown> | null | undefined;
  if (s && typeof s === "object" && typeof s.ativa === "boolean") {
    out.situacao = { ativa: s.ativa, descricao: texto(s.descricao), consultadoEm: texto(s.consultadoEm) ?? "" };
  } else {
    // Empresa enriquecida antes: a situação está nos dados públicos da Receita.
    const d = out.dadosPublicos.find((x) => x.rotulo === "Situação cadastral");
    if (d) out.situacao = { ativa: /^ativa$/i.test(d.valor.trim()), descricao: d.valor, consultadoEm: d.consultadoEm };
  }
  return out;
}
