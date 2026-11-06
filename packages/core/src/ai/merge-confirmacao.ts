import { randomInt } from "node:crypto";
import { db, getCurrentTeamId, getCurrentUserId } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { assertOwnedMany } from "../tenancy/assert-owned";
import { mergeContacts } from "../contacts/service";
import { primaryEmail, primaryTelefone } from "../contacts/identifiers";
import { redisEstado } from "../shared/redis-cache";

/**
 * `merge_contacts` da IA em DUAS fases (item 3.5, INT-23/S16).
 *
 * Unificar apaga os duplicados — é irreversível. Antes, uma página maliciosa no
 * resultado do `web_search` podia induzir a IA a fundir contatos em massa sem
 * ninguém ver. Agora:
 *  1. a IA pede a PRÉVIA: o que fica, o que some, e um código de 6 letras
 *     guardado no Redis por 15 min (no máx. 5 duplicados por vez);
 *  2. só funde quando a mensagem do USUÁRIO (a última `user` da conversa, que só
 *     ele escreve) traz o código, numa rodada POSTERIOR à que gerou a prévia, e
 *     pelo mesmo usuário. keepId/dropIds saem do registro guardado, não do que a
 *     IA mandar na 2ª chamada.
 * Assim nenhum conteúdo de terceiros consegue confirmar sozinho.
 */

export const MERGE_MAX_DROPS = 5;
const TTL_S = 15 * 60;
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I (o usuário digita)

export class MergeRecusado extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeRecusado";
  }
}

/** Contexto da rodada do agente (vem do runAgent). */
export type ContextoMerge = {
  /** Id da rodada (o streamId do job): a confirmação não pode vir da mesma. */
  execId: string;
  /** Última mensagem `user` da conversa — escrita pelo humano. */
  ultimaMensagemDoUsuario: string;
};

type Pendente = { keepId: string; dropIds: string[]; userId: string | null; execId: string };

const chave = (teamId: string, codigo: string) => `ai:merge:${teamId}:${codigo}`;

function timeAtual(): string {
  const teamId = getCurrentTeamId();
  if (!teamId) throw new MergeRecusado("sem time no contexto");
  return teamId;
}

function gerarCodigo(): string {
  let c = "";
  for (let i = 0; i < 6; i++) c += ALFABETO[randomInt(ALFABETO.length)];
  return c;
}

/** Fase 1: valida, monta a prévia e guarda o pedido pendente. Não escreve nada. */
export async function proporMerge(keepId: string, dropIdsBrutos: string[], ctx: ContextoMerge) {
  requireCan("contacts.merge");
  const teamId = timeAtual();
  if (!keepId) throw new MergeRecusado("keepId vazio");
  const dropIds = [...new Set(dropIdsBrutos.map(String))].filter((d) => d && d !== keepId);
  if (dropIds.length === 0) throw new MergeRecusado("dropIds vazio");
  if (dropIds.length > MERGE_MAX_DROPS) {
    throw new MergeRecusado(`no máximo ${MERGE_MAX_DROPS} duplicados por vez (vieram ${dropIds.length})`);
  }
  await assertOwnedMany("contact", [keepId, ...dropIds]);

  const prisma = db();
  const contatos = await prisma.contact.findMany({
    where: { id: { in: [keepId, ...dropIds] } },
    select: { id: true, nome: true, empresa: true, cidade: true, estado: true, identifiers: true },
  });
  const resumo = (id: string) => {
    const c = contatos.find((x) => x.id === id)!;
    return {
      id: c.id,
      nome: c.nome,
      empresa: c.empresa,
      local: [c.cidade, c.estado].filter(Boolean).join("/") || null,
      telefone: primaryTelefone(c.identifiers),
      email: primaryEmail(c.identifiers),
    };
  };

  const codigo = gerarCodigo();
  const pendente: Pendente = { keepId, dropIds, userId: getCurrentUserId(), execId: ctx.execId };
  await redisEstado().set(chave(teamId, codigo), JSON.stringify(pendente), "EX", TTL_S);

  return {
    precisaConfirmacao: true,
    codigo,
    manter: resumo(keepId),
    fundirEApagar: dropIds.map(resumo),
    instrucao:
      `NADA foi unificado ainda. Mostre esta prévia ao usuário e peça que ele responda "confirmar ${codigo}" ` +
      "se concordar. Só chame merge_contacts com `confirmacao` depois que a mensagem DELE trouxer o código.",
  };
}

/** Fase 2: confere o código na mensagem do usuário e só então unifica. */
export async function confirmarMerge(codigoBruto: string, ctx: ContextoMerge) {
  requireCan("contacts.merge");
  const teamId = timeAtual();
  const codigo = codigoBruto.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(codigo)) throw new MergeRecusado("código de confirmação inválido");

  const r = redisEstado();
  const bruto = await r.get(chave(teamId, codigo));
  if (!bruto) throw new MergeRecusado("confirmação inválida ou expirada: gere a prévia de novo");
  const p = JSON.parse(bruto) as Pendente;

  if (p.execId === ctx.execId) {
    throw new MergeRecusado("a confirmação precisa vir do usuário, numa nova mensagem: mostre a prévia e aguarde");
  }
  if (p.userId && p.userId !== getCurrentUserId()) {
    throw new MergeRecusado("a prévia foi pedida por outro usuário");
  }
  if (!new RegExp(`(^|[^A-Z0-9])${codigo}([^A-Z0-9]|$)`, "i").test(ctx.ultimaMensagemDoUsuario)) {
    throw new MergeRecusado(`o usuário ainda não confirmou: peça que ele responda "confirmar ${codigo}"`);
  }
  // Consome uma vez só (duas rodadas simultâneas: só a que apagar funde).
  if ((await r.del(chave(teamId, codigo))) !== 1) throw new MergeRecusado("confirmação já usada");

  await mergeContacts(p.keepId, p.dropIds);
  return { ok: true, keepId: p.keepId, merged: p.dropIds.length };
}
