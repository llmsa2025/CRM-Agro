import { z } from "zod";
import { basePrisma, db, getCurrentTeamId, TenantContextRequiredError } from "@crmagro/db";
import { getActor, requireCan } from "../auth/authz";
import { escopoDoAtor } from "../tenancy/escopo";
import type { ModuloComDono } from "../auth/modulos";
import { assertOwned, assertOwnedMany, OwnedNotFound } from "../tenancy/assert-owned";
import { invalidarPainel } from "../dashboard/cache";
import { invalidarNaoLidas } from "../conversations/ultima-mensagem";

/**
 * Dono dos registros (plano-equipe-permissoes F3d/F4).
 *
 * - "Transferir dono": o administrador redistribui contatos (com os negócios
 *   deles), negócios e números para outra pessoa ATIVA do time. É assim que a
 *   base antiga (toda do master depois do backfill) chega aos vendedores.
 * - "Compartilhar com o time": o dono (ou quem vê tudo) abre um contato, fluxo
 *   ou campanha para o time todo — ou fecha de novo ("Só eu").
 *
 * Tudo filtra pelo time do contexto (extensão + `teamId` explícito no
 * `basePrisma`); ids vindos da tela passam por zod e por `assertOwned*`.
 */

const idSchema = z.string().uuid();
const idsSchema = z.array(idSchema).min(1).max(5000);
/** Redistribuir a base inteira ("todos do filtro"): até 200 mil, em lotes. */
const muitosIdsSchema = z.array(idSchema).min(1).max(200_000);
/** Tamanho do lote de cada transação da transferência de contatos. */
export const LOTE_TRANSFERENCIA = 5000;

/** Destino da transferência não é uma pessoa ativa deste time. */
export class DestinoDaTransferenciaInvalido extends Error {
  constructor(id: string) {
    super(`DestinoDaTransferenciaInvalido: ${id} não é uma pessoa ativa deste time.`);
    this.name = "DestinoDaTransferenciaInvalido";
  }
}

/** Só o dono do registro (ou quem vê tudo) compartilha ou fecha. */
export class SoODonoCompartilha extends Error {
  constructor() {
    super("SoODonoCompartilha: só quem é dono do registro (ou o administrador) pode mudar o compartilhamento.");
    this.name = "SoODonoCompartilha";
  }
}

function timeDoContexto(onde: string): string {
  const teamId = getCurrentTeamId();
  if (!teamId) throw new TenantContextRequiredError(onde, "User");
  return teamId;
}

/** A pessoa que recebe: do time, ativa. Mesma resposta para "não existe" e "é de outro time". */
async function pessoaAtiva(teamId: string, id: string): Promise<string> {
  const p = idSchema.safeParse(id);
  if (!p.success) throw new DestinoDaTransferenciaInvalido(String(id));
  const u = await basePrisma.user.findFirst({ where: { id: p.data, teamId, desativadoEm: null }, select: { id: true } });
  if (!u) throw new DestinoDaTransferenciaInvalido(p.data);
  return u.id;
}

function idsValidos(ids: string[], modelo: "contact" | "deal"): string[] {
  const r = idsSchema.safeParse(ids);
  if (!r.success) throw new OwnedNotFound(modelo, ids.map(String).slice(0, 5));
  return [...new Set(r.data)];
}

export type ResultadoDaTransferencia = { contatos: number; negocios: number };

/**
 * Transfere contatos para `para`. Com `levarNegocios` (padrão), os negócios de
 * cada contato que eram do MESMO dono antigo (ou sem dono) vão junto — o
 * negócio que um colega abriu num contato compartilhado continua dele.
 */
export async function transferirContatos(
  ids: string[],
  para: string,
  opts: { levarNegocios?: boolean; lote?: number } = {},
): Promise<ResultadoDaTransferencia> {
  requireCan("records.transfer");
  const prisma = db();
  const teamId = timeDoContexto("transferirContatos");
  const r0 = muitosIdsSchema.safeParse(ids);
  if (!r0.success) throw new OwnedNotFound("contact", ids.map(String).slice(0, 5));
  const lista = [...new Set(r0.data)];
  const destino = await pessoaAtiva(teamId, para);

  // "Todos do filtro" pode ser a base inteira (a redistribuição depois do
  // backfill): lotes de 5 mil, uma transação cada (revisão do #154 — acima de
  // 5 mil recusava com "contato não encontrado"). Repetir é seguro: o que já
  // foi transferido só é regravado com o mesmo dono.
  const tamanho = Math.max(1, opts.lote ?? LOTE_TRANSFERENCIA);
  const total: ResultadoDaTransferencia = { contatos: 0, negocios: 0 };
  try {
    for (let i = 0; i < lista.length; i += tamanho) {
      const bloco = lista.slice(i, i + tamanho);
      await assertOwnedMany("contact", bloco);
      const r = await prisma.$transaction(
        async (tx) => {
          // O dono antigo é lido DENTRO da transação (dois admins ao mesmo tempo).
          const antes = await tx.contact.findMany({ where: { id: { in: bloco } }, select: { id: true, ownerId: true } });
          const porDono = new Map<string | null, string[]>();
          for (const c of antes) {
            const doDono = porDono.get(c.ownerId);
            if (doDono) doDono.push(c.id);
            else porDono.set(c.ownerId, [c.id]);
          }
          const contatos = (await tx.contact.updateMany({ where: { id: { in: bloco } }, data: { ownerId: destino } })).count;
          let negocios = 0;
          if (opts.levarNegocios !== false) {
            for (const [donoAntigo, doDono] of porDono) {
              negocios += (
                await tx.deal.updateMany({
                  where: { contactId: { in: doDono }, OR: [{ ownerId: donoAntigo }, { ownerId: null }] },
                  data: { ownerId: destino },
                })
              ).count;
            }
          }
          return { contatos, negocios };
        },
        { timeout: 30_000 },
      );
      total.contatos += r.contatos;
      total.negocios += r.negocios;
    }
  } finally {
    // Mesmo com falha num lote, os anteriores ficaram gravados: o Painel relê.
    await invalidarPainel(teamId);
  }
  return total;
}

/** Transfere negócios (cards do funil) para `para`. */
export async function transferirNegocios(ids: string[], para: string): Promise<{ negocios: number }> {
  requireCan("records.transfer");
  const prisma = db();
  const teamId = timeDoContexto("transferirNegocios");
  const lista = idsValidos(ids, "deal");
  const destino = await pessoaAtiva(teamId, para);
  await assertOwnedMany("deal", lista);
  const { count } = await prisma.deal.updateMany({ where: { id: { in: lista } }, data: { ownerId: destino } });
  await invalidarPainel(teamId);
  return { negocios: count };
}

/**
 * Passa um número (WhatsApp/e-mail/rede social) para `para`: a pessoa passa a
 * ver as conversas dele (decisão do dono: quem conectou + master/admin + "ver
 * tudo"). É assim que o admin conecta o número de um vendedor e o entrega.
 */
export async function transferirCanal(id: string, para: string): Promise<void> {
  requireCan("records.transfer");
  const prisma = db();
  const teamId = timeDoContexto("transferirCanal");
  const conta = idSchema.safeParse(id);
  if (!conta.success) throw new OwnedNotFound("channelAccount", [String(id)]);
  const destino = await pessoaAtiva(teamId, para);
  await assertOwned("channelAccount", conta.data);
  await prisma.channelAccount.update({ where: { id: conta.data }, data: { ownerId: destino } });
  await invalidarNaoLidas(teamId); // o badge de cada um muda
}

export type Compartilhavel = "contact" | "flow" | "campaign";

const ACAO_DO_TIPO: Record<Compartilhavel, string> = {
  contact: "contacts.write",
  flow: "flows.write",
  campaign: "campaigns.write",
};
/** Tela de cada tipo: o "editar tudo" que vale para fechar o registro alheio. */
const TELA_DO_TIPO: Record<Compartilhavel, ModuloComDono> = {
  contact: "contatos",
  flow: "fluxos",
  campaign: "campanhas",
};

/**
 * "Compartilhar com o time" / "Só eu" (F4). Só o dono do registro ou quem
 * EDITA tudo na tela ("Ver e editar de todos"); quem só enxerga ("Ver de
 * todos" ou porque está compartilhado) não fecha o registro alheio.
 */
export async function definirCompartilhado(tipo: Compartilhavel, id: string, compartilhado: boolean): Promise<void> {
  requireCan(ACAO_DO_TIPO[tipo]);
  const prisma = db();
  const teamId = timeDoContexto("definirCompartilhado");
  const alvo = idSchema.safeParse(id);
  if (!alvo.success) throw new OwnedNotFound(tipo, [String(id)]);
  await assertOwned(tipo, alvo.data); // existe no time e no escopo de escrita
  const e = escopoDoAtor(TELA_DO_TIPO[tipo], { escrita: true });
  if (!e.tudo) {
    const eu = getActor()?.userId;
    const dono =
      tipo === "contact"
        ? (await prisma.contact.findUnique({ where: { id: alvo.data }, select: { ownerId: true } }))?.ownerId
        : tipo === "flow"
          ? (await prisma.flow.findUnique({ where: { id: alvo.data }, select: { createdById: true } }))?.createdById
          : (await prisma.campaign.findUnique({ where: { id: alvo.data }, select: { createdById: true } }))?.createdById;
    if (!eu || dono !== eu) throw new SoODonoCompartilha();
  }
  const data = { compartilhado: Boolean(compartilhado) };
  if (tipo === "contact") await prisma.contact.update({ where: { id: alvo.data }, data });
  else if (tipo === "flow") await prisma.flow.update({ where: { id: alvo.data }, data });
  else await prisma.campaign.update({ where: { id: alvo.data }, data });
  if (tipo === "contact") await invalidarPainel(teamId);
}

export type PessoaDoTime = { id: string; nome: string; email: string; ativo: boolean };

/**
 * Pessoas do time para os seletores "Transferir para" e "Por vendedor" da tela
 * `modulo`. Quem vê tudo NESSA tela recebe a equipe; os demais, só a si mesmos
 * (não descobrem o time).
 */
export async function listarPessoasDoTime(modulo: ModuloComDono): Promise<PessoaDoTime[]> {
  const teamId = timeDoContexto("listarPessoasDoTime");
  const actor = getActor();
  if (!actor || actor.system) return [];
  const e = escopoDoAtor(modulo);
  const rows = await basePrisma.user.findMany({
    where: { teamId, ...(e.tudo ? {} : { id: actor.userId }) },
    orderBy: [{ desativadoEm: { sort: "asc", nulls: "first" } }, { name: "asc" }],
    select: { id: true, name: true, email: true, desativadoEm: true },
  });
  return rows.map((u) => ({ id: u.id, nome: u.name ?? u.email, email: u.email, ativo: u.desativadoEm === null }));
}
