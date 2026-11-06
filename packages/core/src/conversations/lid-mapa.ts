import type { Prisma } from "@prisma/client";
import { ehJidLid, normalizePhone, type ParLid } from "@crmagro/channels";
import { comCamposCifrados } from "@crmagro/db";
import { logger } from "../logger/index";
import { numeroDe } from "../contacts/identificadores-cifra";

/**
 * Mapa "código anônimo do WhatsApp (@lid) → telefone" por time (tabela
 * `WhatsAppLid`). Leitura e gravação em lote, com o `teamId` SEMPRE explícito:
 * quem chama vem de contextos diferentes (webhook e ação da tela, com o time no
 * contexto; importador do histórico, que roda pelo `basePrisma` com o time do
 * job). Por isso recebe o cliente (`basePrisma` ou o `tx` de uma transação).
 *
 * Por que existe: a documentação interna.
 */

/** Como o par foi descoberto (coluna `origem`). */
export type OrigemParLid = "webhook" | "evolution" | "historico" | "manual";

type Cliente = Pick<Prisma.TransactionClient, "whatsAppLid">;

/**
 * Quem pode trocar o telefone de um par que já existe:
 * - "historico" (linha ANTIGA do banco da Evolution) só cria; nunca troca um par
 *   que já está gravado (o mais novo vale, e o antigo pode ser de outro dono do número);
 * - "manual" (a pessoa unificou pela tela) nunca sobrescreve um par que veio da
 *   própria Evolution: o palpite de uma pessoa não vale mais que o dado do
 *   WhatsApp. O contrário vale (a Evolution corrige um par manual errado).
 */
function podeSobrescrever(nova: OrigemParLid, atual: string): boolean {
  if (nova === "historico") return false;
  return nova !== "manual" || atual === "manual";
}

/** Só o fim do código nos logs (o @lid é anônimo, mas não precisa ir inteiro para o log). */
export function lidResumido(lid: string): string {
  const d = lid.replace(/@.+$/, "");
  return `…${d.slice(-4)}`;
}

/** Par válido: `…@lid` de verdade e telefone E.164 que passa na normalização. */
function parValido(p: ParLid): ParLid | null {
  const telefone = normalizePhone(p.telefone);
  return ehJidLid(p.lid) && telefone ? { lid: p.lid, telefone } : null;
}

/** Telefone de cada @lid conhecido no time (o que não está no mapa não aparece). */
export async function lerParesLid(
  cliente: Cliente,
  teamId: string,
  lids: readonly string[],
): Promise<Map<string, { telefone: string; origem: string }>> {
  const unicos = [...new Set(lids.filter(ehJidLid))];
  if (!teamId || unicos.length === 0) return new Map();
  const linhas = await cliente.whatsAppLid.findMany({
    where: { teamId, lid: { in: unicos } },
    select: { lid: true, telefone: true, telefoneCifrado: true, origem: true },
  });
  // Telefone legível: do valor cifrado quando a cifra dos contatos está em indice/ligada.
  return new Map(linhas.map((l) => [l.lid, { telefone: numeroDe(l, "telefone", "whatsappLid") ?? l.telefone, origem: l.origem }]));
}

/**
 * Grava pares no mapa do time. Idempotente: par igual não escreve nada; o mesmo
 * @lid com OUTRO telefone é atualizado (o @lid segue a conta do WhatsApp, o
 * telefone pode ter mudado de dono), com aviso no log — salvo a regra do
 * "manual" acima. Devolve quantos pares foram criados ou trocados.
 */
export async function gravarParesLid(
  cliente: Cliente,
  teamId: string,
  pares: readonly ParLid[],
  origem: OrigemParLid,
): Promise<number> {
  if (!teamId) return 0;
  // Um por @lid (o último da lista vale) e só pares válidos.
  const porLid = new Map<string, ParLid>();
  for (const p of pares) {
    const v = parValido(p);
    if (v) porLid.set(v.lid, v);
  }
  if (porLid.size === 0) return 0;
  const atuais = await lerParesLid(cliente, teamId, [...porLid.keys()]);
  const criar: Prisma.WhatsAppLidCreateManyInput[] = [];
  let trocados = 0;
  for (const p of porLid.values()) {
    const atual = atuais.get(p.lid);
    if (!atual) {
      // `cliente` pode ser o basePrisma (sem a extensão da cifra): preenche cifrado e índice aqui.
      criar.push(comCamposCifrados("whatsAppLid", teamId, { teamId, lid: p.lid, telefone: p.telefone, origem }));
    } else if (atual.telefone !== p.telefone && podeSobrescrever(origem, atual.origem)) {
      const r = await cliente.whatsAppLid.updateMany({
        where: { teamId, lid: p.lid },
        data: comCamposCifrados("whatsAppLid", teamId, { telefone: p.telefone, origem }),
      });
      trocados += r.count;
      logger.warn({ teamId, lid: lidResumido(p.lid), origem }, "[wa-lid] o @lid passou a apontar para outro telefone");
    }
  }
  // skipDuplicates: duas entregas do mesmo par ao mesmo tempo não brigam.
  const criados = criar.length ? (await cliente.whatsAppLid.createMany({ data: criar, skipDuplicates: true })).count : 0;
  return criados + trocados;
}
