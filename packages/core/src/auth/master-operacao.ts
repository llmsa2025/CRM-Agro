import type { Prisma } from "@prisma/client";
import { basePrisma } from "@crmagro/db";
import { forgetSessionCache } from "./session";
import { PERMISSOES_DE_EX_MASTER } from "./equipe";
import { invalidarPainel } from "../dashboard/cache";
import { invalidarNaoLidas } from "../conversations/ultima-mensagem";

/**
 * OPERAÇÃO (fora do barrel do core de propósito, como o `seed-time`): define o
 * MASTER de um time pelo e-mail e rebaixa os outros "owner" do time para
 * administrador. Escreve sem RBAC (não há sessão: quem roda é o dono da
 * plataforma, pelo `script de operação`). Importar só pelo
 * subcaminho `@crmagro/core/operacao`.
 *
 * Por que existe: antes do master único (28/09/2026) todo "owner" era master;
 * o seed e o script de criar usuário faziam nascer "owner" sem querer, e a
 * migration não inventa master onde há mais de um (backfill conservador).
 *
 * O que muda, numa transação:
 * - `Team.masterId` = a pessoa do e-mail; ela vira "owner" (sem telas nem
 *   listas — vê tudo);
 * - cada OUTRO "owner" do time vira administrador com `PERMISSOES_DE_EX_MASTER`
 *   (convidar + desativar; excluir só se o master liberar depois);
 * - com `transferirRegistros`: os registros que estão com esses "owner" passam
 *   para o master (os backfills de dono deram tudo ao "owner" MAIS ANTIGO, que
 *   pode não ser quem criou a empresa) — os mesmos campos que
 *   `excluirIntegrante` transfere, sempre com `teamId` explícito;
 * - quem mudou de papel tem as sessões derrubadas (`sessionVersion` + cache).
 */

export class MasterInvalido extends Error {
  constructor(motivo: string) {
    super(`MasterInvalido: ${motivo}`);
    this.name = "MasterInvalido";
  }
}

/**
 * Registros com dono que passam para o master (`--transferir-registros`). Cada
 * um: como contar e como transferir, de uma lista de donos para o master,
 * dentro do time. Mesmos campos de `excluirIntegrante` (auth/equipe.ts).
 */
type Tx = Prisma.TransactionClient | typeof basePrisma;
type Transferivel = {
  contar: (p: Tx, teamId: string, de: string) => Promise<number>;
  passar: (tx: Tx, teamId: string, de: string[], para: string) => Promise<number>;
};
const TRANSFERIVEIS = {
  contatos: {
    contar: (p, teamId, de) => p.contact.count({ where: { teamId, ownerId: de } }),
    passar: async (tx, teamId, de, para) => (await tx.contact.updateMany({ where: { teamId, ownerId: { in: de } }, data: { ownerId: para } })).count,
  },
  negocios: {
    contar: (p, teamId, de) => p.deal.count({ where: { teamId, ownerId: de } }),
    passar: async (tx, teamId, de, para) => (await tx.deal.updateMany({ where: { teamId, ownerId: { in: de } }, data: { ownerId: para } })).count,
  },
  canais: {
    contar: (p, teamId, de) => p.channelAccount.count({ where: { teamId, ownerId: de } }),
    passar: async (tx, teamId, de, para) => (await tx.channelAccount.updateMany({ where: { teamId, ownerId: { in: de } }, data: { ownerId: para } })).count,
  },
  ligacoes: {
    contar: (p, teamId, de) => p.call.count({ where: { teamId, userId: de } }),
    passar: async (tx, teamId, de, para) => (await tx.call.updateMany({ where: { teamId, userId: { in: de } }, data: { userId: para } })).count,
  },
  fluxos: {
    contar: (p, teamId, de) => p.flow.count({ where: { teamId, createdById: de } }),
    passar: async (tx, teamId, de, para) => (await tx.flow.updateMany({ where: { teamId, createdById: { in: de } }, data: { createdById: para } })).count,
  },
  campanhas: {
    contar: (p, teamId, de) => p.campaign.count({ where: { teamId, createdById: de } }),
    passar: async (tx, teamId, de, para) => (await tx.campaign.updateMany({ where: { teamId, createdById: { in: de } }, data: { createdById: para } })).count,
  },
  captacao: {
    contar: (p, teamId, de) => p.prospectDraft.count({ where: { teamId, ownerId: de } }),
    passar: async (tx, teamId, de, para) => (await tx.prospectDraft.updateMany({ where: { teamId, ownerId: { in: de } }, data: { ownerId: para } })).count,
  },
  importacoes: {
    contar: (p, teamId, de) => p.importJob.count({ where: { teamId, createdById: de } }),
    passar: async (tx, teamId, de, para) => (await tx.importJob.updateMany({ where: { teamId, createdById: { in: de } }, data: { createdById: para } })).count,
  },
  // O que veio da Agenda Google da pessoa e ela não confirmou fica com ela (só ela vê).
  compromissos: {
    contar: (p, teamId, de) => p.appointment.count({ where: { teamId, responsavelId: de, privadoAteConfirmar: false } }),
    passar: async (tx, teamId, de, para) =>
      (await tx.appointment.updateMany({ where: { teamId, responsavelId: { in: de }, privadoAteConfirmar: false }, data: { responsavelId: para } })).count,
  },
  metas: {
    contar: (p, teamId, de) => p.goal.count({ where: { teamId, ownerId: de } }),
    passar: async (tx, teamId, de, para) => (await tx.goal.updateMany({ where: { teamId, ownerId: { in: de } }, data: { ownerId: para } })).count,
  },
} satisfies Record<string, Transferivel>;
export type TipoDeRegistro = keyof typeof TRANSFERIVEIS;
export type ContagemDeRegistros = Record<TipoDeRegistro, number>;
const TIPOS = Object.keys(TRANSFERIVEIS) as TipoDeRegistro[];

type Conta = { id: string; email: string; role: string; permissoesEquipe: string[]; modulos: string[]; verTudoEm: string[]; sessionVersion: number };

export type PlanoDoMaster = {
  time: { id: string; nome: string; masterAtual: string | null };
  master: { id: string; email: string; papelAntes: string; mudaPapel: boolean };
  /** Os outros "owner" do time, que viram administrador, e os registros que estão com cada um. */
  rebaixar: { id: string; email: string; registros: ContagemDeRegistros }[];
  /** Passa os registros dos rebaixados para o master (`--transferir-registros`). */
  transferirRegistros: boolean;
  /** Já está tudo certo (master definido, papel "owner", nenhum outro "owner"). */
  nadaAFazer: boolean;
  /** Estado ANTES, das contas envolvidas e do time — para desfazer à mão. */
  antes: { em: string; time: { id: string; masterId: string | null }; contas: Conta[] };
};

const CAMPOS_CONTA = { id: true, email: true, role: true, permissoesEquipe: true, modulos: true, verTudoEm: true, sessionVersion: true } as const;

async function contarRegistros(teamId: string, de: string): Promise<ContagemDeRegistros> {
  const n = await Promise.all(TIPOS.map((t) => TRANSFERIVEIS[t].contar(basePrisma, teamId, de)));
  return Object.fromEntries(TIPOS.map((t, i) => [t, n[i]!])) as ContagemDeRegistros;
}

/** Lê o time da pessoa e monta o plano (não grava nada). */
export async function planejarMaster(emailBruto: string, opts: { transferirRegistros?: boolean } = {}): Promise<PlanoDoMaster> {
  const email = emailBruto.trim().toLowerCase();
  if (!email) throw new MasterInvalido("informe o e-mail do master.");
  const pessoa = await basePrisma.user.findUnique({
    where: { email },
    select: { ...CAMPOS_CONTA, teamId: true, desativadoEm: true, team: { select: { id: true, name: true, masterId: true } } },
  });
  if (!pessoa) throw new MasterInvalido(`não existe conta com o e-mail ${email}.`);
  if (pessoa.desativadoEm) throw new MasterInvalido(`${email} está desativado; reative antes de fazer dele o master.`);
  const outros = await basePrisma.user.findMany({
    where: { teamId: pessoa.teamId, role: "owner", id: { not: pessoa.id } },
    orderBy: { createdAt: "asc" },
    select: CAMPOS_CONTA,
  });
  const mudaPapel = pessoa.role !== "owner";
  const team = pessoa.team;
  const conta: Conta = {
    id: pessoa.id,
    email: pessoa.email,
    role: pessoa.role,
    permissoesEquipe: pessoa.permissoesEquipe,
    modulos: pessoa.modulos,
    verTudoEm: pessoa.verTudoEm,
    sessionVersion: pessoa.sessionVersion,
  };
  const rebaixar = [];
  for (const o of outros) rebaixar.push({ id: o.id, email: o.email, registros: await contarRegistros(team.id, o.id) });
  return {
    time: { id: team.id, nome: team.name, masterAtual: team.masterId },
    master: { id: pessoa.id, email: pessoa.email, papelAntes: pessoa.role, mudaPapel },
    rebaixar,
    transferirRegistros: Boolean(opts.transferirRegistros),
    nadaAFazer: !mudaPapel && team.masterId === pessoa.id && outros.length === 0,
    antes: { em: new Date().toISOString(), time: { id: team.id, masterId: team.masterId }, contas: [conta, ...outros] },
  };
}

/**
 * Grava o plano (ver o topo). Refaz o plano na hora e só rebaixa quem AINDA é
 * "owner" (duas execuções seguidas não fazem estrago). Devolve o plano e, com
 * `transferirRegistros`, quantos registros de cada tipo passaram para o master.
 */
export async function definirMaster(
  emailBruto: string,
  opts: { transferirRegistros?: boolean } = {},
): Promise<PlanoDoMaster & { transferidos: Partial<ContagemDeRegistros> }> {
  const plano = await planejarMaster(emailBruto, opts);
  if (plano.nadaAFazer) return { ...plano, transferidos: {} };
  const teamId = plano.time.id;
  const mudaram: string[] = [];
  const transferidos: Partial<ContagemDeRegistros> = {};
  await basePrisma.$transaction(
    async (tx) => {
      await tx.team.update({ where: { id: teamId }, data: { masterId: plano.master.id } });
      if (plano.master.mudaPapel) {
        await tx.user.update({
          where: { id: plano.master.id },
          data: { role: "owner", permissoesEquipe: [], modulos: [], verTudoEm: [], editarTudoEm: [], sessionVersion: { increment: 1 } },
        });
        mudaram.push(plano.master.id);
      }
      const rebaixados: string[] = [];
      for (const r of plano.rebaixar) {
        const { count } = await tx.user.updateMany({
          where: { id: r.id, teamId, role: "owner" },
          data: { role: "admin", permissoesEquipe: [...PERMISSOES_DE_EX_MASTER], modulos: [], verTudoEm: [], editarTudoEm: [], sessionVersion: { increment: 1 } },
        });
        if (count === 1) rebaixados.push(r.id);
      }
      mudaram.push(...rebaixados);
      if (plano.transferirRegistros && rebaixados.length) {
        for (const t of TIPOS) transferidos[t] = await TRANSFERIVEIS[t].passar(tx, teamId, rebaixados, plano.master.id);
      }
    },
    { timeout: 60_000 }, // muitos contatos: o padrão de 5 s estouraria (P2028)
  );
  // Depois de gravar (session.ts): apagar antes deixaria uma leitura recolocar a versão velha.
  for (const id of mudaram) await forgetSessionCache(id);
  if (Object.values(transferidos).some((n) => n > 0)) {
    // Painel e badge de não lidas são por pessoa: os números de cada um mudam.
    await invalidarPainel(teamId);
    await invalidarNaoLidas(teamId);
  }
  return { ...plano, transferidos };
}
