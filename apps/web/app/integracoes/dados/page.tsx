import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { runAsUser, currentUser } from "@/lib/tenant";
import { listarFontesPagas } from "@crmagro/core";
import { PageHeader } from "@/components/ui/page-header";
import { FontesDeDados } from "./FontesDeDados";

export const dynamic = "force-dynamic";

/** Fontes de dados pagas do time (hoje a CNPJá): desligadas até alguém colocar a chave. */
export default async function FontesDeDadosPage() {
  const usuario = await currentUser();
  const podeEditar = usuario?.role === "owner" || usuario?.role === "admin";
  const fontes = await runAsUser(async () => listarFontesPagas()).catch(() => []);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/integracoes" className="mb-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Integrações
        </Link>
        <PageHeader title="Fontes de dados" subtitle="Consultas pagas para achar pessoas e empresas. Ficam desligadas até você colocar a chave." />
      </div>
      <FontesDeDados fontes={fontes} podeEditar={podeEditar} />
    </div>
  );
}
