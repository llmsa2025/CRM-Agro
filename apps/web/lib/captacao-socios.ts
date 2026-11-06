/**
 * Regras PURAS da aba "Por sócios": o que a pessoa digita vira o pedido ao servidor (ou um aviso).
 * O servidor valida o CPF de verdade (dígitos verificadores) e o nome; aqui é só para avisar antes.
 */

export const MOTIVOS: readonly { valor: "cliente" | "indicacao" | "socio_de_empresa" | "pediu_contato" | "outro"; rotulo: string }[] = [
  { valor: "cliente", rotulo: "É cliente" },
  { valor: "indicacao", rotulo: "Foi indicado" },
  { valor: "socio_de_empresa", rotulo: "É sócio de uma empresa que já prospecto" },
  { valor: "pediu_contato", rotulo: "Pediu contato" },
  { valor: "outro", rotulo: "Outro motivo" },
];
export type Motivo = (typeof MOTIVOS)[number]["valor"];

/** "12345678901" → "123.456.789-01" enquanto digita (só formatação). */
export function formatarCpfDigitado(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 11);
  const partes = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9)].filter(Boolean).join(".");
  return d.length > 9 ? `${partes}-${d.slice(9)}` : partes;
}

/** Nome e sobrenome: pelo menos duas palavras com letras. */
export const temNomeESobrenome = (v: string): boolean => v.trim().split(/\s+/).filter((p) => /\p{L}/u.test(p)).length >= 2;

export type FormularioDeSocio = {
  nome: string;
  cpf: string;
  /** Sócio escolhido numa lista de sócios de empresa: a máscara substitui o CPF. */
  mascara: string | null;
  uf: string;
  cidade: string;
  motivo: Motivo | "";
  soAtivas: boolean;
  limite: string;
};

export const FORMULARIO_DE_SOCIO_VAZIO: FormularioDeSocio = {
  nome: "",
  cpf: "",
  mascara: null,
  uf: "",
  cidade: "",
  motivo: "",
  soAtivas: true,
  limite: "100",
};

export type PedidoDeSocio = {
  cpf?: string;
  mascara?: string;
  nome?: string;
  uf?: string;
  cidade?: string;
  motivo: Motivo;
  soAtivas: boolean;
  limite: number;
};

/** Formulário → pedido de busca de empresas por sócio, ou a frase que diz o que corrigir. */
export function montarPedidoDeSocio(f: FormularioDeSocio): { ok: true; pedido: PedidoDeSocio } | { ok: false; erro: string } {
  const cpfDigitos = f.cpf.replace(/\D/g, "");
  if (!f.mascara && !cpfDigitos) return { ok: false, erro: "Informe o CPF da pessoa, ou ache o sócio pela lista de sócios de uma empresa." };
  if (!f.mascara && cpfDigitos.length !== 11) return { ok: false, erro: "O CPF tem 11 dígitos." };
  if (f.nome.trim() && !temNomeESobrenome(f.nome)) return { ok: false, erro: "Informe nome e sobrenome." };
  if (f.cidade.trim() && !f.uf) return { ok: false, erro: "Escolha o estado da cidade." };
  if (!f.motivo) return { ok: false, erro: "Diga por que você busca esta pessoa." };
  const n = Number(f.limite.trim().replace(",", "."));
  const limite = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 500) : 100;
  return {
    ok: true,
    pedido: {
      ...(f.mascara ? { mascara: f.mascara } : { cpf: cpfDigitos }),
      ...(f.nome.trim() ? { nome: f.nome.trim() } : {}),
      ...(f.uf ? { uf: f.uf } : {}),
      ...(f.cidade.trim() ? { cidade: f.cidade.trim() } : {}),
      motivo: f.motivo,
      soAtivas: f.soAtivas,
      limite,
    },
  };
}

/** Texto da confiança de cada empresa achada, como a fila mostra. */
export function rotuloDaConfianca(c: "alta" | "media" | "baixa" | undefined): string | null {
  if (c === "alta") return "Mesmo nome e CPF";
  if (c === "media") return "Nome parecido e mesmo CPF";
  if (c === "baixa") return "Só o CPF bate (pode ser outra pessoa)";
  return null;
}
