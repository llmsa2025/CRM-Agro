"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, PenSquare, Reply, Search, Send, X } from "lucide-react";
import { toast } from "sonner";
import type { ConversationListItem, MessageDTO, SignatureDTO } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { initialsOf } from "@/lib/format";
import {
  listAssinaturasDaCaixaAction,
  listConversationsAction,
  listEmailContactsAction,
  listMessagesAction,
  markReadAction,
  sendEmailReplyAction,
  sendNewEmailAction,
  type EmailContactItem,
} from "./actions";
import { ConversationList } from "./ConversationList";
import { MessageThread } from "./MessageThread";

/**
 * E-mail em Conversas no MESMO desenho do WhatsApp: a lista de conversas fica
 * na coluna da esquerda e a conversa aberta ocupa a área maior, com
 * "Responder" embaixo e "Escrever" (ícone) no topo da lista. A assinatura é
 * escolhida ao enviar e anexada no servidor.
 *
 * O estado mora no hook (`useEmailInbox`) porque a lista e a conversa são
 * colunas irmãs no `ConversationsClient`.
 */

export function useEmailInbox(accountId: string | null) {
  const [convos, setConvos] = useState<ConversationListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ConversationListItem | null>(null);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [compondo, setCompondo] = useState(false);
  const [q, setQ] = useState("");

  const refresh = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      setConvos(await listConversationsAction(accountId));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    setSelected(null);
    setMessages([]);
    void refresh();
  }, [refresh]);

  const abrir = useCallback(async (c: ConversationListItem) => {
    setSelected(c);
    setLoadingMsgs(true);
    setMessages([]);
    try {
      setMessages(await listMessagesAction(c.id));
    } finally {
      setLoadingMsgs(false);
    }
    markReadAction(c.id).catch(() => undefined);
    setConvos((prev) => prev.map((x) => (x.id === c.id ? { ...x, unreadCount: 0 } : x)));
  }, []);

  const recarregarAberta = useCallback(async () => {
    if (!selected) return;
    setMessages(await listMessagesAction(selected.id));
  }, [selected]);

  const filtradas = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return convos;
    return convos.filter((c) => c.displayName.toLowerCase().includes(t) || (c.lastMessage?.conteudo ?? "").toLowerCase().includes(t));
  }, [convos, q]);

  return { accountId, convos, filtradas, loading, selected, abrir, fechar: () => setSelected(null), messages, loadingMsgs, refresh, recarregarAberta, compondo, setCompondo, q, setQ };
}
export type EmailInboxState = ReturnType<typeof useEmailInbox>;

/** Coluna da esquerda: busca + "Escrever" + lista de conversas de e-mail. */
export function EmailLista({ inbox }: { inbox: EmailInboxState }) {
  return (
    <>
      <div className="flex items-center gap-2 px-6 py-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <Input value={inbox.q} onChange={(e) => inbox.setQ(e.target.value)} placeholder="Buscar e-mail" className="h-8 pl-9 text-small" />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Escrever e-mail" className="text-ink-3" onClick={() => inbox.setCompondo(true)}>
              <PenSquare className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Escrever e-mail</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {inbox.loading && inbox.convos.length === 0 ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : inbox.convos.length === 0 ? (
          <EmptyState title="Nenhum e-mail ainda" description="Clique no lápis para escrever o primeiro, ou aguarde a primeira resposta chegar aqui." className="py-10" />
        ) : inbox.filtradas.length === 0 ? (
          <div className="p-4 text-center text-small text-ink-2">Nenhum e-mail encontrado para “{inbox.q}”.</div>
        ) : (
          <ConversationList conversations={inbox.filtradas} selectedId={inbox.selected?.id ?? null} onSelect={(c) => void inbox.abrir(c)} channel="email" />
        )}
      </div>
    </>
  );
}

function assuntoDe(messages: MessageDTO[]): string {
  return [...messages].reverse().find((m) => m.subject)?.subject || "(sem assunto)";
}

/** Área maior: a conversa aberta (ou o convite para escolher/escrever). */
export function EmailThread({ inbox }: { inbox: EmailInboxState }) {
  const { selected, messages } = inbox;
  const [respondendo, setRespondendo] = useState(false);
  useEffect(() => setRespondendo(false), [selected?.id]);

  const assunto = assuntoDe(messages);
  const assuntoResposta = assunto.toLowerCase().startsWith("re:") ? assunto : `Re: ${assunto}`;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {selected ? (
        <>
          <div className="flex items-center gap-4 border-b border-line px-8 py-4">
            <Button variant="ghost" size="icon-sm" onClick={inbox.fechar} aria-label="Voltar para a lista" className="-ml-2 text-ink-3 lg:hidden">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Avatar className="h-10 w-10">
              <AvatarFallback className="text-small">{initialsOf(selected.displayName) || "@"}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-serif text-h2 text-foreground">{assunto}</h2>
              <div className="num truncate text-small text-ink-2">
                {selected.displayName}
                {selected.contactEmail ? ` · ${selected.contactEmail}` : ""}
              </div>
            </div>
            {!respondendo && (
              <Button variant="outline" onClick={() => setRespondendo(true)}>
                <Reply className="mr-1.5 h-4 w-4" /> Responder
              </Button>
            )}
          </div>
          <MessageThread messages={messages} loading={inbox.loadingMsgs && messages.length === 0} channel="email" conversationId={selected.id} />
          {respondendo && (
            <RespostaInline
              conversationId={selected.id}
              accountId={inbox.accountId}
              para={selected.contactEmail}
              assunto={assuntoResposta}
              onCancel={() => setRespondendo(false)}
              onSent={async () => {
                setRespondendo(false);
                await inbox.recarregarAberta();
                void inbox.refresh();
              }}
            />
          )}
        </>
      ) : (
        <EmptyState
          title="Selecione um e-mail"
          description="Escolha uma conversa à esquerda para ler e responder, ou escreva um e-mail novo."
          className="flex-1"
          action={
            <Button variant="outline" onClick={() => inbox.setCompondo(true)}>
              <PenSquare className="mr-1.5 h-4 w-4" /> Escrever e-mail
            </Button>
          }
        />
      )}

      {inbox.compondo && (
        <ComposePopup
          accountId={inbox.accountId}
          onClose={() => inbox.setCompondo(false)}
          onSent={() => {
            inbox.setCompondo(false);
            void inbox.refresh();
          }}
        />
      )}
    </div>
  );
}

/** Assinaturas DA CAIXA aberta (por caixa, 28/09); a padrão da caixa vem marcada. */
function useAssinaturas(accountId: string | null) {
  const [signatures, setSignatures] = useState<SignatureDTO[]>([]);
  const [signatureId, setSignatureId] = useState<string>("");
  useEffect(() => {
    let cancel = false;
    setSignatures([]);
    setSignatureId("");
    if (!accountId) return;
    void listAssinaturasDaCaixaAction(accountId)
      .then((list) => {
        if (cancel) return;
        setSignatures(list);
        const def = list.find((s) => s.isDefault) ?? list[0];
        if (def) setSignatureId(def.id);
      })
      .catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, [accountId]);
  return { signatures, signatureId, setSignatureId };
}

function SeletorAssinatura({ a }: { a: ReturnType<typeof useAssinaturas> }) {
  if (a.signatures.length === 0) return null;
  return (
    <label className="flex items-center gap-1.5 text-caption text-ink-2">
      Assinatura
      <select value={a.signatureId} onChange={(e) => a.setSignatureId(e.target.value)} className="h-7 rounded-md border border-line bg-background px-2 text-caption">
        <option value="">(nenhuma)</option>
        {a.signatures.map((s) => (
          <option key={s.id} value={s.id}>
            {s.nome}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Caixa de resposta no pé da conversa (como a do WhatsApp, com assunto e assinatura). */
function RespostaInline({
  conversationId,
  accountId,
  para,
  assunto,
  onCancel,
  onSent,
}: {
  conversationId: string;
  /** Caixa da conversa: as assinaturas oferecidas são as dela. */
  accountId: string | null;
  para: string | null;
  assunto: string;
  onCancel: () => void;
  onSent: () => void;
}) {
  const [subject, setSubject] = useState(assunto);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const a = useAssinaturas(accountId);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  async function enviar() {
    if (!body.trim() || sending) return;
    setSending(true);
    const res = await sendEmailReplyAction(conversationId, body, subject, a.signatureId || undefined);
    setSending(false);
    if (res.ok) {
      toast.success("E-mail enviado");
      onSent();
    } else toast.error("Falha ao enviar", { description: res.error });
  }

  return (
    <div className="border-t border-line px-8 py-4">
      <div className="flex items-center gap-2 text-small text-ink-2">
        <span className="w-14 shrink-0">Para</span>
        <span className="truncate">{para ?? "e-mail do contato"}</span>
        <button type="button" onClick={onCancel} aria-label="Cancelar resposta" className="ml-auto rounded p-1 text-ink-3 hover:bg-accent hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2 text-small">
        <span className="w-14 shrink-0 text-ink-2">Assunto</span>
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="h-7 border-0 px-0 shadow-none focus-visible:ring-0" />
      </div>
      <Textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Escreva a resposta…"
        rows={5}
        className="mt-2 resize-none"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void enviar();
        }}
      />
      <div className="mt-2 flex items-center gap-3">
        <Button onClick={enviar} disabled={sending || !body.trim()}>
          {sending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
          Enviar
        </Button>
        <SeletorAssinatura a={a} />
        <span className="ml-auto text-caption text-ink-3">Ctrl+Enter envia</span>
      </div>
    </div>
  );
}

/** Pop-up "Nova mensagem" (canto inferior direito da área maior). */
function ComposePopup({ accountId, onClose, onSent }: { accountId: string | null; onClose: () => void; onSent: () => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const a = useAssinaturas(accountId);

  const [picked, setPicked] = useState<EmailContactItem | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<EmailContactItem[]>([]);
  const [showList, setShowList] = useState(false);
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (picked) return;
    if (searchRef.current) clearTimeout(searchRef.current);
    searchRef.current = setTimeout(async () => {
      setResults(await listEmailContactsAction(search || undefined));
      setShowList(true);
    }, 250);
  }, [search, picked]);

  async function enviar() {
    if (!body.trim() || sending) return;
    if (!picked) {
      toast.error("Escolha um contato (Para)");
      return;
    }
    if (!accountId) {
      toast.error("Nenhuma conta de e-mail selecionada");
      return;
    }
    setSending(true);
    const res = await sendNewEmailAction({ contactId: picked.id, subject, body, channelAccountId: accountId, signatureId: a.signatureId || undefined });
    setSending(false);
    if (res.ok) {
      toast.success("E-mail enviado");
      onSent();
    } else toast.error("Falha ao enviar", { description: res.error });
  }

  return (
    <div className="absolute bottom-0 right-6 z-20 flex h-[28rem] w-[32rem] max-w-[calc(100%-3rem)] flex-col rounded-t-lg border border-line bg-card shadow-2xl">
      <div className="flex items-center justify-between rounded-t-lg bg-muted px-3 py-2">
        <span className="text-body font-medium">Nova mensagem</span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fechar">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="relative flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="w-14 shrink-0 text-caption text-ink-2">Para</span>
        {picked ? (
          <span className="flex items-center gap-2 text-body">
            {picked.nome} <span className="text-caption text-ink-2">&lt;{picked.email}&gt;</span>
            <button
              type="button"
              onClick={() => {
                setPicked(null);
                setSearch("");
              }}
              className="text-ink-3 hover:text-foreground"
              aria-label="Trocar destinatário"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : (
          <Input value={search} onChange={(e) => setSearch(e.target.value)} onFocus={() => setShowList(true)} placeholder="Buscar contato…" className="h-7 border-0 px-0 shadow-none focus-visible:ring-0" />
        )}
        {!picked && showList && results.length > 0 && (
          <div className="absolute left-16 right-3 top-full z-30 max-h-56 overflow-y-auto rounded-md border border-line bg-popover shadow-lg">
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setPicked(r);
                  setShowList(false);
                }}
                className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-muted"
              >
                <span className="text-body">{r.nome}</span>
                <span className="text-caption text-ink-2">{r.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="w-14 shrink-0 text-caption text-ink-2">Assunto</span>
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="(assunto)" className="h-7 border-0 px-0 shadow-none focus-visible:ring-0" />
      </div>

      <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Escreva o e-mail…" className="min-h-0 flex-1 resize-none rounded-none border-0 shadow-none focus-visible:ring-0" />

      <div className="flex items-center gap-3 border-t border-line px-3 py-2">
        <Button onClick={enviar} disabled={sending || !body.trim()}>
          {sending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
          Enviar
        </Button>
        <SeletorAssinatura a={a} />
      </div>
    </div>
  );
}
