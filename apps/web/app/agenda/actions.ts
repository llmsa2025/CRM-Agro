"use server";

import { mensagemParaTela } from "@/lib/erros";
import { acaoDaTela, currentUser } from "@/lib/tenant";
import { revalidatePath } from "next/cache";
import {
  createAppointment,
  listAppointments,
  listDueAppointments,
  updateAppointment,
  setAppointmentStatus,
  deleteAppointment,
  desvincularDoGoogle,
  confirmarDoGoogle,
  listarOcupados,
  emailDoContatoParaConvite,
  agendaGoogleLiberadaParaMim,
  googleAgendaConfigurada,
  minhaConexaoGoogle,
  podeConectarGoogle,
  desconectarGoogle,
  pedirSincronizacaoGoogle,
  list as listContacts,
  type AppointmentDTO,
  type CreateAppointmentInput,
  type ConexaoGoogleDTO,
  type OcupadosDTO,
} from "@crmagro/core";
import type { AppointmentStatus } from "@prisma/client";
import { db } from "@crmagro/db";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "agenda". */
const runAsUserAction = acaoDaTela("agenda");
export async function listAppointmentsAction(from: string, to: string): Promise<AppointmentDTO[]> {
  return runAsUserAction(async () => listAppointments({ from, to }));
}

/** Blocos "Ocupado" da agenda pessoal (só início e fim) no intervalo; os dos colegas por dia. */
export async function listOcupadosAction(from: string, to: string): Promise<OcupadosDTO> {
  return runAsUserAction(async () => listarOcupados({ from, to }));
}

/** Compromissos que venceram agora (para o alerta na plataforma). */
export async function dueAppointmentsAction(): Promise<AppointmentDTO[]> {
  return runAsUserAction(async () => listDueAppointments());
}

export type SaveState = { ok?: boolean; error?: string; appointment?: AppointmentDTO };

export async function createAppointmentAction(input: CreateAppointmentInput): Promise<SaveState> {
  try {
    const appointment = await runAsUserAction(async () => createAppointment(input));
    revalidatePath("/agenda");
    return { ok: true, appointment };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function updateAppointmentAction(
  id: string,
  input: Partial<CreateAppointmentInput>,
): Promise<SaveState> {
  try {
    const appointment = await runAsUserAction(async () => updateAppointment(id, input));
    revalidatePath("/agenda");
    return { ok: true, appointment };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function setAppointmentStatusAction(id: string, status: AppointmentStatus): Promise<SaveState> {
  try {
    await runAsUserAction(async () => setAppointmentStatus(id, status));
    revalidatePath("/agenda");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** "Tirar do CRM Agro": o evento que veio do Google sai daqui (nada vai ao Google) e vira "Ocupado". */
export async function desvincularDoGoogleAction(id: string): Promise<SaveState> {
  try {
    await runAsUserAction(async () => desvincularDoGoogle(id));
    revalidatePath("/agenda");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** "Manter no CRM Agro": o que veio da Agenda Google da pessoa é de trabalho — o time passa a ver. */
export async function confirmarDoGoogleAction(id: string): Promise<SaveState> {
  try {
    const appointment = await runAsUserAction(async () => confirmarDoGoogle(id));
    revalidatePath("/agenda");
    return { ok: true, appointment };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function deleteAppointmentAction(id: string): Promise<SaveState> {
  try {
    await runAsUserAction(async () => deleteAppointment(id));
    revalidatePath("/agenda");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export type AgendaContactItem = { id: string; nome: string; email: string | null };

/** Contatos para o seletor do compromisso (com o e-mail, para sugerir como convidado). */
export async function listAgendaContactsAction(search?: string): Promise<AgendaContactItem[]> {
  return runAsUserAction(async () => {
    const { items } = await listContacts({ search, limit: 20 });
    return items.map((c) => ({
      id: c.id,
      nome: c.nome,
      email: c.identifiers.find((i) => i.canal === "email" && !i.invalido)?.valor ?? null,
    }));
  });
}

/** E-mail do contato (fixo, vindo da ficha) para sugerir como convidado. */
export async function emailDoContatoAction(contactId: string): Promise<string | null> {
  return runAsUserAction(async () => emailDoContatoParaConvite(contactId));
}

export type AgendaUserItem = { id: string; nome: string };

/** Usuários do time para o seletor de responsável e de colega convidado (§E). */
export async function listTeamUsersAction(): Promise<AgendaUserItem[]> {
  return runAsUserAction(async () => {
    const rows = await db().user.findMany({ where: { desativadoEm: null }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } });
    return rows.map((u) => ({ id: u.id, nome: u.name || u.email }));
  });
}

export type AgendaGoogleState = {
  configurada: boolean;
  conexao: ConexaoGoogleDTO | null;
  /** Só leitura não conecta (o botão some; desconectar continua). */
  podeConectar: boolean;
  /**
   * A pessoa está em GOOGLE_AGENDA_LIBERADOS (A2, até o Google verificar o app).
   * Falso e sem conexão: a lateral da Agenda nem mostra o cartão.
   */
  liberada: boolean;
  /** Quem está logado: o diálogo só fala em "seu Google Agenda" quando o responsável é a própria pessoa. */
  eu: string | null;
};

/** A Agenda Google da pessoa logada (só a dela). */
export async function minhaAgendaGoogleAction(): Promise<AgendaGoogleState> {
  const eu = (await currentUser())?.id ?? null;
  if (!googleAgendaConfigurada()) return { configurada: false, conexao: null, podeConectar: false, liberada: false, eu };
  return runAsUserAction(async () => ({
    configurada: true,
    conexao: await minhaConexaoGoogle(),
    podeConectar: podeConectarGoogle(),
    liberada: await agendaGoogleLiberadaParaMim().catch(() => false),
    eu,
  }));
}

export async function desconectarGoogleAgendaAction(): Promise<{ ok?: boolean; error?: string }> {
  try {
    await runAsUserAction(async () => desconectarGoogle());
    revalidatePath("/agenda");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function sincronizarGoogleAgendaAction(): Promise<{ ok?: boolean; error?: string }> {
  try {
    const r = await runAsUserAction(async () => pedirSincronizacaoGoogle());
    return r.pedido ? { ok: true } : { error: "A agenda não está conectada." };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}
