import { db, getCurrentTeamId } from "@crmagro/db";
import { getActor } from "../auth/authz";
import { zonedParts } from "../motor-do-dia/tz";
import { escopoDoAtor } from "../tenancy/escopo";
import { googleAgendaConfigurada } from "./google/conexao";
import { fusoDoTime } from "./google/envio";

/**
 * Blocos "Ocupado" da agenda pessoal (decisão 4). A DONA vê o título do
 * próprio evento; os outros (colegas, gestor) veem só início, fim e de quem é.
 * Descrição, local e convidados nunca são guardados. Escopo da tela Agenda: membro vê os seus; master, administrador e "ver
 * tudo" na Agenda veem os de todos (só o horário e de quem é).
 *
 * Quem vê a equipe inteira recebe os dos COLEGAS agrupados por pessoa e dia
 * (primeiro início, último fim e quantos): com o time conectado são milhares
 * de blocos no mês e um corte por quantidade esconderia os últimos dias.
 * `cortado` avisa a tela quando mesmo assim passou do teto.
 */
export type OcupadoDTO = {
  id: string;
  inicio: string;
  fim: string;
  pessoaId: string;
  pessoaNome: string | null;
  meu: boolean;
  /** Título do evento: só vem nos blocos da própria pessoa (`meu`). */
  titulo: string | null;
  /** Blocos juntados neste item (1 = um evento; >1 = o dia da pessoa). */
  quantidade: number;
};

export type OcupadosDTO = { itens: OcupadoDTO[]; cortado: boolean };

const LIMITE_MEUS = 1000;
const LIMITE_EQUIPE = 20_000;

export async function listarOcupados(range: { from: string; to: string }): Promise<OcupadosDTO> {
  const vazio: OcupadosDTO = { itens: [], cortado: false };
  // Integração desligada no .env: os "Ocupado" antigos não aparecem.
  if (!googleAgendaConfigurada()) return vazio;
  const prisma = db();
  const ator = getActor();
  if (!ator) return vazio;
  const from = new Date(range.from);
  const to = new Date(range.to);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return vazio;
  const e = escopoDoAtor("agenda");
  const janela = [{ inicio: { lt: to } }, { fim: { gt: from } }];

  if (!e.tudo) {
    const rows = await prisma.calendarBusyBlock.findMany({
      where: { AND: [...janela, { userId: e.userId }] },
      orderBy: { inicio: "asc" },
      take: LIMITE_MEUS + 1,
      select: { id: true, inicio: true, fim: true, titulo: true, userId: true, user: { select: { name: true } } },
    });
    return {
      cortado: rows.length > LIMITE_MEUS,
      itens: rows.slice(0, LIMITE_MEUS).map((r) => ({
        id: r.id,
        inicio: r.inicio.toISOString(),
        fim: r.fim.toISOString(),
        pessoaId: r.userId,
        pessoaNome: r.user?.name ?? null,
        meu: r.userId === ator.userId,
        titulo: r.userId === ator.userId ? r.titulo : null,
        quantidade: 1,
      })),
    };
  }

  const rows = await prisma.calendarBusyBlock.findMany({
    where: { AND: janela },
    orderBy: { inicio: "asc" },
    take: LIMITE_EQUIPE + 1,
    select: { id: true, inicio: true, fim: true, titulo: true, userId: true },
  });
  const cortado = rows.length > LIMITE_EQUIPE;
  const teamId = getCurrentTeamId();
  const tz = teamId ? await fusoDoTime(teamId) : "America/Sao_Paulo";
  const nomes = new Map(
    (await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );
  const itens: OcupadoDTO[] = [];
  const porPessoaDia = new Map<string, OcupadoDTO>();
  for (const r of rows.slice(0, LIMITE_EQUIPE)) {
    if (r.userId === ator.userId) {
      // Os meus: um a um, como na minha agenda.
      itens.push({ id: r.id, inicio: r.inicio.toISOString(), fim: r.fim.toISOString(), pessoaId: r.userId, pessoaNome: nomes.get(r.userId) ?? null, meu: true, titulo: r.titulo, quantidade: 1 });
      continue;
    }
    const p = zonedParts(r.inicio, tz);
    const chave = `${r.userId}:${p.year}-${p.month}-${p.day}`;
    const atual = porPessoaDia.get(chave);
    if (!atual) {
      porPessoaDia.set(chave, {
        id: chave,
        inicio: r.inicio.toISOString(),
        fim: r.fim.toISOString(),
        pessoaId: r.userId,
        pessoaNome: nomes.get(r.userId) ?? null,
        meu: false,
        titulo: null,
        quantidade: 1,
      });
      continue;
    }
    atual.quantidade++;
    if (r.fim.toISOString() > atual.fim) atual.fim = r.fim.toISOString();
  }
  itens.push(...porPessoaDia.values());
  itens.sort((a, b) => (a.inicio < b.inicio ? -1 : a.inicio > b.inicio ? 1 : 0));
  return { itens, cortado };
}
