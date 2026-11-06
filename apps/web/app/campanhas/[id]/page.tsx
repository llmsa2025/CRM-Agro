import { notFound } from "next/navigation";
import { runAsUser, currentUser } from "@/lib/tenant";
import { db } from "@crmagro/db";
import { CampaignNotFound, escopoCanal, getAccountRateStatus, getCampaign, listCampaigns, listFlows } from "@crmagro/core";
import { CampaignWizard } from "./CampaignWizard";
import { CampaignProgress } from "./CampaignProgress";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
type Busca = Promise<{ editar?: string }>;

/**
 * Uma campanha: em rascunho, o assistente de 4 passos; depois de iniciada, a
 * tela "Em andamento" (produto §A). O que a tela precisa e o core não devolve
 * na campanha vem daqui: contas de WhatsApp, fluxos e a saúde da conta.
 */
export default async function CampanhaPage({ params, searchParams }: { params: Params; searchParams: Busca }) {
  const { id } = await params;
  const { editar } = await searchParams;
  const usuario = await currentUser();
  let dados;
  try {
    dados = await runAsUser(async () => {
      const campaign = await getCampaign(id);
      const [contas, fluxos, todas] = await Promise.all([
        db().channelAccount.findMany({
          where: { AND: [{ canal: "whatsapp" }, escopoCanal({ escrita: true })] }, // F3: os números que a pessoa pode USAR
          orderBy: { createdAt: "asc" },
          select: { id: true, label: true, status: true, paused: true },
        }),
        listFlows({ limit: 50, tipo: "prospeccao" }), // campanha fala com contatos: só fluxo de prospecção
        listCampaigns({ take: 100 }), // para a regra "recebeu mensagem em outra campanha"
      ]);
      const saude = campaign.channelAccountId ? await getAccountRateStatus(campaign.channelAccountId).catch(() => null) : null;
      return {
        campaign,
        contas,
        fluxos: fluxos.items.map((f) => ({ id: f.id, nome: f.nome, status: f.status })),
        outras: todas
          .filter((o) => o.id !== id && o.status !== "draft")
          .map((o) => ({ id: o.id, nome: o.nome, enviados: (o.contagem.sent ?? 0) + (o.contagem.delivered ?? 0) + (o.contagem.read ?? 0) + (o.contagem.replied ?? 0) + (o.contagem.opted_out ?? 0) })),
        saude: saude ? { sent: saude.sent, limit: saude.limit, paused: saude.paused, warmupDay: saude.warmupDay } : null,
      };
    });
  } catch (e) {
    if (e instanceof CampaignNotFound) notFound();
    throw e;
  }

  const podeEditar = usuario?.role !== "viewer";
  if (dados.campaign.status === "draft") {
    return <CampaignWizard inicial={dados.campaign} contas={dados.contas} fluxos={dados.fluxos} outras={dados.outras} podeEditar={podeEditar} />;
  }
  // Pausada ou agendada: "Editar" abre o assistente só com mensagem e ritmo (`?editar=1`).
  if (editar === "1" && podeEditar && (dados.campaign.status === "paused" || dados.campaign.status === "scheduled")) {
    return <CampaignWizard inicial={dados.campaign} contas={dados.contas} fluxos={dados.fluxos} outras={dados.outras} podeEditar={podeEditar} edicao />;
  }
  return (
    <CampaignProgress
      inicial={dados.campaign}
      conta={dados.contas.find((c) => c.id === dados.campaign.channelAccountId) ?? null}
      saude={dados.saude}
      podeEditar={podeEditar}
    />
  );
}
