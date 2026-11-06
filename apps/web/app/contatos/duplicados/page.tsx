import { CopyCheck } from "lucide-react";
import { runAsUser } from "@/lib/tenant";
import { findDuplicateContacts } from "@crmagro/core";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { DuplicatesList } from "./DuplicatesList";

export const dynamic = "force-dynamic";

export default async function DuplicadosPage() {
  const groups = await runAsUser(async () => findDuplicateContacts());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumb={[{ label: "Contatos", href: "/contatos" }]}
        title="Duplicados"
        subtitle={`${groups.length} ${groups.length === 1 ? "grupo" : "grupos"} com nome, telefone ou e-mail repetido`}
      />

      {groups.length === 0 ? (
        <EmptyState
          icon={CopyCheck}
          title="Nenhum duplicado encontrado"
          description="Sua base está limpa: nenhum contato com nome, telefone ou e-mail repetido."
        />
      ) : (
        <DuplicatesList groups={groups} />
      )}
    </div>
  );
}
