"use client";

import { useEffect, useRef } from "react";
import { Bold, Italic, Underline, Link2, Image as ImageIcon, Palette } from "lucide-react";

/**
 * Editor leve (contenteditable) para assinaturas: negrito, itálico, sublinhado,
 * cor, link e imagem. HTML de saída via onChange. Sem biblioteca pesada.
 */
export function RichEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const colorRef = useRef<HTMLInputElement>(null);

  // Conteúdo inicial só na montagem (evita pular o cursor a cada tecla).
  const initedRef = useRef(false);
  useEffect(() => {
    if (initedRef.current) return;
    initedRef.current = true;
    if (ref.current) ref.current.innerHTML = value || "";
  }, [value]);

  function exec(cmd: string, arg?: string) {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    emit();
  }
  function emit() {
    if (ref.current) onChange(ref.current.innerHTML);
  }
  function addLink() {
    const url = prompt("URL do link:");
    if (url) exec("createLink", url);
  }
  function addImage(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      exec("insertImage", String(reader.result));
    };
    reader.readAsDataURL(f);
  }

  const imgRef = useRef<HTMLInputElement>(null);

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-1 border-b bg-muted/40 p-1.5">
        <ToolBtn onClick={() => exec("bold")} title="Negrito"><Bold className="h-4 w-4" /></ToolBtn>
        <ToolBtn onClick={() => exec("italic")} title="Itálico"><Italic className="h-4 w-4" /></ToolBtn>
        <ToolBtn onClick={() => exec("underline")} title="Sublinhado"><Underline className="h-4 w-4" /></ToolBtn>
        <ToolBtn onClick={() => colorRef.current?.click()} title="Cor do texto"><Palette className="h-4 w-4" /></ToolBtn>
        <ToolBtn onClick={addLink} title="Link"><Link2 className="h-4 w-4" /></ToolBtn>
        <ToolBtn onClick={() => imgRef.current?.click()} title="Imagem"><ImageIcon className="h-4 w-4" /></ToolBtn>
        <input ref={colorRef} type="color" className="hidden" onChange={(e) => exec("foreColor", e.target.value)} />
        <input ref={imgRef} type="file" accept="image/*" className="hidden" onChange={addImage} />
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        className="min-h-[120px] max-h-72 overflow-y-auto px-3 py-2 text-sm focus:outline-none [&_img]:max-w-full"
      />
    </div>
  );
}

function ToolBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded hover:bg-muted"
    >
      {children}
    </button>
  );
}
