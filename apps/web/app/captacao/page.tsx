import Link from "next/link";
import { runAsUser } from "@/lib/tenant";
import { db } from "@crmagro/db";
import { escopoRascunho } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

const FONTES = [
  {
    href: "/captacao/cnpj",
    sigla: "CN",
    label: "CNPJ",
    desc: "Por CNPJ ou por filtros (CNAE, cidade, porte): razão social, sócio, telefone e e-mail",
    origem: "cnpj",
  },
  {
    href: "/captacao/maps",
    sigla: "GM",
    label: "Google Maps",
    desc: "Empresas por termo e região: telefone e endereço",
    origem: "maps",
  },
  {
    href: "/captacao/instagram",
    sigla: "IG",
    label: "Instagram",
    desc: "Seguidores de um perfil: @, nome e bio",
    origem: "instagram",
  },
];

export default async function CaptacaoPage() {
  // Fila de pré-recebimento por origem (só contagem — barato).
  const pendentes = await runAsUser(async () => {
    const rows = await db().prospectDraft.groupBy({
      by: ["origem"],
      where: { AND: [{ status: "pendente" }, escopoRascunho()] }, // F3: a fila de quem capturou
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((r) => [r.origem, r._count._all])) as Record<string, number>;
  }).catch(() => ({}) as Record<string, number>);
  const total = Object.values(pendentes).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Captação"
        subtitle={`${total} ${total === 1 ? "contato" : "contatos"} para revisar · ${FONTES.length} fontes`}
      />

      <section aria-labelledby="t-fontes" className="max-w-3xl">
        <SectionHeader id="t-fontes" title="Fontes" />
        {FONTES.map((f) => {
          const n = pendentes[f.origem] ?? 0;
          return (
            <div key={f.href} className="flex items-center gap-4 border-b border-line py-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line text-caption font-semibold text-ink-2">
                {f.sigla}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium">{f.label}</div>
                <div className="text-small text-ink-2">{f.desc}</div>
              </div>
              <span className="num text-small text-ink-2">{n > 0 ? `${n} para revisar` : "fila vazia"}</span>
              <Button asChild variant={n > 0 ? "default" : "outline"}>
                <Link href={f.href}>{n > 0 ? "Revisar" : "Nova busca"}</Link>
              </Button>
            </div>
          );
        })}
      </section>
    </div>
  );
}
