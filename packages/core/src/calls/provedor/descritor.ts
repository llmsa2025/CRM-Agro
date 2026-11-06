import { z } from "zod";
import type { Ambiente } from "./comum";
import { mascararSegredo } from "./comum";
import { MODOS_DE_WEBHOOK_DE_LIGACAO, type ChaveDeProvedorDeLigacao, ChaveDeProvedorDeLigacaoSchema, type ModoDeWebhookDeLigacao } from "./capacidades";

/**
 * O DESCRITOR DECLARATIVO de cada provedor de ligação.
 * A tela de conexão não sabe nada de provedor: lê o descritor e
 * desenha o formulário. É só DADO, mais um schema zod por campo.
 *
 * Cada campo tem um `escopo`.
 * - `conta`: vale para a empresa toda no provedor (domínio, token da conta);
 * - `linha`: vale para uma linha, ou seja, um vendedor (ramal, senha do ramal).
 * As credenciais da conta moram na `Integration`; as da linha, na própria linha. O contexto de cada chamada
 * junta as duas (`ContextoDaLigacao`).
 *
 * Segredo nunca volta à tela depois de salvo: o que sobe é só `{ preenchido, ultimos4 }`.
 */

export const ESCOPOS_DE_CAMPO_DE_LIGACAO = ["conta", "linha"] as const;
export type EscopoDeCampoDeLigacao = (typeof ESCOPOS_DE_CAMPO_DE_LIGACAO)[number];

export type CampoDoDescritorDeLigacao = {
  /** Nome técnico do campo (`dominio`). */
  chave: string;
  rotulo: string;
  /** Uma frase: onde achar o valor no painel do provedor. */
  ajuda: string;
  escopo: EscopoDeCampoDeLigacao;
  obrigatorio: boolean;
  /** Decide a máscara (mostra só os 4 últimos) e a cifra em repouso. */
  secreto: boolean;
  /** Validação no servidor. Nunca só no navegador. */
  schema: z.ZodTypeAny;
  /** Prefixos que a chave de cada ambiente costuma ter. Chave que não começa por um deles é recusada. */
  prefixoPorAmbiente?: Partial<Record<Ambiente, readonly string[]>>;
};

export type SegredoDoWebhookDoDescritorDeLigacao = {
  rotulo: string;
  ajuda: string;
  obrigatorio: boolean;
  schema: z.ZodTypeAny;
};

export type DescritorDeLigacao = {
  chave: ChaveDeProvedorDeLigacao;
  nome: string;
  ambientes: readonly Ambiente[];
  campos: readonly CampoDoDescritorDeLigacao[];
  /** Tem rotação própria (janela com os dois valores), por isso fica à parte dos campos. */
  segredoDoWebhook: SegredoDoWebhookDoDescritorDeLigacao | null;
  webhook: {
    modo: ModoDeWebhookDeLigacao;
    /** O que o dono faz no painel do provedor, em uma ou duas frases. */
    instrucao: string;
    eventosNecessarios: readonly string[];
  };
  /** O que o botão "Testar conexão" faz (deve ser só leitura). */
  testeDeConexao: string;
  avisosDeSetup: readonly string[];
  urlDaDocumentacao: string;
};

// ---------------------------------------------------------------------------------------------------
// Conferência do próprio descritor (roda no registro e nos testes)
// ---------------------------------------------------------------------------------------------------

/** Travessão, meia-risca e " - " como separador: proibidos nos textos da interface (AGENTS.md (texto da interface)). */
const TEXTO_FORA_DO_PADRAO = /[—–]|\s-\s/;

const AMBIENTES_CONHECIDOS: readonly Ambiente[] = ["teste", "producao"];

/** Problemas do descritor (lista vazia = ok), em português, sem valores. */
export function problemasDoDescritorDeLigacao(d: DescritorDeLigacao): string[] {
  const p: string[] = [];
  if (!ChaveDeProvedorDeLigacaoSchema.safeParse(d.chave).success) p.push("A chave do provedor tem formato inválido.");
  if (d.nome.trim().length === 0) p.push("O provedor precisa de um nome.");
  if (d.ambientes.length === 0) p.push("Declare ao menos um ambiente.");
  if (new Set(d.ambientes).size !== d.ambientes.length) p.push("Ambientes repetidos.");
  for (const a of d.ambientes) if (!AMBIENTES_CONHECIDOS.includes(a)) p.push("Ambiente desconhecido.");
  if (!(MODOS_DE_WEBHOOK_DE_LIGACAO as readonly string[]).includes(d.webhook.modo)) p.push("Modo de webhook desconhecido.");
  if (d.webhook.instrucao.trim().length === 0) p.push("Falta a instrução do webhook.");
  if (d.testeDeConexao.trim().length === 0) p.push("Descreva o que o teste de conexão faz.");
  if (!/^https:\/\//.test(d.urlDaDocumentacao)) p.push("A documentação precisa de um endereço https.");

  const chaves = new Set<string>();
  for (const c of d.campos) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(c.chave)) p.push("Há campo com chave de formato inválido.");
    if (chaves.has(c.chave)) p.push("Há campos com a mesma chave.");
    chaves.add(c.chave);
    if (c.rotulo.trim().length === 0 || c.ajuda.trim().length === 0) p.push("Todo campo precisa de rótulo e ajuda.");
    if (!(ESCOPOS_DE_CAMPO_DE_LIGACAO as readonly string[]).includes(c.escopo)) p.push("Há campo com escopo desconhecido.");
    for (const a of Object.keys(c.prefixoPorAmbiente ?? {})) {
      if (!d.ambientes.includes(a as Ambiente)) p.push("Prefixo declarado para um ambiente que o provedor não tem.");
    }
  }

  // Os textos que o usuário lê seguem o padrão da interface.
  const textos = [
    d.nome,
    d.webhook.instrucao,
    d.testeDeConexao,
    ...d.avisosDeSetup,
    ...d.campos.flatMap((c) => [c.rotulo, c.ajuda]),
    ...(d.segredoDoWebhook ? [d.segredoDoWebhook.rotulo, d.segredoDoWebhook.ajuda] : []),
  ];
  if (textos.some((t) => TEXTO_FORA_DO_PADRAO.test(t))) p.push("Os textos não podem ter travessão, meia-risca nem ' - ' como separador.");
  return [...new Set(p)];
}

// ---------------------------------------------------------------------------------------------------
// Validar o que o dono digitou (servidor)
// ---------------------------------------------------------------------------------------------------

export type ErroDeCampoDeLigacao = { campo: string; mensagem: string };
export type ResultadoDaValidacaoDeLigacao = { ok: true; credenciais: Record<string, string> } | { ok: false; erros: ErroDeCampoDeLigacao[] };

/** Mensagens por tipo de problema. NUNCA ecoam o valor digitado (pode ser segredo). */
function mensagemDoIssue(i: z.ZodIssue): string {
  if (i.code === z.ZodIssueCode.too_small) return "O valor é curto demais.";
  if (i.code === z.ZodIssueCode.too_big) return "O valor é longo demais.";
  if (i.code === z.ZodIssueCode.invalid_string || i.code === z.ZodIssueCode.invalid_type) return "O formato do valor não confere.";
  return "O valor não é válido.";
}

function validarUm(
  valor: unknown,
  schema: z.ZodTypeAny,
  obrigatorio: boolean,
  prefixos: readonly string[] | undefined,
): { ok: true; valor: string | null } | { ok: false; mensagem: string } {
  const vazio = valor === undefined || valor === null || (typeof valor === "string" && valor.trim() === "");
  if (vazio) return obrigatorio ? { ok: false, mensagem: "Preencha este campo." } : { ok: true, valor: null };
  const r = schema.safeParse(typeof valor === "string" ? valor.trim() : valor);
  if (!r.success) return { ok: false, mensagem: mensagemDoIssue(r.error.issues[0]!) };
  if (typeof r.data !== "string") return { ok: false, mensagem: "O formato do valor não confere." };
  if (prefixos && prefixos.length > 0 && !prefixos.some((pf) => (r.data as string).startsWith(pf))) {
    return { ok: false, mensagem: "A chave não parece ser do ambiente escolhido." };
  }
  return { ok: true, valor: r.data };
}

/**
 * Valida o que foi digitado para UM escopo (conta ou linha), no ambiente escolhido. Campo desconhecido
 * (ou de outro escopo) é recusado, sem repetir o nome que veio de fora. As mensagens nunca contêm o valor.
 */
export function validarCredenciaisDeLigacao(
  d: DescritorDeLigacao,
  escopo: EscopoDeCampoDeLigacao,
  entrada: unknown,
  ambiente: Ambiente,
): ResultadoDaValidacaoDeLigacao {
  if (!d.ambientes.includes(ambiente)) return { ok: false, erros: [{ campo: "ambiente", mensagem: "Este provedor não tem esse ambiente." }] };
  if (entrada === null || typeof entrada !== "object" || Array.isArray(entrada)) {
    return { ok: false, erros: [{ campo: "credenciais", mensagem: "Preencha os campos do formulário." }] };
  }
  const bruto = entrada as Record<string, unknown>;
  const doEscopo = d.campos.filter((c) => c.escopo === escopo);
  const erros: ErroDeCampoDeLigacao[] = [];
  const credenciais: Record<string, string> = {};
  const conhecidas = new Set(doEscopo.map((c) => c.chave));
  if (Object.keys(bruto).some((k) => !conhecidas.has(k))) erros.push({ campo: "credenciais", mensagem: "O formulário tem um campo que este provedor não usa aqui." });
  for (const c of doEscopo) {
    const r = validarUm(bruto[c.chave], c.schema, c.obrigatorio, c.prefixoPorAmbiente?.[ambiente]);
    if (!r.ok) erros.push({ campo: c.chave, mensagem: r.mensagem });
    else if (r.valor !== null) credenciais[c.chave] = r.valor;
  }
  return erros.length > 0 ? { ok: false, erros } : { ok: true, credenciais };
}

/** Valida o segredo do webhook digitado. `valor: null` quando o descritor não tem segredo. */
export function validarSegredoDoWebhookDeLigacao(
  d: DescritorDeLigacao,
  entrada: unknown,
): { ok: true; valor: string | null } | { ok: false; erros: ErroDeCampoDeLigacao[] } {
  const s = d.segredoDoWebhook;
  if (!s) {
    const vazio = entrada === undefined || entrada === null || entrada === "";
    return vazio ? { ok: true, valor: null } : { ok: false, erros: [{ campo: "segredoDoWebhook", mensagem: "Este provedor não usa segredo de webhook." }] };
  }
  const r = validarUm(entrada, s.schema, s.obrigatorio, undefined);
  return r.ok ? { ok: true, valor: r.valor } : { ok: false, erros: [{ campo: "segredoDoWebhook", mensagem: r.mensagem }] };
}

// ---------------------------------------------------------------------------------------------------
// O que sobe para a tela (nunca o valor de um segredo)
// ---------------------------------------------------------------------------------------------------

export type CampoPreenchidoDeLigacao = {
  chave: string;
  escopo: EscopoDeCampoDeLigacao;
  secreto: boolean;
  preenchido: boolean;
  ultimos4: string | null;
  valor?: string;
};

/**
 * Visão das credenciais de um escopo para a tela: campo secreto vira `{ preenchido, ultimos4 }` (sem `valor`);
 * campo comum (ex.: o domínio da conta) mostra o valor. Não existe caminho que devolva o valor aberto de um segredo.
 */
export function visaoDasCredenciaisDeLigacao(
  d: DescritorDeLigacao,
  escopo: EscopoDeCampoDeLigacao,
  credenciais: Readonly<Record<string, string>>,
): CampoPreenchidoDeLigacao[] {
  return d.campos
    .filter((c) => c.escopo === escopo)
    .map((c) => {
      const v = credenciais[c.chave];
      if (c.secreto) return { chave: c.chave, escopo: c.escopo, secreto: true, ...mascararSegredo(v) };
      return { chave: c.chave, escopo: c.escopo, secreto: false, preenchido: !!v, ultimos4: null, ...(v ? { valor: v } : {}) };
    });
}

/** Todos os valores que NUNCA podem aparecer em log, erro ou resposta (alimenta `redigirSegredos`). */
export function segredosDasCredenciaisDeLigacao(
  d: DescritorDeLigacao,
  credenciais: Readonly<Record<string, string>>,
  segredoDoWebhook?: { atual: string; anterior?: string } | null,
): string[] {
  const lista = d.campos.filter((c) => c.secreto).map((c) => credenciais[c.chave]).filter((v): v is string => !!v);
  if (segredoDoWebhook) {
    lista.push(segredoDoWebhook.atual);
    if (segredoDoWebhook.anterior) lista.push(segredoDoWebhook.anterior);
  }
  return lista;
}

export type FormularioDoProvedorDeLigacao = {
  chave: ChaveDeProvedorDeLigacao;
  nome: string;
  ambientes: readonly Ambiente[];
  campos: { chave: string; rotulo: string; ajuda: string; escopo: EscopoDeCampoDeLigacao; obrigatorio: boolean; secreto: boolean }[];
  segredoDoWebhook: { rotulo: string; ajuda: string; obrigatorio: boolean } | null;
  webhook: { modo: ModoDeWebhookDeLigacao; instrucao: string; eventosNecessarios: readonly string[] };
  testeDeConexao: string;
  avisosDeSetup: readonly string[];
  urlDaDocumentacao: string;
};

/** O descritor sem os schemas zod: serializável, é o que a tela desenha. */
export function formularioDoProvedorDeLigacao(d: DescritorDeLigacao): FormularioDoProvedorDeLigacao {
  return {
    chave: d.chave,
    nome: d.nome,
    ambientes: d.ambientes,
    campos: d.campos.map((c) => ({ chave: c.chave, rotulo: c.rotulo, ajuda: c.ajuda, escopo: c.escopo, obrigatorio: c.obrigatorio, secreto: c.secreto })),
    segredoDoWebhook: d.segredoDoWebhook
      ? { rotulo: d.segredoDoWebhook.rotulo, ajuda: d.segredoDoWebhook.ajuda, obrigatorio: d.segredoDoWebhook.obrigatorio }
      : null,
    webhook: d.webhook,
    testeDeConexao: d.testeDeConexao,
    avisosDeSetup: d.avisosDeSetup,
    urlDaDocumentacao: d.urlDaDocumentacao,
  };
}
