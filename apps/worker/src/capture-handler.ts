import { env } from "@crmagro/config";
import { basePrisma, decryptCredentials } from "@crmagro/db";
import {
  executarCaptura,
  coletarLoteCnpj,
  coletarPorFiltro,
  CapturaFalhou,
  draftDoSeguidorInstagram,
  logger,
  type CaptureJob,
  type ContextoColeta,
  type ResultadoColeta,
} from "@crmagro/core";
import { scrapeGoogleMaps } from "./maps";
import { coletarSeguidoresInstagram } from "../../../packages/captation/src/instagram/seguidores";

/**
 * Processa um job de captação → grava rascunhos no staging. A orquestração
 * (status visível, gravação aos poucos, "vazio" ≠ "concluído", falha visível,
 * job retomado após queda) é do core (`executarCaptura`, item 3.2); aqui só o
 * coletor de cada origem.
 */
export async function handleCaptureJob(job: CaptureJob): Promise<void> {
  await executarCaptura(job, (ctx) => {
    if (job.origem === "maps") return coletarMaps(job, ctx);
    if (job.origem === "instagram") return coletarInstagram(job, ctx);
    if (job.modo === "filtro") return coletarPorFiltro(job)(ctx);
    return coletarLoteCnpj(job.cnpjs)(ctx);
  });
}

async function coletarMaps(job: Extract<CaptureJob, { origem: "maps" }>, ctx: ContextoColeta): Promise<ResultadoColeta> {
  const r = await scrapeGoogleMaps(job.termo, job.limite, {
    aoLer: ctx.progresso,
    aoColetar: async (itens) => {
      await ctx.gravar(
        itens.map((m) => ({
          nome: m.nome,
          empresa: m.nome,
          telefone: m.telefone,
          cidade: m.cidade,
          uf: m.uf,
          extra: { endereco: m.endereco, site: m.site, lat: m.lat, lng: m.lng, avaliacao: m.avaliacao, avaliacoes: m.avaliacoes },
        })),
      );
    },
  });
  if (r.pulados) logger.info({ lote: job.lote, pulados: r.pulados }, "[captura] Maps: fichas puladas (sem nome)");
  return { interrupcao: r.interrupcao };
}

/**
 * LEGADO, SEM USO NOVO. A leitura de seguidores do Instagram agora roda pela EXTENSÃO, no
 * Chrome de quem pediu: daqui o
 * `fetch` saía do IP do VPS (datacenter) e o Instagram respondia 429. A server action
 * `startInstagramCaptureAction` não enfileira mais para cá e `enqueueCapture` recusa a origem
 * `instagram`. O código fica só para esvaziar jobs antigos que já estavam na fila no deploy e
 * como referência do desenho anterior; pode ser apagado quando a fila não tiver mais nenhum.
 */
async function coletarInstagram(
  job: Extract<CaptureJob, { origem: "instagram" }>,
  ctx: ContextoColeta,
): Promise<ResultadoColeta> {
  // Cookie da conta conectada (cross-team via basePrisma — por isso o teamId
  // do job entra no filtro: a conta tem de ser do time que pediu).
  const acc = await basePrisma.channelAccount.findFirst({ where: { id: job.accountId, teamId: job.teamId } });
  if (!acc) throw new CapturaFalhou("sessao_instagram", "conta Instagram não encontrada neste time");
  const cfg = decryptCredentials(acc.credentials) as { cookie?: string } | null;
  if (!cfg?.cookie) throw new CapturaFalhou("sessao_instagram", "conta Instagram sem cookie");

  const r = await coletarSeguidoresInstagram({
    cookie: cfg.cookie,
    perfil: job.perfil,
    limite: job.limite,
    // Bio (produto §H.5): 1 requisição por seguidor, com teto por job e pausa.
    bios: { max: env.INSTAGRAM_BIO_MAX },
    aoPagina: async (itens) => {
      await ctx.gravar(itens.map(draftDoSeguidorInstagram));
    },
  });
  ctx.progresso(r.lidos);
  if (r.interrupcao) {
    logger.warn({ lote: job.lote, ...r.interrupcao, lidos: r.lidos }, "[captura] Instagram parou no meio — parcial gravado");
  }
  return { interrupcao: r.interrupcao };
}
