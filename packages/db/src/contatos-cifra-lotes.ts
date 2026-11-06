import { Prisma } from "@prisma/client";
import { basePrisma } from "./client";
import {
  CONTEXTOS_CONTATO,
  abrirContato,
  canonicoDeContato,
  derivarCampos,
  impressoesDeContato,
  impressoesDeSufixo,
  type ModeloComCifra,
} from "./contatos-cifra";

/**
 * Preenchimento, conferência e reversão EM LOTES da cifra de e-mail e telefone dos contatos
 * (`CONTATOS_CIFRA`). A lógica mora aqui (e não nos scripts) para ser testada contra o banco de teste;
 * os scripts de `packages/db/scripts/` só leem a linha de comando e imprimem.
 *
 * Regras que valem para tudo daqui:
 *  - NUNCA imprime telefone, e-mail nem o valor cifrado: só contagens e ids de linha;
 *  - usa o `basePrisma` com SQL direto, sem tocar `updatedAt` (as listas ordenam por essa data);
 *  - o TEXTO PURO nunca é tocado: só as colunas novas (`*Cifrado`, `*Hash`, `*SufixoHash`) são escritas;
 *  - idempotente e retomável: só olha linhas que ainda não têm os campos novos e nunca sobrescreve um
 *    campo já preenchido (COALESCE) nem escreve se o texto mudou no meio do caminho (compare-and-set);
 *  - em lotes pequenos com pausa, por chave (id), para não disputar memória e banco com o app.
 */

export type TabelaContato = "ChannelIdentifier" | "Conversation" | "WhatsAppLid" | "Call" | "CampaignRecipient";
export const TABELAS_CONTATO: readonly TabelaContato[] = ["ChannelIdentifier", "Conversation", "WhatsAppLid", "Call", "CampaignRecipient"];

type Spec = {
  tabela: TabelaContato;
  modelo: ModeloComCifra;
  contexto: string;
  texto: string;
  cifrado: string;
  hash: string | null;
  sufixo: string | null;
  /** Coluna extra que a derivação precisa ler (o canal do identificador). */
  extra: string | null;
  /** Linhas que fazem parte da cifra (ex.: só whatsapp e e-mail). */
  base: Prisma.Sql;
  /** Linhas que ainda precisam de preenchimento. */
  faltando: Prisma.Sql;
};

const SPECS: Record<TabelaContato, Spec> = {
  ChannelIdentifier: {
    tabela: "ChannelIdentifier",
    modelo: "channelIdentifier",
    contexto: CONTEXTOS_CONTATO.channelIdentifierValor,
    texto: "valor",
    cifrado: "valorCifrado",
    hash: "valorHash",
    sufixo: "valorSufixoHash",
    extra: "canal",
    base: Prisma.sql`"canal" IN ('whatsapp', 'email')`,
    faltando: Prisma.sql`("valorCifrado" IS NULL OR "valorHash" IS NULL)`,
  },
  Conversation: {
    tabela: "Conversation",
    modelo: "conversation",
    contexto: CONTEXTOS_CONTATO.conversationExternalNumber,
    texto: "externalNumber",
    cifrado: "externalNumberCifrado",
    hash: "externalNumberHash",
    sufixo: null,
    extra: null,
    base: Prisma.sql`"externalNumber" IS NOT NULL`,
    // O @lid é código anônimo: fica em claro e só ganha o índice (por isso não "falta" cifrado nele).
    faltando: Prisma.sql`("externalNumberHash" IS NULL OR ("externalNumberCifrado" IS NULL AND lower("externalNumber") NOT LIKE '%@lid'))`,
  },
  WhatsAppLid: {
    tabela: "WhatsAppLid",
    modelo: "whatsAppLid",
    contexto: CONTEXTOS_CONTATO.whatsappLidTelefone,
    texto: "telefone",
    cifrado: "telefoneCifrado",
    hash: "telefoneHash",
    sufixo: null,
    extra: null,
    base: Prisma.sql`TRUE`,
    faltando: Prisma.sql`("telefoneCifrado" IS NULL OR "telefoneHash" IS NULL)`,
  },
  Call: {
    tabela: "Call",
    modelo: "call",
    contexto: CONTEXTOS_CONTATO.callPhoneNumber,
    texto: "phoneNumber",
    cifrado: "phoneNumberCifrado",
    hash: null,
    sufixo: null,
    extra: null,
    base: Prisma.sql`TRUE`,
    faltando: Prisma.sql`"phoneNumberCifrado" IS NULL`,
  },
  CampaignRecipient: {
    tabela: "CampaignRecipient",
    modelo: "campaignRecipient",
    contexto: CONTEXTOS_CONTATO.campaignRecipientTelefone,
    texto: "telefone",
    cifrado: "telefoneCifrado",
    hash: null,
    sufixo: null,
    extra: null,
    base: Prisma.sql`"telefone" IS NOT NULL`,
    faltando: Prisma.sql`"telefoneCifrado" IS NULL`,
  },
};

const col = (nome: string) => Prisma.raw(`"${nome}"`);
const tab = (nome: string) => Prisma.raw(`"${nome}"`);

export type OpcoesLote = {
  /** false (padrão) = só simula, não grava nada. */
  aplicar?: boolean;
  tabelas?: readonly TabelaContato[];
  /** Só este time. */
  teamId?: string;
  lote?: number;
  pausaMs?: number;
  /** Para depois de olhar tantas linhas (por tabela). */
  limite?: number;
  log?: (mensagem: string) => void;
};

type LinhaLida = { id: string; teamId: string; texto: string; cifrado: string | null; hash: string | null; sufixo: string | null; extra: string | null };

function filtroDoTime(teamId?: string): Prisma.Sql {
  return teamId ? Prisma.sql`AND "teamId" = ${teamId}` : Prisma.empty;
}

async function lerLote(spec: Spec, cursor: string, take: number, teamId: string | undefined, soFaltando: boolean): Promise<LinhaLida[]> {
  return basePrisma.$queryRaw<LinhaLida[]>`
    SELECT "id", "teamId", ${col(spec.texto)} AS "texto", ${col(spec.cifrado)} AS "cifrado",
           ${spec.hash ? col(spec.hash) : Prisma.sql`NULL::text`} AS "hash",
           ${spec.sufixo ? col(spec.sufixo) : Prisma.sql`NULL::text`} AS "sufixo",
           ${spec.extra ? Prisma.sql`${col(spec.extra)}::text` : Prisma.sql`NULL::text`} AS "extra"
    FROM ${tab(spec.tabela)}
    WHERE "id" > ${cursor} AND ${spec.base} ${soFaltando ? Prisma.sql`AND ${spec.faltando}` : Prisma.empty} ${filtroDoTime(teamId)}
    ORDER BY "id"
    LIMIT ${take}`;
}

function dormir(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** Erro de violação de unique do Postgres (23505) vindo de `$executeRaw`. */
function ehViolacaoDeUnique(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string }; message?: string };
  return err?.code === "P2002" || err?.meta?.code === "23505" || /23505|duplicate key/i.test(err?.message ?? "");
}

/** Campos derivados do texto da linha (sem olhar a flag). */
function derivadosDe(spec: Spec, l: LinhaLida): Record<string, string | null> {
  const dados: Record<string, unknown> = { [spec.texto]: l.texto };
  if (spec.extra) dados[spec.extra] = l.extra;
  const d = derivarCampos(spec.modelo, l.teamId, dados) as Record<string, string | null>;
  return d;
}

export type ResumoDaTabela = {
  tabela: TabelaContato;
  /** Linhas da tabela (do time, se pedido) que fazem parte da cifra. */
  total: number;
  /** Quantas ainda não tinham cifrado ou índice (as candidatas deste passe). */
  faltavam: number;
  /** Gravadas (ou, na simulação, que seriam gravadas). */
  preenchidas: number;
  /** Linhas cujo valor não é canônico (telefone fora do E.164, e-mail sem @): ficam sem índice, só com cifrado. */
  semIndice: number;
  /** E-mail com maiúscula ou espaço no texto gravado: o índice usa a forma minúscula e aparada. */
  naoNormalizadas: number;
  /** Duas linhas do mesmo time e canal com o mesmo índice: a segunda fica sem índice (ids no relatório). */
  colisoes: number;
  colisaoIds: string[];
  /** O texto mudou no meio do caminho (compare-and-set): a linha fica para o próximo passe. */
  mudaramNoCaminho: number;
  falhas: number;
};

/**
 * Preenche cifrado e índice cego das linhas que ainda não têm. Simula por padrão (`aplicar: false`).
 * Exige `CONTATOS_INDICE_KEY` (e a chave de credenciais, que o anel já exige).
 */
export async function preencherContatosCifrados(opts: OpcoesLote = {}): Promise<ResumoDaTabela[]> {
  const aplicar = opts.aplicar === true;
  const lote = Math.max(1, opts.lote ?? 500);
  const pausa = opts.pausaMs ?? 50;
  const limite = opts.limite ?? Number.POSITIVE_INFINITY;
  const log = opts.log ?? (() => undefined);
  const resumos: ResumoDaTabela[] = [];

  for (const nome of opts.tabelas ?? TABELAS_CONTATO) {
    const spec = SPECS[nome];
    const total = ((await basePrisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${tab(spec.tabela)} WHERE ${spec.base} ${filtroDoTime(opts.teamId)}`)[0]?.n) ?? 0;
    const r: ResumoDaTabela = {
      tabela: nome, total, faltavam: 0, preenchidas: 0, semIndice: 0, naoNormalizadas: 0,
      colisoes: 0, colisaoIds: [], mudaramNoCaminho: 0, falhas: 0,
    };
    let cursor = "";
    let vistas = 0;
    const vistosNaSimulacao = new Set<string>();
    while (vistas < limite) {
      const linhas = await lerLote(spec, cursor, Math.min(lote, limite - vistas), opts.teamId, true);
      if (linhas.length === 0) break;
      cursor = linhas[linhas.length - 1]!.id;
      vistas += linhas.length;
      for (const l of linhas) {
        r.faltavam++;
        try {
          const d = derivadosDe(spec, l);
          const cifrado = d[spec.cifrado] ?? null;
          const hash = spec.hash ? (d[spec.hash] ?? null) : null;
          const sufixo = spec.sufixo ? (d[spec.sufixo] ?? null) : null;
          if (spec.hash && !hash) r.semIndice++;
          if (spec.extra === "canal" && l.extra === "email" && l.texto !== l.texto.trim().toLowerCase()) r.naoNormalizadas++;
          if (!aplicar) {
            if (nome === "ChannelIdentifier" && hash && (await colidiriaNaSimulacao(l, hash, vistosNaSimulacao))) {
              r.colisoes++;
              if (r.colisaoIds.length < 200) r.colisaoIds.push(l.id);
            }
            r.preenchidas++;
            continue;
          }
          const gravou = await gravarLinha(spec, l, cifrado, hash, sufixo, r);
          if (gravou) r.preenchidas++;
        } catch (e) {
          r.falhas++;
          log(`${nome} ${l.id}: falhou (${e instanceof Error ? e.name : "erro"})`);
        }
      }
      log(`${nome}: ${vistas} linha(s) olhadas, ${r.preenchidas} ${aplicar ? "gravadas" : "a gravar"}`);
      await dormir(pausa);
    }
    resumos.push(r);
  }
  return resumos;
}

/**
 * Na simulação: este índice de identificador já existe em OUTRA linha do mesmo time e canal (ou já apareceu
 * neste passe)? É o que estouraria o unique ao gravar de verdade.
 */
async function colidiriaNaSimulacao(l: LinhaLida, hash: string, vistos: Set<string>): Promise<boolean> {
  const chave = `${l.teamId}|${l.extra}|${hash}`;
  if (vistos.has(chave)) return true;
  vistos.add(chave);
  const n = ((await basePrisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "ChannelIdentifier"
    WHERE "teamId" = ${l.teamId} AND "canal"::text = ${l.extra} AND "valorHash" = ${hash} AND "id" <> ${l.id}`)[0]?.n) ?? 0;
  return n > 0;
}

/** Grava os campos novos de UMA linha (compare-and-set no texto; COALESCE: nunca sobrescreve). */
async function gravarLinha(spec: Spec, l: LinhaLida, cifrado: string | null, hash: string | null, sufixo: string | null, r: ResumoDaTabela): Promise<boolean> {
  const atribuicoes = (comIndice: boolean): Prisma.Sql[] => {
    const a: Prisma.Sql[] = [];
    if (cifrado) a.push(Prisma.sql`${col(spec.cifrado)} = COALESCE(${col(spec.cifrado)}, ${cifrado}::text)`);
    if (comIndice && spec.hash && hash) a.push(Prisma.sql`${col(spec.hash)} = COALESCE(${col(spec.hash)}, ${hash}::text)`);
    if (comIndice && spec.sufixo && sufixo) a.push(Prisma.sql`${col(spec.sufixo)} = COALESCE(${col(spec.sufixo)}, ${sufixo}::text)`);
    return a;
  };
  const executar = async (comIndice: boolean): Promise<number> => {
    const a = atribuicoes(comIndice);
    if (a.length === 0) return 1; // nada a gravar (ex.: o @lid já tem o índice): não é erro
    return basePrisma.$executeRaw`UPDATE ${tab(spec.tabela)} SET ${Prisma.join(a)} WHERE "id" = ${l.id} AND ${col(spec.texto)} = ${l.texto}`;
  };
  let afetadas: number;
  try {
    afetadas = await executar(true);
  } catch (e) {
    if (!ehViolacaoDeUnique(e)) throw e;
    // Mesmo índice que outra linha do time: grava só o cifrado e relata (a unificação é manual).
    r.colisoes++;
    if (r.colisaoIds.length < 200) r.colisaoIds.push(l.id);
    afetadas = await executar(false);
  }
  if (afetadas === 0) {
    r.mudaramNoCaminho++;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Conferência (só leitura)
// ---------------------------------------------------------------------------

export type ConferenciaDaTabela = {
  tabela: TabelaContato;
  total: number;
  semCifrado: number;
  /** Cifrado que não abre (chave errada, adulterado, de outro campo). */
  naoAbre: number;
  /** Abre, mas é diferente do texto. */
  diferenteDoTexto: number;
  /** Deveria ter índice (valor canônico) e não tem. */
  semIndice: number;
  /** O índice gravado não é o recalculado com o time da linha (inclui cifrado transplantado entre times). */
  indiceErrado: number;
  ids: string[];
};

/** Confere cifrado e índice contra o texto. Não escreve nada e não imprime dado. */
export async function conferirContatosCifrados(opts: Omit<OpcoesLote, "aplicar"> = {}): Promise<ConferenciaDaTabela[]> {
  const lote = Math.max(1, opts.lote ?? 500);
  const limite = opts.limite ?? Number.POSITIVE_INFINITY;
  const out: ConferenciaDaTabela[] = [];
  for (const nome of opts.tabelas ?? TABELAS_CONTATO) {
    const spec = SPECS[nome];
    const total = ((await basePrisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${tab(spec.tabela)} WHERE ${spec.base} ${filtroDoTime(opts.teamId)}`)[0]?.n) ?? 0;
    const c: ConferenciaDaTabela = { tabela: nome, total, semCifrado: 0, naoAbre: 0, diferenteDoTexto: 0, semIndice: 0, indiceErrado: 0, ids: [] };
    const marcar = (id: string) => {
      if (c.ids.length < 200 && !c.ids.includes(id)) c.ids.push(id);
    };
    let cursor = "";
    let vistas = 0;
    while (vistas < limite) {
      const linhas = await lerLote(spec, cursor, Math.min(lote, limite - vistas), opts.teamId, false);
      if (linhas.length === 0) break;
      cursor = linhas[linhas.length - 1]!.id;
      vistas += linhas.length;
      for (const l of linhas) {
        const ehLid = nome === "Conversation" && l.texto.toLowerCase().endsWith("@lid");
        if (!l.cifrado) {
          if (!ehLid) {
            c.semCifrado++;
            marcar(l.id);
          }
        } else {
          try {
            if (abrirContato(l.cifrado, spec.contexto) !== l.texto) {
              c.diferenteDoTexto++;
              marcar(l.id);
            }
          } catch {
            c.naoAbre++;
            marcar(l.id);
          }
        }
        if (spec.hash) {
          const esperado = derivadosDe(spec, l);
          const deveTer = esperado[spec.hash];
          if (!l.hash) {
            if (deveTer) {
              c.semIndice++;
              marcar(l.id);
            }
          } else {
            const rotulo = rotuloDe(spec, l);
            const aceitos = rotulo ? impressoesDeContato(l.teamId, rotulo.rotulo, rotulo.canonico) : [];
            if (!aceitos.includes(l.hash)) {
              c.indiceErrado++;
              marcar(l.id);
            }
          }
          if (spec.sufixo && l.extra === "whatsapp") {
            const canonico = canonicoDeContato("whatsapp", l.texto);
            const aceitosSfx = canonico ? impressoesDeSufixo(l.teamId, canonico) : [];
            if (!l.sufixo && aceitosSfx.length > 0 && l.hash) {
              c.semIndice++;
              marcar(l.id);
            } else if (l.sufixo && !aceitosSfx.includes(l.sufixo)) {
              c.indiceErrado++;
              marcar(l.id);
            }
          }
        }
      }
      await dormir(opts.pausaMs ?? 0);
    }
    out.push(c);
  }
  return out;
}

function rotuloDe(spec: Spec, l: LinhaLida): { rotulo: "whatsapp" | "email" | "lid"; canonico: string } | null {
  if (spec.tabela === "ChannelIdentifier") {
    const canal = l.extra === "email" ? "email" : "whatsapp";
    const canonico = canonicoDeContato(canal, l.texto);
    return canonico ? { rotulo: canal, canonico } : null;
  }
  const lid = canonicoDeContato("lid", l.texto);
  if (lid) return { rotulo: "lid", canonico: lid };
  const tel = canonicoDeContato("whatsapp", l.texto);
  return tel ? { rotulo: "whatsapp", canonico: tel } : null;
}

// ---------------------------------------------------------------------------
// Reversão
// ---------------------------------------------------------------------------

export type ResumoDaReversao = { tabela: TabelaContato; comCamposNovos: number; zeradas: number };

/**
 * Volta atrás do preenchimento: zera `*Cifrado`, `*Hash` e `*SufixoHash`. O texto puro nunca foi tocado,
 * então nada se perde. Simula por padrão. Em lotes, sem mexer em `updatedAt`.
 */
export async function reverterContatosCifrados(opts: OpcoesLote = {}): Promise<ResumoDaReversao[]> {
  const aplicar = opts.aplicar === true;
  const lote = Math.max(1, opts.lote ?? 1000);
  const pausa = opts.pausaMs ?? 50;
  const log = opts.log ?? (() => undefined);
  const out: ResumoDaReversao[] = [];
  for (const nome of opts.tabelas ?? TABELAS_CONTATO) {
    const spec = SPECS[nome];
    const colunas = [spec.cifrado, spec.hash, spec.sufixo].filter((x): x is string => !!x);
    const algum = Prisma.join(colunas.map((c) => Prisma.sql`${col(c)} IS NOT NULL`), " OR ");
    const zerar = Prisma.join(colunas.map((c) => Prisma.sql`${col(c)} = NULL`));
    const time = filtroDoTime(opts.teamId);
    const n = ((await basePrisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM ${tab(spec.tabela)} WHERE (${algum}) ${time}`)[0]?.n) ?? 0;
    let zeradas = 0;
    if (aplicar) {
      for (;;) {
        const feitas = await basePrisma.$executeRaw`
          UPDATE ${tab(spec.tabela)} SET ${zerar}
          WHERE "id" IN (SELECT "id" FROM ${tab(spec.tabela)} WHERE (${algum}) ${time} ORDER BY "id" LIMIT ${lote})`;
        if (feitas === 0) break;
        zeradas += feitas;
        log(`${nome}: ${zeradas} linha(s) zeradas`);
        await dormir(pausa);
      }
    }
    out.push({ tabela: nome, comCamposNovos: n, zeradas });
  }
  return out;
}

/** Contagem de textos que parecem telefone no lugar do nome do contato (para decidir a limpeza do histórico). */
export async function contarNomesQueSaoTelefone(teamId?: string): Promise<number> {
  const n = ((await basePrisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "Contact"
    WHERE btrim("nome") ~ '^[+0-9 ().-]+$' AND length(regexp_replace("nome", '\\D', '', 'g')) >= 8 ${filtroDoTime(teamId)}`)[0]?.n) ?? 0;
  return n;
}
