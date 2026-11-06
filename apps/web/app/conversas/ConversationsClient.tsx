"use client";

import { mensagemParaTela } from "@/lib/erros";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { iconeDaFerramenta } from "@/components/brand-icons";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { AvatarDoContato } from "./AvatarDoContato";
import { StatusDot } from "@/components/ui/status-dot";
import { initialsOf, formatPhone } from "@/lib/format";
import { tipoDoAnexo } from "@/lib/anexar-arquivos";
import { toast } from "sonner";
import type { Canal } from "@prisma/client";
import type { ConversationListItem, MessageDTO, RealtimeEvent } from "@crmagro/core";
import { cn } from "@/lib/utils";
import { useSocket } from "@/lib/socket-client";
import {
  listConversationsAction,
  listMessagesAction,
  markReadAction,
  sendMessageAction,
  sendMediaAction,
  sendTypingAction,
} from "./actions";
import { InteresseBadge } from "@/components/ui/interesse-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConversationList } from "./ConversationList";
import { MessageThread } from "./MessageThread";
import { Composer, type ComposerHandle } from "./Composer";
import { AreaSoltarArquivos } from "./AreaSoltarArquivos";
import { EmailLista, EmailThread, useEmailInbox } from "./EmailWorkspace";
import { ConversationActions } from "./ConversationActions";
import { NewConversationButton } from "./NewConversationButton";
import type { FunnelOption } from "@/components/add-to-funnel-dialog";
import { canalEmBreve } from "../integracoes/canais/abas";

/** Conversa sem contato mostra o número; iniciais só fazem sentido para nome. */
type FiltroConversa = "todas" | "nao_lidas" | "interessados" | "aguardando";

/** Filtros rápidos da lista. "Aguardando" = o contato falou por último e ainda não houve resposta. */
const FILTROS_CONVERSA: Record<FiltroConversa, { rotulo: string; casa: (c: ConversationListItem) => boolean }> = {
  todas: { rotulo: "Todas", casa: () => true },
  nao_lidas: { rotulo: "Não lidas", casa: (c) => c.unreadCount > 0 },
  interessados: { rotulo: "Interessados", casa: (c) => c.contact?.interesse === "interessado" },
  aguardando: { rotulo: "Aguardando", casa: (c) => c.lastMessage?.direcao === "in" },
};

function nomeExibido(nome: string): string {
  return nome.startsWith("+") ? formatPhone(nome) : nome;
}
function iniciais(nome: string): string {
  return nome.startsWith("+") ? "#" : initialsOf(nome) || "?";
}

export type ChannelAccountDTO = {
  id: string;
  canal: Canal;
  label: string;
  provider: string;
  status: string;
};

type Platform = { canal: Canal; label: string };

/** Dica (e nome acessível) do ícone do canal: o canal e a conta, ou o estado dele. */
function dicaDoCanal(label: string, contas: ChannelAccountDTO[], emBreve: boolean): string {
  if (emBreve) return `${label} · em breve`;
  if (contas.length === 0) return `${label} · sem conta conectada`;
  if (contas.length > 1) return `${label} · ${contas.length} contas`;
  const [c] = contas;
  return c!.status === "connected" ? `${label} · ${c!.label}` : `${label} · ${c!.label} (${c!.status})`;
}

const PLATFORMS: Platform[] = [
  { canal: "whatsapp", label: "WhatsApp" },
  { canal: "instagram", label: "Instagram" },
  { canal: "linkedin", label: "LinkedIn" },
  { canal: "email", label: "E-mail" },
];

export function ConversationsClient({
  accounts,
  funnels,
  initial,
}: {
  accounts: ChannelAccountDTO[];
  funnels: FunnelOption[];
  /** Seleção inicial via deep-link (ícone de canal na lista de contatos). */
  initial?: { platform: Canal; accountId: string; conversationId: string } | null;
}) {
  const accountsByCanal = (canal: Canal) => accounts.filter((a) => a.canal === canal);

  const firstPlatformWithAccounts =
    PLATFORMS.find((p) => accountsByCanal(p.canal).length > 0)?.canal ?? "whatsapp";

  const [platform, setPlatform] = useState<Canal>(initial?.platform ?? firstPlatformWithAccounts);
  const [accountId, setAccountId] = useState<string | null>(
    initial?.accountId ?? accountsByCanal(firstPlatformWithAccounts)[0]?.id ?? null,
  );
  // Conversa a abrir assim que a lista da conta carregar (deep-link). Consumida
  // uma única vez.
  const pendingOpen = useRef<string | null>(initial?.conversationId ?? null);

  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [loadingConvos, setLoadingConvos] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const conversationIdRef = useRef<string | null>(null);
  conversationIdRef.current = conversationId;

  const refreshConvosNow = useCallback(async (accId: string) => {
    setLoadingConvos(true);
    try {
      const list = await listConversationsAction(accId);
      setConversations(list);
    } catch (e) {
      toast.error("Falha ao carregar conversas", { description: mensagemParaTela(e) });
    } finally {
      setLoadingConvos(false);
    }
  }, []);

  // Debounce de 1 s: cada mensagem recebida dispara um evento por aba; sem isso
  // uma rajada recarrega a lista dezenas de vezes (a lista é a consulta mais
  // cara do inbox — auditoria DP-01).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshConvos = useCallback(
    (accId: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void refreshConvosNow(accId);
      }, 1_000);
    },
    [refreshConvosNow],
  );

  const refreshMessages = useCallback(async (convId: string) => {
    setLoadingMsgs(true);
    try {
      const list = await listMessagesAction(convId);
      setMessages(list);
    } catch (e) {
      toast.error("Falha ao carregar mensagens", { description: mensagemParaTela(e) });
    } finally {
      setLoadingMsgs(false);
    }
  }, []);

  // Troca de conta conectada → recarrega conversas.
  useEffect(() => {
    if (!accountId) {
      setConversations([]);
      setConversationId(null);
      setMessages([]);
      return;
    }
    setConversationId(null);
    setMessages([]);
    void refreshConvosNow(accountId);
  }, [accountId, refreshConvosNow]);

  // Socket.IO: inbox ao vivo. O socket entra na room do time (autenticada no
  // handshake) e recebe TODOS os eventos de conversa do time; filtramos aqui
  // pela conta selecionada. Um único socket por aba, com reconexão automática —
  // trocar de conta só troca o filtro, não reconecta.
  const handleMessageEvent = useCallback(
    (event: Extract<RealtimeEvent, { type: "message:received" | "message:sent" }>) => {
      if (!accountId || event.channelAccountId !== accountId) return;
      // Atualiza lista (preview/não-lidas) e, se a conversa aberta for a afetada, a thread.
      refreshConvos(accountId);
      if (event.conversationId === conversationIdRef.current) {
        refreshMessages(event.conversationId);
      }
    },
    [accountId, refreshConvos, refreshMessages],
  );

  // Recibo de status (✓/✓✓): atualiza só o tique da mensagem afetada, ao vivo.
  const handleStatusEvent = useCallback(
    (event: Extract<RealtimeEvent, { type: "message:status" }>) => {
      if (!accountId || event.channelAccountId !== accountId) return;
      if (event.conversationId !== conversationIdRef.current) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === event.messageId ? { ...m, status: event.status } : m)),
      );
    },
    [accountId],
  );

  const { connected: socketUp } = useSocket({
    "message:received": handleMessageEvent,
    "message:sent": handleMessageEvent,
    "message:status": handleStatusEvent,
  });

  // Polling — só rede de segurança, não o mecanismo principal.
  //
  // Com o Socket.IO + Redis adapter, o evento cruza processos (worker → web) e
  // chega de fato, mesmo com múltiplas instâncias. O polling vira reconciliação:
  //
  // Socket de pé: reconciliação lenta (60s), só pra corrigir divergência caso um
  // evento se perca. Socket caído (ex.: Vercel sem custom server, ou queda de
  // rede antes de reconectar): volta pros 6s até o socket voltar.
  useEffect(() => {
    if (!accountId) return;
    const intervalo = socketUp ? 60_000 : 6_000;
    const id = setInterval(() => {
      refreshConvos(accountId);
      if (conversationIdRef.current) refreshMessages(conversationIdRef.current);
    }, intervalo);
    return () => clearInterval(id);
  }, [accountId, socketUp, refreshConvos, refreshMessages]);

  function openConversationById(conversationId: string) {
    if (accountId) refreshConvos(accountId);
    setConversationId(conversationId);
    setMessages([]);
    refreshMessages(conversationId);
  }

  // Deep-link: assim que a lista da conta carregar e contiver a conversa alvo,
  // abre-a uma vez. Se a conta ainda não tem a conversa listada (recém-criada),
  // abre mesmo assim pelo id.
  useEffect(() => {
    const target = pendingOpen.current;
    if (!target) return;
    pendingOpen.current = null;
    setConversationId(target);
    setMessages([]);
    refreshMessages(target);
  }, [conversations, refreshMessages]);

  function selectConversation(c: ConversationListItem) {
    setConversationId(c.id);
    setMessages([]);
    refreshMessages(c.id);
    markReadAction(c.id).catch(() => undefined);
    // otimista: zera não-lidas localmente
    setConversations((prev) =>
      prev.map((x) => (x.id === c.id ? { ...x, unreadCount: 0 } : x)),
    );
  }

  async function handleSend(text: string) {
    if (!conversationId) return;
    // UI otimista: a mensagem aparece na hora (status "enviando") e o campo NÃO
    // trava — dá pra digitar/enviar a próxima em seguida, como no WhatsApp.
    const tempId = `temp-${Date.now()}`;
    const optimistic: MessageDTO = {
      id: tempId,
      direcao: "out",
      tipo: "text",
      conteudo: text,
      mediaUrl: null,
      mediaMime: null,
      status: "sending",
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    const res = await sendMessageAction(conversationId, text);
    if (res.ok && res.message) {
      setMessages((prev) => prev.map((m) => (m.id === tempId ? res.message! : m)));
      if (accountId) refreshConvos(accountId);
    } else {
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, status: "failed" } : m)));
      toast.error("Falha ao enviar", { description: res.error });
    }
  }

  async function handleSendMedia(file: File, caption: string, confirmarReenvio = false) {
    if (!conversationId) return;

    // UI otimista: a mídia aparece IMEDIATAMENTE com preview local (object URL),
    // enquanto sobe pro servidor. Reconciliamos quando a action responde.
    const tempId = `temp-${Date.now()}`;
    const localUrl = URL.createObjectURL(file);
    const tipo = tipoDoAnexo(file.type);
    const optimistic: MessageDTO = {
      id: tempId,
      direcao: "out",
      tipo,
      conteudo: caption || (tipo === "doc" ? file.name : null),
      mediaUrl: localUrl,
      mediaMime: file.type || null,
      status: "sending",
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    const fd = new FormData();
    fd.set("conversationId", conversationId);
    fd.set("file", file);
    fd.set("caption", caption);
    if (confirmarReenvio) fd.set("confirmarReenvio", "1");
    const res = await sendMediaAction(fd);

    if (res.ok && res.message) {
      // Troca a mensagem otimista pela real (URL assinada do servidor).
      setMessages((prev) => prev.map((m) => (m.id === tempId ? res.message! : m)));
      URL.revokeObjectURL(localUrl);
      if (res.message.status === "unconfirmed") {
        // Prazo estourou, mas a mídia pode ter saído: NÃO é falha ainda. O
        // tique atualiza sozinho quando o WhatsApp confirmar.
        toast.warning("Envio ainda não confirmado", {
          description: "A mídia pode já ter chegado ao WhatsApp. O status atualiza sozinho. Confira antes de reenviar.",
        });
      } else if (res.message.status === "failed") {
        toast.warning("Mídia salva, mas não enviada ao WhatsApp", {
          description: "O provider recusou o envio. Ela aparece aqui na conversa.",
        });
      }
      if (accountId) refreshConvos(accountId);
    } else if (res.reenvioPendente) {
      // O mesmo arquivo foi enviado há pouco e ainda não foi confirmado: pergunta
      // antes de duplicar no celular do destinatário.
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      URL.revokeObjectURL(localUrl);
      toast.warning("Este arquivo pode já ter sido enviado", {
        description: res.error,
        duration: 15000,
        action: { label: "Enviar mesmo assim", onClick: () => void handleSendMedia(file, caption, true) },
      });
    } else {
      // Falhou: remove a otimista e avisa.
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      URL.revokeObjectURL(localUrl);
      toast.error("Falha ao enviar mídia", { description: res.error });
    }
  }

  // Enquanto o operador digita, mostra "digitando" no WhatsApp do contato.
  // Throttle: no máximo 1 chamada a cada 3s (a presença dura ~4s no provider),
  // para não inundar a Evolution a cada tecla.
  const lastTypingRef = useRef(0);
  function handleTyping() {
    if (!conversationId) return;
    const agora = Date.now();
    if (agora - lastTypingRef.current < 3000) return;
    lastTypingRef.current = agora;
    sendTypingAction(conversationId, 4000).catch(() => undefined);
  }

  // Conta aberta por último em cada canal: voltar ao canal reabre a mesma conta.
  const ultimaContaPorCanal = useRef<Partial<Record<Canal, string>>>({});
  function changePlatform(canal: Canal) {
    if (accountId) ultimaContaPorCanal.current[platform] = accountId;
    setPlatform(canal);
    const contas = accountsByCanal(canal);
    const lembrada = contas.find((a) => a.id === ultimaContaPorCanal.current[canal]);
    setAccountId((lembrada ?? contas[0])?.id ?? null);
  }

  const platformAccounts = accountsByCanal(platform);
  const selectedConversation = conversations.find((c) => c.id === conversationId) ?? null;

  // Busca na lista: nome, número ou palavra da última mensagem.
  const [q, setQ] = useState("");
  // Filtro rápido embaixo da busca (combina com o texto digitado).
  const [filtro, setFiltro] = useState<FiltroConversa>("todas");
  const contagemFiltros = useMemo(
    () => ({
      todas: conversations.length,
      nao_lidas: conversations.filter(FILTROS_CONVERSA.nao_lidas.casa).length,
      interessados: conversations.filter(FILTROS_CONVERSA.interessados.casa).length,
      aguardando: conversations.filter(FILTROS_CONVERSA.aguardando.casa).length,
    }),
    [conversations],
  );
  const filteredConversations = useMemo(() => {
    const term = q.trim().toLowerCase();
    const base = filtro === "todas" ? conversations : conversations.filter(FILTROS_CONVERSA[filtro].casa);
    if (!term) return base;
    return base.filter((c) =>
      [c.displayName, c.numero, c.externalNumber, c.lastMessage?.conteudo]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(term)),
    );
  }, [conversations, q, filtro]);

  // Trava o scroll da PÁGINA enquanto Conversas está aberto — o inbox e a thread
  // já rolam por dentro. Assim, mesmo que algum conteúdo tente esticar a página,
  // nunca aparece aquela "sobra" cinza embaixo. Restaura ao sair da tela.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const plataformaAtual = PLATFORMS.find((p) => p.canal === platform)!;
  // Arrastar e soltar arquivo só vale com conversa aberta E campo de escrita à mostra
  // (conversa antiga sem telefone só permite consulta: sem Composer, sem anexo).
  const conversaSoConsulta = Boolean(selectedConversation?.externalNumber?.endsWith("@lid") && !selectedConversation.numero);
  const podeAnexar = Boolean(conversationId) && !conversaSoConsulta;
  const composerRef = useRef<ComposerHandle>(null);
  // E-mail: lista à esquerda + conversa na área maior (mesmo desenho do WhatsApp).
  const emailInbox = useEmailInbox(platform === "email" ? accountId : null);
  const naoLidas = conversations.reduce((a, c) => a + (c.unreadCount > 0 ? 1 : 0), 0);

  return (
    // Tela cheia (a casca tira o padding): lista | thread | ficha, altura do viewport.
    <div className="flex h-[calc(100dvh-52px)] min-h-0 overflow-hidden">
      {/* Coluna 1 — lista de conversas */}
      <div className="flex w-[336px] shrink-0 flex-col border-r border-line">
        <div className="px-6 pt-8">
          <h1 className="font-serif text-title text-foreground">Conversas</h1>
        </div>

        {/* Canais: um ícone por canal, a troca é um clique. O nome da conta fica na dica. */}
        <div className="flex items-end gap-3 px-6 pt-4">
          <Tabs value={platform} onValueChange={(v) => changePlatform(v as Canal)} className="min-w-0 flex-1">
            <TabsList className="gap-5">
              {PLATFORMS.map((p) => {
                const ativo = p.canal === platform;
                const emBreve = canalEmBreve(p.canal);
                const contas = accountsByCanal(p.canal);
                const Icone = iconeDaFerramenta(p.canal);
                const dica = dicaDoCanal(p.label, contas, emBreve);
                return (
                  <Tooltip key={p.canal}>
                    <TooltipTrigger asChild>
                      {/* span: o botão desabilitado (Em breve) não recebe o mouse, a dica fica no span */}
                      <span className="inline-flex">
                        <TabsTrigger value={p.canal} disabled={emBreve} aria-label={dica} className="group h-10 w-9 justify-center">
                          <span className="relative inline-flex">
                            <Icone
                              decorativo
                              className={cn("h-5 w-5 transition", !ativo && "opacity-50 grayscale group-hover:opacity-100 group-hover:grayscale-0")}
                            />
                            {contas.some((a) => a.status !== "connected") && (
                              <span aria-hidden className="absolute -right-1 -top-0.5 h-1.5 w-1.5 rounded-full bg-warning-500 ring-2 ring-background" />
                            )}
                          </span>
                        </TabsTrigger>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{dica}</TooltipContent>
                  </Tooltip>
                );
              })}
            </TabsList>
          </Tabs>
          {platformAccounts.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="ghost" size="icon-sm" aria-label="Adicionar conta" className="mb-1 text-ink-3">
                  <Link href={`/integracoes/canais?canal=${platform}`}>
                    <Plus className="h-4 w-4" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Adicionar conta de {plataformaAtual.label}</TooltipContent>
            </Tooltip>
          )}
        </div>

        {platformAccounts.length === 0 ? (
          <div className="px-6">
            <EmptyState
              title={`Nenhuma conta de ${plataformaAtual.label}`}
              description="Conecte uma conta para ver e responder conversas deste canal aqui."
              action={
                <Button asChild>
                  <Link href={`/integracoes/canais?canal=${platform}`}>Conectar conta</Link>
                </Button>
              }
            />
          </div>
        ) : (
          <>
            {/* Só quando o canal tem mais de uma conta: com uma só, o nome fica na dica do ícone. */}
            {platformAccounts.length > 1 && (
              <Tabs value={accountId ?? undefined} onValueChange={setAccountId} className="px-6 pt-1">
                <TabsList className="gap-5 overflow-x-auto border-b-0">
                  {platformAccounts.map((a) => (
                    <TabsTrigger key={a.id} value={a.id} className="h-8 max-w-[180px] text-small">
                      <span className="truncate">{a.label}</span>
                      {a.status !== "connected" && <StatusDot tone="attention" className="ml-1 text-caption">{a.status}</StatusDot>}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}

            {platform === "email" ? (
              <EmailLista inbox={emailInbox} />
            ) : (
              <>
                <div className="flex items-center gap-2 px-6 py-3">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
                    <Input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder={naoLidas > 0 ? `Buscar · ${naoLidas} não lidas` : "Buscar conversa"}
                      className="h-8 pl-9 text-small"
                    />
                  </div>
                  <NewConversationButton channelAccountId={accountId} onStarted={openConversationById} compact />
                </div>
                {conversations.length > 0 && (
                  <div className="flex gap-1 overflow-x-auto px-6 pb-2" role="group" aria-label="Filtrar conversas">
                    {(Object.keys(FILTROS_CONVERSA) as FiltroConversa[]).map((k) => {
                      const ativo = filtro === k;
                      return (
                        <button
                          key={k}
                          type="button"
                          aria-pressed={ativo}
                          onClick={() => setFiltro(k)}
                          className={cn(
                            "num inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-caption leading-none transition-colors",
                            ativo ? "bg-foreground text-background" : "bg-black/5 text-ink-2 hover:bg-black/10",
                          )}
                        >
                          {FILTROS_CONVERSA[k].rotulo}
                          {k !== "todas" && contagemFiltros[k] > 0 && <span className={ativo ? "opacity-70" : "text-ink-3"}>{contagemFiltros[k]}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                  {loadingConvos && conversations.length === 0 ? (
                    <div className="space-y-2 p-3">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <Skeleton key={i} className="h-12 w-full" />
                      ))}
                    </div>
                  ) : conversations.length === 0 ? (
                    <EmptyState
                      title="Nenhuma conversa ainda"
                      description="Quando chegar a primeira mensagem nesta conta, ela aparece aqui."
                      className="py-10"
                    />
                  ) : filteredConversations.length === 0 ? (
                    <div className="p-4 text-center text-small text-ink-2">
                      {q.trim() ? `Nenhuma conversa encontrada para “${q}”.` : "Nenhuma conversa neste filtro."}
                    </div>
                  ) : (
                    <ConversationList
                      conversations={filteredConversations}
                      selectedId={conversationId}
                      onSelect={selectConversation}
                      channel={platform}
                    />
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Coluna 2 (e-mail) — conversa aberta, responder e escrever */}
      {platform === "email" && platformAccounts.length > 0 && <EmailThread inbox={emailInbox} />}

      {/* Coluna 2 — thread + escrita */}
      {platform !== "email" && platformAccounts.length > 0 && (
        <AreaSoltarArquivos
          className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
          desabilitada={!podeAnexar}
          onSoltar={(arquivos) => composerRef.current?.anexar(arquivos)}
        >
          {conversationId ? (
            <>
              {selectedConversation && (
                <div className="flex items-center gap-4 border-b border-line px-8 py-4">
                  <AvatarDoContato
                    conversationId={selectedConversation.id}
                    nome={nomeExibido(selectedConversation.displayName)}
                    iniciais={iniciais(selectedConversation.displayName)}
                    comFoto={selectedConversation.canal === "whatsapp"}
                    ampliavel
                    className="h-10 w-10"
                    fallbackClassName="text-small"
                  />
                  <div className="min-w-0 flex-1">
                    <h2 className="num truncate font-serif text-h2 text-foreground">{nomeExibido(selectedConversation.displayName)}</h2>
                    <div className="num truncate text-small text-ink-2">
                      {plataformaAtual.label}
                      {selectedConversation.numero ? ` · ${formatPhone(selectedConversation.numero)}` : ""}
                      {!selectedConversation.contact ? " · não cadastrado" : ""}
                    </div>
                  </div>
                  <ConversationActions
                    conversationId={selectedConversation.id}
                    contactId={selectedConversation.contact?.id ?? null}
                    interesse={selectedConversation.contact?.interesse}
                    status={selectedConversation.contact?.relacionamentoStatus}
                    nomeSugerido={selectedConversation.nomeSugerido}
                    externalNumber={selectedConversation.externalNumber}
                    funnels={funnels}
                    onDeleted={() => {
                      setConversationId(null);
                      setMessages([]);
                      if (accountId) refreshConvos(accountId);
                    }}
                    onRegistered={() => {
                      if (accountId) refreshConvos(accountId);
                    }}
                    onUnificada={(id) => openConversationById(id)}
                    onStatusChange={(relacionamentoStatus) => {
                      setConversations((prev) =>
                        prev.map((x) =>
                          x.id === selectedConversation.id && x.contact ? { ...x, contact: { ...x.contact, relacionamentoStatus } } : x,
                        ),
                      );
                    }}
                    onInteresseChange={(interesse) => {
                      setConversations((prev) =>
                        prev.map((x) =>
                          x.id === selectedConversation.id && x.contact ? { ...x, contact: { ...x.contact, interesse } } : x,
                        ),
                      );
                    }}
                  />
                </div>
              )}
              <MessageThread messages={messages} loading={loadingMsgs && messages.length === 0} channel={platform} conversationId={conversationId ?? undefined} />
              {selectedConversation?.externalNumber?.endsWith("@lid") && !selectedConversation.numero ? (
                <p className="border-t p-4 text-sm text-muted-foreground" role="status">
                  O WhatsApp não informou o telefone desta conversa antiga, por isso ela aparece separada da conversa da
                  mesma pessoa com número. O histórico está disponível para consulta. Para responder, escolha “Unificar
                  com o contato” no menu (três pontinhos) ou cadastre o contato com o número correto.
                </p>
              ) : <Composer ref={composerRef} onSend={handleSend} onSendMedia={handleSendMedia} onTyping={handleTyping} />}
            </>
          ) : (
            <EmptyState
              title="Selecione uma conversa"
              description="Escolha um contato à esquerda para ver a conversa e responder."
              className="flex-1"
            />
          )}
        </AreaSoltarArquivos>
      )}

      {/* Coluna 3 — sobre o contato */}
      {platform !== "email" && platformAccounts.length > 0 && selectedConversation && (
        <aside className="hidden w-[300px] shrink-0 flex-col gap-6 border-l border-line px-6 py-8 xl:flex">
          <div>
            <h3 className="text-label text-foreground">Sobre {selectedConversation.contact ? selectedConversation.displayName.split(" ")[0] : "o número"}</h3>
            <dl className="mt-3 flex flex-col gap-2.5 text-small">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-3">Canal</dt>
                <dd className="text-right text-foreground">{plataformaAtual.label}</dd>
              </div>
              {selectedConversation.numero && (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-3">Número</dt>
                  <dd className="num text-right text-foreground">{formatPhone(selectedConversation.numero)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <dt className="text-ink-3">Status</dt>
                <dd className="text-right">
                  {selectedConversation.contact ? (
                    <StatusBadge status={selectedConversation.contact.relacionamentoStatus} />
                  ) : (
                    <span className="text-ink-3">não cadastrado</span>
                  )}
                </dd>
              </div>
              {selectedConversation.contact && (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-3">Interesse</dt>
                  <dd className="text-right">
                    <InteresseBadge interesse={selectedConversation.contact.interesse} />
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <dt className="text-ink-3">Não lidas</dt>
                <dd className="num text-right text-foreground">{selectedConversation.unreadCount}</dd>
              </div>
            </dl>
          </div>
          {selectedConversation.contact && (
            <div className="border-t border-line pt-5">
              <h3 className="text-label text-foreground">Próximo passo</h3>
              <div className="mt-3 flex flex-col gap-2">
                <Link href={`/contatos/${selectedConversation.contact.id}`} className="text-small font-medium text-brand-500 hover:underline">
                  Abrir ficha completa
                </Link>
                <Link href="/agenda?novo=1" className="text-small font-medium text-brand-500 hover:underline">
                  Agendar ligação
                </Link>
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
