"use client";

import { mensagemParaTela } from "@/lib/erros";
import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import {
  Send,
  Wrench,
  Minus,
  Paperclip,
  ArrowLeft,
  MessageSquarePlus,
  History,
  Trash2,
  X,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  loadAiProvidersAction,
  listConversationsAction,
  getConversationAction,
  saveConversationAction,
  deleteConversationAction,
} from "@/app/assistente/actions";

type Msg = {
  role: "user" | "assistant";
  content: string;
  tools?: { name: string; ok: boolean; write: boolean }[];
};
type Provider = "anthropic" | "glm";
type ProviderOpt = { provider: Provider; label: string };
type Resumo = { id: string; titulo: string; updatedAt: number; count: number };

const MODEL_KEY = "crmagro-assistant-model-v1";
const AUTO = "__auto__";

function quando(ts: number): string {
  const d = new Date(ts);
  const hoje = new Date();
  const mesmoDia = d.toDateString() === hoje.toDateString();
  return mesmoDia
    ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

/**
 * Assistente de IA flutuante — bolinha no canto inferior direito que abre um
 * painel de chat em QUALQUER tela. Conversa com o agente tool-use (tenant-scoped,
 * respeita a governança) via streaming (/api/ai/chat). O histórico de conversas
 * fica GUARDADO NA CONTA (banco, tenant-scoped) — sincroniza entre dispositivos.
 */
export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"chat" | "historico">("chat");

  // O botão "Assistente" da barra superior abre/fecha o painel por evento global
  // (a bolinha flutuante saiu: o assistente agora tem lugar fixo no topo).
  useEffect(() => {
    const alternar = () => setOpen((v) => !v);
    window.addEventListener("crmagro:assistente:alternar", alternar);
    return () => window.removeEventListener("crmagro:assistente:alternar", alternar);
  }, []);
  const [conversas, setConversas] = useState<Resumo[]>([]);
  const [carregandoLista, setCarregandoLista] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [providers, setProviders] = useState<ProviderOpt[]>([]);
  const [modelo, setModelo] = useState<string>(AUTO); // AUTO ou um provider
  const [anexo, setAnexo] = useState<{ nome: string; conteudo: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void loadAiProvidersAction().then(setProviders).catch(() => {});
    void carregarLista();
    try {
      const m = localStorage.getItem(MODEL_KEY);
      if (m) setModelo(m);
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_KEY, modelo);
    } catch {
      /* noop */
    }
  }, [modelo]);

  async function carregarLista() {
    setCarregandoLista(true);
    try {
      const lista = await listConversationsAction();
      setConversas(lista);
    } finally {
      setCarregandoLista(false);
    }
  }

  // Auto-save na CONTA. Só persiste quando o turno TERMINA (sending=false) — não
  // a cada token do streaming (evita reescrever o JSON inteiro dezenas de vezes).
  // O debounce ainda protege de rajadas (ex.: abrir uma conversa).
  useEffect(() => {
    if (messages.length === 0 || sending) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const snapshot = messages;
    saveTimer.current = setTimeout(() => {
      void saveConversationAction({ id: currentIdRef.current, messages: snapshot }).then((resumo) => {
        if (!resumo) return;
        currentIdRef.current = resumo.id;
        setCurrentId(resumo.id);
        setConversas((prev) => [resumo, ...prev.filter((c) => c.id !== resumo.id)]);
      });
    }, 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [messages, sending]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending, open, view]);

  function novaConversa() {
    setCurrentId(null);
    currentIdRef.current = null;
    setMessages([]);
    setAnexo(null);
    setText("");
    setView("chat");
  }
  async function abrirConversa(id: string) {
    setView("chat");
    setCurrentId(id);
    currentIdRef.current = id;
    const full = await getConversationAction(id);
    if (full) setMessages(full.messages as Msg[]);
    setAnexo(null);
    setText("");
  }
  function excluirConversa(id: string) {
    setConversas((prev) => prev.filter((c) => c.id !== id));
    void deleteConversationAction(id);
    if (currentIdRef.current === id) novaConversa();
  }
  function abrirHistorico() {
    setView("historico");
    void carregarLista(); // reflete conversas criadas em outros dispositivos
  }

  const MAX_ANEXO = 60_000; // ~60k chars — evita estourar o contexto

  function anexarArquivo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const nome = file.name.toLowerCase();
    if (!/\.(csv|tsv|txt|md|json)$/.test(nome)) {
      toast.error("Por ora só CSV/TXT", { description: "Planilha (xlsx) e PDF ficam para depois. Exporte como CSV." });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      let conteudo = String(reader.result ?? "");
      if (conteudo.length > MAX_ANEXO) conteudo = conteudo.slice(0, MAX_ANEXO) + "\n…(truncado)";
      setAnexo({ nome: file.name, conteudo });
      toast.success(`Anexado: ${file.name}`);
    };
    reader.onerror = () => toast.error("Falha ao ler o arquivo");
    reader.readAsText(file);
  }

  async function enviar() {
    const q = text.trim();
    if ((!q && !anexo) || sending) return;
    const visivel = anexo ? `${q}\n\n📎 ${anexo.nome}`.trim() : q;
    const paraIA = anexo
      ? `${q}\n\n[Arquivo anexado: ${anexo.nome}]\n${anexo.conteudo}`.trim()
      : q;
    setMessages([...messages, { role: "user", content: visivel }]);
    setText("");
    setAnexo(null);
    setSending(true);
    setView("chat");
    // A IA recebe o conteúdo COMPLETO do anexo (a última msg); na tela fica só o resumo.
    const outgoing = messages.map((m) => ({ role: m.role, content: m.content }));
    outgoing.push({ role: "user", content: paraIA });
    const provider = modelo === AUTO ? undefined : (modelo as Provider);
    try {
      // Streaming via fetch (NÃO server action) → não trava a plataforma e as
      // mensagens aparecem uma a uma, conforme a IA trabalha.
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: outgoing, ...(provider ? { provider } : {}) }),
      });
      if (!res.ok || !res.body) {
        const msg =
          res.status === 401
            ? "sessão expirada"
            : res.status === 429
              ? `muitas solicitações, aguarde ${res.headers.get("retry-after") ?? "alguns"}s e tente de novo`
              : `falha (HTTP ${res.status})`;
        setMessages((prev) => [...prev, { role: "assistant", content: `⚠ ${msg}` }]);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let lastTools: { name: string; ok: boolean; write: boolean }[] | undefined;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          let obj: { type: string; text?: string; error?: string; toolCalls?: { name: string; ok: boolean; write: boolean }[] };
          try {
            obj = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (obj.type === "text" && obj.text) {
            setMessages((prev) => [...prev, { role: "assistant", content: obj.text! }]);
          } else if (obj.type === "error") {
            toast.error("Falha na IA", { description: obj.error });
            setMessages((prev) => [...prev, { role: "assistant", content: `⚠ ${obj.error}` }]);
          } else if (obj.type === "done") {
            lastTools = obj.toolCalls;
          }
        }
      }
      // Anexa o resumo de ferramentas na última mensagem da IA (se houver).
      if (lastTools?.length) {
        setMessages((prev) => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i]!.role === "assistant") {
              copy[i] = { ...copy[i]!, tools: lastTools };
              break;
            }
          }
          return copy;
        });
      }
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", content: `⚠ ${mensagemParaTela(e)}` }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {/* Painel lateral — aberto pelo botão "Assistente" da barra superior. */}
      {open && (
        <div className="fixed inset-y-0 right-0 z-50 flex w-[min(400px,100vw)] flex-col border-l border-line bg-background shadow-popover">
          {/* Cabeçalho */}
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-1.5">
              {view === "historico" ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => setView("chat")}
                    aria-label="Voltar para a conversa"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <span className="truncate text-h3 font-semibold tracking-tight">Conversas</span>
                </>
              ) : (
                <>

                  <span className="truncate text-h3 font-semibold tracking-tight">Assistente</span>
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {view === "chat" && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={novaConversa}
                    aria-label="Nova conversa"
                    title="Nova conversa"
                  >
                    <MessageSquarePlus className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={abrirHistorico}
                    aria-label="Histórico de conversas"
                    title="Histórico"
                  >
                    <History className="h-4 w-4" />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground"
                onClick={() => setOpen(false)}
                aria-label="Minimizar assistente"
                title="Minimizar"
              >
                <Minus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {view === "historico" ? (
            /* ---------- Lista de conversas ---------- */
            <div className="flex-1 min-h-0 overflow-y-auto p-2">
              <Button
                variant="outline"
                className="mb-2 w-full justify-start gap-2"
                onClick={novaConversa}
              >
                <MessageSquarePlus className="h-4 w-4" /> Nova conversa
              </Button>
              {carregandoLista ? (
                <p className="flex items-center justify-center gap-2 px-2 py-8 text-caption text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
                </p>
              ) : conversas.length === 0 ? (
                <p className="px-2 py-8 text-center text-caption text-muted-foreground">
                  Nenhuma conversa guardada ainda.
                </p>
              ) : (
                <ul className="space-y-1">
                  {conversas.map((c) => (
                    <li
                      key={c.id}
                      className={
                        "group flex items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted " +
                        (c.id === currentId ? "bg-muted" : "")
                      }
                    >
                      <button
                        type="button"
                        onClick={() => abrirConversa(c.id)}
                        className="flex min-w-0 flex-1 flex-col items-start"
                      >
                        <span className="w-full truncate text-body">{c.titulo}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {quando(c.updatedAt)} · {c.count} msg
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => excluirConversa(c.id)}
                        aria-label="Excluir conversa"
                        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            /* ---------- Conversa ---------- */
            <>
              <div ref={scrollRef} className="flex-1 min-h-0 space-y-3 overflow-y-auto p-4">
                {messages.length === 0 ? (
                  <p className="py-8 text-center text-caption text-muted-foreground">
                    Pergunte sobre sua base. Exemplos: “tem contatos duplicados?”, “busque a empresa Fazenda Horizonte”,
                    “resuma o contato X”. Precisa de um provedor conectado e a governança ligada em
                    Integrações → IA.
                  </p>
                ) : (
                  messages.map((m, i) => (
                    <div key={i} className={m.role === "user" ? "text-right" : ""}>
                      <div
                        className={
                          "inline-block max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md px-3 py-2 text-left text-body " +
                          (m.role === "user" ? "bg-brand-500 text-white" : "bg-muted")
                        }
                      >
                        {m.content}
                      </div>
                      {m.tools && m.tools.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {m.tools.map((t, j) => (
                            <Badge
                              key={j}
                              variant={t.ok ? (t.write ? "warning" : "outline-muted") : "destructive"}
                              className="gap-1 text-[10px]"
                            >
                              <Wrench className="h-3 w-3" /> {t.name}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
                {sending && <p className="text-caption text-muted-foreground">Pensando…</p>}
              </div>

              {/* Composer */}
              <div className="shrink-0 border-t p-3">
                {anexo && (
                  <div className="mb-2 flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1 text-caption">
                    <span className="flex items-center gap-1.5 truncate">
                      <Paperclip className="h-3.5 w-3.5" /> {anexo.nome}
                    </span>
                    <button type="button" onClick={() => setAnexo(null)} aria-label="Remover anexo">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-1.5 rounded-lg border bg-background p-1.5 focus-within:ring-1 focus-within:ring-ring">
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    accept=".csv,.tsv,.txt,.md,.json"
                    onChange={anexarArquivo}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 text-muted-foreground"
                    onClick={() => fileRef.current?.click()}
                    aria-label="Anexar CSV/texto"
                  >
                    <Paperclip className="h-4 w-4" />
                  </Button>
                  <Textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        enviar();
                      }
                    }}
                    placeholder="Pergunte, peça uma ação, ou anexe um CSV…"
                    rows={1}
                    className="max-h-32 min-h-[36px] resize-none border-0 bg-transparent px-1 py-2 shadow-none focus-visible:ring-0"
                  />
                  <Button
                    onClick={enviar}
                    disabled={sending || (!text.trim() && !anexo)}
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    aria-label="Enviar"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
                <div className="mt-2 flex justify-end">
                  <Select value={modelo} onValueChange={setModelo}>
                    <SelectTrigger className="h-7 w-[150px] text-caption" aria-label="Modelo de IA">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AUTO}>Automático</SelectItem>
                      {providers.map((p) => (
                        <SelectItem key={p.provider} value={p.provider}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
