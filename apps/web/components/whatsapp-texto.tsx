import { Fragment } from "react";
import { formatarWhatsApp, type Trecho } from "@/lib/whatsapp-formato";

function Trechos({ trechos }: { trechos: Trecho[] }) {
  return (
    <>
      {trechos.map((t, i) => {
        if (t.tipo === "texto") return <Fragment key={i}>{t.texto}</Fragment>;
        if (t.tipo === "codigo") return <code key={i} className="rounded-sm bg-black/5 px-1 font-mono text-[0.92em] dark:bg-white/10">{t.texto}</code>;
        const filhos = <Trechos trechos={t.filhos} />;
        if (t.tipo === "negrito") return <strong key={i}>{filhos}</strong>;
        if (t.tipo === "italico") return <em key={i}>{filhos}</em>;
        return <s key={i}>{filhos}</s>;
      })}
    </>
  );
}

/** Texto como o WhatsApp mostra: negrito, itálico, riscado e código, com as quebras de linha do autor. */
export function TextoWhatsApp({ texto }: { texto: string }) {
  return (
    <span className="whitespace-pre-wrap break-words">
      <Trechos trechos={formatarWhatsApp(texto)} />
    </span>
  );
}

/** Balão de mensagem enviada, no jeito do WhatsApp. */
export function BalaoWhatsApp({ texto }: { texto: string }) {
  return (
    <div className="max-w-full rounded-lg rounded-tr-none bg-[#d9fdd3] px-3 py-2 text-body leading-snug text-[#111b21] shadow-sm dark:bg-[#005c4b] dark:text-[#e9edef]">
      <TextoWhatsApp texto={texto} />
    </div>
  );
}
