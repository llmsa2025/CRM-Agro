import crypto from "node:crypto";
import { env } from "@crmagro/config";

/**
 * Criptografia do campo `credentials` (Integration e ChannelAccount): tokens de
 * CRM, chaves de IA, senha SMTP/IMAP, cookies de sessão social. AES-256-GCM com
 * IV aleatório por registro e auth tag que detecta adulteração.
 *
 * Formatos persistidos (JSON):
 *   v2 (atual): { v: 2, kid: "<id da chave>", iv, tag, data }
 *   v1 (antigo, sem kid): { v: 1, iv, tag, data }
 *
 * ROTAÇÃO (item 3.7, S20). Antes a chave era `sha256(CREDENTIALS_ENCRYPTION_KEY)`
 * fixa e sem id: trocar a env quebrava todas as credenciais. Agora há um ANEL:
 *  - `CREDENTIALS_ENCRYPTION_KEYS` (opcional) = segredos separados por vírgula;
 *    o PRIMEIRO é o atual (cifra), os outros só decifram;
 *  - `CREDENTIALS_ENCRYPTION_KEY` (a de sempre) entra no anel só para decifrar,
 *    e é a atual quando a lista não existe.
 * O `kid` é derivado do segredo (8 hex de um sha256) — não há nome para errar.
 *
 * Leitura:
 *  - v2 → a chave do `kid`; kid desconhecido → erro claro (faltou a chave antiga);
 *  - v1 → a `CREDENTIALS_ENCRYPTION_KEY` (a atual quando o dado foi gravado) e,
 *    se não bater, as outras do anel (o GCM recusa chave errada);
 *  - sem `v` (texto puro legado) → devolve como está, com aviso no log.
 * A migração de v1 para v2 acontece só ao REGRAVAR (ou pelo script
 * `packages/db/scripts/recifrar-credenciais.ts`).
 */

const ALGORITHM = "aes-256-gcm";

type Chave = { kid: string; key: Buffer };
export type AnelDeChaves = {
  /** Cifra tudo o que for gravado. */
  atual: Chave;
  /** A de `CREDENTIALS_ENCRYPTION_KEY` — primeira tentativa do formato v1. */
  legado: Chave;
  porKid: Map<string, Chave>;
};

function chaveDe(segredo: string): Chave {
  return {
    // Id público da chave: não revela o segredo e é estável entre processos.
    kid: crypto.createHash("sha256").update(`crmagro-kid:${segredo}`).digest("hex").slice(0, 8),
    // Deriva 32 bytes (256 bits): exatamente o tamanho do AES-256.
    key: crypto.createHash("sha256").update(segredo).digest(),
  };
}

/** Monta o anel a partir da chave de sempre + a lista opcional (1ª = atual). */
export function anelDeChaves(principal: string, lista?: string | null): AnelDeChaves {
  const segredos = (lista ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of segredos) {
    if (s.length < 32) throw new Error("CREDENTIALS_ENCRYPTION_KEYS: cada chave precisa de 32+ caracteres");
  }
  const legado = chaveDe(principal);
  const chaves = [...segredos.map(chaveDe), legado];
  const porKid = new Map<string, Chave>();
  for (const c of chaves) if (!porKid.has(c.kid)) porKid.set(c.kid, c);
  return { atual: chaves[0]!, legado, porKid };
}

/** Payload criptografado — formato versionado. */
export interface EncryptedCredentials {
  /** Versão do formato (2 = AES-256-GCM com id da chave; 1 = antigo, sem kid). */
  v: 1 | 2;
  /** Id da chave (só v2). */
  kid?: string;
  /** IV aleatório (12 bytes, base64). */
  iv: string;
  /** Auth tag do GCM (16 bytes, base64). */
  tag: string;
  /** Cifra (base64). */
  data: string;
}

/** O valor é um payload cifrado (v1 ou v2)? */
export function estaCifrado(value: unknown): value is EncryptedCredentials {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const base = typeof v.iv === "string" && typeof v.tag === "string" && typeof v.data === "string";
  return base && (v.v === 1 || (v.v === 2 && typeof v.kid === "string"));
}

export function cifrarCom(anel: AnelDeChaves, json: unknown): EncryptedCredentials {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, anel.atual.key, iv);
  const plaintext = Buffer.from(JSON.stringify(json), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 2,
    kid: anel.atual.kid,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function abrir(key: Buffer, value: EncryptedCredentials): unknown {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

/** Chave de credencial não configurada (rotação sem a chave antiga no anel). */
export class ChaveDeCredencialAusente extends Error {
  constructor(kid: string) {
    super(`Credencial cifrada com a chave "${kid}", que não está em CREDENTIALS_ENCRYPTION_KEYS/_KEY.`);
    this.name = "ChaveDeCredencialAusente";
  }
}

let avisouTextoPuro = false;

export function decifrarCom(anel: AnelDeChaves, value: unknown): unknown {
  if (value == null) return null;
  if (!estaCifrado(value)) {
    // Texto puro legado: continua funcionando, mas não pode passar em silêncio.
    if (!avisouTextoPuro && typeof value === "object") {
      avisouTextoPuro = true;
      console.warn("[crypto] credencial em texto puro (legado) lida — regrave ou rode o script de recifragem");
    }
    return value;
  }
  if (value.v === 2) {
    const chave = anel.porKid.get(value.kid!);
    if (!chave) throw new ChaveDeCredencialAusente(value.kid!);
    return abrir(chave.key, value);
  }
  // v1 (sem kid): a chave de sempre primeiro; depois as outras do anel.
  const ordem = [anel.legado, ...[...anel.porKid.values()].filter((c) => c !== anel.legado)];
  let ultimoErro: unknown;
  for (const c of ordem) {
    try {
      return abrir(c.key, value);
    } catch (e) {
      ultimoErro = e;
    }
  }
  throw ultimoErro;
}

/** Alguma camada do valor está em formato antigo ou com chave que não é a atual? */
export function precisaRecifrar(anel: AnelDeChaves, value: unknown): boolean {
  if (!estaCifrado(value)) return false;
  if (value.v !== 2 || value.kid !== anel.atual.kid) return true;
  return precisaRecifrar(anel, decifrarCom(anel, value));
}

/**
 * Recifra com a chave atual preservando as camadas (Integration tem duas: a da
 * extensão do client e a do serviço). Texto puro continua texto puro — cifrar
 * aqui mudaria o que o serviço espera ler.
 */
export function recifrarCom(anel: AnelDeChaves, value: unknown): unknown {
  if (!estaCifrado(value)) return value;
  return cifrarCom(anel, recifrarCom(anel, decifrarCom(anel, value)));
}

// ---------------------------------------------------------------------------
// Texto cifrado em coluna String (ex.: Contact.cpfCifrado).
//
// Mesmo anel de chaves e mesmo AES-256-GCM das credenciais, num formato de uma linha só para caber
// numa coluna de texto: `crmagro.enc.v2.<kid>.<iv>.<tag>.<dados>` (base64url, sem ponto dentro).
// O `contexto` (ex.: "Contact.cpf") entra como dado autenticado (AAD): um valor cifrado de um campo
// não abre se for copiado para outro. Texto sem o prefixo é legado em texto puro e volta como está
// (o script `packages/db/scripts/cifrar-cpf.ts` cifra o que sobrou).
// ---------------------------------------------------------------------------

/** Contexto (AAD) do CPF do contato. Compartilhado com o leitor de core/contacts/cpf.ts e com o script de recifragem. */
export const CONTEXTO_CPF = "Contact.cpf";

const PREFIXO_TEXTO = "crmagro.enc.v2.";

/** O valor é um texto cifrado por `cifrarTextoCom`? */
export function textoEstaCifrado(valor: unknown): valor is string {
  return typeof valor === "string" && valor.startsWith(PREFIXO_TEXTO);
}

export function cifrarTextoCom(anel: AnelDeChaves, texto: string, contexto: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, anel.atual.key, iv);
  cipher.setAAD(Buffer.from(contexto, "utf8"));
  const dados = Buffer.concat([cipher.update(Buffer.from(texto, "utf8")), cipher.final()]);
  const b64 = (b: Buffer) => b.toString("base64url");
  return `${PREFIXO_TEXTO}${anel.atual.kid}.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(dados)}`;
}

/** Valor cifrado que não abre (adulterado, de outro campo ou formato quebrado). */
export class TextoCifradoIlegivel extends Error {
  constructor(contexto: string) {
    super(`Texto cifrado de "${contexto}" não pôde ser aberto (adulterado, de outro campo ou formato inválido).`);
    this.name = "TextoCifradoIlegivel";
  }
}

export function decifrarTextoCom(anel: AnelDeChaves, valor: string, contexto: string): string {
  if (!textoEstaCifrado(valor)) return valor; // legado em texto puro
  const partes = valor.slice(PREFIXO_TEXTO.length).split(".");
  if (partes.length !== 4) throw new TextoCifradoIlegivel(contexto);
  const [kid, iv, tag, dados] = partes as [string, string, string, string];
  const chave = anel.porKid.get(kid);
  if (!chave) throw new ChaveDeCredencialAusente(kid);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, chave.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(contexto, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dados, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new TextoCifradoIlegivel(contexto);
  }
}

/** Texto puro (legado) ou cifrado com uma chave que não é a atual? */
export function textoPrecisaRecifrar(anel: AnelDeChaves, valor: string): boolean {
  if (!textoEstaCifrado(valor)) return true;
  return valor.slice(PREFIXO_TEXTO.length).split(".")[0] !== anel.atual.kid;
}

const ANEL = anelDeChaves(env.CREDENTIALS_ENCRYPTION_KEY, env.CREDENTIALS_ENCRYPTION_KEYS);

/**
 * Criptografa um JSON de credenciais com a chave atual. Retorna um
 * `EncryptedCredentials` serializável como `Prisma.JsonValue`.
 */
export function encryptCredentials(json: unknown): EncryptedCredentials {
  return cifrarCom(ANEL, json);
}

/**
 * Descriptografa um valor lido do DB (v1 ou v2). Null e texto plano legado
 * voltam como estão.
 */
export function decryptCredentials(value: unknown): unknown {
  return decifrarCom(ANEL, value);
}

/** O anel carregado do env (para o script de recifragem). */
export function anelDoAmbiente(): AnelDeChaves {
  return ANEL;
}

/** Cifra um texto (ex.: CPF) com a chave atual do ambiente. */
export function cifrarTexto(texto: string, contexto: string): string {
  return cifrarTextoCom(ANEL, texto, contexto);
}

/** Abre um texto cifrado do banco. Texto puro legado volta como está. */
export function decifrarTexto(valor: string, contexto: string): string {
  return decifrarTextoCom(ANEL, valor, contexto);
}

/**
 * Impressão com chave (HMAC-SHA256) de um texto, para achar "o mesmo valor" sem abrir o cifrado (ex.: o mesmo
 * CPF). O `escopo` (o time) entra na conta: o mesmo CPF em dois times dá impressões diferentes. Usa a chave de
 * `CREDENTIALS_ENCRYPTION_KEY` (a de sempre, não a da rotação): trocar essa chave muda as impressões e exige
 * refazê-las (`preencherHashDoCpf({ refazer: true })`).
 */
export function impressaoDeTexto(texto: string, escopo: string, contexto: string): string {
  const chave = crypto.createHash("sha256").update(`impressao:${contexto}:`).update(ANEL.legado.key).digest();
  return crypto.createHmac("sha256", chave).update(`${escopo}:${texto}`).digest("hex");
}

