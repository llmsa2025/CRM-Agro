"use server";

import { mensagemParaTela } from "@/lib/erros";
import bcrypt from "bcryptjs";
import { currentUser, acaoDaTela } from "@/lib/tenant";
import { revalidatePath } from "next/cache";
import {
  createInvite,
  listInvites,
  revokeInvite,
  listIntegrantes,
  alterarPapel,
  definirPermissoesEquipe,
  definirVerTudoEm,
  definirModulos,
  desativarIntegrante,
  reativarIntegrante,
  excluirIntegrante,
  redefinirSenhaDeIntegrante,
  type InviteDTO,
  type CreatedInvite,
  type IntegranteDTO,
} from "@crmagro/core";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "configuracoes". */
const runAsUserAction = acaoDaTela("configuracoes");
export type ActionState = { error?: string; ok?: boolean };

/**
 * Emite um convite para um e-mail entrar no time da sessão. Retorna o link do
 * convite (texto puro, exibido UMA vez) e se o e-mail chegou a ser enviado (pelo
 * remetente da plataforma ou, sem ele, pela caixa do time). Tenant-scoped via
 * runAsUserAction. Ver packages/core/src/auth/invites.ts.
 */
export async function createInviteAction(
  email: string,
  role?: string,
  extras: { verTudoEm?: string[]; editarTudoEm?: string[]; permissoesEquipe?: string[]; modulos?: string[] } = {},
): Promise<ActionState & { invite?: CreatedInvite }> {
  try {
    const user = await currentUser();
    // O papel (default "member") é repassado ao serviço, que valida e exige
    // admin+ (fail-closed). Ver packages/core/src/auth/invites.ts.
    const invite = await runAsUserAction(async () =>
      createInvite({
        email,
        ...(role ? { role } : {}),
        ...(user?.id ? { invitedByUserId: user.id } : {}),
        verTudoEm: extras.verTudoEm ?? [],
        editarTudoEm: extras.editarTudoEm ?? [],
        permissoesEquipe: extras.permissoesEquipe ?? [],
        modulos: extras.modulos ?? [],
      }),
    );
    revalidatePath("/configuracoes");
    return { ok: true, invite };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Lista os convites do time (mascarado — nunca o token). */
export async function listInvitesAction(): Promise<InviteDTO[]> {
  try {
    return await runAsUserAction(async () => listInvites());
  } catch {
    return [];
  }
}

/** Revoga um convite pendente pelo id. */
export async function revokeInviteAction(id: string): Promise<ActionState> {
  try {
    await runAsUserAction(async () => revokeInvite(id));
    revalidatePath("/configuracoes");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

// ---------------------------------------------------------------------------
// Integrantes (plano-equipe-permissoes F2a). O core confere papel, hierarquia e
// as permissões de equipe; aqui só traduz o erro para a tela.
// ---------------------------------------------------------------------------

export type IntegranteState = { ok: true; integrante: IntegranteDTO } | { ok: false; error: string };

function mensagem(e: unknown): string {
  if (e instanceof Error && e.name === "ForbiddenError") return "Você não tem permissão para isto. Fale com o master.";
  // Só as mensagens do domínio vão à tela; erro de banco/validação fica genérico.
  if (e instanceof Error && ["AcaoNaoPermitida", "IntegranteNaoEncontrado"].includes(e.name)) return e.message.replace(/^[A-Za-z]+: /, "");
  return "Não foi possível concluir agora. Tente de novo.";
}

async function integrante(fn: () => Promise<IntegranteDTO>): Promise<IntegranteState> {
  try {
    const r = await runAsUserAction(fn);
    revalidatePath("/configuracoes");
    return { ok: true, integrante: r };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

export async function listIntegrantesAction(): Promise<IntegranteDTO[]> {
  try {
    return await runAsUserAction(() => listIntegrantes());
  } catch {
    return [];
  }
}

export async function alterarPapelAction(id: string, papel: string): Promise<IntegranteState> {
  return integrante(() => alterarPapel(id, papel));
}

export async function definirPermissoesEquipeAction(id: string, permissoes: string[]): Promise<IntegranteState> {
  return integrante(() => definirPermissoesEquipe(id, permissoes));
}

/** O que um membro/só leitura vê (`ver`) e altera (`editar`) de todos, por tela. */
export async function definirVerTudoEmAction(id: string, ver: string[], editar: string[]): Promise<IntegranteState> {
  return integrante(() => definirVerTudoEm(id, ver, editar));
}

/** Telas de um membro/só leitura (F2b). Lista vazia = todas. */
export async function definirModulosAction(id: string, modulos: string[]): Promise<IntegranteState> {
  return integrante(() => definirModulos(id, modulos));
}

export async function desativarAction(id: string): Promise<IntegranteState> {
  return integrante(() => desativarIntegrante(id));
}

export async function reativarAction(id: string): Promise<IntegranteState> {
  return integrante(() => reativarIntegrante(id));
}

export async function excluirAction(id: string, transferirPara: string): Promise<{ ok: true; transferidos: Record<string, number> } | { ok: false; error: string }> {
  try {
    const r = await runAsUserAction(() => excluirIntegrante(id, transferirPara));
    revalidatePath("/configuracoes");
    return { ok: true, transferidos: r.transferidos };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

/** Só o master: devolve a senha provisória UMA vez (a tela mostra e não guarda). */
export async function redefinirSenhaAction(id: string): Promise<{ ok: true; senha: string } | { ok: false; error: string }> {
  try {
    const r = await runAsUserAction(() => redefinirSenhaDeIntegrante(id, { hashSenha: (x) => bcrypt.hash(x, 10) }));
    return { ok: true, senha: r.senhaProvisoria };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}
