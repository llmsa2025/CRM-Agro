"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Paperclip } from "lucide-react";
import { arrasteTemArquivos, contadorDeArraste } from "@/lib/anexar-arquivos";
import { cn } from "@/lib/utils";

/**
 * Área da conversa que aceita arrastar e soltar arquivos. Ao arrastar arquivo
 * por cima aparece a sobreposição "Solte para anexar"; ao soltar, entrega a
 * lista para quem cuida do anexo (o Composer, que valida e envia igual ao clipe).
 *
 * Cuidados:
 * - só reage a arraste que carrega arquivo (`types` com "Files"); texto e link
 *   arrastados seguem o comportamento normal do navegador (seleção de texto,
 *   soltar texto no campo) e nunca recebem `preventDefault`;
 * - o contador de entradas/saídas impede a sobreposição de piscar ao passar por
 *   cima de cada elemento filho; a sobreposição não captura o mouse
 *   (`pointer-events-none`), então também não gera saída falsa;
 * - só conta o que está DENTRO da área no DOM: janelas e menus que abrem em
 *   portal (e ficam por cima) não disparam anexo por baixo;
 * - arraste que COMEÇOU dentro da área (ex.: sem querer, arrastar a foto de uma
 *   mensagem) é ignorado: o Chrome anota a imagem arrastada como "Files", e soltá-la
 *   ali reenviaria a foto ao cliente sem ninguém ter pedido;
 * - acessibilidade: o clipe segue como o caminho por teclado; a região `aria-live`
 *   fica sempre montada (leitor de tela só anuncia mudança em região já existente).
 */
export function AreaSoltarArquivos({
  onSoltar,
  desabilitada,
  className,
  children,
}: {
  onSoltar: (arquivos: File[]) => void;
  /** Sem conversa aberta / sem campo de escrita: não intercepta nada. */
  desabilitada?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [contador, setContador] = useState(0);
  // O contador precisa valer já no próximo evento (vários por frame): guarda também em ref.
  const contadorRef = useRef(0);
  // O arraste atual nasceu dentro da própria área (dragstart borbulha até aqui).
  const internoRef = useRef(false);
  const arrastando = contador > 0 && !desabilitada;

  const mudar = useCallback((evento: Parameters<typeof contadorDeArraste>[1]) => {
    contadorRef.current = contadorDeArraste(contadorRef.current, evento);
    setContador(contadorRef.current);
  }, []);

  // Rede de segurança: arraste cancelado com Esc ou solto fora da área nem
  // sempre dispara `dragleave` aqui; sem isto a sobreposição ficaria presa.
  useEffect(() => {
    // Todo arraste termina em `drop` ou `dragend` (solto onde for): fecha o contador e
    // a marca de "nasceu aqui dentro" (o `drop` da própria área roda antes, na raiz do React).
    const fim = () => {
      internoRef.current = false;
      mudar("reiniciar");
    };
    window.addEventListener("drop", fim);
    window.addEventListener("dragend", fim);
    return () => {
      window.removeEventListener("drop", fim);
      window.removeEventListener("dragend", fim);
    };
  }, [mudar]);

  // Ficou desabilitada no meio do arraste (trocou de conversa): solta o contador.
  useEffect(() => {
    if (desabilitada) mudar("reiniciar");
  }, [desabilitada, mudar]);

  /** Este evento é para nós? (arquivo, dentro da área no DOM, área ligada) */
  function meu(e: DragEvent<HTMLDivElement>): boolean {
    if (desabilitada || internoRef.current) return false;
    if (!arrasteTemArquivos(e.dataTransfer?.types)) return false;
    return e.currentTarget.contains(e.target as Node);
  }

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!meu(e)) return;
    e.preventDefault();
    mudar("entrou");
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!meu(e)) return;
    // Sem isto o navegador não deixa soltar (e abriria o arquivo na aba).
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!meu(e)) return;
    mudar("saiu");
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!meu(e)) return;
    e.preventDefault();
    mudar("soltou");
    const arquivos = Array.from(e.dataTransfer.files);
    if (arquivos.length > 0) onSoltar(arquivos);
  }

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragStart={() => {
        internoRef.current = true;
      }}
    >
      {children}
      {arrastando ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-3 z-30 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-brand-500 bg-background/90"
        >
          <Paperclip className="h-6 w-6 text-brand-500" />
          <p className="text-h2 font-serif text-foreground">Solte para anexar</p>
          <p className="text-small text-ink-2">Imagem, áudio, PDF ou documento</p>
        </div>
      ) : null}
      <div aria-live="polite" role="status" className="sr-only">
        {arrastando ? "Solte para anexar o arquivo na conversa" : ""}
      </div>
    </div>
  );
}
