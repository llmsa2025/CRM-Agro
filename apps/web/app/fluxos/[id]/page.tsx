import { runAsUser } from "@/lib/tenant";
import { notFound } from "next/navigation";
import { db } from "@crmagro/db";
import {
  NOME_DO_TIPO,
  andamentoDoFluxo,
  escopoCanal,
  escopoDoContato,
  getFlow,
  getTeamConfig,
  gatilhoServeAoTipo,
  lerJanelaEnvio,
  listFlowRuns,
  listReviewEnrollments,
  lerWebhookDoFluxo,
  webhookSoGravaHash,
  listTags,
  listarMetodologias,
  noServeAoTipo,
  resumoDoHorarioDaEmpresa,
} from "@crmagro/core";
import { Editor } from "./Editor";
import { FlowRuns } from "./FlowRuns";
import { FlowTabs } from "./FlowTabs";
import { FlowHistorico } from "./FlowHistorico";
import { AndamentoDoFluxo } from "./AndamentoDoFluxo";
import { NODE_TYPES, nodeLabel } from "./node-types";
import { PageNav } from "@/components/ui/page-nav";

export const dynamic = "force-dynamic";

const GATILHOS = ["contact_created", "stage_changed", "tag_added", "message_received", "manual", "contacts_selected", "schedule", "webhook"];

type FlowNodeRow = {
  id: string;
  tipo: import("@prisma/client").FlowNodeType;
  config: unknown;
  nextNodeId: string | null;
  branches: unknown;
  posX: number | null;
  posY: number | null;
};

export default async function FlowEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { flow, funnels, accounts, contacts, runs, review, tags, metodologias, resumoEmpresa, andamento, webhook } = await runAsUser(async () => {
    const flow = await getFlow(id);
    const [funnels, accounts, contacts, runs, review, tags, cfgDaEmpresa, metodologias, andamento, webhook] = await Promise.all([
      db().funnel.findMany({ orderBy: { createdAt: "asc" }, include: { stages: { orderBy: { ordem: "asc" } } } }),
      // F3: os números e os contatos que a pessoa vê.
      db().channelAccount.findMany({ where: { AND: [{ canal: "whatsapp", status: "connected" }, escopoCanal()] }, select: { id: true, label: true } }),
      db().contact.findMany({ where: escopoDoContato(), orderBy: { createdAt: "desc" }, take: 200, select: { id: true, nome: true } }),
      listFlowRuns(id),
      listReviewEnrollments(id),
      listTags(),
      getTeamConfig(),
      // As metodologias do agente (o passo escolhe uma, ou segue a padrão da empresa). Lê sem criar: os modelos
      // prontos são criados pela tela de IA ou na primeira vez que um agente precisa deles.
      listarMetodologias("agente_fluxo"),
      // Andamento por estado: se a leitura falhar, a tela segue sem o painel.
      andamentoDoFluxo(id).catch(() => null),
      // URL do webhook: só o estado (tem URL, quando foi gerada). O texto puro só vem para fluxo antigo.
      lerWebhookDoFluxo(id),
    ]);
    return { flow, funnels, accounts, contacts, runs, review, tags, metodologias, resumoEmpresa: resumoDoHorarioDaEmpresa(cfgDaEmpresa), andamento, webhook };
  }).catch(() => ({ flow: null, funnels: [], accounts: [], contacts: [], runs: [], review: [], tags: [], metodologias: [], resumoEmpresa: "", andamento: null, webhook: null }));

  if (!flow) notFound();

  const nodes: FlowNodeRow[] = flow.nodes.map((n) => ({
    id: n.id,
    tipo: n.tipo,
    config: n.config,
    nextNodeId: n.nextNodeId,
    branches: n.branches,
    posX: n.posX,
    posY: n.posY,
  }));

  const nodeOpts = nodes.map((n, i) => ({ id: n.id, tipo: n.tipo, label: nodeLabel(n.tipo, i) }));

  return (
    <div className="flex flex-col gap-4 px-4 pb-4 pt-5 md:px-8">
      <PageNav
        items={[{ label: "Fluxos", href: "/fluxos" }, { label: flow.nome }]}
        backHref="/fluxos"
      />
      {andamento ? <AndamentoDoFluxo flowId={flow.id} inicial={andamento} /> : null}
      <FlowTabs
      revisar={review.length}
      fluxo={
        <Editor
          flow={{
            id: flow.id,
            nome: flow.nome,
            triggerType: flow.triggerType,
            triggerConfig: (flow.triggerConfig ?? null) as {
              tagId?: string;
              startNodeId?: string;
              jitterMin?: number;
              jitterMax?: number;
            } | null,
            // Nunca o hash. `tokenLegado` só existe em fluxo antigo (texto puro ainda no banco) e só vai
            // para quem pode editar fluxos; fluxo novo mostra a URL uma vez, na hora de gerar.
            webhook: {
              temUrl: webhook?.temUrl ?? false,
              geradaEm: webhook?.geradaEm ? webhook.geradaEm.toISOString() : null,
              tokenLegado: webhook?.tokenLegado ?? null,
              // Chave FLOW_WEBHOOK_TOKEN_HASH: decide se a tela promete que a URL "não aparece de novo".
              soHash: webhookSoGravaHash(),
            },
            // Fluxo sem nada salvo (ou com valor torto) lê como "seguir a empresa".
            janelaEnvio: lerJanelaEnvio(flow.triggerConfig),
            status: flow.status,
            nodes,
          }}
          funnels={funnels.map((f) => ({ id: f.id, nome: f.nome, stages: f.stages.map((s) => ({ id: s.id, nome: s.nome })) }))}
          accounts={accounts}
          metodologias={metodologias.map((m) => ({ id: m.id, nome: m.nome, padrao: m.padrao }))}
          contacts={contacts}
          tags={tags.map((t) => ({ id: t.id, nome: t.nome, cor: t.cor }))}
          resumoEmpresa={resumoEmpresa}
          tipo={{
            nome: NOME_DO_TIPO[flow.tipo],
            nos: NODE_TYPES.filter((t) => noServeAoTipo(flow.tipo, t)),
            gatilhos: GATILHOS.filter((g) => gatilhoServeAoTipo(flow.tipo, g)),
          }}
        />
      }
      historico={<FlowHistorico flowId={flow.id} rows={review} nodes={nodeOpts} />}
      logs={<FlowRuns runs={runs} />}
      />
    </div>
  );
}
