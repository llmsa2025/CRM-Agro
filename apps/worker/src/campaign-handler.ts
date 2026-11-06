import { runAsSystem } from "@crmagro/db";
import { montarLista, processarTickDaCampanha, type CampaignJob } from "@crmagro/core";

/**
 * Handler da fila `campaign` (produto §A.3). Cada job roda no contexto do time
 * DELE (`runAsSystem`): o `teamId` vem do job gravado pelo core, e todo acesso
 * passa pelo `db()` — campanha de outro time não é achada.
 * - `lista`: monta e classifica a lista (`montarLista`);
 * - `tick`: no máximo um envio + o agendamento do próximo
 *   (`processarTickDaCampanha`). `TickOcupado` sobe para o BullMQ repetir.
 */
export async function handleCampaignJob(job: CampaignJob): Promise<string> {
  return runAsSystem(job.teamId, async () => {
    if (job.kind === "lista") {
      const r = await montarLista(job.campaignId, job.versao);
      return r ? `lista: ${r.fila} na fila, ${r.segurados} segurados, ${r.pulados} pulados` : "lista: versão antiga";
    }
    return processarTickDaCampanha(job);
  });
}
