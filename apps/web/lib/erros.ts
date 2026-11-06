/**
 * Erros de REGRA do core cuja mensagem foi escrita para a pessoa ler (regra do
 * responsável, 28/09: "já cadastrado com o responsável João…").
 */
const LEGIVEIS = new Set([
  "ContatoJaCadastrado",
  "ResponsavelInvalido",
  // Quem pediu para sair não muda de status por aqui (packages/core/src/contacts/errors.ts).
  "StatusDeQuemSaiuNaoMuda",
  // Unificação da conversa sem número (packages/core/src/conversations/unificar-lid.ts).
  "ConversaJaTemNumero",
  "ContatoSemWhatsApp",
  "LidComOutroNumero",
  "NumeroDoLidNaoEncontrado",
]);

/**
 * Mensagem de um desses erros pronta para a tela, sem o prefixo com o nome do
 * erro ("ContatoJaCadastrado: este contato…" → "Este contato…"). Devolve
 * `null` quando é outro erro — a action mantém o tratamento que já tinha.
 * Compara pelo `name` (não importa valor de `@crmagro/core`: serve a qualquer tela).
 */
export function mensagemDaRegra(e: unknown): string | null {
  if (!(e instanceof Error) || !LEGIVEIS.has(e.name)) return null;
  return e.message.replace(/^[A-Za-z]+: /, "").replace(/^./, (c) => c.toUpperCase());
}

/** Frase mostrada no lugar de um erro técnico (banco, rede, código). */
export const MENSAGEM_ERRO_GENERICA = "Algo deu errado do nosso lado. Tente de novo em instantes.";

/**
 * Cara de erro técnico: Prisma, banco fora do ar, rede, SQL, pilha de chamadas, JSON quebrado.
 * Nada disso ajuda a pessoa, e o texto cru entrega o endereço do banco e o desenho das consultas.
 */
const PADROES_TECNICOS: readonly RegExp[] = [
  /invalid `?prisma/i,
  /prisma(client)?\b/i,
  /\bP[1-6]\d{3}\b/,
  /invocation:/i,
  /can'?t reach database/i,
  /connection pool|timed out fetching a new connection/i,
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED)\b/,
  /fetch failed|socket hang up|network error|failed to fetch/i,
  /\bSQLSTATE\b|violates (foreign key|unique|not-null|check) constraint|duplicate key value|(column|relation|table) .{0,80} does not exist/i,
  /\bat \S+ \(.*:\d+:\d+\)|\n\s+at /,
  /unexpected token|is not valid JSON|unexpected end of JSON/i,
  /cannot read propert|is not a function|is not defined|undefined is not|null is not/i,
];

/**
 * Texto de erro seguro para devolver à tela (retorno de server action ou resposta de API).
 *
 * Mensagem escrita para a pessoa (regra de negócio, validação) passa como está. Mensagem com cara
 * de erro técnico vira `MENSAGEM_ERRO_GENERICA`, e o texto original vai só para o log do servidor.
 * Troca o antigo `e instanceof Error ? e.message : String(e)` (e o `String(e)` solto, que ainda trazia "Error: " na frente), que despejava na tela o erro cru do
 * Prisma (com o endereço do banco) toda vez que o pool de conexões enchia.
 */
export function mensagemParaTela(e: unknown, opcoes: { semPrefixo?: boolean } = {}): string {
  const regra = mensagemDaRegra(e);
  if (regra) return regra;
  const texto = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const tecnico = !texto || texto.length > 400 || PADROES_TECNICOS.some((re) => re.test(texto));
  // `semPrefixo`: erros do core que escrevem "NomeDoErro: texto" na mensagem (como já faziam as telas de Conversas e Campanhas).
  if (!tecnico) return opcoes.semPrefixo ? texto.replace(/^[A-Za-z]+: /, "") : texto;
  // No navegador não há log útil; no servidor, o texto cru fica no log (stderr do pm2), sem ir para a tela.
  if (typeof window === "undefined" && texto) console.error("[erro mascarado para a tela]", texto.slice(0, 600));
  return MENSAGEM_ERRO_GENERICA;
}
