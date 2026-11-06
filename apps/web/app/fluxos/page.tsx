import { runAsUser, currentUser } from "@/lib/tenant";
import Link from "next/link";

import {
  DESCRICAO_DO_TIPO,
  FLOW_TIPOS,
  NOME_DO_TIPO,
  TIPOS_DISPONIVEIS,
  editaTudoNaTela,
  gatilhosDoTipo,
  getTeamConfig,
  lerJanelaEnvio,
  listFlowsWithMetrics,
  resumoDoHorarioDaEmpresa,
} from "@crmagro/core";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NewFlowButton, type TipoParaATela } from "./NewFlowButton";
import { CompartilharFluxo } from "./CompartilharFluxo";
import { MenuDoFluxo } from "./MenuDoFluxo";

export const dynamic = "force-dynamic";

const TRIGGER_LABEL: Record<string, string> = {
  contact_created: "Contato criado",
  stage_changed: "Mudança de etapa",
  tag_added: "Tag adicionada",
  message_received: "Mensagem recebida",
  manual: "Manual",
  schedule: "Agendado",
  webhook: "Webhook",
  contacts_selected: "Contatos selecionados",
};

const STATUS: Record<string, { label: string; tone: StatusTone }> = {
  active: { label: "Ativo", tone: "ok" },
  draft: { label: "Rascunho", tone: "attention" },
  paused: { label: "Pausado", tone: "attention" },
  archived: { label: "Arquivado", tone: "done" },
};

const GATILHOS = ["contact_created", "message_received", "stage_changed", "tag_added", "manual", "contacts_selected", "schedule", "webhook"] as const;
const TIPOS_PARA_A_TELA: TipoParaATela[] = FLOW_TIPOS.map((t) => ({
  value: t,
  nome: NOME_DO_TIPO[t],
  descricao: DESCRICAO_DO_TIPO[t],
  disponivel: TIPOS_DISPONIVEIS.includes(t),
  gatilhos: gatilhosDoTipo(t, GATILHOS),
}));

export default async function FluxosPage() {
  const [{ flows, resumoEmpresa }, usuario] = await Promise.all([
    runAsUser(async () => ({ flows: await listFlowsWithMetrics(), resumoEmpresa: resumoDoHorarioDaEmpresa(await getTeamConfig()) })),
    currentUser(),
  ]);
  // F4: quem pode abrir/fechar um fluxo para o time — quem criou ou quem vê o time todo.
  // Mudar o fluxo do colega pede "Ver e editar de todos" em Fluxos (só ver não basta).
  const veTudo = editaTudoNaTela(usuario?.role, usuario?.editarTudoEm, "fluxos");
  const podeMudar = (criador: string | null) => usuario?.role !== "viewer" && (veTudo || (criador !== null && criador === usuario?.id));
  const ativos = flows.filter((f) => f.status === "active").length;
  const emAndamento = flows.reduce((a, f) => a + f.metrics.emAndamento, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Fluxos"
        subtitle={`${flows.length} ${flows.length === 1 ? "fluxo" : "fluxos"} · ${ativos} ativos · ${emAndamento} contatos em andamento`}
        actions={<NewFlowButton resumoEmpresa={resumoEmpresa} tipos={TIPOS_PARA_A_TELA} />}
      />

      {flows.length === 0 ? (
        <EmptyState
          title="Você ainda não tem fluxos"
          description="Um fluxo faz a cadência sozinho: envia, espera, ramifica pela resposta e move o negócio."
          action={<NewFlowButton resumoEmpresa={resumoEmpresa} tipos={TIPOS_PARA_A_TELA} />}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fluxo</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Começa quando</TableHead>
              <TableHead>Status</TableHead>
              <TableHead numeric>Entraram</TableHead>
              <TableHead numeric>Em andamento</TableHead>
              <TableHead numeric>Concluídos</TableHead>
              <TableHead numeric>Falhas</TableHead>
              <TableHead>Visível para</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Ações</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {flows.map((f) => {
              const st = STATUS[f.status] ?? { label: f.status, tone: "done" as StatusTone };
              return (
                <TableRow key={f.id}>
                  <TableCell>
                    <Link href={`/fluxos/${f.id}`} className="font-medium text-foreground hover:underline">
                      {f.nome}
                    </Link>
                  </TableCell>
                  <TableCell className="text-ink-2">{NOME_DO_TIPO[f.tipo] ?? f.tipo}</TableCell>
                  <TableCell className="text-ink-2">{TRIGGER_LABEL[f.triggerType] ?? f.triggerType}</TableCell>
                  <TableCell>
                    <StatusDot tone={st.tone}>{st.label}</StatusDot>
                  </TableCell>
                  <TableCell numeric className="text-ink-2">
                    {f.metrics.total}
                  </TableCell>
                  <TableCell numeric className="text-ink-2">
                    {f.metrics.emAndamento}
                  </TableCell>
                  <TableCell numeric>{f.metrics.concluidos}</TableCell>
                  <TableCell numeric className={f.metrics.falhas > 0 ? "font-medium text-danger-500" : "text-ink-3"}>
                    {f.metrics.falhas}
                  </TableCell>
                  <TableCell>
                    <CompartilharFluxo id={f.id} compartilhado={f.compartilhado} podeMudar={podeMudar(f.createdById)} />
                  </TableCell>
                  <TableCell className="text-right">
                    {podeMudar(f.createdById) ? (
                      <MenuDoFluxo id={f.id} nome={f.nome} janelaEnvio={lerJanelaEnvio(f.triggerConfig)} resumoEmpresa={resumoEmpresa} emAndamento={f.metrics.emAndamento} />
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
