import { runAsUser, currentUser } from "@/lib/tenant";
import {
  listAiIntegrations,
  getAiMode,
  listarDocumentos,
  resumoDaBase,
  garantirModelosIniciais,
  listarMetodologias,
  FINALIDADES,
  NOME_DA_FINALIDADE,
  DESCRICAO_DA_FINALIDADE,
  MODELOS_PRONTOS,
} from "@crmagro/core";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IaClient } from "./IaClient";
import { BaseDeConhecimento } from "./BaseDeConhecimento";
import { Metodologias } from "./Metodologias";

export const dynamic = "force-dynamic";

const ABAS = ["provedores", "conhecimento", "metodologias"] as const;

export default async function IaIntegracoesPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const { aba } = await searchParams;
  const usuario = await currentUser();
  const podeEditarBase = usuario?.role === "owner" || usuario?.role === "admin";
  const [integrations, mode, docs, resumo, metodologias] = await runAsUser(async () => {
    // O administrador que abre a tela já encontra os modelos prontos (SPIN Selling e outros), uma única vez.
    if (podeEditarBase) await garantirModelosIniciais();
    return Promise.all([listAiIntegrations(), getAiMode(), listarDocumentos(), resumoDaBase(), listarMetodologias()]);
  });
  const finalidades = FINALIDADES.map((id) => ({ id, nome: NOME_DA_FINALIDADE[id], descricao: DESCRICAO_DA_FINALIDADE[id] }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back="/integracoes"
        breadcrumb={[{ label: "Integrações", href: "/integracoes" }]}
        title="Inteligência artificial"
        subtitle="Provedores conectados e o que a IA pode fazer. A chave fica cifrada e nunca é exibida de volta."
      />
      <Tabs defaultValue={(ABAS as readonly string[]).includes(aba ?? "") ? aba : "provedores"}>
        <TabsList>
          <TabsTrigger value="provedores">Provedores</TabsTrigger>
          <TabsTrigger value="conhecimento">Base de conhecimento</TabsTrigger>
          <TabsTrigger value="metodologias">Metodologias</TabsTrigger>
        </TabsList>
        <TabsContent value="provedores" className="space-y-6">
          <IaClient integrations={integrations} mode={mode} />
          <p className="text-caption text-ink-3">
            Com um provedor conectado e a governança ligada, o botão “Assistente” na barra superior funciona em qualquer tela.
          </p>
        </TabsContent>
        <TabsContent value="conhecimento">
          <BaseDeConhecimento docs={docs} resumo={resumo} podeEditar={podeEditarBase} />
        </TabsContent>
        <TabsContent value="metodologias">
          <Metodologias lista={metodologias} finalidades={finalidades} modelos={[...MODELOS_PRONTOS]} podeEditar={podeEditarBase} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
