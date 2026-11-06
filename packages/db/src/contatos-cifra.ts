import crypto from "node:crypto";
import { cifrarTexto, decifrarTexto } from "./crypto";

/**
 * Cifra em repouso de e-mail e telefone dos contatos.
 *
 * Duas peças por valor:
 *  - o valor CIFRADO (AES-256-GCM, mesma chave e anel das credenciais, preso à coluna por AAD), para
 *    mostrar e para enviar;
 *  - o ÍNDICE CEGO (HMAC-SHA256 com chave PRÓPRIA, o time dentro da conta), para achar "o mesmo valor"
 *    por igualdade exata sem abrir o cifrado (dedupe, webhook do WhatsApp, importação, LGPD).
 *
 * Este arquivo só tem as primitivas, sem ler o banco. Quem grava (a extensão do `db()` e os poucos
 * pontos que usam `basePrisma`) chama `comCamposCifrados`; quem lê usa o módulo
 * `packages/core/src/contacts/identificadores-cifra.ts`.
 *
 * Flag `CONTATOS_CIFRA` (padrão `off`): com `off` NADA aqui grava nem muda nada.
 */

export type ModoCifraContatos = "off" | "dupla" | "indice" | "ligada";

/**
 * Modo atual. Lê o ambiente a CADA chamada (os testes trocam o modo; em produção só muda com
 * reinício do pm2). Fail-safe: ausente ou erro de digitação = `off` (o zod do boot recusa o erro).
 */
export function modoCifraContatos(): ModoCifraContatos {
  const v = (process.env.CONTATOS_CIFRA ?? "").trim().toLowerCase();
  return v === "dupla" || v === "indice" || v === "ligada" ? v : "off";
}

/** Contextos (AAD do GCM): o cifrado de uma coluna não abre se for copiado para outra. */
export const CONTEXTOS_CONTATO = {
  channelIdentifierValor: "ChannelIdentifier.valor",
  conversationExternalNumber: "Conversation.externalNumber",
  whatsappLidTelefone: "WhatsAppLid.telefone",
  callPhoneNumber: "Call.phoneNumber",
  campaignRecipientTelefone: "CampaignRecipient.telefone",
} as const;

/** A chave do índice não está configurada (ou é curta demais) e algo precisou dela. */
export class ChaveDoIndiceAusente extends Error {
  constructor() {
    super("CONTATOS_INDICE_KEY ausente ou com menos de 32 caracteres: a cifra dos contatos não pode gravar nem buscar.");
    this.name = "ChaveDoIndiceAusente";
  }
}

type SubchaveDoIndice = { kid: string; key: Buffer };
const subchaves = new Map<string, SubchaveDoIndice>();

function subchaveDe(segredo: string): SubchaveDoIndice {
  let c = subchaves.get(segredo);
  if (!c) {
    c = {
      // Id público (não revela o segredo): fica no começo do hash e permite achar hash de chave antiga.
      kid: crypto.createHash("sha256").update(`crmagro-idx-kid:${segredo}`).digest("hex").slice(0, 4),
      key: crypto.createHash("sha256").update(`crmagro-contatos-indice:v1:${segredo}`).digest(),
    };
    subchaves.set(segredo, c);
  }
  return c;
}

function segredoValido(s: string | undefined): s is string {
  return typeof s === "string" && s.trim().length >= 32;
}

/** Chaves do índice em uso: a atual primeiro, depois a anterior (só existe durante uma rotação). */
function segredosDoIndice(): string[] {
  const atual = process.env.CONTATOS_INDICE_KEY?.trim();
  if (!segredoValido(atual)) throw new ChaveDoIndiceAusente();
  const anterior = process.env.CONTATOS_INDICE_KEY_ANTERIOR?.trim();
  return segredoValido(anterior) && anterior !== atual ? [atual, anterior] : [atual];
}

/** Id (4 hex) da chave atual do índice. */
export function kidDoIndice(): string {
  return subchaveDe(segredosDoIndice()[0]!).kid;
}

/** O que o hash identifica. O mesmo número tem o MESMO hash em ChannelIdentifier, Conversation e WhatsAppLid. */
export type RotuloContato = "whatsapp" | "email" | "lid" | "sfx8";

function hmac(sub: SubchaveDoIndice, teamId: string, rotulo: RotuloContato, canonico: string): string {
  const h = crypto.createHmac("sha256", sub.key).update(`v1\0${teamId}\0${rotulo}\0${canonico}`).digest("hex");
  return `${sub.kid}.${h.slice(0, 32)}`;
}

/**
 * Índice cego de um valor JÁ canônico (ver `canonicoDeContato`). Formato `<kid>.<32 hex>`. O time
 * entra na conta: o mesmo número em dois times dá índices diferentes (coerente com o unique por time).
 */
export function impressaoDeContato(teamId: string, rotulo: RotuloContato, canonico: string): string {
  return hmac(subchaveDe(segredosDoIndice()[0]!), teamId, rotulo, canonico);
}

/** O índice com a chave atual e, na rotação, também com a anterior (para BUSCAR). */
export function impressoesDeContato(teamId: string, rotulo: RotuloContato, canonico: string): string[] {
  return segredosDoIndice().map((s) => hmac(subchaveDe(s), teamId, rotulo, canonico));
}

/**
 * Forma canônica que entra no índice. null = não dá para indexar com segurança (o texto continua
 * sendo a única referência daquela linha, e as buscas caem no texto enquanto o modo permitir).
 *  - whatsapp: E.164 estrito (`+` e 8 a 15 dígitos). A normalização com libphonenumber é feita ANTES
 *    de gravar (contacts/identifiers.ts), então o que está no banco já é isso;
 *  - email: aparado e em minúsculas, com `@` e sem espaço (não canonicaliza ponto nem +tag do Gmail);
 *  - lid: o código anônimo do WhatsApp (`...@lid`), aparado.
 */
export function canonicoDeContato(rotulo: "whatsapp" | "email" | "lid", valor: string | null | undefined): string | null {
  const t = (valor ?? "").trim();
  if (!t) return null;
  if (rotulo === "email") {
    const e = t.toLowerCase();
    return e.includes("@") && !/\s/.test(e) ? e : null;
  }
  if (rotulo === "lid") return t.toLowerCase().endsWith("@lid") ? t : null;
  return /^\+\d{8,15}$/.test(t) ? t : null;
}

/** Os 8 últimos dígitos (o que une as duas variantes do 9º dígito). null se houver menos de 8. */
export function sufixo8DoTelefone(valor: string | null | undefined): string | null {
  const d = (valor ?? "").replace(/\D/g, "");
  return d.length >= 8 ? d.slice(-8) : null;
}

/** Índice do sufixo de 8 dígitos de um telefone canônico (para "Telefone igual" dos Duplicados e a busca sem DDD). */
export function impressaoDeSufixo(teamId: string, telefone: string): string | null {
  const s = sufixo8DoTelefone(telefone);
  return s ? impressaoDeContato(teamId, "sfx8", s) : null;
}

/** Índices do sufixo de 8 dígitos com a chave atual e, na rotação, a anterior (para BUSCAR e conferir). */
export function impressoesDeSufixo(teamId: string, telefone: string): string[] {
  const s = sufixo8DoTelefone(telefone);
  return s ? impressoesDeContato(teamId, "sfx8", s) : [];
}

/** Ids de chave de índice que existem hoje (atual e anterior), para os scripts achar hash de chave velha. */
export function kidsDoIndice(): string[] {
  return segredosDoIndice().map((s) => subchaveDe(s).kid);
}

// ---------------------------------------------------------------------------
// Preenchimento dos campos derivados na ESCRITA
// ---------------------------------------------------------------------------

export type ModeloComCifra = "channelIdentifier" | "conversation" | "whatsAppLid" | "call" | "campaignRecipient";

type Dados = Record<string, unknown>;

/** Valor de um campo de `data`: aceita `x` e `{ set: x }`. `indefinido` = o campo não foi mexido. */
function valorDoCampo(d: Dados, campo: string): { mexeu: false } | { mexeu: true; valor: string | null } {
  if (!(campo in d) || d[campo] === undefined) return { mexeu: false };
  const v = d[campo];
  if (v === null) return { mexeu: true, valor: null };
  if (typeof v === "string") return { mexeu: true, valor: v };
  if (typeof v === "object" && "set" in (v as object)) {
    const s = (v as { set?: unknown }).set;
    if (s === null) return { mexeu: true, valor: null };
    if (typeof s === "string") return { mexeu: true, valor: s };
  }
  // Operação que não sabemos traduzir (nunca acontece com texto): trata como "mexeu e some o derivado".
  return { mexeu: true, valor: null };
}

function jaTemDerivados(d: Dados, campos: readonly string[]): boolean {
  return campos.some((c) => c in d && d[c] !== undefined);
}

/**
 * Devolve o `data` de uma escrita com os campos cifrados e de índice preenchidos a partir do campo em
 * claro. Não mexe se: a flag está `off`, o campo em claro não está no `data`, ou o `data` já traz os
 * derivados (quem chamou já preparou). `null` explícito no campo em claro zera os derivados.
 *
 * `opts.canal` serve para `update` de ChannelIdentifier em que o `data` não traz o canal: se mesmo
 * assim o canal não for conhecido, os derivados são ZERADOS (a linha cai para o texto, nunca fica
 * com índice de um valor antigo).
 */
export function comCamposCifrados<T extends Dados>(
  modelo: ModeloComCifra,
  teamId: string,
  data: T,
  opts: { canal?: string | null } = {},
): T & Dados {
  if (modoCifraContatos() === "off") return data;
  return derivarCampos(modelo, teamId, data, opts);
}

/**
 * O mesmo preenchimento de `comCamposCifrados`, SEM olhar a flag: é o que os scripts de preenchimento e de
 * conferência usam (eles precisam calcular mesmo com `CONTATOS_CIFRA=off`; só exigem a chave do índice).
 */
export function derivarCampos<T extends Dados>(
  modelo: ModeloComCifra,
  teamId: string,
  data: T,
  opts: { canal?: string | null } = {},
): T & Dados {
  if (data == null || typeof data !== "object") return data;
  switch (modelo) {
    case "channelIdentifier": {
      if (jaTemDerivados(data, ["valorCifrado", "valorHash", "valorSufixoHash"])) return data;
      const v = valorDoCampo(data, "valor");
      if (!v.mexeu) return data;
      const c = valorDoCampo(data, "canal");
      const canal = c.mexeu ? c.valor : (opts.canal ?? null);
      if (canal === "instagram" || canal === "linkedin") return data;
      const zerado = { valorCifrado: null, valorHash: null, valorSufixoHash: null };
      if ((canal !== "whatsapp" && canal !== "email") || v.valor === null) return { ...data, ...zerado };
      const canonico = canonicoDeContato(canal, v.valor);
      return {
        ...data,
        valorCifrado: cifrarTexto(v.valor, CONTEXTOS_CONTATO.channelIdentifierValor),
        valorHash: canonico ? impressaoDeContato(teamId, canal, canonico) : null,
        valorSufixoHash: canal === "whatsapp" && canonico ? impressaoDeSufixo(teamId, canonico) : null,
      };
    }
    case "conversation": {
      if (jaTemDerivados(data, ["externalNumberCifrado", "externalNumberHash"])) return data;
      const v = valorDoCampo(data, "externalNumber");
      if (!v.mexeu) return data;
      if (v.valor === null) return { ...data, externalNumberCifrado: null, externalNumberHash: null };
      const lid = canonicoDeContato("lid", v.valor);
      // O @lid é código anônimo e fica em claro (a tela e o código dependem do sufixo): só ganha o índice.
      if (lid) return { ...data, externalNumberCifrado: null, externalNumberHash: impressaoDeContato(teamId, "lid", lid) };
      const tel = canonicoDeContato("whatsapp", v.valor);
      return {
        ...data,
        externalNumberCifrado: cifrarTexto(v.valor, CONTEXTOS_CONTATO.conversationExternalNumber),
        externalNumberHash: tel ? impressaoDeContato(teamId, "whatsapp", tel) : null,
      };
    }
    case "whatsAppLid": {
      if (jaTemDerivados(data, ["telefoneCifrado", "telefoneHash"])) return data;
      const v = valorDoCampo(data, "telefone");
      if (!v.mexeu) return data;
      if (v.valor === null) return { ...data, telefoneCifrado: null, telefoneHash: null };
      const tel = canonicoDeContato("whatsapp", v.valor);
      return {
        ...data,
        telefoneCifrado: cifrarTexto(v.valor, CONTEXTOS_CONTATO.whatsappLidTelefone),
        telefoneHash: tel ? impressaoDeContato(teamId, "whatsapp", tel) : null,
      };
    }
    case "call": {
      if (jaTemDerivados(data, ["phoneNumberCifrado"])) return data;
      const v = valorDoCampo(data, "phoneNumber");
      if (!v.mexeu) return data;
      return { ...data, phoneNumberCifrado: v.valor === null ? null : cifrarTexto(v.valor, CONTEXTOS_CONTATO.callPhoneNumber) };
    }
    case "campaignRecipient": {
      if (jaTemDerivados(data, ["telefoneCifrado"])) return data;
      const v = valorDoCampo(data, "telefone");
      if (!v.mexeu) return data;
      return { ...data, telefoneCifrado: v.valor === null ? null : cifrarTexto(v.valor, CONTEXTOS_CONTATO.campaignRecipientTelefone) };
    }
  }
}

/** Abre um valor cifrado de contato (lança `TextoCifradoIlegivel` / `ChaveDeCredencialAusente` se não abrir). */
export function abrirContato(cifrado: string, contexto: string): string {
  return decifrarTexto(cifrado, contexto);
}
