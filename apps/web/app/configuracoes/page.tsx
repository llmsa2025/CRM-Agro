import Link from "next/link";
import { runAsUser, currentUser } from "@/lib/tenant";
import { MetasTab } from "./metas/MetasTab";
import { EquipeTab } from "./equipe/EquipeTab";
import { getEmpresa, listIntegrantes, listInvites, saudeDoCanal, LIMIARES, type Indicador, type NivelAlerta } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EmpresaTab } from "./empresa/EmpresaTab";

export const dynamic = "force-dynamic";

const NIVEL: Record<NivelAlerta, { label: string; tone: StatusTone }> = {
  ok: { label: "Saudável", tone: "ok" },
  atencao: { label: "Atenção", tone: "attention" },
  critico: { label: "Crítico", tone: "error" },
};

function IndicadorLinha({ i }: { i: Indicador }) {
  const conf = NIVEL[i.nivel];
  return (
    <div className="flex items-center gap-6 border-b border-line py-4">
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium">{i.titulo}</div>
        <div className="text-small text-ink-2">{i.descricao}</div>
      </div>
      <div className="num text-right">
        <div className="font-serif text-num">{i.semDados ? "—" : `${i.percentual.toFixed(1)}%`}</div>
        {!i.semDados && (
          <div className="text-caption text-ink-3">
            {i.valor} de {i.total}
          </div>
        )}
      </div>
      <div className="w-28">
        {i.semDados ? <StatusDot tone="empty">sem dados</StatusDot> : <StatusDot tone={conf.tone}>{conf.label}</StatusDot>}
      </div>
    </div>
  );
}

const ABAS = [
  { value: "empresa", label: "Empresa" },
  { value: "equipe", label: "Equipe" },
  { value: "metas", label: "Metas" },
  { value: "horarios", label: "Horário de envio" },
  { value: "alertas", label: "Alertas" },
];

export default async function ConfiguracoesPage() {
  const usuario = await currentUser();
  const saude = await runAsUser(async () => saudeDoCanal()).catch(() => null);
  const convites = await runAsUser(async () => listInvites()).catch(() => []);
  const empresa = await runAsUser(async () => getEmpresa()).catch(() => null);
  const podeEditarEmpresa = usuario?.role === "owner" || usuario?.role === "admin";
  // Equipe (F2a): lista para master/admin; o core nega para os outros (lista vazia).
  const integrantes = await runAsUser(async () => listIntegrantes()).catch(() => []);
  const minhasPermissoes = integrantes.find((u) => u.id === usuario?.id)?.permissoesEquipe ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Configurações" subtitle={usuario?.email ?? undefined} />

      {/* Navegação vertical à esquerda; conteúdo à direita (padrão dos mockups). */}
      <Tabs defaultValue="equipe" orientation="vertical" className="grid grid-cols-1 gap-x-14 gap-y-6 md:grid-cols-[200px_minmax(0,1fr)]">
        <TabsList className="flex h-auto flex-col items-stretch gap-px border-0">
          {ABAS.map((a) => (
            <TabsTrigger
              key={a.value}
              value={a.value}
              className="h-9 justify-start rounded-md border-0 px-2.5 text-body data-[state=active]:bg-accent data-[state=active]:font-medium"
            >
              {a.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="min-w-0">
          <TabsContent value="empresa" className="mt-0">
            {empresa ? (
              <EmpresaTab empresa={empresa} podeEditar={podeEditarEmpresa} />
            ) : (
              <p className="py-6 text-body text-ink-2">Não foi possível carregar os dados da empresa agora.</p>
            )}
          </TabsContent>

          <TabsContent value="equipe" className="mt-0">
            <EquipeTab
              initialInvites={convites}
              integrantes={integrantes}
              euId={usuario?.id ?? ""}
              euRole={usuario?.role ?? ""}
              minhasPermissoes={minhasPermissoes}
            />
          </TabsContent>

          <TabsContent value="metas" className="mt-0">
            <MetasTab />
          </TabsContent>

          <TabsContent value="horarios" className="mt-0">
            <SectionHeader title="Horário de envio" />
            <div className="flex items-center gap-6 border-b border-line py-5">
              <div className="min-w-0 flex-1">
                <p className="text-body">Horário comercial e feriados</p>
                <p className="text-small text-ink-2">
                  Horário padrão da empresa para ligar e enviar. Cada fluxo pode seguir este horário ou ter o próprio. Desligue para prospectar a qualquer hora.
                </p>
              </div>
              <Button asChild variant="outline">
                <Link href="/configuracoes/business-hours">Configurar</Link>
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="alertas" className="mt-0">
            <div className="flex flex-col gap-8">
            {!saude ? (
              <p className="py-6 text-body text-ink-2">Não foi possível carregar os indicadores agora.</p>
            ) : (
              <div className="flex flex-col gap-8">
                <section>
                  <SectionHeader
                    title="Saúde do canal"
                    aside={
                      <>
                        <span className="num">
                          últimos {saude.dias} dias · {saude.enviadas} enviadas
                        </span>
                        <StatusDot tone={NIVEL[saude.nivelGeral].tone}>{NIVEL[saude.nivelGeral].label}</StatusDot>
                      </>
                    }
                  />
                  {!saude.rastreamentoAtivo && (
                    <p className="flex gap-2.5 border-b border-line py-4 text-small leading-relaxed text-ink-2">
                      <StatusDot tone="attention" className="mt-[3px]" />
                      <span>
                        Rastreamento de entrega inativo: nenhuma mensagem enviada saiu de “enviada”. Reconecte o número em{" "}
                        <Link href="/integracoes/canais" className="font-medium text-brand-500 hover:underline">
                          Integrações
                        </Link>{" "}
                        para o WhatsApp voltar a mandar recibos de entrega.
                      </span>
                    </p>
                  )}
                  {saude.indicadores.map((i) => (
                    <IndicadorLinha key={i.chave} i={i} />
                  ))}
                  <p className="pt-3 text-caption text-ink-3">
                    Limiares são política nossa, medidos na sua base (a Meta não publica os dela). “Recusadas pelo servidor” vem do
                    WhatsApp e é o indicador mais confiável.
                  </p>
                </section>

                <section>
                  <SectionHeader title="Recusas do servidor do WhatsApp" />
                  {saude.erros.length === 0 ? (
                    <p className="py-4 text-small text-ink-2">
                      Nenhuma recusa no período. Se aparecer algo aqui, o WhatsApp está limitando o número ativamente.
                    </p>
                  ) : (
                    saude.erros.map((e) => (
                      <div key={e.codigo} className="flex gap-4 border-b border-line py-3.5">
                        <span className="num w-14 shrink-0 text-small text-ink-3">{e.codigo}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-body">
                            {e.label} · <span className="num">{e.quantidade}×</span>
                          </p>
                          <p className="text-small text-ink-2">{e.explicacao}</p>
                        </div>
                        {e.grave && <StatusDot tone="error">grave</StatusDot>}
                      </div>
                    ))
                  )}
                </section>

                <section>
                  <SectionHeader title="Limiares em uso" aside={<span>atenção / crítico</span>} />
                  {[
                    ["Não entregues", LIMIARES.naoEntregue],
                    ["Recusadas pelo servidor", LIMIARES.erroAck],
                    ["Conversas sem retorno", LIMIARES.semResposta],
                    ["Recusas na base", LIMIARES.optOut],
                  ].map(([titulo, l]) => (
                    <div key={titulo as string} className="flex justify-between border-b border-line py-3 text-body">
                      <span>{titulo as string}</span>
                      <span className="num text-ink-2">
                        {(l as { atencao: number }).atencao}% / {(l as { critico: number }).critico}%
                      </span>
                    </div>
                  ))}
                </section>
              </div>
            )}
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
