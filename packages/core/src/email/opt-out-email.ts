import { aplicarOptOut, classificarOptOut, normalizarTexto } from "../conversations/opt-out";

/**
 * Opt-out por E-MAIL (N12): a mesma regra conservadora do WhatsApp
 * (`classificarOptOut`), aplicada ao que o contato ESCREVEU — não ao e-mail
 * inteiro.
 *
 * Uma resposta de e-mail traz, além do texto novo, a nossa mensagem citada
 * ("> …", "Em … escreveu:", "-----Mensagem original-----"), a assinatura dele
 * e, às vezes, um cumprimento na 1ª linha. Rodar a regra no corpo todo faria
 * a NOSSA frase citada ("Se não quiser mais receber, responda SAIR") virar
 * pedido de saída. Por isso a regra olha só a PRIMEIRA LINHA ÚTIL:
 *  - para no início da citação (cabeçalho "Em … escreveu:"/"On … wrote:",
 *    mesmo quebrado em duas linhas, "-----Mensagem original-----",
 *    "-----Original Message-----", a linha "____" do Outlook e o bloco
 *    "De:/From:" + "Enviado:/Sent:") e na assinatura ("-- ");
 *  - pula linha citada ("> …"), linha em branco e cumprimento sozinho
 *    ("Olá", "Bom dia", "Prezados", "Olá, Fulano").
 *
 * Sem linha útil no corpo, vale o ASSUNTO — só se não for resposta nem
 * encaminhamento ("Re:", "Res:", "Fwd:"…): o assunto de uma resposta é o NOSSO
 * assunto, e "Re: Pare de perder dinheiro com adubo" não é pedido de saída.
 */

const CABECALHO_CITACAO = [
  /^(em|on)\b.{0,300}\b(escreveu|wrote)\s*:?\s*$/i,
  /^-{2,}\s*(mensagem original|original message|mensagem encaminhada|forwarded message)\s*-{2,}\s*$/i,
  /^_{8,}\s*$/,
];
/** "Em sex., 26 de set. de 2026 às 10:00, Fulano <x@y>" + "escreveu:" na linha de baixo (Gmail). */
const INICIO_CABECALHO_QUEBRADO = /^(em|on)\b.{0,300}(<[^>]+@[^>]+>|\d{1,2}:\d{2})/i;
const SO_ESCREVEU = /^(escreveu|wrote)\s*:?\s*$/i;
const CABECALHO_OUTLOOK = /^(de|from)\s*:/i;
const CABECALHO_OUTLOOK_SEGUINTE = /^(enviado|enviada|sent|data|date|para|to|assunto|subject)\s*:/i;
const ASSINATURA = /^--\s*$/;
const CUMPRIMENTO = /^(ola|oi|opa|bom dia|boa tarde|boa noite|prezad[oa]s?|car[oa]s?|senhor[ae]s?)( \p{L}+){0,3}$/u;
const ASSUNTO_DE_RESPOSTA = /^\s*(re|res|resp|enc|fw|fwd|tr)\s*(\[\d+\])?\s*:/i;

/** A 1ª linha escrita pelo contato (sem citação, assinatura nem cumprimento). */
export function primeiraLinhaUtil(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const linhas = texto.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i]!.trim();
    if (ASSINATURA.test(linhas[i]!.trimEnd()) || CABECALHO_CITACAO.some((r) => r.test(linha))) return null;
    if (INICIO_CABECALHO_QUEBRADO.test(linha) && SO_ESCREVEU.test((linhas[i + 1] ?? "").trim())) return null;
    if (CABECALHO_OUTLOOK.test(linha) && CABECALHO_OUTLOOK_SEGUINTE.test((linhas[i + 1] ?? "").trim())) return null;
    if (!linha || linha.startsWith(">")) continue;
    const normal = normalizarTexto(linha);
    if (!normal || CUMPRIMENTO.test(normal)) continue;
    return linha;
  }
  return null;
}

/** O que a regra de opt-out avalia num e-mail recebido (ou `null`: nada a avaliar). */
export function textoParaOptOut(e: { text: string | null | undefined; subject: string | null | undefined }): string | null {
  const linha = primeiraLinhaUtil(e.text);
  if (linha) return linha;
  const assunto = e.subject?.trim();
  return assunto && !ASSUNTO_DE_RESPOSTA.test(assunto) ? assunto : null;
}

/**
 * Chamado pelo `processIncomingEmail` para um e-mail de um CONTATO, ANTES de
 * gravar a mensagem: se o processo cair entre os dois, a releitura da caixa
 * grava a mensagem e o opt-out (idempotente) é refeito — nunca fica a
 * mensagem sem o opt-out (a mesma lição do #121 no WhatsApp). Devolve se foi
 * pedido de saída.
 */
export async function optOutDoEmailRecebido(input: {
  contactId: string;
  text: string | null | undefined;
  subject: string | null | undefined;
  messageId?: string | null;
}): Promise<boolean> {
  const texto = textoParaOptOut(input);
  const decisao = classificarOptOut(texto);
  if (!decisao.optOut) return false;
  await aplicarOptOut(input.contactId, { origem: "regra", texto, regra: decisao.regra, messageId: input.messageId ?? null });
  return true;
}
