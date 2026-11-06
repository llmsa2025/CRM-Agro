/**
 * Regras PURAS da aba "Por filtros" da captação por CNPJ: CNAEs sugeridos, leitura do que a
 * pessoa digita (CNAE, valor em reais) e a montagem do pedido para o servidor. Sem React, sem
 * rede. O servidor valida tudo de novo (`normalizarFiltros` do core); aqui é só para a tela
 * avisar antes e não mandar lixo.
 */

/** Teto de empresas por busca (o mesmo do lote de CNPJ no core). */
export const LIMITE_BUSCA_MAX = 500;
export const LIMITE_BUSCA_PADRAO = 100;

/** CNAEs do agro e do que gira em torno dele. Códigos e nomes conferidos na base da Receita (05/10/2026). */
export const CNAES_SUGERIDOS: readonly { codigo: string; nome: string }[] = [
  { codigo: "0115600", nome: "Cultivo de soja" },
  { codigo: "0111302", nome: "Cultivo de milho" },
  { codigo: "0112101", nome: "Cultivo de algodão herbáceo" },
  { codigo: "0113000", nome: "Cultivo de cana-de-açúcar" },
  { codigo: "0111301", nome: "Cultivo de arroz" },
  { codigo: "0111303", nome: "Cultivo de trigo" },
  { codigo: "0119905", nome: "Cultivo de feijão" },
  { codigo: "0134200", nome: "Cultivo de café" },
  { codigo: "0131800", nome: "Cultivo de laranja" },
  { codigo: "0121101", nome: "Horticultura, exceto morango" },
  { codigo: "0141501", nome: "Produção de sementes certificadas" },
  { codigo: "0151201", nome: "Criação de bovinos para corte" },
  { codigo: "0151202", nome: "Criação de bovinos para leite" },
  { codigo: "0154700", nome: "Criação de suínos" },
  { codigo: "0155501", nome: "Criação de frangos para corte" },
  { codigo: "0210101", nome: "Cultivo de eucalipto" },
  { codigo: "0161003", nome: "Preparação de terreno, cultivo e colheita (serviço)" },
  { codigo: "0161001", nome: "Pulverização e controle de pragas agrícolas (serviço)" },
  { codigo: "0163600", nome: "Atividades de pós-colheita" },
  { codigo: "4683400", nome: "Atacado de defensivos, adubos e fertilizantes" },
  { codigo: "4661300", nome: "Atacado de máquinas e equipamentos agropecuários" },
  { codigo: "4622200", nome: "Atacado de soja" },
  { codigo: "4632001", nome: "Atacado de cereais e leguminosas beneficiados" },
];

export const UFS_BR = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI",
  "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
] as const;

export const PORTES_BUSCA: readonly { valor: "micro" | "pequeno" | "demais"; rotulo: string }[] = [
  { valor: "micro", rotulo: "Micro" },
  { valor: "pequeno", rotulo: "Pequeno" },
  { valor: "demais", rotulo: "Médio ou grande" },
];

/** "0115-6/00", "0115600" ou "115600" → "0115600". Null se não for um CNAE. */
export function cnaeNormalizado(v: string): string | null {
  const d = v.replace(/\D/g, "");
  if (!d || d.length > 7) return null;
  const c = d.padStart(7, "0");
  return c === "0000000" ? null : c;
}

/** "0115600" → "0115-6/00" (como a pessoa lê). */
export function cnaeFormatado(codigo: string): string {
  return codigo.length === 7 ? `${codigo.slice(0, 4)}-${codigo[4]}/${codigo.slice(5)}` : codigo;
}

/** Texto com vários CNAEs (vírgula, espaço, ponto e vírgula, quebra de linha) → códigos únicos e o que não deu para ler. */
export function lerCnaes(texto: string): { codigos: string[]; invalidos: string[] } {
  const codigos: string[] = [];
  const invalidos: string[] = [];
  for (const parte of texto.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)) {
    const c = cnaeNormalizado(parte);
    if (!c) invalidos.push(parte);
    else if (!codigos.includes(c)) codigos.push(c);
  }
  return { codigos, invalidos };
}

/** Valor em reais ("1.500.000,50", "R$ 1500000"). Vazio → null. Texto que não é número → "invalido". */
export function lerValorEmReais(texto: string): number | null | "invalido" {
  const t = texto.replace(/R\$/gi, "").trim();
  if (!t) return null;
  if (!/^[\d.,\s]+$/.test(t)) return "invalido";
  const limpo = t.replace(/\s/g, "");
  // pt-BR: ponto separa milhar, vírgula separa centavos. Sem vírgula, só ponto de milhar ("1.500.000").
  const n = limpo.includes(",") ? Number(limpo.replace(/\./g, "").replace(",", ".")) : Number(limpo.replace(/\./g, ""));
  return Number.isFinite(n) && n >= 0 ? n : "invalido";
}

/** Texto do campo "quantas empresas": 1 a 500; vazio ou inválido volta ao padrão. */
export function limiteDaBusca(valor: string | number): number {
  const n = typeof valor === "number" ? valor : Number(String(valor).trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 1) return LIMITE_BUSCA_PADRAO;
  return Math.min(Math.floor(n), LIMITE_BUSCA_MAX);
}

/** Quantas cidades a busca aceita de uma vez (o mesmo teto do servidor). */
export const CIDADES_BUSCA_MAX = 20;

/** Sem acento e em minúsculas, para comparar texto digitado (busca de CNAE e de cidade). */
export function semAcento(t: string): string {
  return t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Filtra a lista de CNAEs pelo que a pessoa digitou: por código (só os dígitos, "0115", "0115-6/00") ou por
 * texto (todas as palavras, sem acento e em qualquer caixa). Vazio devolve o começo da lista. `max` limita o
 * que a tela desenha.
 */
export function filtrarCnaes<T extends readonly [string, string]>(lista: readonly T[], termo: string, max = 80): { itens: T[]; total: number } {
  const t = termo.trim();
  let achados: readonly T[];
  if (!t) achados = lista;
  else if (/^[\d\s./-]+$/.test(t)) {
    const d = t.replace(/\D/g, "");
    achados = lista.filter(([codigo]) => codigo.startsWith(d) || codigo.includes(d));
  } else {
    const palavras = semAcento(t).split(/\s+/).filter(Boolean);
    achados = lista.filter(([, nome]) => {
      const n = semAcento(nome);
      return palavras.every((p) => n.includes(p));
    });
  }
  return { itens: achados.slice(0, max) as T[], total: achados.length };
}

/** A palavra do domínio tem algo além de espaço, vírgula e @? (o servidor limpa de novo.) */
export const temPalavraDeDominio = (texto: string) => /[^\s,;@]/.test(texto);

/** O filtro "e-mail com a palavra depois do @" vale? Só com a caixa marcada E com palavra. */
export const dominioAtivo = (f: Pick<FormularioDeFiltros, "emailDominioAtivo" | "emailDominio">) => f.emailDominioAtivo && temPalavraDeDominio(f.emailDominio);

export type FormularioDeFiltros = {
  cnaesTexto: string;
  uf: string;
  cidades: string[];
  portes: ("micro" | "pequeno" | "demais")[];
  capitalMin: string;
  capitalMax: string;
  abertaDesde: string;
  abertaAte: string;
  soAtivas: boolean;
  excluirPessoa: boolean;
  soComTelefone: boolean;
  completarContato: boolean;
  checarWhatsApp: boolean;
  incluirJaCadastradas: boolean;
  cnaeSecundario: boolean;
  ignorarEmailContabilidade: boolean;
  soComEmail: boolean;
  emailDominioAtivo: boolean;
  emailDominio: string;
  limite: string;
};

export const FORMULARIO_VAZIO: FormularioDeFiltros = {
  cnaesTexto: "",
  uf: "",
  cidades: [],
  portes: [],
  capitalMin: "",
  capitalMax: "",
  abertaDesde: "",
  abertaAte: "",
  soAtivas: true,
  excluirPessoa: true,
  soComTelefone: false,
  completarContato: false,
  checarWhatsApp: false,
  incluirJaCadastradas: false,
  cnaeSecundario: false,
  ignorarEmailContabilidade: true,
  soComEmail: false,
  emailDominioAtivo: false,
  emailDominio: "",
  limite: String(LIMITE_BUSCA_PADRAO),
};

export type PedidoDeFiltros = {
  cnaes: string[];
  ufs: string[];
  cidades: string[];
  portes: ("micro" | "pequeno" | "demais")[];
  capitalMin: number | null;
  capitalMax: number | null;
  abertaDesde: string | null;
  abertaAte: string | null;
  soAtivas: boolean;
  excluirPessoa: boolean;
  soComTelefone: boolean;
  completarContato: boolean;
  checarWhatsApp: boolean;
  incluirJaCadastradas: boolean;
  cnaeSecundario: boolean;
  ignorarEmailContabilidade: boolean;
  soComEmail: boolean;
  emailDominioAtivo: boolean;
  emailDominio: string;
  limite: number;
};

/** Formulário → pedido ao servidor, ou a frase que diz o que corrigir. */
export function montarPedido(f: FormularioDeFiltros): { ok: true; pedido: PedidoDeFiltros } | { ok: false; erro: string } {
  const { codigos, invalidos } = lerCnaes(f.cnaesTexto);
  if (invalidos.length) return { ok: false, erro: `CNAE inválido: ${invalidos.slice(0, 3).join(", ")}. Use os 7 dígitos, como 0115-6/00.` };
  const cidades = [...new Set(f.cidades.map((c) => c.trim()).filter(Boolean))];
  if (cidades.length && !f.uf) return { ok: false, erro: "Escolha o estado das cidades." };
  if (cidades.length > CIDADES_BUSCA_MAX) return { ok: false, erro: `Escolha no máximo ${CIDADES_BUSCA_MAX} cidades por busca.` };
  if (!codigos.length && !f.uf) return { ok: false, erro: "Escolha ao menos um CNAE ou um estado." };
  const min = lerValorEmReais(f.capitalMin);
  const max = lerValorEmReais(f.capitalMax);
  if (min === "invalido" || max === "invalido") return { ok: false, erro: "O capital social deve ser um valor em reais, como 500.000." };
  if (min !== null && max !== null && min > max) return { ok: false, erro: "O capital mínimo é maior que o máximo." };
  if (f.abertaDesde && f.abertaAte && f.abertaDesde > f.abertaAte) return { ok: false, erro: "A data inicial é depois da final." };
  return {
    ok: true,
    pedido: {
      cnaes: codigos,
      ufs: f.uf ? [f.uf] : [],
      cidades,
      portes: f.portes,
      capitalMin: min,
      capitalMax: max,
      abertaDesde: f.abertaDesde || null,
      abertaAte: f.abertaAte || null,
      soAtivas: f.soAtivas,
      excluirPessoa: f.excluirPessoa,
      soComTelefone: f.soComTelefone,
      // Filtro de e-mail exige consultar cada empresa (a fonte da busca não traz e-mail).
      completarContato: f.completarContato || f.soComEmail || dominioAtivo(f),
      checarWhatsApp: f.checarWhatsApp,
      incluirJaCadastradas: f.incluirJaCadastradas,
      cnaeSecundario: f.cnaeSecundario,
      ignorarEmailContabilidade: f.ignorarEmailContabilidade,
      // A palavra do domínio implica "só com e-mail". Caixa desmarcada ou campo vazio: nada de filtro.
      soComEmail: f.soComEmail || dominioAtivo(f),
      emailDominioAtivo: dominioAtivo(f),
      emailDominio: dominioAtivo(f) ? f.emailDominio.trim() : "",
      limite: limiteDaBusca(f.limite),
    },
  };
}
