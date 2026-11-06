import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, getCurrentTeamId } from "@crmagro/db";
import { ondeIdentificadorExato, valorDe } from "../contacts/identificadores-cifra";
import { assertOwnedMany } from "../tenancy/assert-owned";
import { escopoDoContato } from "../contacts/escopo";

/**
 * Convidados do compromisso (decisão 8, 28/09): vários por compromisso —
 * contato, colega do time ou e-mail avulso. Substitui o antigo
 * `Appointment.convidadoEmail` (um só).
 *
 * - E-mail sempre em minúsculas e validado (o Google recusa o resto).
 * - Colega: vem pelo id (assertOwned: tem de ser do time) e o e-mail sai do
 *   cadastro dele, nunca do cliente.
 * - Contato: casado pelo e-mail (ChannelIdentifier) só entre os contatos que a
 *   pessoa VÊ — o convite não revela o contato de um colega.
 */

/** Convidados que a pessoa ADICIONA pelo CRM Agro (o convite sai para cada um). */
export const MAX_CONVIDADOS = 50;
/**
 * Teto da lista inteira: o evento importado do Google entra com até 100
 * convidados (sincronizacao.ts) e precisa continuar salvando quando a pessoa
 * edita só a nota ou o lembrete. O limite de 50 vale para quem ENTRA pelo CRM Agro
 * (service.ts confere na edição).
 */
export const MAX_CONVIDADOS_TOTAL = 100;

export const convidadoSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254).nullish(),
    nome: z.string().trim().max(200).nullish(),
    userId: z.string().min(1).max(64).nullish(),
  })
  .refine((c) => Boolean(c.email || c.userId), { message: "convidado sem e-mail" });

export const convidadosSchema = z.array(convidadoSchema).max(MAX_CONVIDADOS_TOTAL);

export type ConvidadoInput = z.input<typeof convidadoSchema>;

export type ConvidadoDTO = {
  email: string;
  nome: string | null;
  /** Colega do time convidado. */
  userId: string | null;
  /** Contato do CRM Agro com este e-mail (se a pessoa o vê). */
  contactId: string | null;
  /** Resposta vinda do Google: needsAction | accepted | declined | tentative. */
  resposta: string;
};

/** Convidado pronto para gravar (e-mail normalizado, colega/contato resolvidos). */
export type ConvidadoNormalizado = {
  email: string;
  nome: string | null;
  userId: string | null;
  contactId: string | null;
  resposta?: string;
};

const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** E-mail limpo em minúsculas, ou null se não tem cara de e-mail. */
export function normalizarEmail(v: string | null | undefined): string | null {
  const e = String(v ?? "").trim().toLowerCase();
  return e && e.length <= 254 && EMAIL_OK.test(e) ? e : null;
}

/**
 * Contatos que a pessoa do contexto vê, por e-mail. Serve ao convite (CRM Agro) e
 * à sincronização (Google → CRM Agro, rodando com a identidade do dono da agenda).
 */
export async function contatosPorEmail(emails: string[]): Promise<Map<string, { contactId: string; nome: string }>> {
  const lista = [...new Set(emails.map((e) => e.toLowerCase()))].slice(0, 200);
  const mapa = new Map<string, { contactId: string; nome: string }>();
  if (!lista.length) return mapa;
  const rows = await db().channelIdentifier.findMany({
    where: { ...ondeIdentificadorExato(getCurrentTeamId() ?? "", "email", lista), contact: escopoDoContato() },
    select: { valor: true, valorCifrado: true, contactId: true, contact: { select: { nome: true } } },
    orderBy: { createdAt: "asc" },
  });
  for (const r of rows) {
    const valor = valorDe(r);
    if (valor && !mapa.has(valor)) mapa.set(valor, { contactId: r.contactId, nome: r.contact.nome });
  }
  return mapa;
}

/** Colegas do time por e-mail (convidado interno). */
export async function colegasPorEmail(emails: string[]): Promise<Map<string, { userId: string; nome: string }>> {
  const lista = [...new Set(emails.map((e) => e.toLowerCase()))].slice(0, 200);
  const mapa = new Map<string, { userId: string; nome: string }>();
  if (!lista.length) return mapa;
  const rows = await db().user.findMany({
    where: { email: { in: lista, mode: "insensitive" } },
    select: { id: true, email: true, name: true },
  });
  for (const u of rows) mapa.set(u.email.toLowerCase(), { userId: u.id, nome: u.name });
  return mapa;
}

/**
 * Valida e resolve a lista vinda da tela (zod + assertOwned dos colegas).
 * Sem duplicados; colega pelo id; contato casado pelo e-mail no escopo.
 */
export async function normalizarConvidados(entrada: unknown): Promise<ConvidadoNormalizado[]> {
  const lista = convidadosSchema.parse(entrada ?? []);
  const ids = [...new Set(lista.map((c) => c.userId).filter((x): x is string => Boolean(x)))];
  // S1: colega vindo do cliente tem de ser do time.
  if (ids.length) await assertOwnedMany("user", ids);
  const colegas = ids.length
    ? await db().user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, name: true } })
    : [];
  const porId = new Map(colegas.map((u) => [u.id, u]));

  const vistos = new Map<string, ConvidadoNormalizado>();
  for (const c of lista) {
    const colega = c.userId ? porId.get(c.userId) : undefined;
    const email = normalizarEmail(colega?.email ?? c.email);
    if (!email || vistos.has(email)) continue;
    vistos.set(email, { email, nome: colega?.name ?? c.nome ?? null, userId: colega?.id ?? null, contactId: null });
  }
  const semColega = [...vistos.values()].filter((c) => !c.userId).map((c) => c.email);
  const [contatos, porEmail] = await Promise.all([contatosPorEmail([...vistos.keys()]), colegasPorEmail(semColega)]);
  for (const c of vistos.values()) {
    const ct = contatos.get(c.email);
    if (ct) {
      c.contactId = ct.contactId;
      c.nome ??= ct.nome;
    }
    const colega = porEmail.get(c.email);
    if (colega && !c.userId) {
      c.userId = colega.userId;
      c.nome ??= colega.nome;
    }
  }
  return [...vistos.values()];
}

/**
 * E-mail principal (válido) de um contato que a pessoa VÊ — para sugerir como
 * convidado no compromisso. Fora do escopo = null (não revela nada).
 */
export async function emailDoContatoParaConvite(contactId: string): Promise<string | null> {
  if (!contactId || contactId.length > 64) return null;
  const i = await db().channelIdentifier.findFirst({
    where: { contactId, canal: "email", invalido: false, contact: escopoDoContato() },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { valor: true, valorCifrado: true },
  });
  return i ? valorDe(i) : null;
}

/**
 * Troca a lista de convidados do compromisso pela nova (apaga quem saiu, cria
 * quem entrou, atualiza nome/resposta). Devolve os e-mails NOVOS e se mudou
 * algo que o convidado vê (quem está convidado). Roda no contexto do time.
 */
type ClienteDeConvidados = Pick<ReturnType<typeof db>, "appointmentAttendee">;

export async function substituirConvidados(
  appointmentId: string,
  teamId: string,
  lista: ConvidadoNormalizado[],
  // Dentro de uma transação do time (sincronização com CAS), o cliente dela.
  prisma: ClienteDeConvidados = db(),
): Promise<{ novos: string[]; mudou: boolean }> {
  const atuais = await prisma.appointmentAttendee.findMany({
    where: { appointmentId },
    select: { id: true, email: true, nome: true, userId: true, contactId: true, resposta: true },
  });
  const porEmail = new Map(atuais.map((a) => [a.email, a]));
  const novosEmails = new Set(lista.map((c) => c.email));
  const sairam = atuais.filter((a) => !novosEmails.has(a.email));
  if (sairam.length) await prisma.appointmentAttendee.deleteMany({ where: { id: { in: sairam.map((a) => a.id) } } });

  const novos: string[] = [];
  for (const c of lista) {
    const atual = porEmail.get(c.email);
    if (!atual) {
      novos.push(c.email);
      await prisma.appointmentAttendee.create({
        data: {
          teamId,
          appointmentId,
          email: c.email,
          nome: c.nome,
          userId: c.userId,
          contactId: c.contactId,
          ...(c.resposta ? { resposta: c.resposta } : {}),
        } as Prisma.AppointmentAttendeeUncheckedCreateInput,
      });
      continue;
    }
    const data: Prisma.AppointmentAttendeeUncheckedUpdateInput = {};
    if (c.nome && c.nome !== atual.nome) data.nome = c.nome;
    if (c.userId && c.userId !== atual.userId) data.userId = c.userId;
    if (c.contactId && c.contactId !== atual.contactId) data.contactId = c.contactId;
    if (c.resposta && c.resposta !== atual.resposta) data.resposta = c.resposta;
    if (Object.keys(data).length) await prisma.appointmentAttendee.update({ where: { id: atual.id }, data });
  }
  return { novos, mudou: novos.length > 0 || sairam.length > 0 };
}

/**
 * Só as RESPOSTAS (RSVP) vindas do Google, sem incluir nem tirar ninguém: é o
 * que muda quando o convidado aceita/recusa — não é alteração "comum" (não
 * sobrescreve uma mudança do CRM Agro que ainda não chegou ao Google).
 */
export async function atualizarRespostas(appointmentId: string, respostas: { email: string; resposta: string }[]): Promise<void> {
  const prisma = db();
  const porResposta = new Map<string, string[]>();
  for (const r of respostas) (porResposta.get(r.resposta) ?? porResposta.set(r.resposta, []).get(r.resposta)!).push(r.email);
  for (const [resposta, emails] of porResposta) {
    await prisma.appointmentAttendee.updateMany({ where: { appointmentId, email: { in: emails }, NOT: { resposta } }, data: { resposta } });
  }
}
