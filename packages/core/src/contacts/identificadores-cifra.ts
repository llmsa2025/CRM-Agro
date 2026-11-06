import type { Prisma } from "@prisma/client";
import {
  CONTEXTOS_CONTATO,
  abrirContato,
  canonicoDeContato,
  impressaoDeSufixo,
  impressoesDeContato,
  modoCifraContatos,
  sufixo8DoTelefone,
  TextoCifradoIlegivel,
  ChaveDeCredencialAusente,
  type ModoCifraContatos,
  type RotuloContato,
} from "@crmagro/db";
import { normalizeEmail, normalizePhone } from "../normalize/index";
import { phoneVariants } from "@crmagro/channels";
import { logger } from "../logger/index";

/**
 * Cifra em repouso de e-mail e telefone dos contatos: LEITURA, BUSCA EXATA e DEDUPE.
 *
 * Este é o ÚNICO lugar que monta comparação por valor de telefone e e-mail. Quem precisa achar
 * "o contato (ou a conversa) deste número ou e-mail" chama um construtor de `where` daqui, em vez de
 * escrever `valor: { in: ... }` à mão. Por modo (`CONTATOS_CIFRA`):
 *
 *   off, dupla  → compara o TEXTO (exatamente como antes da cifra existir);
 *   indice      → compara o ÍNDICE CEGO, com fallback pelo texto nas linhas ainda sem índice;
 *   ligada      → compara só o índice cego (sem fallback).
 *
 * Quem grava não precisa fazer nada: a extensão do `db()` (packages/db/src/client.ts) preenche cifrado e
 * índice. Os poucos pontos que gravam por `basePrisma` chamam `comCamposCifrados` (@crmagro/db).
 *
 * O que o índice cego NÃO faz: busca por trecho ("contém"). Só valor completo (em qualquer formato de
 * digitação, ele normaliza) e os 8 últimos dígitos de telefone
 */

export { modoCifraContatos };
export type { ModoCifraContatos };

type Canal = "whatsapp" | "email" | "instagram" | "linkedin";

/** Nesses modos as buscas passam pelo índice cego (e a busca por trecho de e-mail e telefone some). */
export function buscaExataDeContatos(modo: ModoCifraContatos = modoCifraContatos()): boolean {
  return modo === "indice" || modo === "ligada";
}

/** O canal tem cifra (e-mail e telefone)? Instagram e LinkedIn são handles públicos e ficam em claro. */
export function canalCifravel(canal: string): canal is "whatsapp" | "email" {
  return canal === "whatsapp" || canal === "email";
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

let avisosDeLeitura = 0;

/** Abre um valor cifrado. Não abrir (chave errada, dado adulterado) vira null + aviso, sem dado no log. */
function abrirOuNull(cifrado: string, contexto: string): string | null {
  try {
    return abrirContato(cifrado, contexto);
  } catch (e) {
    if (e instanceof TextoCifradoIlegivel || e instanceof ChaveDeCredencialAusente) {
      // Nas 5 primeiras vezes por processo (um erro de chave afeta todo contato).
      if (avisosDeLeitura++ < 5) logger.error({ contexto }, "[contato] não consegui abrir um valor cifrado");
      return null;
    }
    throw e;
  }
}

/**
 * Valor legível a partir do par texto + cifrado de uma linha. Em `indice` e `ligada` prefere o cifrado
 * (e cai no texto se ele não abrir); em `off` e `dupla` prefere o texto. Sem texto (apagado numa etapa
 * futura), usa o cifrado. Legado só com texto continua funcionando em qualquer modo.
 */
export function valorLegivel(texto: string | null | undefined, cifrado: string | null | undefined, contexto: string): string | null {
  const preferirCifrado = buscaExataDeContatos();
  if (!preferirCifrado && texto != null) return texto;
  if (cifrado) {
    const aberto = abrirOuNull(cifrado, contexto);
    if (aberto != null) return aberto;
  }
  return texto ?? null;
}

/** Valor (telefone, e-mail ou handle) de um `ChannelIdentifier` lido do banco. */
export function valorDe(linha: { valor?: string | null; valorCifrado?: string | null }): string | null {
  return valorLegivel(linha.valor, linha.valorCifrado, CONTEXTOS_CONTATO.channelIdentifierValor);
}

/** Número de uma `Conversation` (`externalNumber`), de um `WhatsAppLid` (`telefone`), de uma `Call` ou de um `CampaignRecipient`. */
export function numeroDe(
  linha: Record<string, unknown>,
  campo: "externalNumber" | "telefone" | "phoneNumber",
  tabela: "conversation" | "whatsappLid" | "call" | "campaignRecipient",
): string | null {
  const contexto = {
    conversation: CONTEXTOS_CONTATO.conversationExternalNumber,
    whatsappLid: CONTEXTOS_CONTATO.whatsappLidTelefone,
    call: CONTEXTOS_CONTATO.callPhoneNumber,
    campaignRecipient: CONTEXTOS_CONTATO.campaignRecipientTelefone,
  }[tabela];
  const texto = linha[campo];
  const cifrado = linha[`${campo}Cifrado`];
  return valorLegivel(typeof texto === "string" ? texto : null, typeof cifrado === "string" ? cifrado : null, contexto);
}

// ---------------------------------------------------------------------------
// Índice cego para BUSCAR
// ---------------------------------------------------------------------------

/** Índices (chave atual e, na rotação, a anterior) de cada valor. Valor que não é canônico fica de fora. */
function hashesDe(teamId: string, rotuloPorValor: (v: string) => { rotulo: RotuloContato; canonico: string } | null, valores: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of valores) {
    const r = rotuloPorValor(v);
    if (!r) continue;
    for (const h of impressoesDeContato(teamId, r.rotulo, r.canonico)) out.add(h);
  }
  return [...out];
}

/** Índices dos valores de um canal cifrável (whatsapp ou email). */
export function hashesDeBusca(teamId: string, canal: "whatsapp" | "email", valores: readonly string[]): string[] {
  return hashesDe(
    teamId,
    (v) => {
      const canonico = canonicoDeContato(canal, v);
      return canonico ? { rotulo: canal, canonico } : null;
    },
    valores,
  );
}

/** Índices de números de conversa: telefone (rótulo whatsapp) ou `@lid` (rótulo lid). */
export function hashesDeNumeros(teamId: string, valores: readonly string[]): string[] {
  return hashesDe(
    teamId,
    (v) => {
      const lid = canonicoDeContato("lid", v);
      if (lid) return { rotulo: "lid", canonico: lid };
      const tel = canonicoDeContato("whatsapp", v);
      return tel ? { rotulo: "whatsapp", canonico: tel } : null;
    },
    valores,
  );
}

/** Índice de UM identificador (o que a escrita grava em `valorHash`), ou null se não é canônico. */
export function hashDeIdentificador(teamId: string, canal: "whatsapp" | "email", valor: string): string | null {
  return hashesDeBusca(teamId, canal, [valor])[0] ?? null;
}

// ---------------------------------------------------------------------------
// Construtores de `where` (o único lugar que compara valor de telefone e e-mail)
// ---------------------------------------------------------------------------

/** Linha de ChannelIdentifier de um canal com algum destes valores EXATOS (já normalizados). */
export function ondeIdentificadorExato(teamId: string, canal: Canal, valores: readonly string[]): Prisma.ChannelIdentifierWhereInput {
  const V = [...valores];
  const modo = modoCifraContatos();
  if (modo === "off" || modo === "dupla" || !canalCifravel(canal)) return { canal, valor: { in: V } };
  const H = hashesDeBusca(teamId, canal, V);
  if (modo === "ligada") return { canal, valorHash: { in: H } };
  return { canal, OR: [{ valorHash: { in: H } }, { valorHash: null, valor: { in: V } }] };
}

/**
 * Mesmo que `ondeIdentificadorExato`, para vários canais de uma vez (`[{ canal, valor }]`): o OR de
 * `findByIdentifiers`. Instagram e LinkedIn comparam o texto.
 */
export function ondeIdentificadoresExatos(teamId: string, pares: readonly { canal: Canal; valor: string }[]): Prisma.ChannelIdentifierWhereInput {
  const porCanal = new Map<Canal, string[]>();
  for (const p of pares) porCanal.set(p.canal, [...(porCanal.get(p.canal) ?? []), p.valor]);
  return { OR: [...porCanal].map(([canal, valores]) => ondeIdentificadorExato(teamId, canal, valores)) };
}

/** Conversa pelo número (telefone ou `@lid`) EXATO. */
export function ondeConversaPorNumero(teamId: string, valores: readonly string[]): Prisma.ConversationWhereInput {
  const V = [...valores];
  const modo = modoCifraContatos();
  if (modo === "off" || modo === "dupla") return { externalNumber: { in: V } };
  const H = hashesDeNumeros(teamId, V);
  if (modo === "ligada") return { externalNumberHash: { in: H } };
  return { OR: [{ externalNumberHash: { in: H } }, { externalNumberHash: null, externalNumber: { in: V } }] };
}

/** Par `@lid` → telefone pelo telefone EXATO (já com as variantes do 9º dígito, se for o caso). */
export function ondeLidPorTelefone(teamId: string, valores: readonly string[]): Prisma.WhatsAppLidWhereInput {
  const V = [...valores];
  const modo = modoCifraContatos();
  if (modo === "off" || modo === "dupla") return { telefone: { in: V } };
  const H = hashesDeBusca(teamId, "whatsapp", V);
  if (modo === "ligada") return { telefoneHash: { in: H } };
  return { OR: [{ telefoneHash: { in: H } }, { telefoneHash: null, telefone: { in: V } }] };
}

// ---------------------------------------------------------------------------
// Busca digitada pela pessoa
// ---------------------------------------------------------------------------

export type TipoDeTermo = "email" | "telefone" | "sufixo8" | "texto";

/**
 * O que a pessoa digitou na busca, para decidir como procurar quando o texto de e-mail e telefone não
 * está mais disponível para "contém":
 *  - `email`: um e-mail completo (acha por índice);
 *  - `sufixo8`: só dígitos, 8 ou 9 (o de 9 começa com 9): acha pelos 8 últimos dígitos;
 *  - `telefone`: um telefone completo em qualquer formato ("(66) 99988-7766", "+55 66 ...");
 *  - `texto`: o resto (nome, empresa, cidade, trecho de qualquer coisa).
 * Trecho de telefone ou de e-mail cai em `texto` e NÃO acha nada pelo telefone/e-mail nesses modos.
 */
export function classificarTermoDeBusca(texto: string): { tipo: TipoDeTermo; email?: string; telefone?: string; sufixo8?: string } {
  const t = texto.trim();
  if (t.includes("@")) {
    const e = normalizeEmail(t).canonical;
    if (e) return { tipo: "email", email: e };
    return { tipo: "texto" };
  }
  // 8 ou 9 dígitos (o de 9 começa com 9) não são um telefone completo (falta o DDD): acha pelo sufixo. Vem ANTES do
  // telefone porque o libphonenumber aceita alguns desses números soltos como válidos.
  const digitos = t.replace(/\D/g, "");
  if (/^[\d\s().-]+$/.test(t) && (digitos.length === 8 || (digitos.length === 9 && digitos.startsWith("9")))) {
    return { tipo: "sufixo8", sufixo8: digitos.slice(-8) };
  }
  const tel = normalizePhone(t).canonical;
  if (tel) return { tipo: "telefone", telefone: tel };
  return { tipo: "texto" };
}

/**
 * Linhas de identificador que a busca digitada acha. Em `off` e `dupla`: "contém" no texto (como sempre).
 * Em `indice` e `ligada`: handle de instagram e linkedin (trecho), mais e-mail e telefone COMPLETOS
 * pelo índice, mais o número sem DDD pelo sufixo de 8 dígitos. Devolve `null` quando a busca não tem nada
 * a procurar em identificadores (para o chamador não montar um OR vazio).
 */
export function ondeBuscaDeIdentificador(
  teamId: string,
  texto: string,
  opts: { insensivel?: boolean } = {},
): Prisma.ChannelIdentifierWhereInput | null {
  const modo = modoCifraContatos();
  const contem = opts.insensivel === false ? { contains: texto } : { contains: texto, mode: "insensitive" as const };
  if (!buscaExataDeContatos(modo)) return { valor: contem };

  const ou: Prisma.ChannelIdentifierWhereInput[] = [{ canal: { in: ["instagram", "linkedin"] }, valor: contem }];
  const termo = classificarTermoDeBusca(texto);
  if (termo.tipo === "email") ou.push(ondeIdentificadorExato(teamId, "email", [termo.email!]));
  if (termo.tipo === "telefone") ou.push(ondeIdentificadorExato(teamId, "whatsapp", phoneVariants(termo.telefone!)));
  if (termo.tipo === "sufixo8") {
    const h = impressoesDeContato(teamId, "sfx8", termo.sufixo8!);
    ou.push(
      modo === "ligada"
        ? { canal: "whatsapp", valorSufixoHash: { in: h } }
        : { canal: "whatsapp", OR: [{ valorSufixoHash: { in: h } }, { valorSufixoHash: null, valor: { endsWith: termo.sufixo8! } }] },
    );
  }
  return { OR: ou };
}

/** Conversa sem contato (só número) que a busca digitada acha: só o número COMPLETO, nesses modos. */
export function ondeBuscaDeConversaPorNumero(teamId: string, texto: string): Prisma.ConversationWhereInput | null {
  if (!buscaExataDeContatos()) return null;
  const termo = classificarTermoDeBusca(texto);
  if (termo.tipo !== "telefone") return null;
  return ondeConversaPorNumero(teamId, phoneVariants(termo.telefone!));
}

/** O termo parece telefone ou e-mail mas não foi achado como valor completo: a tela avisa para digitar inteiro. */
export function termoPareceTelefoneOuEmailParcial(texto: string): boolean {
  if (!buscaExataDeContatos()) return false;
  const t = texto.trim();
  if (classificarTermoDeBusca(t).tipo !== "texto") return false;
  const digitos = t.replace(/\D/g, "");
  // Parece telefone: só símbolos de telefone e pelo menos 4 dígitos; parece e-mail: tem @.
  return t.includes("@") || (/^[\d\s().+-]+$/.test(t) && digitos.length >= 4);
}

/** Sufixo de 8 dígitos (índice) de um telefone canônico: o que une as variantes do 9º dígito. */
export function sufixoDeTelefone(teamId: string, telefone: string): string | null {
  return impressaoDeSufixo(teamId, telefone);
}

export { sufixo8DoTelefone };
