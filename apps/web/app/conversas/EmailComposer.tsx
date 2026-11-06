"use client";

import { useState } from "react";
import { Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * Compositor de e-mail estilo cliente (Para / Assunto / corpo / Enviar).
 * Diferente do chat: Enter quebra linha; envio só pelo botão.
 */
export function EmailComposer({
  to,
  autoSubject,
  onSend,
}: {
  to: string | null;
  autoSubject: string;
  onSend: (subject: string, body: string) => Promise<boolean>;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  async function enviar() {
    if (!body.trim() || sending) return;
    setSending(true);
    // Assunto: usa o digitado; se vazio, cai no automático ("Re:") do servidor.
    const ok = await onSend(subject.trim(), body);
    setSending(false);
    if (ok) {
      setBody("");
      setSubject("");
    }
  }

  return (
    <div className="border-t bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-1.5">
        <span className="w-16 shrink-0 text-caption text-muted-foreground">Para</span>
        <span className="truncate text-body">{to || "e-mail do contato"}</span>
      </div>
      <div className="flex items-center gap-2 border-b px-4 py-1.5">
        <span className="w-16 shrink-0 text-caption text-muted-foreground">Assunto</span>
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={autoSubject || "(assunto do e-mail)"}
          className="h-7 border-0 px-0 shadow-none focus-visible:ring-0"
        />
      </div>
      <div className="px-4 py-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Escreva o e-mail…"
          rows={6}
          className="max-h-72 min-h-[120px] resize-y border-0 px-0 shadow-none focus-visible:ring-0"
        />
      </div>
      <div className="flex items-center justify-between px-4 pb-3">
        <Button onClick={enviar} disabled={sending || !body.trim()}>
          {sending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
          Enviar
        </Button>
      </div>
    </div>
  );
}
