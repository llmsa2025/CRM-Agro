"use client";

import { useEffect, useRef, useState } from "react";
import { Forward, Loader2, Pencil, QrCode, Trash2, UserRoundCheck } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import type { EnvioPeloGmail, SignatureDTO, WhatsAppHistoryStatus } from "@crmagro/core";
import type { PessoaLite } from "@/components/escopo/filtro-vendedor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { iconeDaFerramenta } from "@/components/brand-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabCount } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import type { Canal } from "@prisma/client";
import { deleteChannelAccountAction } from "../../conversas/actions";
import { desligarEnvioGmailAction } from "../email/actions";
import { NewEmailConnection, EditEmailConnection } from "./EmailConnectDialog";
import { EncaminhamentoDialog } from "./EncaminhamentoDialog";
import { caixaParaAbrirRecebimento, linhaDoRecebimento, recebimentoEmAndamento, type EstadoDoRecebimento } from "./encaminhamento";
import { resultadoDoGoogleEmCanais, rotuloDoProvedor } from "./gmail";
import { NewSocialConnection } from "./SocialConnectDialog";
import { SignaturesManager } from "./SignaturesManager";
import type { IdentidadeDaPagina } from "@/lib/extensao/ponte";
import { CANAIS_DA_TELA, canalAbreEmIntegracoes, type CanalDaTela } from "./abas";
import { HREF_CONECTAR_LINKEDIN, linhaDoLinkedin, resultadoDoLinkedinEmCanais, type ValidadeDoLinkedin } from "./linkedin";
import { desconectarLinkedinAction } from "./linkedin-actions";
import {
  cancelWhatsAppConnectAction,
  checkWhatsAppConnectAction,
  confirmWhatsAppConnectAction,
  startWhatsAppConnectAction,
  toggleAccountPausedAction,
  transferirCanalAction,
  renameChannelAccountAction,
} from "./actions";

export type ChannelAccountDTO = {
  id: string;
  canal: Canal;
  label: string;
  provider: string;
  status: string;
  /** Quem conectou/recebeu o número (F3d) — vê as conversas dele. */
  ownerId: string | null;
  donoNome: string | null;
  /** Progresso da importação do histórico do WhatsApp. */
  history: WhatsAppHistoryStatus | null;
  rate: { limit: number; sent: number; remaining: number; paused: boolean; warmupDay: number } | null;
  /** Só a conta oficial do LinkedIn: quanto falta para o token vencer. */
  validade?: ValidadeDoLinkedin | null;
};

// O logo de cada aba vem do mapa central (components/brand-icons.tsx).
const CANAIS: Record<CanalDaTela, { label: string; desc: string }> = {
  whatsapp: { label: "WhatsApp", desc: "Evolution API: conectar via QR code" },
  instagram: { label: "Instagram", desc: "Meta Graph / Messenger API" },
  linkedin: { label: "LinkedIn", desc: "Entrar com o LinkedIn e publicar no seu perfil. As mensagens chegam em breve." },
  email: { label: "E-mail", desc: "Gmail / IMAP+SMTP" },
};

/**
 * Como cada canal chama a conta (ajuste do dono, 28/09): o menu de transferir
 * dizia "o número" até na caixa de e-mail.
 */
const CONTA_DO_CANAL: Record<string, { passar: string; aria: string; desta: string }> = {
  whatsapp: { passar: "Passar o número para", aria: "Passar o número para outra pessoa", desta: "deste número" },
  email: { passar: "Passar a caixa para", aria: "Passar a caixa para outra pessoa", desta: "desta caixa" },
};
const CONTA_DE_REDE = { passar: "Passar a conta para", aria: "Passar a conta para outra pessoa", desta: "desta conta" };
const contaDo = (canal: string) => CONTA_DO_CANAL[canal] ?? CONTA_DE_REDE;

/** Situação da conexão em português (antes aparecia "connected"/"close" cru). */
function situacao(account: ChannelAccountDTO): { label: string; tone: StatusTone } {
  if (account.rate?.paused) return { label: "Pausada", tone: "attention" };
  if (account.status === "connected") return { label: "Conectado", tone: "ok" };
  if (account.status === "error") {
    return { label: account.canal === "whatsapp" ? "Sessão expirada" : account.canal === "linkedin" ? "Conexão vencida" : "Falha na conexão", tone: "error" };
  }
  return { label: "Desconectado", tone: "empty" };
}

const COUNTRY_CODES: { code: string; label: string }[] = [
  { code: "+55", label: "🇧🇷 +55" },
  { code: "+1", label: "🇺🇸 +1" },
  { code: "+351", label: "🇵🇹 +351" },
  { code: "+44", label: "🇬🇧 +44" },
  { code: "+34", label: "🇪🇸 +34" },
  { code: "+54", label: "🇦🇷 +54" },
];

/** Máscara BR de celular: "99 9 9999-9999" (DDD, 9, 4 dígitos, 4 dígitos). */
function maskPhoneBR(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 11);
  let out = d.slice(0, 2);
  if (d.length > 2) out += " " + d.slice(2, 3);
  if (d.length > 3) out += " " + d.slice(3, 7);
  if (d.length > 7) out += "-" + d.slice(7, 11);
  return out;
}

/**
 * Integrações → Canais em ABAS, uma por canal (ajuste do dono, 28/09). A aba
 * vem do `?canal=` (os "Gerenciar"/"Conectar" do card de Integrações abrem já
 * no canal) e trocar de aba reescreve o `?canal=` sem recarregar, para voltar e
 * recarregar manterem a aba.
 */
export function CanaisClient({
  accounts,
  transferirPara = [],
  assinaturas = [],
  canalInicial,
  identidade = null,
  recebeSemSenha = false,
  envioGmail = "desligado",
  enderecoGoogle = null,
  senhaNoEnderecoDoGoogle = false,
  recebimento = {},
  google = null,
  linkedinLigado = false,
  podeConectarLinkedin = false,
  linkedin = null,
}: {
  accounts: ChannelAccountDTO[];
  transferirPara?: PessoaLite[];
  /** Assinaturas de e-mail das caixas que a pessoa vê (por caixa). */
  assinaturas?: SignatureDTO[];
  canalInicial: CanalDaTela;
  /** Usuário e time da sessão: a conexão automática de Instagram/LinkedIn pela extensão precisa. */
  identidade?: IdentidadeDaPagina | null;
  /** A entrada de e-mail por encaminhamento está ligada neste servidor (o botão "Receber sem senha" aparece). */
  recebeSemSenha?: boolean;
  /** Estado do envio pelo Gmail para a pessoa da sessão (lido no servidor). */
  envioGmail?: EnvioPeloGmail;
  /** A conta Google da Agenda da pessoa (o Gmail sem senha usa a mesma), para o pop-up "Conectar e-mail". */
  enderecoGoogle?: string | null;
  /** Já existe caixa conectada por senha de app com esse endereço: o Gmail sem senha fica bloqueado. */
  senhaNoEnderecoDoGoogle?: boolean;
  /** Estado do recebimento por encaminhamento de cada caixa do Gmail sem senha (por id da caixa). */
  recebimento?: Record<string, EstadoDoRecebimento>;
  /** `?google=` da volta do Google (lido no servidor): o resultado que a tela mostra uma vez. */
  google?: string | null;
  /** O app do LinkedIn está configurado neste servidor: a aba abre (senão fica "Em breve"). */
  linkedinLigado?: boolean;
  /** A pessoa pode conectar o próprio LinkedIn (papel de membro e a tela Integrações). */
  podeConectarLinkedin?: boolean;
  /** `?linkedin=` da volta do LinkedIn (lido no servidor): o resultado que a tela mostra uma vez. */
  linkedin?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/integracoes/canais";
  const [canal, setCanal] = useState<CanalDaTela>(canalInicial);
  const hasWhatsApp = accounts.some((a) => a.canal === "whatsapp" && a.status === "connected");
  const syncing = accounts.some((a) => a.canal === "whatsapp" && a.status === "connected" && a.history?.status !== "completed");
  useEffect(() => {
    if (!hasWhatsApp) return;
    const timer = setInterval(() => router.refresh(), syncing ? 5000 : 30_000);
    return () => clearInterval(timer);
  }, [hasWhatsApp, syncing, router]);

  // Volta do Google (`?google=`): mostra o aviso UMA vez (o ref evita repetir no modo dev) e limpa
  // a URL, como o `trocarAba`.
  const avisoDoGoogleMostrado = useRef(false);
  useEffect(() => {
    if (!google || avisoDoGoogleMostrado.current) return;
    // Atraso curto de propósito: o `<Toaster />` do layout vem DEPOIS do conteúdo da página e só
    // passa a ouvir os avisos quando os efeitos dos filhos já rodaram. Um toast disparado direto
    // daqui se perderia (a URL ficava limpa e o aviso nunca aparecia).
    const timer = setTimeout(() => {
      avisoDoGoogleMostrado.current = true;
      const r = resultadoDoGoogleEmCanais(google);
      if (r) {
        if (r.ok) toast.success(r.texto);
        else toast.error(r.texto);
      }
      window.history.replaceState(null, "", `${pathname}?canal=${canal}`);
    }, 100);
    return () => clearTimeout(timer);
  }, [google, pathname, canal]);

  // Volta do LinkedIn (`?linkedin=`): o mesmo aviso de uma vez só.
  const avisoDoLinkedinMostrado = useRef(false);
  useEffect(() => {
    if (!linkedin || avisoDoLinkedinMostrado.current) return;
    const timer = setTimeout(() => {
      avisoDoLinkedinMostrado.current = true;
      const r = resultadoDoLinkedinEmCanais(linkedin);
      if (r) {
        if (r.ok) toast.success(r.texto);
        else toast.error(r.texto);
      }
      window.history.replaceState(null, "", `${pathname}?canal=${canal}`);
    }, 100);
    return () => clearTimeout(timer);
  }, [linkedin, pathname, canal]);

  // Enquanto falta o primeiro e-mail encaminhado, a linha da caixa confere de novo sozinha (a cada 15 s, com a
  // aba à vista, por até 15 minutos): o verde aparece sem a pessoa abrir nada.
  const recebimentoAndando = recebimentoEmAndamento(Object.values(recebimento));
  useEffect(() => {
    if (!recebimentoAndando) return;
    const inicio = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - inicio > 15 * 60_000) return clearInterval(timer);
      if (document.visibilityState === "visible") router.refresh();
    }, 15_000);
    return () => clearInterval(timer);
  }, [recebimentoAndando, router]);

  function trocarAba(v: string) {
    const novo = (CANAIS_DA_TELA as readonly string[]).includes(v) ? (v as CanalDaTela) : "whatsapp";
    setCanal(novo);
    // replaceState (e não push): trocar de aba não empilha histórico; o Next
    // sincroniza a URL com o roteador, então recarregar abre nesta aba.
    window.history.replaceState(null, "", `${pathname}?canal=${novo}`);
  }

  // Logo depois de conectar o Gmail sem senha, o passo a passo do recebimento abre sozinho: quem conecta
  // acha que já terminou, mas falta o encaminhamento (o Google só deixa a própria pessoa ligar).
  const abrirRecebimentoDe = recebeSemSenha ? caixaParaAbrirRecebimento(google, accounts, identidade?.userId ?? null) : null;

  const doCanal = accounts.filter((a) => a.canal === canal);
  const conectadas = doCanal.filter((a) => a.status === "connected").length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back="/integracoes"
        breadcrumb={[{ label: "Integrações", href: "/integracoes" }, { label: "Canais" }]}
        title={CANAIS[canal].label}
        subtitle={`${doCanal.length} ${doCanal.length === 1 ? "conta" : "contas"} · ${conectadas} ${conectadas === 1 ? "conectada" : "conectadas"}`}
      />

      <Tabs value={canal} onValueChange={trocarAba}>
        <TabsList className="gap-5 overflow-x-auto">
          {CANAIS_DA_TELA.map((c) => (
            <TabsTrigger key={c} value={c}>
              {CANAIS[c].label}
              <TabCount>{canalAbreEmIntegracoes(c, linkedinLigado) ? accounts.filter((a) => a.canal === c).length : "Em breve"}</TabCount>
            </TabsTrigger>
          ))}
        </TabsList>

        {CANAIS_DA_TELA.map((c) => {
          const meta = CANAIS[c];
          const Icone = iconeDaFerramenta(c);
          const canalAccounts = accounts.filter((a) => a.canal === c);
          return (
            <TabsContent key={c} value={c} className="mt-5">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
                  <Icone decorativo className="h-5 w-5" />
                </span>
                <p className="text-caption text-muted-foreground">
                  {c === "linkedin" && !linkedinLigado ? "Captação e mensagens diretas, em breve" : meta.desc}
                </p>
              </div>

              <div className="mt-4 space-y-2">
                {canalAccounts.length === 0 ? (
                  <p className="py-2 text-small text-ink-2">
                    {canalAbreEmIntegracoes(c, linkedinLigado) ? `Nenhuma conta de ${meta.label} conectada ainda.` : `A conexão com o ${meta.label} chega em breve.`}
                  </p>
                ) : (
                  canalAccounts.map((a) => (
                    <AccountRow
                      key={a.id}
                      account={a}
                      transferirPara={transferirPara}
                      assinaturas={c === "email" ? assinaturas.filter((s) => s.channelAccountId === a.id) : []}
                      recebeSemSenha={recebeSemSenha}
                      recebimento={recebimento[a.id]}
                      abrirRecebimentoAoMontar={a.id === abrirRecebimentoDe}
                    />
                  ))
                )}
              </div>

              {c === "whatsapp" ? (
                <NewWhatsAppConnection />
              ) : c === "email" ? (
                <NewEmailConnection
                  envioGmail={envioGmail}
                  enderecoGoogle={enderecoGoogle}
                  senhaNoEnderecoDoGoogle={senhaNoEnderecoDoGoogle}
                />
              ) : c === "linkedin" ? (
                // Uma conta de LinkedIn por pessoa: quem já tem a sua usa o "Conectar de novo" da própria linha.
                linkedinLigado && podeConectarLinkedin && !canalAccounts.some((a) => a.ownerId === identidade?.userId) ? (
                  <Button asChild variant="outline" size="sm" className="mt-4">
                    <a href={HREF_CONECTAR_LINKEDIN}>
                      <Icone decorativo className="mr-1.5 h-4 w-4" />
                      Entrar com LinkedIn
                    </a>
                  </Button>
                ) : null
              ) : (
                <NewSocialConnection canal={c} identidade={identidade} />
              )}
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}

function AccountRow({
  account,
  transferirPara,
  assinaturas,
  recebeSemSenha,
  recebimento,
  abrirRecebimentoAoMontar,
}: {
  account: ChannelAccountDTO;
  transferirPara: PessoaLite[];
  /** Só caixa de e-mail: as assinaturas desta caixa. */
  assinaturas: SignatureDTO[];
  /** Só caixa de e-mail: mostra o botão "Receber sem senha" (a entrada por encaminhamento está ligada). */
  recebeSemSenha: boolean;
  /** Só caixa do Gmail sem senha: em que pé está o recebimento por encaminhamento. */
  recebimento?: EstadoDoRecebimento;
  /** Abre o passo a passo do recebimento logo que a linha aparece (logo depois de conectar o Gmail). */
  abrirRecebimentoAoMontar: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [recebimentoAberto, setRecebimentoAberto] = useState(abrirRecebimentoAoMontar);
  const conta = contaDo(account.canal);
  const st = situacao(account);
  // Caixa do envio pelo Gmail (`gmail_api`): sem o lápis do SMTP, e quem desliga é o dono ou o administrador.
  const gmailApi = account.canal === "email" && account.provider === "gmail_api";
  // Enquanto o encaminhamento não funciona, a linha da caixa diz o que falta (envio e recebimento são passos separados).
  const linhaDeRecebimento = gmailApi && recebeSemSenha ? linhaDoRecebimento(recebimento) : null;
  // LinkedIn oficial: a linha diz quanto falta para o token vencer (o LinkedIn não renova sozinho).
  const linkedinOficial = account.canal === "linkedin" && account.provider === "linkedin_official";
  const linhaDoLinkedinOficial = linkedinOficial ? linhaDoLinkedin(account.status === "error" ? { estado: "vencida", dias: null } : account.validade) : null;

  async function transferir(p: PessoaLite) {
    if (!confirm(`Passar "${account.label}" para ${p.nome}? Ela passa a ver as conversas ${conta.desta}.`)) return;
    const res = await transferirCanalAction(account.id, p.id);
    if (res.ok) toast.success(`"${account.label}" agora é de ${p.nome}`);
    else toast.error("Não deu para transferir", { description: res.error });
  }
  const [pausing, setPausing] = useState(false);
  const rate = account.rate;

  async function disconnect() {
    if (linkedinOficial) {
      if (!confirm(`Desconectar o LinkedIn "${account.label}"? Os posts já publicados continuam no LinkedIn.`)) return;
      setBusy(true);
      const res = await desconectarLinkedinAction(account.id);
      setBusy(false);
      if (res.ok) {
        toast.success("LinkedIn desconectado");
        router.refresh();
      } else toast.error("Não deu para desconectar", { description: res.error });
      return;
    }
    if (gmailApi) {
      if (!confirm("Desligar o envio pelo Gmail? A sua Agenda Google continua conectada.")) return;
      setBusy(true);
      const res = await desligarEnvioGmailAction(account.id);
      setBusy(false);
      if (res.ok) toast.success("Envio pelo Gmail desligado");
      else toast.error("Não deu para desligar", { description: res.error });
      return;
    }
    const aviso =
      account.canal === "email"
        ? `Desconectar a caixa "${account.label}"? As assinaturas desta caixa também são apagadas.`
        : `Desconectar "${account.label}"?`;
    if (!confirm(aviso)) return;
    setBusy(true);
    const res = await deleteChannelAccountAction(account.id);
    setBusy(false);
    if (res.ok) toast.success(`Conta "${account.label}" desconectada`);
    else toast.error("Falha ao desconectar", { description: res.error });
  }

  async function togglePause() {
    if (!rate) return;
    setPausing(true);
    const res = await toggleAccountPausedAction(account.id, !rate.paused);
    setPausing(false);
    if (res.ok) toast.success(rate.paused ? "Conta retomada" : "Conta pausada");
    else toast.error("Falha", { description: res.error });
  }

  return (
    <div className="rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-body font-medium">{account.label}</p>
          <p className="text-caption text-muted-foreground">
            {rotuloDoProvedor(account.provider)}
            {account.donoNome ? ` · de ${account.donoNome}` : ""}
            {rate ? (
              <>
                {" · "}
                <span title="Envios de hoje / teto diário">
                  {rate.sent}/{rate.limit} hoje
                </span>
                {rate.warmupDay < 30 ? <span className="text-muted-foreground/70"> · aquecimento dia {rate.warmupDay}</span> : null}
              </>
            ) : null}
          </p>
          {account.canal === "whatsapp" && (account.status === "connected" || account.history) ? (
            <p className="mt-1 text-caption text-muted-foreground" role="status">
              {account.history?.status === "completed"
                ? `Histórico sincronizado · ${account.history.importadas.toLocaleString("pt-BR")} mensagens disponíveis`
                : account.history?.status === "error"
                  ? "Importação interrompida. Tentaremos novamente automaticamente."
                  : account.history?.status === "running"
                    ? `Importando histórico · ${Math.min(account.history.processadas, account.history.total).toLocaleString("pt-BR")} de ${account.history.total.toLocaleString("pt-BR")} registros verificados`
                    : "Aguardando importação do histórico…"}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusDot tone={st.tone}>{st.label}</StatusDot>
          {rate ? (
            <Button variant="ghost" size="sm" onClick={togglePause} disabled={pausing}>
              {pausing ? <Loader2 className="h-4 w-4 animate-spin" /> : rate.paused ? "Retomar" : "Pausar"}
            </Button>
          ) : null}
          {transferirPara.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={conta.aria}
                  title="Passa para outra pessoa da equipe; ela passa a ver as conversas desta conta"
                >
                  <UserRoundCheck className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel>{conta.passar}</DropdownMenuLabel>
                <p className="px-2 pb-1.5 text-caption text-muted-foreground">
                  Ela passa a ver as conversas {conta.desta}.
                </p>
                {transferirPara
                  .filter((p) => p.id !== account.ownerId)
                  .map((p) => (
                    <DropdownMenuItem key={p.id} onSelect={() => void transferir(p)}>
                      {p.nome}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {account.canal === "email" && recebeSemSenha ? (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setRecebimentoAberto(true)}
                aria-label={`Receber sem senha: ${account.label}`}
                title="Receber sem senha"
              >
                <Forward className="h-4 w-4" />
              </Button>
              <EncaminhamentoDialog
                accountId={account.id}
                label={account.label}
                open={recebimentoAberto}
                onOpenChange={(aberto) => {
                  setRecebimentoAberto(aberto);
                  // Ao fechar, a linha da caixa lê de novo em que pé está o recebimento.
                  if (!aberto) router.refresh();
                }}
              />
            </>
          ) : null}
          {/* Um lápis só por conta: no e-mail, nome e configuração ficam no mesmo diálogo. */}
          {account.canal === "email" && !gmailApi ? <EditEmailConnection accountId={account.id} label={account.label} /> : null}
          {account.canal === "whatsapp" ? <EditAccountName account={account} /> : null}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={disconnect}
            disabled={busy}
            aria-label={gmailApi ? `Desligar o envio pelo Gmail: ${account.label}` : `Desconectar ${account.label}`}
            title={gmailApi ? "Desligar o envio pelo Gmail" : "Desconectar"}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>
      {linhaDoLinkedinOficial ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
          <StatusDot tone={linhaDoLinkedinOficial.tone} className="items-start whitespace-normal [&>span:first-child]:mt-[7px]">
            {linhaDoLinkedinOficial.texto}
          </StatusDot>
          {linhaDoLinkedinOficial.reconectar ? (
            <Button asChild variant="outline" size="sm">
              <a href={HREF_CONECTAR_LINKEDIN}>Conectar de novo</a>
            </Button>
          ) : null}
        </div>
      ) : null}
      {linhaDeRecebimento ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
          <StatusDot tone={linhaDeRecebimento.tone} className="items-start whitespace-normal [&>span:first-child]:mt-[7px]">
            {linhaDeRecebimento.texto}
          </StatusDot>
          {linhaDeRecebimento.assistente ? (
            <Button variant="outline" size="sm" onClick={() => setRecebimentoAberto(true)}>
              Ver o passo a passo
            </Button>
          ) : null}
        </div>
      ) : null}
      {account.canal === "email" ? (
        <SignaturesManager channelAccountId={account.id} caixa={account.label} inicial={assinaturas} />
      ) : null}
    </div>
  );
}

function EditAccountName({ account }: { account: ChannelAccountDTO }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await renameChannelAccountAction(account.id, label.trim());
      if (!r.ok) { toast.error("Falha ao editar nome", { description: r.error }); return; }
      toast.success("Nome da conta atualizado");
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Não foi possível salvar. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) setOpen(v); }}>
      <Button variant="ghost" size="icon-sm" aria-label={`Editar nome de ${account.label}`} title="Editar nome" onClick={() => { setLabel(account.label); setOpen(true); }}>
        <Pencil className="h-4 w-4" />
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar nome da conta</DialogTitle>
          <DialogDescription>Esse nome identifica o WhatsApp nos canais e nas conversas do CRM Agro.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`account-name-${account.id}`}>Nome da conta</Label>
            <Input id={`account-name-${account.id}`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} required disabled={saving} autoFocus />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>Cancelar</Button>
            <Button type="submit" disabled={saving || !label.trim()}>{saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}Salvar nome</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewWhatsAppConnection() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4">
      <Button size="sm" onClick={() => setOpen(true)}>
        <QrCode className="mr-1.5 h-4 w-4" />
        Nova conexão
      </Button>
      <WhatsAppConnectDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function WhatsAppConnectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [label, setLabel] = useState("");
  const [countryCode, setCountryCode] = useState("+55");
  const [number, setNumber] = useState("");
  const [instance, setInstance] = useState<string | null>(null);

  /** Número completo em formato E.164 (código do país + dígitos), ou undefined. */
  function fullNumber(): string | undefined {
    const d = number.replace(/\D/g, "");
    return d ? `${countryCode}${d}` : undefined;
  }
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Instância confirmada (virou conta salva) NÃO deve ser deletada ao fechar.
  const confirmedRef = useRef(false);

  function reset() {
    setLabel("");
    setCountryCode("+55");
    setNumber("");
    setInstance(null);
    setQr(null);
    setBusy(false);
    setPolling(false);
    setError(null);
    confirmedRef.current = false;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function close() {
    // Se gerou o QR mas não confirmou a conexão, remove a instância órfã na
    // Evolution (fire-and-forget) pra não vazar recurso na VPS.
    const abandoned = instance && !confirmedRef.current ? instance : null;
    reset();
    onOpenChange(false);
    if (abandoned) void cancelWhatsAppConnectAction(abandoned);
  }

  async function generate() {
    if (!label.trim()) {
      setError("Informe um nome para a conta.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await startWhatsAppConnectAction({ label: label.trim(), number: fullNumber() });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "falha ao gerar QR");
      return;
    }
    setInstance(res.instance ?? null);
    if (res.alreadyConnected) {
      await finish(res.instance!);
      return;
    }
    setQr(res.qrBase64 ?? null);
    startPolling(res.instance!);
  }

  function startPolling(inst: string) {
    setPolling(true);
    pollRef.current = setInterval(async () => {
      const check = await checkWhatsAppConnectAction(inst);
      if (check.connected) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setPolling(false);
        await finish(inst);
      }
    }, 3000);
  }

  async function finish(inst: string) {
    setBusy(true);
    const res = await confirmWhatsAppConnectAction({
      label: label.trim(),
      number: fullNumber(),
      instance: inst,
    });
    setBusy(false);
    if (res.ok) {
      confirmedRef.current = true; // conta salva — não deletar a instância no close
      toast.success(`Conta "${label.trim()}" conectada`, { description: "O histórico será importado automaticamente. Acompanhe o progresso em Canais." });
      close();
    } else {
      setError(res.error ?? "falha ao salvar conta");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Conectar WhatsApp</DialogTitle>
          <DialogDescription>
            Informe um nome e o número de referência. Geramos um QR code pra você escanear pelo WhatsApp e conectar.
            As conversas anteriores serão importadas automaticamente. Arquivos antigos poderão ser consultados no celular.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="wa-label">Nome da conta</Label>
            <Input id="wa-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex.: WhatsApp comercial" disabled={!!instance} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wa-number">Número (referência)</Label>
            <div className="flex gap-2">
              <Select value={countryCode} onValueChange={setCountryCode} disabled={!!instance}>
                <SelectTrigger className="w-28 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRY_CODES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                id="wa-number"
                inputMode="numeric"
                value={number}
                onChange={(e) => setNumber(maskPhoneBR(e.target.value))}
                placeholder="99 9 9999-9999"
                disabled={!!instance}
              />
            </div>
          </div>

          {qr && (
            <div className="flex flex-col items-center gap-2 py-2">
              <img src={qr} alt="QR code WhatsApp" className="h-56 w-56 rounded-md border bg-white p-2" />
              <p className="text-caption text-muted-foreground">
                Abra o WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho e escaneie o QR.
              </p>
              {polling && (
                <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Aguardando scan…
                </span>
              )}
            </div>
          )}

          {error && <p className="text-caption text-danger-700">{error}</p>}
        </div>

        <DialogFooter>
          {!instance ? (
            <Button onClick={generate} disabled={busy}>
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <QrCode className="mr-1.5 h-4 w-4" />}
              Gerar QR
            </Button>
          ) : (
            <Button variant="outline" onClick={close} disabled={busy}>
              Fechar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
