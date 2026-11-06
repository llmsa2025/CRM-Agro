import { notFound } from "next/navigation";
import { statusNectar } from "@crmagro/core";
import { PageHeader } from "@/components/ui/page-header";
import { subtituloDaPagina } from "@/lib/nectar/conexao";
import { currentUser, runAsUser } from "@/lib/tenant";
import { NectarClient } from "./NectarClient";
import { removerNectarAction, salvarTokenNectarAction, testarNectarAction } from "./actions";

export const dynamic = "force-dynamic";

/** Conexão do Nectar CRM (admin). Só existe para os times do beta: fora dele, a página dá 404. */
export default async function NectarCrmPage() {
  // `statusNectar` espera a primeira leitura da flag e já diz se o time está liberado.
  const status = await runAsUser(() => statusNectar());
  if (!status.liberado) notFound();
  const user = await currentUser();
  const podeEditar = user?.role === "owner" || user?.role === "admin";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back="/integracoes"
        breadcrumb={[{ label: "Integrações", href: "/integracoes" }]}
        title="Nectar CRM"
        subtitle={subtituloDaPagina(status)}
      />
      <NectarClient
        // Quem não é admin nem vê o final do token.
        status={podeEditar ? status : { ...status, finalDoToken: null }}
        podeEditar={podeEditar}
        salvar={salvarTokenNectarAction}
        testar={testarNectarAction}
        remover={removerNectarAction}
      />
    </div>
  );
}
