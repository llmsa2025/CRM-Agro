import { Suspense } from "react";
import Link from "next/link";
import { runAsUser } from "@/lib/tenant";
import { db } from "@crmagro/db";
import {
  agendaGoogleLiberadaParaMim,
  aquecerBetaCrm,
  crmLiberadoParaOTime,
  escopoCanal,
  getAccountRateStatus,
  getAiMode,
  googleAgendaConfigurada,
  linkedinConfigurado,
  listAiIntegrations,
  minhaConexaoGoogle,
  podeConectarGoogle,
  statusNectar,
  type ConexaoGoogleDTO,
} from "@crmagro/core";
import { GoogleAgendaConexao } from "@/components/agenda/google-agenda-conexao";
import { desconectarGoogleAction, sincronizarGoogleAction } from "./google/actions";
import { iconeDaFerramenta, LogoFerramenta, nomeDaFerramenta } from "@/components/brand-icons";
import { Button } from "@/components/ui/button";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { canalAbreEmIntegracoes, contasDeIntegracoes } from "./canais/abas";
import { estadoNoHub } from "@/lib/nectar/conexao";

export const dynamic = "force-dynamic";

const CANAL_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  email: "E-mail",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

const STATUS: Record<string, { label: string; tone: StatusTone }> = {
  connected: { label: "Conectado", tone: "ok" },
  pending: { label: "Aguardando", tone: "attention" },
  error: { label: "Sessão expirada", tone: "error" },
  disconnected: { label: "Desconectado", tone: "empty" },
  paused: { label: "Pausado", tone: "attention" },
};

/**
 * ERPs e CRMs que o CRM Agro integra. Cada item tem id (o mesmo do mapa de logos
 * em components/brand-icons.tsx), nome e descrição curta. Só o Nectar está na
 * lista. O estado dele vem da conexão do time (`estadoNoHub`): time fora do beta
 * (`CRM_BETA_TEAM_IDS`) continua "Em breve", sem botão; time do beta vê
 * "Conectar" ou "Gerenciar" e o estado real. O bloco fica pronto para os
 * próximos entrarem por aqui.
 */
const ERPS: { id: string; nome: string; descricao: string; href: string }[] = [
  {
    id: "nectar",
    nome: "Nectar CRM",
    descricao: "envio de contatos, cards e histórico para o Nectar",
    href: "/integracoes/crm/nectarcrm",
  },
];

/** Hub de Integrações: canais conectados, IA, dados e extensão, numa tela só. */
export default async function IntegracoesPage() {
  const agendaGoogle = googleAgendaConfigurada();
  const linkedinLigado = linkedinConfigurado();
  const { contas, ia, provedores, google, podeConectar, liberada, crm } = await runAsUser(async () => {
    const rows = contasDeIntegracoes(
      await db().channelAccount.findMany({
        where: escopoCanal(), // F3: os números que a pessoa vê
        orderBy: { createdAt: "asc" },
        select: { id: true, canal: true, label: true, provider: true, status: true, paused: true },
      }),
      linkedinLigado,
    );
    const contas = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        rate: r.canal === "whatsapp" ? await getAccountRateStatus(r.id).catch(() => null) : null,
      })),
    );
    const ia = await getAiMode().catch(() => null);
    // Só o estado de cada provedor (a chave nunca vem): alimenta os logos do card de IA.
    const provedores = await listAiIntegrations().catch(() => []);
    // A conexão é só da pessoa logada (nunca a de outra, nem para o master).
    const google: ConexaoGoogleDTO | null = agendaGoogle ? await minhaConexaoGoogle().catch(() => null) : null;
    // A2: até o Google verificar o app, só quem está em GOOGLE_AGENDA_LIBERADOS conecta.
    const liberada = agendaGoogle ? await agendaGoogleLiberadaParaMim().catch(() => false) : false;
    // Nectar: só os times do beta veem a integração; o hub nunca quebra se a leitura falhar.
    // Esperar a primeira leitura da flag: na Vercel a instância sobe fria e o gate síncrono diria "desligado".
    await aquecerBetaCrm().catch(() => undefined);
    const crm = crmLiberadoParaOTime() ? await statusNectar().catch(() => null) : null;
    return { contas, ia, provedores, google, podeConectar: podeConectarGoogle(), liberada, crm };
  }).catch(() => ({ contas: [], ia: null, provedores: [], google: null, podeConectar: false, liberada: false, crm: null }));

  const conectadas = contas.filter((c) => c.status === "connected").length;
  const atencao = contas.filter((c) => c.status !== "connected" || c.paused).length;
  const canaisCadastrados = new Set(contas.map((c) => c.canal));
  const faltando = (["whatsapp", "email", "instagram", "linkedin"] as const).filter((c) => !canaisCadastrados.has(c));
  const IconeWebhook = iconeDaFerramenta("webhook");
  const IconeApi = iconeDaFerramenta("api");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Integrações"
        subtitle={`${conectadas} ${conectadas === 1 ? "conectada" : "conectadas"}${atencao ? ` · ${atencao} ${atencao === 1 ? "precisa" : "precisam"} de atenção` : ""}`}
      />

      <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-10">
          <section aria-labelledby="t-canais">
            <SectionHeader id="t-canais" title="Canais de mensagem" />
            {contas.map((c) => {
              // Estado desconhecido nunca aparece cru em inglês: vale "Desconectado".
              const st = c.paused ? STATUS.paused! : (STATUS[c.status] ?? STATUS.disconnected!);
              const sub =
                c.canal === "whatsapp" && c.rate
                  ? `${c.rate.warmupDay ? `aquecimento dia ${c.rate.warmupDay} · ` : ""}${c.rate.sent}/${c.rate.limit} envios hoje`
                  : c.canal === "email"
                    ? "envio, leitura e assinaturas da caixa"
                    : c.canal === "linkedin"
                      ? "publicar no seu perfil"
                      : "captação e mensagens diretas";
              return (
                <div key={c.id} className="flex items-center gap-4 border-b border-line py-3.5">
                  <LogoFerramenta id={c.canal} />
                  <div className="min-w-0 flex-1">
                    <div className="text-body font-medium">
                      {CANAL_LABEL[c.canal] ?? c.canal} · {c.label}
                    </div>
                    <div className="num truncate text-small text-ink-2">{sub}</div>
                  </div>
                  <StatusDot tone={st.tone}>{st.label}</StatusDot>
                  <Button asChild variant={st.tone === "error" ? "default" : "ghost"}>
                    <Link href={`/integracoes/canais?canal=${c.canal}`}>{st.tone === "error" ? "Reconectar" : "Gerenciar"}</Link>
                  </Button>
                </div>
              );
            })}
            {faltando.map((canal) => (
              <div key={canal} className="flex items-center gap-4 border-b border-line py-3.5">
                <LogoFerramenta id={canal} />
                <div className="min-w-0 flex-1">
                  <div className="text-body font-medium">{CANAL_LABEL[canal]}</div>
                  <div className="text-small text-ink-2">
                    {canal === "whatsapp"
                      ? "envio de campanhas e inbox"
                      : canal === "email"
                        ? "envio e leitura da caixa"
                        : canal === "linkedin"
                          ? "publicar no seu perfil"
                          : "captação e mensagens diretas"}
                  </div>
                </div>
                {!canalAbreEmIntegracoes(canal, linkedinLigado) ? (
                  <StatusDot tone="empty">Em breve</StatusDot>
                ) : (
                  <>
                    <StatusDot tone="empty">Não conectado</StatusDot>
                    <Button asChild variant="outline">
                      <Link href={`/integracoes/canais?canal=${canal}`}>Conectar</Link>
                    </Button>
                  </>
                )}
              </div>
            ))}
          </section>

          {/* A2: fora da lista de liberados e sem conexão, o cartão nem aparece. */}
          {agendaGoogle && (liberada || google) && (
            <section aria-labelledby="t-agenda">
              <SectionHeader id="t-agenda" title="Agenda e reuniões" />
              <Suspense>
                <GoogleAgendaConexao
                  conexao={google}
                  volta="integracoes"
                  podeConectar={podeConectar}
                  liberada={liberada}
                  desconectar={desconectarGoogleAction}
                  sincronizar={sincronizarGoogleAction}
                />
              </Suspense>
            </section>
          )}

          <section aria-labelledby="t-ia">
            <SectionHeader id="t-ia" title="Inteligência artificial" />
            <div className="flex items-center gap-4 border-b border-line py-3.5">
              <LogoFerramenta id="ia" />
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium">Provedores e governança</div>
                <div className="text-small text-ink-2">
                  {ia === "off" || ia === null ? "Desligada" : ia === "read_only" ? "Só consulta" : "Consulta e edita"}
                </div>
              </div>
              {/* Logo de cada provedor; os que ainda não têm chave ficam apagados. */}
              <ul className="hidden items-center gap-2 sm:flex" aria-label="Provedores de IA">
                {provedores.map((p) => {
                  const Logo = iconeDaFerramenta(p.provider, "ia");
                  const nome = nomeDaFerramenta(p.provider, "ia");
                  return (
                    <li
                      key={p.provider}
                      title={`${nome}: ${p.connected ? "conectado" : "não conectado"}`}
                      className={p.connected ? undefined : "opacity-40 grayscale"}
                    >
                      <Logo decorativo className="h-4 w-4" />
                      <span className="sr-only">
                        {nome}, {p.connected ? "conectado" : "não conectado"}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <StatusDot tone={ia && ia !== "off" ? "ok" : "empty"}>{ia && ia !== "off" ? "Ativa" : "Desligada"}</StatusDot>
              <Button asChild variant="ghost">
                <Link href="/integracoes/ia">Gerenciar</Link>
              </Button>
            </div>
          </section>

          <section aria-labelledby="t-dados">
            <SectionHeader id="t-dados" title="Fontes de dados" />
            <div className="flex items-center gap-4 border-b border-line py-3.5">
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium">Consultas pagas</div>
                <div className="text-small text-ink-2">busca de pessoas por nome, com custo mostrado antes de cada consulta</div>
              </div>
              <Button asChild variant="ghost">
                <Link href="/integracoes/dados">Gerenciar</Link>
              </Button>
            </div>
          </section>

          <section aria-labelledby="t-erps">
            <SectionHeader id="t-erps" title="ERPs e CRMs" />
            {ERPS.map((e) => {
              // Só o Nectar existe hoje: o estado dele vem da conexão do time.
              const estado = estadoNoHub(crm);
              return (
                <div key={e.id} className="flex items-center gap-4 border-b border-line py-3.5">
                  <LogoFerramenta id={e.id} />
                  <div className="min-w-0 flex-1">
                    <div className="text-body font-medium">{e.nome}</div>
                    <div className="truncate text-small text-ink-2">{e.descricao}</div>
                  </div>
                  <StatusDot tone={estado.tone}>{estado.label}</StatusDot>
                  {estado.botao ? (
                    <Button asChild variant={estado.botao === "Conectar" ? "outline" : "ghost"}>
                      <Link href={e.href}>{estado.botao}</Link>
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </section>
        </div>

        <aside className="flex flex-col gap-9">
          <section aria-labelledby="t-api">
            <SectionHeader id="t-api" variant="aside" title="API e webhooks" />
            <div className="flex items-center justify-between border-b border-line py-3 text-small">
              <span className="flex items-center gap-2 text-ink-2">
                <IconeWebhook decorativo className="h-4 w-4" />
                Webhooks de entrada
              </span>
              <span className="text-ink-3">no gatilho do fluxo</span>
            </div>
            <div className="flex items-center justify-between border-b border-line py-3 text-small">
              <span className="flex items-center gap-2 text-ink-2">
                <IconeApi decorativo className="h-4 w-4" />
                API pública
              </span>
              <span className="text-ink-3">Em breve</span>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
