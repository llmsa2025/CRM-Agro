import { Prisma } from "@prisma/client";
import { db } from "@crmagro/db";
import { env } from "@crmagro/config";
import { checkWhatsAppNumbers, normalizePhone, WHATSAPP_NUMBERS_LOTE } from "@crmagro/channels";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import { assertOwned, OwnedNotFound } from "../tenancy/assert-owned";

/**
 * "Tem WhatsApp?" SEM ENVIAR (Campanhas A.4). Base da classificação "sem
 * WhatsApp" da lista da campanha (A.2) e, depois, da captação e do "Revisar
 * dados".
 *
 * 1. Cache GLOBAL `WhatsAppNumberCheck` primeiro (30 dias; sem time e sem nome).
 * 2. Só o número sem checagem válida vai à Evolution, pela instância da conta
 *    WhatsApp DO PRÓPRIO TIME (conferida no banco — instância de outro time é
 *    `OwnedNotFound`), em lotes de 50 com pausa entre eles e teto diário por
 *    conta: muita consulta seguida é sinal de robô para o WhatsApp.
 * 3. Conta desconectada/pausada, teto do dia, Evolution fora → `existe: null`
 *    ("não deu para saber"): a lista NÃO descarta o número.
 *
 * NUNCA envia mensagem nem abre conversa: o único endpoint usado é
 * `/chat/whatsappNumbers`.
 */

/** Validade de uma checagem "tem WhatsApp" no cache. */
export const VALIDADE_CHECAGEM_DIAS = 30;
/**
 * Validade de um "NÃO tem WhatsApp": menor, porque um `false` errado tira o
 * número da campanha de TODOS os times (o cache é global).
 */
export const VALIDADE_SEM_WHATSAPP_DIAS = 7;
/**
 * Lote com pelo menos isto de números e 100% "não tem" é SUSPEITO: é a cara de
 * uma sessão meio caída/restrita que responde tudo `false`. Não vai para o cache
 * e volta como "não deu para saber" (`existe: null`) também para quem perguntou
 * — o número fica na fila da campanha e o envio descobre.
 *
 * Falso positivo aceito: uma lista só de telefones FIXOS (comum na captação por
 * CNPJ) dá lotes legítimos 100% "não tem"; eles ficam como "não sei" e são
 * consultados de novo a cada lista (gastando o teto diário da conta).
 */
export const LOTE_SUSPEITO_MIN = 20;
/** Motivo do `CampaignRecipient` pulado por não ter WhatsApp (contrato do A.1). */
export const MOTIVO_SEM_WHATSAPP = "sem WhatsApp";

/** Resultado por número (chave = E.164 do `normalizePhone`). */
export type ResultadoTemWhatsApp = {
  /** true/false = resposta do WhatsApp (cache ou consulta); null = não deu para saber. */
  existe: boolean | null;
  /** Nome que a instância do time conhece — só na consulta nova (o cache não guarda nome). */
  nome: string | null;
};

export type OpcoesTemWhatsApp = {
  /** Instância da Evolution da conta do time (contrato do A.1). */
  instance?: string | null;
  /** Ou a conta WhatsApp do time (tem precedência sobre `instance`). */
  channelAccountId?: string | null;
};

const DIA_MS = 24 * 60 * 60_000;
const TAMANHO_BUSCA_CACHE = 1000;

/** Pausa base entre lotes à Evolution (sorteia entre 1× e 1,5×). */
function pausaEntreLotesMs(): number {
  const n = Number(process.env.WA_CHECAGEM_PAUSA_MS ?? 2000);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}
/** Números consultados por conta por dia (UTC). */
function tetoDiario(): number {
  const n = Number(process.env.WA_CHECAGEM_DIA ?? 1000);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}
const chaveDoDia = (accountId: string, agora: Date) => `wa:checagem:${accountId}:${agora.toISOString().slice(0, 10)}`;

/** Instância da Evolution de uma conta WhatsApp (a coluna nova primeiro, o JSON antigo depois). */
export function instanciaDaConta(conta: { externalId?: string | null; credentials?: unknown }): string | null {
  return conta.externalId ?? (conta.credentials as { instance?: string } | null)?.instance ?? null;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Conta WhatsApp (Evolution) do time pela qual a consulta sai. */
type ContaDaConsulta = { id: string; instance: string; utilizavel: boolean };

async function contaDoTime(opts: OpcoesTemWhatsApp): Promise<ContaDaConsulta | null> {
  const prisma = db();
  const select = { id: true, provider: true, canal: true, externalId: true, credentials: true, status: true, paused: true } as const;
  let conta;
  if (opts.channelAccountId) {
    await assertOwned("channelAccount", opts.channelAccountId);
    conta = await prisma.channelAccount.findUnique({ where: { id: opts.channelAccountId }, select });
  } else if (opts.instance) {
    // A extensão de tenancy filtra pelo time: instância de outro time não acha.
    conta = await prisma.channelAccount.findFirst({
      where: {
        provider: "evolution",
        OR: [{ externalId: opts.instance }, { credentials: { path: ["instance"], equals: opts.instance } }],
      },
      select,
    });
    if (!conta) throw new OwnedNotFound("channelAccount", [opts.instance]);
  } else {
    return null;
  }
  if (!conta || conta.provider !== "evolution" || conta.canal !== "whatsapp") return null;
  const instance = instanciaDaConta(conta);
  if (!instance) return null;
  return { id: conta.id, instance, utilizavel: conta.status === "connected" && !conta.paused };
}

/**
 * Reserva `n` consultas no teto do dia da conta. Devolve quantas couberam.
 * Redis fora → libera (a Evolution também depende da rede; não é aqui que a
 * campanha deve parar).
 */
export async function reservarNoTeto(accountId: string, n: number, agora: Date): Promise<number> {
  const teto = tetoDiario();
  try {
    const r = redisEstado();
    const k = chaveDoDia(accountId, agora);
    // Incremento e prazo juntos (MULTI): a chave nunca fica sem TTL.
    const res = await r.multi().incrby(k, n).pexpire(k, 2 * DIA_MS, "NX").exec();
    const total = Number(res?.[0]?.[1]);
    if (!Number.isFinite(total)) throw new Error("resposta inesperada do Redis");
    if (total <= teto) return n;
    const cabe = Math.max(0, n - (total - teto));
    await r.decrby(k, n - cabe);
    return cabe;
  } catch (e) {
    logger.warn({ accountId, err: e instanceof Error ? e.message : String(e) }, "[tem-whatsapp] teto diário indisponível — liberando");
    return n;
  }
}

/**
 * Devolve ao teto do dia `n` consultas que não chegaram a ser feitas (a Evolution não respondeu). Melhor esforço:
 * Redis fora não atrapalha quem chamou.
 */
export async function devolverAoTeto(accountId: string, n: number, agora: Date): Promise<void> {
  try {
    const r = redisEstado();
    const k = chaveDoDia(accountId, agora);
    // Só devolve onde há o que devolver: a unidade pode ter sido paga em outro dia (UTC), e `DECRBY` numa chave que
    // não existe a criaria negativa e sem prazo, aumentando o teto daquele dia.
    if (Number(await r.get(k)) >= n) await r.decrby(k, n);
  } catch {
    /* o teto é uma proteção; não derruba quem chamou */
  }
}

/**
 * Lê o cache global: só checagem dentro da validade (30 dias o "tem", 7 o "não tem"). Devolve o que achou, por número
 * E.164; número sem checagem válida fica fora do mapa.
 */
export async function lerDoCache(numeros: readonly string[], agora: Date): Promise<Map<string, boolean>> {
  const achou = new Map<string, boolean>();
  const desdeTem = new Date(agora.getTime() - VALIDADE_CHECAGEM_DIAS * DIA_MS);
  const desdeSem = new Date(agora.getTime() - VALIDADE_SEM_WHATSAPP_DIAS * DIA_MS);
  const prisma = db();
  for (let i = 0; i < numeros.length; i += TAMANHO_BUSCA_CACHE) {
    const achados = await prisma.whatsAppNumberCheck.findMany({
      where: {
        numero: { in: numeros.slice(i, i + TAMANHO_BUSCA_CACHE) },
        OR: [
          { existe: true, checkedAt: { gte: desdeTem } },
          { existe: false, checkedAt: { gte: desdeSem } },
        ],
      },
      select: { numero: true, existe: true },
    });
    for (const a of achados) achou.set(a.numero, a.existe);
  }
  return achou;
}

/** Grava as respostas no cache global (upsert em uma ida; tabela sem time). */
export async function gravarNoCache(itens: { numero: string; existe: boolean; jid: string | null }[], agora: Date): Promise<void> {
  if (itens.length === 0) return;
  const valores = itens.map((i) => Prisma.sql`(${i.numero}, ${i.existe}, ${i.jid}, ${agora})`);
  await db().$executeRaw`
    INSERT INTO "WhatsAppNumberCheck" ("numero", "existe", "jid", "checkedAt")
    VALUES ${Prisma.join(valores)}
    ON CONFLICT ("numero") DO UPDATE
      SET "existe" = EXCLUDED."existe", "jid" = EXCLUDED."jid", "checkedAt" = EXCLUDED."checkedAt"`;
}

/**
 * "Tem WhatsApp?" para uma lista de números (qualquer formato). Chave do mapa =
 * E.164 do `normalizePhone`; número que não normaliza fica FORA do mapa (a lista
 * já o trata como inválido).
 */
export async function temWhatsApp(
  numeros: readonly string[],
  opts: OpcoesTemWhatsApp = {},
): Promise<Map<string, ResultadoTemWhatsApp>> {
  requireCan("messages.send");
  const agora = new Date();
  const unicos = [...new Set(numeros.map((n) => normalizePhone(n)).filter((n): n is string => !!n))];
  const out = new Map<string, ResultadoTemWhatsApp>(unicos.map((n) => [n, { existe: null, nome: null }]));
  if (unicos.length === 0) return out;

  // 1) Cache global (só checagem dentro da validade: 30 dias o "tem", 7 o "não tem").
  for (const [numero, existe] of await lerDoCache(unicos, agora)) out.set(numero, { existe, nome: null });
  const faltam = unicos.filter((n) => out.get(n)!.existe === null);
  if (faltam.length === 0) return out;

  // 2) Consulta nova, pela conta do time.
  const conta = await contaDoTime(opts);
  if (!conta || !conta.utilizavel) {
    if (conta) logger.info({ accountId: conta.id, faltam: faltam.length }, "[tem-whatsapp] conta desconectada/pausada — só o cache");
    return out;
  }
  let consultados = 0;
  for (let i = 0; i < faltam.length; i += WHATSAPP_NUMBERS_LOTE) {
    if (i > 0) {
      const base = pausaEntreLotesMs();
      await dormir(base + Math.round(Math.random() * base * 0.5));
    }
    const lote = faltam.slice(i, i + WHATSAPP_NUMBERS_LOTE);
    const cabe = await reservarNoTeto(conta.id, lote.length, agora);
    if (cabe === 0) {
      logger.warn({ accountId: conta.id, restantes: faltam.length - i }, "[tem-whatsapp] teto diário de consultas da conta — o resto fica sem resposta");
      break;
    }
    const pedido = lote.slice(0, cabe);
    let respostas;
    try {
      respostas = await checkWhatsAppNumbers({
        apiUrl: env.EVOLUTION_API_URL,
        apiKey: env.EVOLUTION_API_KEY,
        instance: conta.instance,
        numbers: pedido,
      });
    } catch (e) {
      // Evolution fora/lenta: para de insistir (o resto fica "não sei").
      logger.warn({ accountId: conta.id, err: e instanceof Error ? e.message : String(e) }, "[tem-whatsapp] Evolution não respondeu — o resto fica sem resposta");
      break;
    }
    consultados += pedido.length;
    if (respostas.length >= LOTE_SUSPEITO_MIN && respostas.every((r) => !r.existe)) {
      // Suspeito: nem cache nem "sem WhatsApp" para quem perguntou (fica null).
      logger.warn({ accountId: conta.id, lote: respostas.length }, "[tem-whatsapp] lote inteiro \"sem WhatsApp\" — resposta suspeita, tratada como \"não sei\"");
    } else {
      for (const r of respostas) out.set(r.numero, { existe: r.existe, nome: r.nome });
      await gravarNoCache(respostas.map((r) => ({ numero: r.numero, existe: r.existe, jid: r.jid })), agora);
    }
    if (cabe < lote.length) {
      logger.warn({ accountId: conta.id }, "[tem-whatsapp] teto diário de consultas da conta atingido");
      break;
    }
  }
  logger.info({ accountId: conta.id, pedidos: unicos.length, cache: unicos.length - faltam.length, consultados }, "[tem-whatsapp] checagem feita");
  return out;
}

/**
 * Para a lista da campanha (A.2): quais números são "sem WhatsApp" (resposta
 * certa de que NÃO têm). `existe: null` não entra — o número segue na fila.
 */
export async function numerosSemWhatsApp(
  numeros: readonly string[],
  opts: OpcoesTemWhatsApp = {},
): Promise<Set<string>> {
  const r = await temWhatsApp(numeros, opts);
  return new Set([...r].filter(([, v]) => v.existe === false).map(([n]) => n));
}
