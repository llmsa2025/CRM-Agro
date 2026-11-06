"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireRoleAction, acaoDaTela } from "@/lib/tenant";
import { salvarFontePaga, removerFontePaga, ForbiddenError, logger } from "@crmagro/core";

/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "integracoes". */
const runAsUserAction = acaoDaTela("integracoes");

export type EstadoDaFonte = { ok?: boolean; error?: string };

const formSchema = z.object({
  apiKey: z.string().max(200),
  precoCreditoCentavos: z.number().int().min(0).max(100_000).nullable(),
  tetoCreditosPorBusca: z.number().int().min(1).max(100),
  tetoCreditosMes: z.number().int().min(1).max(1_000_000).nullable(),
});

/** Liga a fonte paga do time (a chave é cifrada no serviço e nada é consultado agora). */
export async function salvarFontePagaAction(id: "cnpja", entrada: z.input<typeof formSchema>): Promise<EstadoDaFonte> {
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    const f = formSchema.parse(entrada);
    await runAsUserAction(async () =>
      salvarFontePaga(id, {
        apiKey: f.apiKey,
        precoCreditoCentavos: f.precoCreditoCentavos,
        tetoCreditosPorBusca: f.tetoCreditosPorBusca,
        tetoCreditosMes: f.tetoCreditosMes,
      }),
    );
    revalidatePath("/integracoes/dados");
    return { ok: true };
  } catch (e) {
    if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? "Confira os campos." };
    if (e instanceof ForbiddenError) return { error: "Só administradores configuram fontes de dados." };
    logger.warn({ erro: e instanceof Error ? e.name : "erro" }, "[fonte-paga] não salvei");
    return { error: "Não deu para salvar. Confira a chave e tente de novo." };
  }
}

/** Desliga a fonte e apaga a chave. */
export async function removerFontePagaAction(id: "cnpja"): Promise<EstadoDaFonte> {
  try {
    await requireRoleAction("admin");
    await runAsUserAction(async () => removerFontePaga(id));
    revalidatePath("/integracoes/dados");
    return { ok: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "Só administradores configuram fontes de dados." };
    return { error: "Não deu para desligar agora." };
  }
}
