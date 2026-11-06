"use client";

import { useRef, useState, useEffect, useImperativeHandle, type ClipboardEvent, type KeyboardEvent, type Ref } from "react";
import { Paperclip, Mic, X } from "lucide-react";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ANEXO_ACCEPT, arquivosColados, validarAnexos } from "@/lib/anexar-arquivos";

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** O que quem hospeda o campo pode pedir a ele (ex.: a área de soltar arquivos). */
export type ComposerHandle = {
  /** Anexa arquivos pelo MESMO caminho do clipe (valida, usa o texto como legenda, envia). */
  anexar: (arquivos: File[]) => void;
};

/**
 * Caixa de escrita (v2): anexo · campo · botão "Enviar" primário. Enter envia,
 * Shift+Enter quebra linha. Sem texto, o botão vira o microfone.
 *
 * Anexo por três caminhos, todos no mesmo fluxo (`receberArquivos`): o clipe
 * (teclado e mouse), arrastar e soltar sobre a conversa (via `ref.anexar`) e
 * colar imagem com Ctrl+V no campo.
 */
export function Composer({
  onSend,
  onSendMedia,
  onTyping,
  placeholder,
  ref,
}: {
  onSend: (text: string) => void;
  onSendMedia?: (file: File, caption: string) => void;
  onTyping?: () => void;
  placeholder?: string;
  ref?: Ref<ComposerHandle>;
}) {
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      recRef.current?.stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function submit() {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  /**
   * Porta única dos anexos (clipe, soltar e colar): mesma validação de tipo e
   * tamanho, mesma legenda (o texto do campo) e mesmo envio. Quem falha na
   * validação recebe o motivo e nada é enviado.
   */
  function receberArquivos(arquivos: File[]) {
    if (!onSendMedia || arquivos.length === 0) return;
    if (recording) {
      toast.info("Termine a gravação antes de anexar um arquivo.");
      return;
    }
    const r = validarAnexos(arquivos);
    if (!r.ok) {
      if (r.erro) toast.error(r.erro);
      return;
    }
    onSendMedia(r.arquivo, text.trim());
    setText("");
  }

  // Sem lista de dependências de propósito: refaz a cada render para o
  // `receberArquivos` sempre enxergar o texto e o estado de gravação atuais.
  useImperativeHandle(ref, () => ({ anexar: receberArquivos }));

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const arquivos = Array.from(e.target.files ?? []);
    e.target.value = "";
    receberArquivos(arquivos);
  }

  /** Ctrl+V com arquivo (print de tela, imagem copiada) vira anexo; texto cola como sempre. */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!onSendMedia) return;
    const colados = arquivosColados(Array.from(e.clipboardData.files), e.clipboardData.getData("text/plain"));
    if (colados.length === 0) return;
    e.preventDefault();
    receberArquivos(colados);
  }

  async function startRecording() {
    if (recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      cancelRef.current = false;
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) clearInterval(timerRef.current);
        if (cancelRef.current) return;
        const type = rec.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size === 0) return;
        const file = new File([blob], `voz-${Date.now()}.webm`, { type });
        onSendMedia?.(file, "");
      };
      recRef.current = rec;
      rec.start();
      setSeconds(0);
      setRecording(true);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      alert("Não consegui acessar o microfone. Verifique a permissão do navegador.");
    }
  }

  function stopAndSend() {
    cancelRef.current = false;
    recRef.current?.stop();
    setRecording(false);
  }

  function cancelRecording() {
    cancelRef.current = true;
    recRef.current?.stop();
    setRecording(false);
  }

  if (recording) {
    return (
      <div className="flex items-center gap-3 border-t border-line px-6 py-3">
        <Button size="icon-sm" variant="ghost" onClick={cancelRecording} aria-label="Cancelar gravação">
          <X className="h-4 w-4 text-danger-500" />
        </Button>
        <div className="flex flex-1 items-center gap-2 text-body text-ink-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-danger-500" />
          <span className="num">Gravando… {fmt(seconds)}</span>
        </div>
        <Button onClick={stopAndSend}>Enviar áudio</Button>
      </div>
    );
  }

  const hasText = text.trim().length > 0;

  return (
    <div className="flex items-end gap-2 border-t border-line px-6 py-4">
      {onSendMedia ? (
        <>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept={ANEXO_ACCEPT}
            onChange={onPickFile}
          />
          <Button size="icon" variant="outline" onClick={() => fileRef.current?.click()} aria-label="Anexar arquivo" className="h-9 w-9">
            <Paperclip className="h-4 w-4 text-ink-2" />
          </Button>
        </>
      ) : null}
      <Textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim()) onTyping?.();
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={placeholder ?? "Escreva uma mensagem"}
        rows={1}
        className="max-h-40 min-h-[36px] resize-none py-2"
      />
      {hasText || !onSendMedia ? (
        <Button onClick={submit} disabled={!hasText} className="h-9">
          Enviar
        </Button>
      ) : (
        <Button size="icon" variant="outline" onClick={startRecording} aria-label="Gravar áudio" className="h-9 w-9">
          <Mic className="h-4 w-4 text-ink-2" />
        </Button>
      )}
    </div>
  );
}
