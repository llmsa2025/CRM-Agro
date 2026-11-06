import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { CHAVES_PUBLICAS } from "./chave-publica";

/**
 * SELO do token de administrador da telefonia (F2-25, decisão 20 da F2).
 *
 * Com o token de administrador de uma conta de telefonia dá para ligar pelo número da empresa, criar usuários e baixar
 * todas as gravações. Este módulo faz o site só GUARDAR esse token e o worker ser o único que o ABRE:
 *
 * - `selarParaOWorker(texto)` usa só a chave PÚBLICA (versionada em `chave-publica.ts`). Roda em qualquer processo,
 *   inclusive no site. Não existe, no site, caminho para ler de volta o que foi selado.
 * - `abrirNoWorker(selado)` usa a chave PRIVADA, que só o worker tem (`TELEFONIA_CHAVE_PRIVADA`, entregue pelo workflow
 *   "Configurar serviços do worker"). Sem ela, lança `ChaveDoWorkerAusente`. A catraca `selo.catraca.test.ts` garante que
 *   nenhum arquivo do `apps/web` cita `abrirNoWorker`.
 *
 * Por que NÃO o anel de credenciais (`packages/db/src/crypto.ts`): ele é simétrico e a mesma chave abre no site e no
 * worker. Aqui a ideia é o contrário: quem grava não consegue ler.
 *
 * Formato (envelope): uma chave AES-256-GCM aleatória por selo cifra o texto; essa chave é cifrada com a pública por
 * RSA-OAEP (SHA-256). `kid` são os 8 primeiros hex do sha256 do SPKI da pública e diz qual privada abre. O `kid` e o
 * `contexto` (opcional) entram como dado autenticado do GCM: um selo não abre com outro `kid`, nem em outro lugar SE quem
 * chama passar o `contexto` (nada aqui obriga; o serviço que guarda o token da conta, F2-07, sela e abre sempre com
 * `<teamId>:<integrationId>`).
 *
 * Regras:
 * - Nenhum erro carrega o texto, a chave ou o selo. As mensagens são fixas (AGENTS.md (texto da interface)).
 * - Rotação: o worker aceita `TELEFONIA_CHAVE_PRIVADA` (atual) e `TELEFONIA_CHAVE_PRIVADA_ANTERIOR`; o selo escolhe a
 *   dele pelo `kid`. Selo de `kid` que o worker não tem dá `SeloDeChaveDesconhecida`.
 * - A chave privada vem direto do ambiente do processo (não do `@crmagro/config`, que o site também carrega), e é lida a
 *   cada abertura: ela não é guardada em lugar nenhum além do ambiente.
 */

/** Versão do formato do envelope. */
export const VERSAO_DO_SELO = 1 as const;
/** RSA mínimo e máximo aceitos nas chaves (o script de geração faz 3072). */
export const BITS_MINIMOS_DA_CHAVE = 3072;
export const BITS_MAXIMOS_DA_CHAVE = 4096;
/** Maior texto selado, em bytes (um token de API tem poucas centenas). */
export const TAMANHO_MAXIMO_DO_TEXTO = 8192;

/** Nomes das variáveis de ambiente do WORKER. Nunca no `.env` do site, nunca no do VPS à mão. */
export const ENV_CHAVE_PRIVADA = "TELEFONIA_CHAVE_PRIVADA";
export const ENV_CHAVE_PRIVADA_ANTERIOR = "TELEFONIA_CHAVE_PRIVADA_ANTERIOR";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const SeloDoWorkerSchema = z
  .object({
    v: z.literal(VERSAO_DO_SELO),
    kid: z.string().regex(/^[0-9a-f]{8}$/),
    /** Chave AES cifrada com a pública (RSA, até 4096 bits = 512 bytes). */
    chave: z.string().max(700).regex(BASE64),
    /** IV do GCM: 12 bytes. */
    iv: z.string().length(16).regex(BASE64),
    /** Tag do GCM: 16 bytes. */
    tag: z.string().length(24).regex(BASE64),
    /** O texto cifrado. */
    dado: z.string().max(11_000).regex(BASE64),
  })
  .strict();
export type SeloDoWorker = z.infer<typeof SeloDoWorkerSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Erros nomeados. Texto fixo: nunca vai valor de chave, de selo ou do token.

/** Não há chave pública cadastrada em `chave-publica.ts`: o site não tem com o que selar. */
export class ChavePublicaAusente extends Error {
  constructor() {
    super("Não há chave pública da telefonia cadastrada. Gere o par de chaves e cadastre a pública na configuração da telefonia.");
    this.name = "ChavePublicaAusente";
  }
}

/** A chave pública cadastrada não é um RSA de 3072 a 4096 bits em SPKI. */
export class ChavePublicaInvalida extends Error {
  constructor() {
    super("A chave pública da telefonia está inválida (precisa ser RSA de 3072 a 4096 bits).");
    this.name = "ChavePublicaInvalida";
  }
}

/** O texto a selar está vazio ou grande demais. */
export class TextoParaSelarInvalido extends Error {
  constructor() {
    super(`O texto a selar precisa ter de 1 a ${TAMANHO_MAXIMO_DO_TEXTO} bytes.`);
    this.name = "TextoParaSelarInvalido";
  }
}

/** Este processo não tem a chave privada: só o worker abre o token da conta. */
export class ChaveDoWorkerAusente extends Error {
  constructor() {
    super("Este processo não tem a chave privada da telefonia. Só o worker abre o token da conta.");
    this.name = "ChaveDoWorkerAusente";
  }
}

/** A chave privada do ambiente não abre como RSA de 3072 a 4096 bits em PKCS8. */
export class ChaveDoWorkerInvalida extends Error {
  constructor() {
    super("A chave privada da telefonia no ambiente do worker está inválida.");
    this.name = "ChaveDoWorkerInvalida";
  }
}

/** O selo foi feito para uma chave que este worker não tem (o `kid` não é segredo e ajuda a achar a chave). */
export class SeloDeChaveDesconhecida extends Error {
  readonly kid: string;
  constructor(kid: string) {
    super(`O token foi selado com a chave ${kid}, que este worker não tem. Reconecte a conta ou entregue a chave anterior.`);
    this.name = "SeloDeChaveDesconhecida";
    this.kid = kid;
  }
}

/** O selo não tem o formato esperado, foi alterado ou foi feito para outro contexto. */
export class SeloInvalido extends Error {
  constructor() {
    super("O token selado está inválido, foi alterado ou pertence a outro registro.");
    this.name = "SeloInvalido";
  }
}

// ---------------------------------------------------------------------------------------------------------------

type ChaveLida = { objeto: KeyObject; kid: string };

const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" } as const;

function rsaPermitido(chave: KeyObject): boolean {
  if (chave.asymmetricKeyType !== "rsa") return false;
  const bits = chave.asymmetricKeyDetails?.modulusLength ?? 0;
  return bits >= BITS_MINIMOS_DA_CHAVE && bits <= BITS_MAXIMOS_DA_CHAVE;
}

/** `kid`: 8 hex do sha256 do SPKI em DER (forma canônica, a mesma do `openssl pkey -pubout -outform DER`). */
function kidDe(publica: KeyObject): string {
  return createHash("sha256").update(publica.export({ type: "spki", format: "der" })).digest("hex").slice(0, 8);
}

function lerPublica(spkiBase64: string): ChaveLida {
  try {
    const objeto = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
    if (!rsaPermitido(objeto)) throw new Error("rsa");
    return { objeto, kid: kidDe(objeto) };
  } catch {
    throw new ChavePublicaInvalida();
  }
}

function lerPrivada(pkcs8Base64: string): ChaveLida {
  try {
    const objeto = createPrivateKey({ key: Buffer.from(pkcs8Base64, "base64"), format: "der", type: "pkcs8" });
    if (!rsaPermitido(objeto)) throw new Error("rsa");
    return { objeto, kid: kidDe(createPublicKey(objeto)) };
  } catch {
    throw new ChaveDoWorkerInvalida();
  }
}

/** `kid` de uma chave pública em base64 (o que o script e o workflow escrevem). Lança `ChavePublicaInvalida`. */
export function kidDaChavePublica(spkiBase64: string): string {
  return lerPublica(spkiBase64).kid;
}

/** Dado autenticado do GCM: prende o selo ao `kid` e ao contexto (por exemplo, o registro onde ele mora). */
const aad = (kid: string, contexto: string) => Buffer.from(`crmagro.telefonia.selo.v${VERSAO_DO_SELO}|${kid}|${contexto}`, "utf8");

export type OpcoesDeSelar = {
  /** Só para teste: a lista de chaves públicas (a atual primeiro). O padrão é `CHAVES_PUBLICAS`. */
  chavesPublicas?: readonly string[];
  /**
   * Prende o selo a um lugar (por exemplo, `<teamId>:<integrationId>`). Quem abre precisa passar o mesmo valor. Evita que
   * um selo copiado de uma empresa para outra abra. Opcional.
   */
  contexto?: string;
};

/**
 * Sela o texto com a chave pública ATUAL. Roda em qualquer processo; não lê chave privada. Não é determinístico:
 * dois selos do mesmo texto são diferentes.
 */
export function selarParaOWorker(texto: string, opcoes: OpcoesDeSelar = {}): SeloDoWorker {
  if (typeof texto !== "string" || !texto || Buffer.byteLength(texto, "utf8") > TAMANHO_MAXIMO_DO_TEXTO) throw new TextoParaSelarInvalido();
  const atual = (opcoes.chavesPublicas ?? CHAVES_PUBLICAS)[0];
  if (!atual) throw new ChavePublicaAusente();
  const publica = lerPublica(atual);

  const aes = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const cifra = createCipheriv("aes-256-gcm", aes, iv);
    cifra.setAAD(aad(publica.kid, opcoes.contexto ?? ""));
    const dado = Buffer.concat([cifra.update(texto, "utf8"), cifra.final()]);
    const tag = cifra.getAuthTag();
    const chave = publicEncrypt({ key: publica.objeto, ...OAEP }, aes);
    return {
      v: VERSAO_DO_SELO,
      kid: publica.kid,
      chave: chave.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      dado: dado.toString("base64"),
    };
  } finally {
    aes.fill(0);
  }
}

export type OpcoesDeAbrir = {
  /** Só para teste: o ambiente de onde sai a chave privada. O padrão é `process.env`. */
  env?: Record<string, string | undefined>;
  /** O mesmo `contexto` usado ao selar. */
  contexto?: string;
};

/**
 * Abre um selo com a chave privada do ambiente do WORKER. Só o worker (e os módulos de job de `calls/telefonia/`
 * listados na catraca) chamam isto. Devolve o texto em claro: quem chama não pode logar, devolver à tela nem guardar.
 */
export function abrirNoWorker(selado: unknown, opcoes: OpcoesDeAbrir = {}): string {
  const lido = SeloDoWorkerSchema.safeParse(selado);
  if (!lido.success) throw new SeloInvalido();
  const selo = lido.data;

  const env = opcoes.env ?? process.env;
  const brutas = [env[ENV_CHAVE_PRIVADA], env[ENV_CHAVE_PRIVADA_ANTERIOR]].map((v) => v?.trim() ?? "").filter(Boolean);
  if (!brutas.length) throw new ChaveDoWorkerAusente();

  // Uma privada ruim não derruba as outras: só vira erro se for a que faltava para abrir este selo.
  const privadas: ChaveLida[] = [];
  let ruins = 0;
  for (const bruta of brutas) {
    try {
      privadas.push(lerPrivada(bruta));
    } catch {
      ruins++;
    }
  }
  const dona = privadas.find((p) => p.kid === selo.kid);
  if (!dona) {
    if (ruins) throw new ChaveDoWorkerInvalida();
    throw new SeloDeChaveDesconhecida(selo.kid);
  }

  let aes: Buffer | undefined;
  try {
    aes = privateDecrypt({ key: dona.objeto, ...OAEP }, Buffer.from(selo.chave, "base64"));
    const decifra = createDecipheriv("aes-256-gcm", aes, Buffer.from(selo.iv, "base64"));
    decifra.setAAD(aad(selo.kid, opcoes.contexto ?? ""));
    decifra.setAuthTag(Buffer.from(selo.tag, "base64"));
    return Buffer.concat([decifra.update(Buffer.from(selo.dado, "base64")), decifra.final()]).toString("utf8");
  } catch {
    throw new SeloInvalido();
  } finally {
    aes?.fill(0);
  }
}
