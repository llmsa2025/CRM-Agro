"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { desligarEncaminhamento, garantirEncaminhamento, gerarEncaminhamento, obterEncaminhamento, type EncaminhamentoDTO } from "@crmagro/core";
import { acaoDaTela } from "@/lib/tenant";
import { mensagemDoErroDeEncaminhamento } from "../canais/encaminhamento";

/**
 * "Receber sem senha" (ficha E5): o endereço de encaminhamento de uma caixa de e-mail.
 *
 * Sem `requireRoleAction("admin")` de propósito: o dono da caixa (membro) também pode, e
 * quem decide é o core (`exigirGestaoDaCaixa`: dono da caixa ou administrador). A tela
 * "integracoes" é conferida aqui, como nas outras actions de Integrações.
 *
 * O erro nunca sobe cru para a tela (a mensagem do core traz o id da caixa): só o NOME do
 * erro vira um texto fixo.
 */
const runAsUserAction = acaoDaTela("integracoes");
const IdDaCaixa = z.string().uuid();

export type EncaminhamentoResultado = { dto?: EncaminhamentoDTO | null; error?: string };

const erroDe = (e: unknown): { error: string } => ({
  error: mensagemDoErroDeEncaminhamento(e instanceof Error ? e.name : ""),
});

/** O endereço da caixa (ou `null` se ainda não foi gerado ou a entrada está desligada). */
export async function obterEncaminhamentoAction(id: string): Promise<EncaminhamentoResultado> {
  const caixa = IdDaCaixa.safeParse(id);
  if (!caixa.success) return erroDe(null);
  try {
    return { dto: await runAsUserAction(async () => obterEncaminhamento(caixa.data)) };
  } catch (e) {
    return erroDe(e);
  }
}

/** Gera o endereço (ou troca por um novo: o antigo para de funcionar). */
export async function gerarEncaminhamentoAction(id: string): Promise<EncaminhamentoResultado> {
  const caixa = IdDaCaixa.safeParse(id);
  if (!caixa.success) return erroDe(null);
  try {
    const dto = await runAsUserAction(async () => gerarEncaminhamento(caixa.data));
    revalidatePath("/integracoes/canais");
    return { dto };
  } catch (e) {
    return erroDe(e);
  }
}

/**
 * Garante o endereço da caixa: devolve o que já existe e só cria se não houver (nunca troca). É o que o
 * assistente chama ao abrir; "gerar" (acima) é a troca de propósito.
 */
export async function garantirEncaminhamentoAction(id: string): Promise<EncaminhamentoResultado> {
  const caixa = IdDaCaixa.safeParse(id);
  if (!caixa.success) return erroDe(null);
  try {
    const dto = await runAsUserAction(async () => garantirEncaminhamento(caixa.data));
    revalidatePath("/integracoes/canais");
    return { dto };
  } catch (e) {
    return erroDe(e);
  }
}

/** Desliga o recebimento sem senha da caixa. */
export async function desligarEncaminhamentoAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const caixa = IdDaCaixa.safeParse(id);
  if (!caixa.success) return erroDe(null);
  try {
    await runAsUserAction(async () => desligarEncaminhamento(caixa.data));
    revalidatePath("/integracoes/canais");
    return { ok: true };
  } catch (e) {
    return erroDe(e);
  }
}
