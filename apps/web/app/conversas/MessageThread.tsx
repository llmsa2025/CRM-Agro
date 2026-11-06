"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { FileText, Check, CheckCheck, Clock, AlertCircle, ChevronDown, ChevronRight, Copy, Share2, X } from "lucide-react";
import { toast } from "sonner";
import { AudioPlayer } from "@/components/audio-player";
import { BotaoCopiar } from "@/components/botao-copiar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { copiarTexto } from "@/lib/copiar";
import { formatDate, formatDayLabel, formatTime } from "@/lib/format";
import {
  TOQUE_LONGO_MS,
  dedoAndouDemais,
  ehTeclaDoMenu,
  podeCompartilhar,
  proximoIndiceDaLista,
  rotuloDeSelecionadas,
  selecionadasEmOrdem,
  situacaoDoCompartilhar,
  textoCopiavel,
  textoDasMensagens,
  textoParaCopiar,
} from "@/lib/menu-mensagem";
import type { MessageDTO } from "@crmagro/core";
import { EncaminharDialog } from "./EncaminharDialog";
import { MenuDaMensagem, type AcaoDoMenu, type AlvoDoMenu } from "./MenuDaMensagem";

/** ✓/✓✓ de status (WhatsApp) — só em mensagens de saída. */
function Ticks({ status }: { status: string }) {
  if (status === "sending") return <Clock className="h-3 w-3 text-ink-3" aria-label="enviando" />;
  // Envio de mídia que não deu para confirmar (prazo estourou): pode já ter
  // chegado. O eco/recibo do WhatsApp promove sozinho; sem sinal, vira "falhou".
  if (status === "unconfirmed")
    return (
      <span title="Envio ainda não confirmado, pode já ter chegado. Confira no WhatsApp antes de reenviar.">
        <Clock className="h-3.5 w-3.5 text-warning-500" aria-label="envio ainda não confirmado" />
      </span>
    );
  if (status === "failed") return <AlertCircle className="h-3.5 w-3.5 text-danger-500" aria-label="falhou" />;
  if (status === "bounced") return <AlertCircle className="h-3.5 w-3.5 text-warning-500" aria-label="bloqueado/devolvido" />;
  if (status === "read") return <CheckCheck className="h-3.5 w-3.5 text-info-500" aria-label="lida" />;
  if (status === "delivered") return <CheckCheck className="h-3.5 w-3.5 text-ink-3" aria-label="entregue" />;
  return <Check className="h-3.5 w-3.5 text-ink-3" aria-label="enviada" />;
}

/** Render da mídia (imagem/áudio/documento) quando a mensagem tem mediaUrl. */
function MediaBlock({ m }: { m: MessageDTO }) {
  if (!m.mediaUrl) {
    return <p className="italic text-ink-3">[{m.tipo}]</p>;
  }
  if (m.tipo === "image") {
    return (
      <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="block">
        <img src={m.mediaUrl} alt={m.conteudo ?? "imagem"} className="max-h-72 w-auto max-w-full rounded-md object-cover" />
      </a>
    );
  }
  if (m.tipo === "audio") {
    return <AudioPlayer src={m.mediaUrl} mime={m.mediaMime} />;
  }
  return (
    <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md border border-line px-2.5 py-2 hover:bg-accent">
      <FileText className="h-4 w-4 shrink-0 text-ink-3" />
      <span className="truncate">{m.conteudo || "Documento"}</span>
    </a>
  );
}

/** Status do e-mail enviado. */
function EmailStatus({ status }: { status: string }) {
  if (status === "sending")
    return <span className="inline-flex items-center gap-1 text-caption text-ink-3"><Clock className="h-3.5 w-3.5" /> Enviando</span>;
  if (status === "failed")
    return <span className="inline-flex items-center gap-1 text-caption font-medium text-danger-500"><AlertCircle className="h-3.5 w-3.5" /> Falhou</span>;
  if (status === "bounced")
    return <span className="inline-flex items-center gap-1 text-caption font-medium text-warning-500"><AlertCircle className="h-3.5 w-3.5" /> Devolvido</span>;
  if (status === "read")
    return <span className="inline-flex items-center gap-1 text-caption font-medium text-success-500"><CheckCheck className="h-4 w-4" /> Aberto</span>;
  return <span className="inline-flex items-center gap-1 text-caption text-ink-3"><Check className="h-3.5 w-3.5" /> Enviado</span>;
}

/** Um e-mail como cartão recolhível (clique no cabeçalho abre/fecha o corpo). */
function EmailCard({ m, defaultOpen, acoes }: { m: MessageDTO; defaultOpen?: boolean; acoes?: ReactNode }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const out = m.direcao === "out";
  const contraparte = out ? m.emailTo : m.emailFrom;
  const snippet = (m.conteudo ?? "").replace(/\s+/g, " ").trim();
  return (
    <div className="rounded-md border border-line bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-accent/60"
      >
        <ChevronRight className={cn("mt-0.5 h-4 w-4 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-medium">{m.subject || "(sem assunto)"}</p>
          <p className="truncate text-small text-ink-2">
            {out ? "Para" : "De"}: {contraparte || "—"}
            {!open && snippet ? <span className="text-ink-3"> · {snippet}</span> : null}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-caption text-ink-3">
          <span className="num">{formatDate(m.createdAt)}</span>
          {out ? <EmailStatus status={m.status} /> : <span className="font-medium text-brand-500">Recebido</span>}
        </div>
      </button>
      {open && (
        <div className="border-t border-line px-4 py-3 text-body">
          {m.conteudo ? (
            <>
              {/* Copia só o corpo (sem assunto), como está na tela. */}
              <div className="flex justify-end gap-1">
                {acoes}
                <BotaoCopiar texto={m.conteudo} rotulo="Copiar texto do e-mail" sempreVisivel />
              </div>
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.conteudo}</p>
            </>
          ) : (
            <p className="italic text-ink-3">(sem conteúdo)</p>
          )}
        </div>
      )}
    </div>
  );
}

function diaDe(iso: string): string {
  return new Date(iso).toDateString();
}

/** Trecho de texto que a pessoa marcou DENTRO deste elemento ("" se não há, ou se a seleção sai dele). */
function trechoSelecionadoEm(el: HTMLElement | null): string {
  if (typeof window === "undefined" || !el) return "";
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return "";
  return el.contains(sel.anchorNode) && el.contains(sel.focusNode) ? sel.toString() : "";
}

type MenuAberto = { id: string; alvo: AlvoDoMenu; trecho: string };

/**
 * Thread (v2): fundo papel; balões de saída em verde-claro, de entrada em branco
 * com hairline; separador de dia ("hoje", "12 de agosto") entre grupos.
 *
 * Menu da mensagem (Copiar, Selecionar, Compartilhar): abre com o botão direito,
 * toque longo, a setinha que aparece ao passar o mouse, ou a tecla de menu /
 * Shift+F10 com a mensagem focada. "Selecionar" liga o modo de seleção (caixinhas
 * e barra no topo; Esc sai). "Compartilhar" encaminha no MESMO canal (regras no
 * servidor). Cada mensagem é um item focável, mas só UMA linha entra no Tab (a última,
 * ou a que estava em foco); as setas andam entre elas. Os botões que já existiam
 * dentro do balão (copiar, player, links) seguem no Tab como antes.
 *
 * `conversationId`: sem ele não há como listar destinos, então "Compartilhar" some.
 */
export function MessageThread({
  messages,
  loading,
  channel,
  conversationId,
}: {
  messages: MessageDTO[];
  loading: boolean;
  channel?: string;
  conversationId?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const linhas = useRef(new Map<string, HTMLElement>());
  const [menu, setMenu] = useState<MenuAberto | null>(null);
  const ultimoMenuId = useRef<string | null>(null);
  const [selecionando, setSelecionando] = useState(false);
  const [selecionadas, setSelecionadas] = useState<ReadonlySet<string>>(new Set());
  const [compartilhar, setCompartilhar] = useState<MessageDTO[] | null>(null);
  const [focoId, setFocoId] = useState<string | null>(null);
  const toque = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const abriuPorTeclado = useRef(0);
  // O que o menu aberto pode fazer. Fica gravado ao abrir para os itens não piscarem como
  // desabilitados enquanto o menu some (animação de saída).
  const [habilitacao, setHabilitacao] = useState({ copiar: false, compartilhar: false });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, loading]);

  const cancelarToque = useCallback(() => {
    if (toque.current) clearTimeout(toque.current.timer);
    toque.current = null;
  }, []);
  useEffect(() => cancelarToque, [cancelarToque]);

  const sairDaSelecao = useCallback(() => {
    setSelecionando(false);
    setSelecionadas(new Set());
  }, []);

  // Trocou de conversa: nada de menu, seleção ou pop-up da conversa anterior.
  useEffect(() => {
    sairDaSelecao();
    setMenu(null);
    setCompartilhar(null);
    setFocoId(null);
  }, [conversationId, sairDaSelecao]);

  // Esc sai da seleção. O menu e o pop-up (Radix) tratam o próprio Esc e marcam o
  // evento como tratado: aí não sai da seleção junto.
  useEffect(() => {
    if (!selecionando) return;
    const aoTeclar = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) sairDaSelecao();
    };
    document.addEventListener("keydown", aoTeclar);
    return () => document.removeEventListener("keydown", aoTeclar);
  }, [selecionando, sairDaSelecao]);

  const canal = channel ?? "whatsapp";
  const ultimoId = messages[messages.length - 1]?.id ?? null;
  // Só uma mensagem entra no Tab: a que estava em foco, ou a última.
  const idNoTab = focoId && messages.some((m) => m.id === focoId) ? focoId : ultimoId;

  const devolverFoco = useCallback((id: string | null) => {
    if (id) linhas.current.get(id)?.focus({ preventScroll: true });
  }, []);

  const alternar = useCallback((id: string) => {
    setSelecionadas((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) novo.delete(id);
      else novo.add(id);
      return novo;
    });
  }, []);

  function abrirMenu(m: MessageDTO, x: number, y: number, via: AlvoDoMenu["via"], bolha: HTMLElement | null) {
    const trecho = trechoSelecionadoEm(bolha);
    ultimoMenuId.current = m.id;
    setHabilitacao({ copiar: Boolean(textoParaCopiar(m, trecho)), compartilhar: Boolean(conversationId && podeCompartilhar(m)) });
    setMenu({ id: m.id, alvo: { x, y, via }, trecho });
  }

  async function copiar(texto: string, aviso: string) {
    const ok = await copiarTexto(texto);
    if (ok) toast.success(aviso);
    else toast.error("Não consegui copiar. Selecione o texto e copie manualmente.");
  }

  const mensagemDoMenu = menu ? (messages.find((m) => m.id === menu.id) ?? null) : null;

  function escolherNoMenu(acao: AcaoDoMenu) {
    if (!menu || !mensagemDoMenu) return;
    const m = mensagemDoMenu;
    if (acao === "copiar") {
      const texto = textoParaCopiar(m, menu.trecho);
      if (texto) void copiar(texto, "Mensagem copiada");
    } else if (acao === "selecionar") {
      setSelecionando(true);
      setSelecionadas(new Set([m.id]));
      setFocoId(m.id);
    } else {
      setCompartilhar([m]);
    }
  }

  /** As caixinhas só contam mensagens que ainda existem na tela (a lista recarrega ao vivo). */
  const escolhidas = selecionadasEmOrdem(messages, selecionadas);

  function copiarSelecionadas() {
    const texto = textoDasMensagens(escolhidas);
    if (texto === null) {
      toast.info("Nenhuma das mensagens escolhidas tem texto para copiar.");
      return;
    }
    void copiar(texto, escolhidas.length === 1 ? "Mensagem copiada" : "Mensagens copiadas");
  }

  const situacao = situacaoDoCompartilhar(escolhidas);

  /** A linha da mensagem: item focável (menu, seleção, setas) que envolve o balão/cartão. */
  function linha(m: MessageDTO, filho: ReactNode) {
    const out = m.direcao === "out";
    const marcada = selecionadas.has(m.id);
    const indice = messages.findIndex((x) => x.id === m.id);

    const bolhaDoEvento = (alvo: EventTarget): HTMLElement | null => (alvo as HTMLElement).closest<HTMLElement>("[data-bolha]");

    function aoMenuDeContexto(e: MouseEvent<HTMLDivElement>) {
      const bolha = bolhaDoEvento(e.target);
      if (!bolha || !e.currentTarget.contains(bolha)) return; // fora do balão: menu do navegador
      e.preventDefault();
      if (selecionando) return;
      // A tecla de menu também dispara este evento, com posição inventada: já tratamos no teclado.
      if (Date.now() - abriuPorTeclado.current < 400) return;
      abrirMenu(m, e.clientX, e.clientY, "mouse", bolha);
    }

    function aoTocar(e: PointerEvent<HTMLDivElement>) {
      if (e.pointerType !== "touch" || selecionando) return;
      const bolha = bolhaDoEvento(e.target);
      if (!bolha) return;
      cancelarToque();
      const { clientX: x, clientY: y } = e;
      toque.current = {
        x,
        y,
        timer: setTimeout(() => {
          toque.current = null;
          abrirMenu(m, x, y, "mouse", bolha);
        }, TOQUE_LONGO_MS),
      };
    }

    function aoMoverDedo(e: PointerEvent<HTMLDivElement>) {
      const t = toque.current;
      if (t && dedoAndouDemais(e.clientX - t.x, e.clientY - t.y)) cancelarToque();
    }

    function aoTeclar(e: KeyboardEvent<HTMLDivElement>) {
      // Só teclas da própria linha: as de dentro (player, links, copiar) seguem com eles.
      if (e.target !== e.currentTarget) return;
      if (!selecionando && ehTeclaDoMenu(e)) {
        e.preventDefault();
        abriuPorTeclado.current = Date.now();
        const bolha = e.currentTarget.querySelector<HTMLElement>("[data-bolha]") ?? e.currentTarget;
        const r = bolha.getBoundingClientRect();
        abrirMenu(m, r.left + 16, r.top + 16, "teclado", bolha);
        return;
      }
      const proximo = proximoIndiceDaLista(indice, messages.length, e.key);
      if (proximo !== null) {
        e.preventDefault();
        devolverFoco(messages[proximo]!.id);
        return;
      }
      if (selecionando && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        alternar(m.id);
      }
    }

    return (
      <div
        ref={(el) => {
          if (el) linhas.current.set(m.id, el);
          else linhas.current.delete(m.id);
        }}
        data-msg-id={m.id}
        role={selecionando ? "option" : "article"}
        aria-selected={selecionando ? marcada : undefined}
        aria-label={`Mensagem ${out ? "enviada" : "recebida"} às ${formatTime(m.createdAt)}`}
        aria-haspopup={selecionando ? undefined : "menu"}
        aria-keyshortcuts={selecionando ? undefined : "Shift+F10"}
        tabIndex={m.id === idNoTab ? 0 : -1}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setFocoId(m.id);
        }}
        onClick={selecionando ? () => alternar(m.id) : undefined}
        onContextMenu={aoMenuDeContexto}
        onPointerDown={aoTocar}
        onPointerMove={aoMoverDedo}
        onPointerUp={cancelarToque}
        onPointerCancel={cancelarToque}
        onKeyDown={aoTeclar}
        className={cn(
          "group/linha flex items-start gap-3 rounded-md outline-none",
          selecionando && "-mx-2 cursor-pointer px-2 py-1 focus-visible:bg-accent/60",
          marcada && "bg-brand-50",
        )}
      >
        {selecionando ? (
          <span
            aria-hidden
            className={cn(
              "mt-2.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border",
              marcada ? "border-brand-500 bg-brand-500 text-white" : "border-line-strong bg-background",
            )}
          >
            {marcada ? <Check className="h-3 w-3" strokeWidth={2.5} /> : null}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">{filho}</div>
      </div>
    );
  }

  /** Setinha da mensagem (como no WhatsApp Web): abre o mesmo menu, colado no botão. */
  function setinha(m: MessageDTO, className?: string) {
    return (
      <button
        type="button"
        tabIndex={-1}
        aria-label="Abrir menu da mensagem"
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          abrirMenu(m, r.left, r.bottom + 2, "mouse", null);
        }}
        className={cn(
          "inline-flex h-5 w-5 items-center justify-center rounded-full bg-background/85 text-ink-3 shadow-sm ring-1 ring-line transition-[color,opacity] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [@media(hover:none)]:hidden",
          className,
        )}
      >
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 space-y-3 overflow-y-auto p-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className={cn("h-10 w-2/3", i % 2 && "ml-auto")} />
        ))}
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-body text-ink-2">
        Nenhuma mensagem ainda. Escreva a primeira abaixo.
      </div>
    );
  }

  const barra = selecionando ? (
    <div role="toolbar" aria-label="Mensagens selecionadas" className="flex shrink-0 items-center gap-2 border-b border-line bg-accent/50 px-6 py-2">
      <p className="mr-auto text-body font-medium text-foreground" aria-live="polite">
        {rotuloDeSelecionadas(escolhidas.length)}
        {!situacao.ok && escolhidas.length > 0 ? <span className="ml-3 text-small font-normal text-ink-2">{situacao.motivo}</span> : null}
      </p>
      <Button size="sm" variant="ghost" onClick={copiarSelecionadas} disabled={escolhidas.length === 0}>
        <Copy aria-hidden /> Copiar
      </Button>
      {conversationId ? (
        <Button size="sm" variant="ghost" onClick={() => setCompartilhar(escolhidas)} disabled={!situacao.ok}>
          <Share2 aria-hidden /> Compartilhar
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={sairDaSelecao}>
        <X aria-hidden /> Cancelar
      </Button>
    </div>
  ) : null;

  const sobreposicoes = (
    <>
      <MenuDaMensagem
        alvo={menu?.alvo ?? null}
        podeCopiar={habilitacao.copiar}
        podeCompartilhar={habilitacao.compartilhar}
        aoEscolher={escolherNoMenu}
        aoFechar={() => setMenu(null)}
        aoDevolverFoco={() => devolverFoco(ultimoMenuId.current)}
      />
      {conversationId ? (
        <EncaminharDialog
          mensagens={compartilhar}
          conversationId={conversationId}
          canal={canal}
          aoFechar={() => setCompartilhar(null)}
          aoConcluir={() => {
            setCompartilhar(null);
            sairDaSelecao();
          }}
          aoDevolverFoco={() => devolverFoco(ultimoMenuId.current)}
        />
      ) : null}
    </>
  );

  if (channel === "email") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {barra}
        <div
          ref={scrollRef}
          role={selecionando ? "listbox" : undefined}
          aria-multiselectable={selecionando ? true : undefined}
          aria-label={selecionando ? "E-mails" : undefined}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-muted/40 p-6"
        >
          {messages.map((m, i) => (
            <Fragment key={m.id}>
              {linha(
                m,
                <div data-bolha className={cn(selecionando && "[&_a]:pointer-events-none [&_button]:pointer-events-none")}>
                  <EmailCard
                    m={m}
                    defaultOpen={i === messages.length - 1}
                    acoes={selecionando || !podeCompartilhar(m) ? undefined : setinha(m, "opacity-100")}
                  />
                </div>,
              )}
            </Fragment>
          ))}
        </div>
        {sobreposicoes}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {barra}
      <div
        ref={scrollRef}
        role={selecionando ? "listbox" : undefined}
        aria-multiselectable={selecionando ? true : undefined}
        aria-label={selecionando ? "Mensagens" : undefined}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-8 py-6"
      >
        {messages.map((m, i) => {
          const out = m.direcao === "out";
          const novoDia = i === 0 || diaDe(messages[i - 1]!.createdAt) !== diaDe(m.createdAt);
          const copiavel = textoCopiavel(m);
          return (
            <Fragment key={m.id}>
              {novoDia && (
                <div className="flex items-center gap-3 py-3 text-caption text-ink-3" aria-hidden>
                  <span className="h-px flex-1 bg-line" />
                  <span>{formatDayLabel(m.createdAt)}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              )}
              {linha(
                m,
                <div className={cn("flex", out ? "justify-end" : "justify-start")}>
                  <div
                    data-bolha
                    className={cn(
                      "group relative max-w-[72%] rounded-md px-3 py-2 text-body leading-relaxed group-focus-visible/linha:ring-2 group-focus-visible/linha:ring-ring/40",
                      out ? "bg-brand-100 text-foreground" : "border border-line bg-background text-foreground",
                      // Toque longo abre o menu: sem isto o celular seleciona o texto/abre o menu nativo no lugar.
                      !selecionando && "[-webkit-touch-callout:none] [@media(hover:none)]:select-none",
                      // Controle desabilitado (player que ainda não carregou) não recebe clique direito no
                      // Chrome nem no Firefox: com pointer-events off o evento cai no balão e abre o menu.
                      "[&_button:disabled]:pointer-events-none [&_input:disabled]:pointer-events-none",
                      // Na seleção, o clique é da linha inteira: player, links e botões ficam quietos.
                      selecionando && "[&_a]:pointer-events-none [&_button]:pointer-events-none [&_input]:pointer-events-none",
                    )}
                  >
                    {m.tipo !== "text" ? (
                      <div className="space-y-1.5">
                        <MediaBlock m={m} />
                        {m.conteudo && m.tipo !== "doc" ? <p className="whitespace-pre-wrap break-words">{m.conteudo}</p> : null}
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap break-words">{m.conteudo}</p>
                    )}
                    {/* Botão de copiar fora do fluxo do balão (absolute, colado na lateral externa, embaixo):
                        não ocupa espaço no rodapé, então não alarga mensagem curta nem cobre o texto.
                        Enviada (à direita) → botão à esquerda; recebida (à esquerda) → botão à direita.
                        Sem folga entre o balão e o botão: o mouse passa de um ao outro sem perder o hover do grupo. */}
                    {copiavel && !selecionando ? (
                      <BotaoCopiar
                        texto={copiavel}
                        className={cn("absolute bottom-1 group-focus-within/linha:opacity-100", out ? "right-full" : "left-full")}
                      />
                    ) : null}
                    {selecionando
                      ? null
                      : setinha(
                          m,
                          "absolute right-1 top-1 z-10 opacity-0 group-hover:opacity-100 group-focus-within/linha:opacity-100",
                        )}
                    <div className="num mt-1 flex items-center justify-end gap-1 text-caption text-ink-3">
                      <span>{formatTime(m.createdAt)}</span>
                      {out ? <Ticks status={m.status} /> : null}
                    </div>
                  </div>
                </div>,
              )}
            </Fragment>
          );
        })}
      </div>
      {sobreposicoes}
    </div>
  );
}
