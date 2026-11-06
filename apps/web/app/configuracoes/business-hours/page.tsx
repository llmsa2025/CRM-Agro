import { runAsUser } from "@/lib/tenant";
import { getTeamConfig, type TeamConfigDTO } from "@crmagro/core";
import { PageHeader } from "@/components/ui/page-header";
import { BusinessHoursForm } from "./BusinessHoursForm";

export const dynamic = "force-dynamic";

/**
 * /configuracoes/business-hours — horário comercial e feriados configuráveis.
 * O server busca a config atual (ou defaults) e repassa ao form client.
 */
export default async function BusinessHoursPage() {
  const initial: TeamConfigDTO = await runAsUser(() => getTeamConfig());

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader
        breadcrumb={[{ label: "Configurações", href: "/configuracoes" }]}
        title="Horário de envio"
        subtitle="Horário padrão da empresa para ligar e enviar. Cada fluxo pode seguir este horário ou ter o próprio, no editor do fluxo. Desligado, prospecta a qualquer hora."
      />
      <BusinessHoursForm initial={initial} />
    </div>
  );
}
