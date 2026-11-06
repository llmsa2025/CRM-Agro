import { runAsUser } from "@/lib/tenant";
import { listRelayTokens } from "@crmagro/core";
import { PageHeader } from "@/components/ui/page-header";
import { ExtensaoClient } from "./ExtensaoClient";

export const dynamic = "force-dynamic";

export default async function ExtensaoIntegracaoPage() {
  const tokens = await runAsUser(async () => listRelayTokens());
  // A extensão não vem nesta versão pública: sem versão para mostrar.
  const versao: string | null = null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back="/integracoes"
        breadcrumb={[{ label: "Integrações", href: "/integracoes" }]}
        title="Extensão do navegador"
        subtitle="Captação e envios pelas suas sessões logadas, direto do seu navegador."
      />
      <ExtensaoClient initialTokens={tokens} versao={versao} />
    </div>
  );
}
