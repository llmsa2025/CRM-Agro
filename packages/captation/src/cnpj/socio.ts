import type { RegistroMinhaReceita } from "./busca";

/**
 * Busca de empresas por SÓCIO. A Receita publica o CPF do sócio MASCARADO ("***456789**": só os 6
 * dígitos do meio). Uma máscara serve a cerca de mil pessoas diferentes, por isso toda busca por CPF
 * é conferida pelo NOME (e pela UF) antes de ligar uma empresa a uma pessoa, e cada resultado diz
 * com que confiança foi ligado.
 *
 * O CPF inteiro nunca sai daqui: só a máscara vai para a fonte, e nada é guardado.
 */

export const cpfDigitos = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

/** CPF com os dígitos verificadores corretos (11 dígitos, não todos iguais). */
export function cpfValido(v: string | null | undefined): boolean {
  const d = cpfDigitos(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (base: string, pesoInicial: number) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(d.slice(0, 9), 10) === Number(d[9]) && dv(d.slice(0, 10), 11) === Number(d[10]);
}

/** Máscara da Receita ("***456789**") a partir de um CPF completo. Null se não for um CPF de 11 dígitos. */
export function mascaraDeBusca(cpf: string): string | null {
  const d = cpfDigitos(cpf);
  return d.length === 11 ? `***${d.slice(3, 9)}**` : null;
}

export const mascaraValida = (m: string | null | undefined): boolean => /^\*{3}\d{6}\*{2}$/.test(m ?? "");

/** Como a tela mostra o CPF: "***.456.789-**" (aceita CPF completo ou a máscara da Receita). */
export function cpfParaExibir(v: string | null | undefined): string {
  const t = (v ?? "").trim();
  const m = mascaraValida(t) ? t : mascaraDeBusca(t);
  return m ? `***.${m.slice(3, 6)}.${m.slice(6, 9)}-**` : "";
}

const PARTICULAS = new Set(["de", "da", "do", "dos", "das", "e"]);

/** Nome em palavras minúsculas e sem acento; "de", "da", "do"… saem (variam de um cadastro para outro). */
export function palavrasDoNome(nome: string | null | undefined): string[] {
  return (nome ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((p) => p && !PARTICULAS.has(p));
}

/** "exato": as mesmas palavras. "parcial": tudo o que foi buscado está no nome do sócio, com o mesmo primeiro e o mesmo último nome. */
export type ComparacaoDeNome = "exato" | "parcial" | null;

export function compararNome(buscado: string | null | undefined, doSocio: string | null | undefined): ComparacaoDeNome {
  const a = palavrasDoNome(buscado);
  const b = palavrasDoNome(doSocio);
  if (a.length < 2 || b.length < 2) return null; // nome e sobrenome: uma palavra só não identifica ninguém
  if (a.length === b.length && a.every((p, i) => p === b[i])) return "exato";
  const contem = a.every((p) => b.includes(p));
  return contem && a[0] === b[0] && a[a.length - 1] === b[b.length - 1] ? "parcial" : null;
}

export type ConfiancaDoSocio = "alta" | "media" | "baixa";
export type AlvoDeSocio = { mascara: string; nome: string | null };
export type SocioAchado = { nome: string; qualificacao: string | null; confianca: ConfiancaDoSocio };

/**
 * O sócio procurado está neste registro? Máscara igual e, quando há nome, nome compatível.
 * Confiança: nome igual = alta; nome contido = média; só a máscara (sem nome) = baixa.
 */
export function socioDoRegistro(reg: Pick<RegistroMinhaReceita, "qsa">, alvo: AlvoDeSocio): SocioAchado | null {
  for (const q of reg.qsa ?? []) {
    if ((q?.cnpj_cpf_do_socio ?? "") !== alvo.mascara || !q?.nome_socio) continue;
    if (!alvo.nome?.trim()) return { nome: String(q.nome_socio).trim(), qualificacao: q.qualificacao_socio ?? null, confianca: "baixa" };
    const c = compararNome(alvo.nome, q.nome_socio);
    if (c) return { nome: String(q.nome_socio).trim(), qualificacao: q.qualificacao_socio ?? null, confianca: c === "exato" ? "alta" : "media" };
  }
  return null;
}
