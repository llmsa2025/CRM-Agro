import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { CHAVES_PUBLICAS } from "./chave-publica";
import {
  ChaveDoWorkerAusente,
  ChaveDoWorkerInvalida,
  ChavePublicaAusente,
  ChavePublicaInvalida,
  SeloDeChaveDesconhecida,
  SeloInvalido,
  TextoParaSelarInvalido,
  abrirNoWorker,
  kidDaChavePublica,
  selarParaOWorker,
  type SeloDoWorker,
} from "./selo";

/**
 * Selo do token de administrador da telefonia (F2-25). Nenhuma chave de teste mora no repositório: os pares RSA são
 * gerados aqui, na hora (3072 bits leva alguns segundos, por isso só dois e uma vez).
 */

type Par = { publica: string; privada: string; kid: string };

function gerar(bits = 3072): Par {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return pares(publicKey, privateKey);
}
function pares(publicKey: KeyObject, privateKey: KeyObject): Par {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    publica: spki.toString("base64"),
    privada: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    kid: createHash("sha256").update(spki).digest("hex").slice(0, 8),
  };
}

let A: Par;
let B: Par;
beforeAll(() => {
  A = gerar();
  B = gerar();
}, 60_000);

const TOKEN = "tok_Ç4-ficticio/with+symbols=ção 日本語";
const envDe = (atual?: string, anterior?: string) => ({ TELEFONIA_CHAVE_PRIVADA: atual, TELEFONIA_CHAVE_PRIVADA_ANTERIOR: anterior });

/** Executa e devolve o erro lançado (ou falha o teste). */
function erroDe(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("era para lançar");
}

/** Nada do que é segredo pode aparecer no erro, em nenhuma forma de mostrá-lo. */
function semSegredo(e: Error, ...segredos: string[]) {
  const mostrado = [e.message, e.stack ?? "", String(e), JSON.stringify(e), JSON.stringify({ ...e })].join("\n");
  for (const s of segredos) expect(mostrado.includes(s), `vazou ${s.slice(0, 6)}...`).toBe(false);
}

/**
 * A chave que o `script de operação` produz (openssl) tem de servir no Node. Os comandos abaixo são os
 * do script; o teste `scripts/ci/testes/telefonia-gerar-chaves.test.mjs` prende o script a eles. Sem `openssl` no PATH, pula.
 */
const temOpenssl = spawnSync("openssl", ["version"]).status === 0;
describe.skipIf(!temOpenssl)("chave gerada pelo openssl, como no script do dono", () => {
  const sh = (comando: string, entrada?: string) => {
    const r = spawnSync("bash", ["-c", `set -o pipefail; ${comando}`], { input: entrada, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };

  it("sela com a pública do openssl e abre com a privada do openssl", () => {
    const privada = sh("openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -outform DER 2>/dev/null | openssl base64 -A");
    const publica = sh("openssl base64 -d -A | openssl pkey -inform DER -pubout -outform DER 2>/dev/null | openssl base64 -A", privada);
    const kidDoShell = sh("openssl base64 -d -A | openssl dgst -sha256 | awk '{print $NF}' | cut -c1-8", publica);

    expect(kidDaChavePublica(publica)).toBe(kidDoShell);
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [publica] });
    expect(selo.kid).toBe(kidDoShell);
    expect(abrirNoWorker(selo, { env: envDe(privada) })).toBe(TOKEN);
  }, 30_000);
});

describe("o vetor do kid (o mesmo do worker-credenciais.test.mjs)", () => {
  // Chave pública SÓ de teste, gerada com o openssl; a privada foi descartada. O kid foi calculado fora do Node:
  //   printf '%s' "$PUB" | openssl base64 -d -A | openssl dgst -sha256 | awk '{print $NF}' | cut -c1-8
  const PUBLICA_DO_VETOR =
    "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA52Y6zb74yNQLcAbdaIfR6T1n11CX4NDL3J48ZYQGoDlYLCxdk8qTI7rARgvlRyYCLkCCviFWwv4m4/lpJRU/p5l3F8flUMqYrof1pP2qukWYiHkwypBTtVFlBDgFO2zPbZHDIunebrlh9ve2wFDp/rnDV+XinxSRw9tPoG7m/Jv4yuOqzZYRLFj+n/DzDZQbzcInSC3TfgMiAa6t+SZzLAaYcmg2yJAQ+V421pEvPN/QJtJSGuP42g0j6WhEI2b7q+u8m3DU3PH5+e45kp6GO/aBzq3LIKDQRto/cTOQ8gsTtQhYYVGJ98SV3UfD1UdpWgkAwqvaCUZ4QELbKbOBSVdLyrfvcCAG09ow2oU8TadbHO5mFSz2qYjv6sicngdFfOTAfhDJKE3KEt71z3AlFTUtUcqfVqyA9Gvyslw2eBqhNrKfp5lEPmIObK/QIqmtXIRRN2zhGE/jTo8FyU/3HQMCcqGsHHnHD/ZEsCsiOXDN0A91h+dFoXo1orBOCSCtAgMBAAE=";

  it("kidDaChavePublica bate com o cálculo feito fora do Node", () => {
    expect(kidDaChavePublica(PUBLICA_DO_VETOR)).toBe("9fa879f7");
  });

  it("um selo feito com a pública do vetor leva esse kid", () => {
    expect(selarParaOWorker(TOKEN, { chavesPublicas: [PUBLICA_DO_VETOR] }).kid).toBe("9fa879f7");
  });
});

describe("selar e abrir", () => {
  it("o que o site sela, o worker abre (texto com acento e símbolos inclusive)", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    expect(abrirNoWorker(selo, { env: envDe(A.privada) })).toBe(TOKEN);
  });

  it("o envelope tem a forma combinada e o kid são 8 hex do sha256 do SPKI", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    expect(Object.keys(selo).sort()).toEqual(["chave", "dado", "iv", "kid", "tag", "v"]);
    expect(selo.v).toBe(1);
    expect(selo.kid).toBe(A.kid);
    expect(selo.kid).toMatch(/^[0-9a-f]{8}$/);
    expect(Buffer.from(selo.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(selo.tag, "base64")).toHaveLength(16);
    expect(Buffer.from(selo.chave, "base64")).toHaveLength(384); // RSA 3072
    // O texto não aparece no que vai para o banco.
    expect(JSON.stringify(selo)).not.toContain("ficticio");
  });

  it("não é determinístico: o mesmo texto vira dois selos diferentes, e os dois abrem", () => {
    const um = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    const dois = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    for (const campo of ["chave", "iv", "dado", "tag"] as const) expect(um[campo]).not.toBe(dois[campo]);
    expect(abrirNoWorker(um, { env: envDe(A.privada) })).toBe(TOKEN);
    expect(abrirNoWorker(dois, { env: envDe(A.privada) })).toBe(TOKEN);
  });

  it("abrir é repetível: o mesmo selo abre sempre igual", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    const env = envDe(A.privada);
    expect(abrirNoWorker(selo, { env })).toBe(abrirNoWorker(selo, { env }));
    expect(abrirNoWorker(JSON.parse(JSON.stringify(selo)), { env })).toBe(TOKEN); // volta do banco como JSON
  });

  it("o site (sem privada) sela, mas não abre", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    for (const env of [{}, envDe(undefined, undefined), envDe("", ""), envDe("   ", "\n")]) {
      const e = erroDe(() => abrirNoWorker(selo, { env }));
      expect(e).toBeInstanceOf(ChaveDoWorkerAusente);
      semSegredo(e, TOKEN, A.privada);
    }
  });

  it("texto vazio ou grande demais é recusado antes de qualquer chave", () => {
    for (const texto of ["", "x".repeat(8193), "ç".repeat(4097)]) {
      expect(erroDe(() => selarParaOWorker(texto, { chavesPublicas: [A.publica] }))).toBeInstanceOf(TextoParaSelarInvalido);
    }
    expect(abrirNoWorker(selarParaOWorker("x".repeat(8192), { chavesPublicas: [A.publica] }), { env: envDe(A.privada) })).toHaveLength(8192);
  });
});

describe("chaves ausentes e inválidas (fail-closed)", () => {
  it("sem chave pública cadastrada, o site recusa em vez de guardar o token em claro", () => {
    expect(erroDe(() => selarParaOWorker(TOKEN, { chavesPublicas: [] }))).toBeInstanceOf(ChavePublicaAusente);
    semSegredo(erroDe(() => selarParaOWorker(TOKEN, { chavesPublicas: [] })), TOKEN);
  });

  it("chave pública que não é RSA de 3072 a 4096 bits em SPKI é recusada", () => {
    const rsa2048 = gerar(2048).publica;
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    for (const ruim of [rsa2048, ec, "isto-nao-e-uma-chave", "", "AAAA"]) {
      const e = erroDe(() => selarParaOWorker(TOKEN, { chavesPublicas: [ruim] }));
      // O vazio cai em "ausente" (nenhuma chave); o resto, em "inválida".
      expect(e).toBeInstanceOf(ruim === "" ? ChavePublicaAusente : ChavePublicaInvalida);
      semSegredo(e, TOKEN, ruim || "nunca");
    }
    expect(erroDe(() => kidDaChavePublica(rsa2048))).toBeInstanceOf(ChavePublicaInvalida);
  });

  it("a chave PRIVADA no ambiente que não é RSA de 3072 a 4096 bits em PKCS8 é recusada, sem mostrar o valor", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
    const rsa2048 = gerar(2048).privada;
    for (const ruim of ["lixo-de-segredo-1234567890", ec, rsa2048, A.publica]) {
      const e = erroDe(() => abrirNoWorker(selo, { env: envDe(ruim) }));
      expect(e).toBeInstanceOf(ChaveDoWorkerInvalida);
      semSegredo(e, TOKEN, ruim);
    }
  });

  it("a lista real do repositório só tem RSA válido, sem repetir kid", () => {
    // Hoje a lista nasce vazia (o dono gera o par). Quando tiver chave, ela precisa abrir no `kidDaChavePublica`.
    const kids = CHAVES_PUBLICAS.map((p) => kidDaChavePublica(p));
    expect(new Set(kids).size).toBe(kids.length);
    for (const p of CHAVES_PUBLICAS) expect(p).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});

describe("kid e rotação", () => {
  it("kid desconhecido dá erro claro, com o kid (que não é segredo) e sem texto algum", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    const e = erroDe(() => abrirNoWorker(selo, { env: envDe(B.privada) }));
    expect(e).toBeInstanceOf(SeloDeChaveDesconhecida);
    expect((e as SeloDeChaveDesconhecida).kid).toBe(A.kid);
    expect(e.message).toContain(A.kid);
    semSegredo(e, TOKEN, A.privada, B.privada);
  });

  it("na rotação, o selado com a chave anterior ainda abre, e o novo abre com a atual", () => {
    const velho = selarParaOWorker("token-velho-ficticio", { chavesPublicas: [A.publica] });
    // Depois da rotação o site sela com a B (a atual vem primeiro) e a A fica só como anterior no worker.
    const novo = selarParaOWorker("token-novo-ficticio", { chavesPublicas: [B.publica, A.publica] });
    expect(novo.kid).toBe(B.kid);
    const envDoWorker = envDe(B.privada, A.privada);
    expect(abrirNoWorker(velho, { env: envDoWorker })).toBe("token-velho-ficticio");
    expect(abrirNoWorker(novo, { env: envDoWorker })).toBe("token-novo-ficticio");
    // Sem a anterior, o velho deixa de abrir (e o erro diz qual chave falta).
    expect(erroDe(() => abrirNoWorker(velho, { env: envDe(B.privada) }))).toBeInstanceOf(SeloDeChaveDesconhecida);
  });

  it("a ordem das variáveis não importa: o selo escolhe a privada pelo kid", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    expect(abrirNoWorker(selo, { env: envDe(A.privada, B.privada) })).toBe(TOKEN);
    expect(abrirNoWorker(selo, { env: envDe(B.privada, A.privada) })).toBe(TOKEN);
    expect(abrirNoWorker(selo, { env: envDe(undefined, A.privada) })).toBe(TOKEN); // só a anterior configurada
  });

  it("privada ruim ao lado de uma boa não atrapalha o selo que a boa abre; atrapalha o que dependia da ruim", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    expect(abrirNoWorker(selo, { env: envDe(A.privada, "lixo-1234567890") })).toBe(TOKEN);
    expect(erroDe(() => abrirNoWorker(selo, { env: envDe("lixo-1234567890", B.privada) }))).toBeInstanceOf(ChaveDoWorkerInvalida);
  });
});

describe("adulteração e selo mal formado", () => {
  const trocarUmChar = (b64: string) => {
    const i = Math.floor(b64.length / 2);
    return b64.slice(0, i) + (b64[i] === "A" ? "B" : "A") + b64.slice(i + 1);
  };

  it("mexer no dado, na tag, no iv, na chave AES ou no kid derruba o selo", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    const env = envDe(A.privada, B.privada);
    const trocas: Partial<SeloDoWorker>[] = [
      { dado: trocarUmChar(selo.dado) },
      { tag: trocarUmChar(selo.tag) },
      { iv: trocarUmChar(selo.iv) },
      { chave: trocarUmChar(selo.chave) },
      { kid: B.kid }, // outro kid que o worker tem: a chave AES não abre com a privada errada
    ];
    for (const troca of trocas) {
      const e = erroDe(() => abrirNoWorker({ ...selo, ...troca }, { env }));
      expect(e).toBeInstanceOf(SeloInvalido);
      semSegredo(e, TOKEN, A.privada);
    }
  });

  it("trocar o kid por um que o worker não tem dá 'chave desconhecida', e nunca abre com a privada errada", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    expect(erroDe(() => abrirNoWorker({ ...selo, kid: "00000000" }, { env: envDe(A.privada) }))).toBeInstanceOf(SeloDeChaveDesconhecida);
  });

  it("forma inválida é SeloInvalido, sem vazar o conteúdo", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    const env = envDe(A.privada);
    const ruins: unknown[] = [
      null,
      undefined,
      "texto solto",
      42,
      [],
      {},
      { ...selo, v: 2 },
      { ...selo, kid: "XYZ" },
      { ...selo, iv: "curto" },
      { ...selo, tag: "curto" },
      { ...selo, dado: "não é base64!" },
      { ...selo, chave: "" },
      { ...selo, extra: "campo-a-mais" },
      { v: 1, kid: selo.kid },
    ];
    for (const ruim of ruins) {
      const e = erroDe(() => abrirNoWorker(ruim, { env }));
      expect(e).toBeInstanceOf(SeloInvalido);
      semSegredo(e, TOKEN, A.privada);
    }
  });
});

describe("contexto (prende o selo a um registro)", () => {
  it("com o mesmo contexto abre; com outro, ou sem, não abre", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica], contexto: "time-1:integracao-1" });
    const env = envDe(A.privada);
    expect(abrirNoWorker(selo, { env, contexto: "time-1:integracao-1" })).toBe(TOKEN);
    expect(erroDe(() => abrirNoWorker(selo, { env, contexto: "time-2:integracao-1" }))).toBeInstanceOf(SeloInvalido);
    expect(erroDe(() => abrirNoWorker(selo, { env }))).toBeInstanceOf(SeloInvalido);
  });

  it("selo sem contexto não abre com contexto", () => {
    const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
    expect(erroDe(() => abrirNoWorker(selo, { env: envDe(A.privada), contexto: "qualquer" }))).toBeInstanceOf(SeloInvalido);
  });
});

describe("o ambiente do processo", () => {
  it("sem opcoes.env usa o process.env (é assim que o worker abre)", () => {
    const antes = { atual: process.env.TELEFONIA_CHAVE_PRIVADA, anterior: process.env.TELEFONIA_CHAVE_PRIVADA_ANTERIOR };
    try {
      const selo = selarParaOWorker(TOKEN, { chavesPublicas: [A.publica] });
      delete process.env.TELEFONIA_CHAVE_PRIVADA;
      delete process.env.TELEFONIA_CHAVE_PRIVADA_ANTERIOR;
      expect(erroDe(() => abrirNoWorker(selo))).toBeInstanceOf(ChaveDoWorkerAusente);
      process.env.TELEFONIA_CHAVE_PRIVADA = A.privada;
      expect(abrirNoWorker(selo)).toBe(TOKEN);
    } finally {
      for (const [chave, valor] of [["TELEFONIA_CHAVE_PRIVADA", antes.atual], ["TELEFONIA_CHAVE_PRIVADA_ANTERIOR", antes.anterior]] as const) {
        if (valor === undefined) delete process.env[chave];
        else process.env[chave] = valor;
      }
    }
  });
});
