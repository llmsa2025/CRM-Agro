/**
 * O que a pessoa respondeu, para a condição do fluxo. Sem IA: regras de palavras pensadas para resposta curta de
 * WhatsApp (grátis, instantâneo e igual toda vez). O que não casa com nada vira "outro", e é para esse caso que
 * serve o agente ou um fluxo à parte. Para uma palavra sua, use `respostaTemTexto`.
 *
 * Ordem (a primeira que casar vale): recusa explícita > interesse claro > "já resolvi" > outro. Assim "não quero"
 * não vira interesse por causa do "quero", e "tenho interesse, mas já tenho outro" fica como interesse.
 */
export type ClasseDaResposta = "sem_interesse" | "interesse" | "outro";

/** Minúsculo, sem acento nem pontuação, espaços únicos: "Obrigado, Já tenho!" vira "obrigado ja tenho". */
export function normalizarResposta(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A frase aparece como palavras inteiras (não casa "preco" dentro de "preconceito"). */
const temFrase = (t: string, frases: readonly string[]) => frases.some((f) => ` ${t} `.includes(` ${f} `));
/** Alguma palavra do texto começa com o radical ("interessad" pega interessado e interessada). */
const temRadical = (t: string, radicais: readonly string[]) => t.split(" ").some((p) => radicais.some((r) => p.startsWith(r)));

const RECUSA_EXATA = new Set(["nao", "n", "nao obrigado", "nao obrigada", "nao grato", "nao quero", "nao precisa", "nao preciso"]);
const RECUSA_EXPLICITA = [
  "nao tenho interesse", "nao temos interesse", "sem interesse", "nao me interessa", "nao nos interessa", "nao tenho necessidade",
  "nao quero", "nao queremos", "nao preciso", "nao precisamos", "nao precisa", "nao necessito", "nao obrigado", "nao obrigada",
  "agora nao", "no momento nao", "nao uso", "nao utilizo", "nao compro", "nao trabalho com", "nao trabalhamos com",
  "nao envie", "nao mande", "nao me chame", "nao me procure", "nao quero receber", "pare", "parem", "parar", "sair", "remover",
  "remova", "me remove", "me tira", "descadastrar", "descadastre", "bloquear",
];
const INTERESSE_EXATO = new Set(["sim", "s", "pode", "pode ser", "claro", "com certeza", "quero", "tenho", "ok", "topo", "bora", "vamos", "fechado", "positivo", "sim pode"]);
const INTERESSE_CLARO = [
  "tenho interesse", "temos interesse", "tenho sim", "me interessa", "nos interessa", "interessante", "pode mandar", "pode enviar",
  "pode me mandar", "pode me enviar", "me manda", "me envia", "me mande", "me envie", "como funciona", "quanto custa", "qual o valor",
  "qual valor", "qual o preco", "qual preco", "valor", "valores", "preco", "precos", "quero saber", "quero conhecer", "quero ver",
  "quero sim", "gostaria", "vamos conversar", "pode ligar", "me liga", "me ligue", "ligue", "pode chamar", "me chama",
];
const INTERESSE_RADICAIS = ["interessad", "orcament", "proposta", "cotac", "catalog"];
const JA_RESOLVIDO = [
  "ja tenho", "ja temos", "ja uso", "ja usamos", "ja compro", "ja compramos", "ja trabalho com", "ja trabalhamos com", "ja possuo",
  "ja possuimos", "ja resolvi", "ja resolvemos", "ja fechei", "ja fechamos", "ja comprei", "estou bem servido", "estamos bem servidos",
];

export function classificarResposta(texto: string): ClasseDaResposta {
  const t = normalizarResposta(texto);
  if (!t) return "outro";
  if (RECUSA_EXATA.has(t) || temFrase(t, RECUSA_EXPLICITA)) return "sem_interesse";
  if (INTERESSE_EXATO.has(t) || temFrase(t, INTERESSE_CLARO) || temRadical(t, INTERESSE_RADICAIS)) return "interesse";
  if (temFrase(t, JA_RESOLVIDO)) return "sem_interesse";
  return "outro";
}

/**
 * A resposta tem a palavra (ou uma das palavras, separadas por vírgula, ponto e vírgula ou barra)?
 * `contem`: aparece em qualquer parte da resposta. `exato`: a resposta inteira é a palavra. Sem acento nem caixa.
 * Cada mensagem é vista sozinha no modo `exato`.
 */
export function respostaTemTexto(respostas: readonly string[], texto: string, modo: "contem" | "exato"): boolean {
  const alvos = texto.split(/[,;|\n]/).map(normalizarResposta).filter(Boolean);
  if (alvos.length === 0) return false;
  const msgs = respostas.map(normalizarResposta).filter(Boolean);
  return modo === "exato" ? msgs.some((m) => alvos.includes(m)) : msgs.some((m) => alvos.some((a) => m.includes(a)));
}
