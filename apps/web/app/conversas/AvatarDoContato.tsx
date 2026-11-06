"use client";

import * as React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Avatar de quem está na conversa: a foto do WhatsApp quando existe, as iniciais quando não (escondida, sem foto,
 * conversa sem telefone). A foto vem de `/api/conversations/:id/foto`, que busca na hora e não guarda nada.
 *
 * `ampliavel`: clicar na foto abre um pop-up com ela grande, que fecha no X, no Esc ou fora da caixa (igual ao
 * WhatsApp). Sem foto não há o que ampliar, então o avatar fica como está.
 */
export function AvatarDoContato({
  conversationId,
  nome,
  iniciais,
  comFoto = true,
  ampliavel = false,
  className,
  fallbackClassName,
}: {
  conversationId: string;
  /** Nome já formatado para a tela (vai no título do pop-up e no texto alternativo). */
  nome: string;
  iniciais: string;
  /** false = canal sem foto (e-mail): nem pede a imagem. */
  comFoto?: boolean;
  ampliavel?: boolean;
  className?: string;
  fallbackClassName?: string;
}) {
  const src = `/api/conversations/${conversationId}/foto`;
  const [carregada, setCarregada] = React.useState(false);
  const [aberta, setAberta] = React.useState(false);

  // Trocou de conversa: o estado da foto anterior não vale.
  React.useEffect(() => {
    setCarregada(false);
    setAberta(false);
  }, [conversationId]);

  const avatar = (
    <Avatar className={className}>
      {comFoto && <AvatarImage src={src} alt="" className="object-cover" onLoadingStatusChange={(s) => setCarregada(s === "loaded")} />}
      <AvatarFallback className={fallbackClassName}>{iniciais}</AvatarFallback>
    </Avatar>
  );
  if (!ampliavel) return avatar;

  const podeAmpliar = comFoto && carregada;
  return (
    <>
      {/* O botão é sempre o mesmo elemento: trocar o invólucro remontaria o avatar e a foto piscaria. */}
      <button
        type="button"
        disabled={!podeAmpliar}
        aria-hidden={podeAmpliar ? undefined : true}
        aria-label={podeAmpliar ? `Ver foto de ${nome}` : undefined}
        onClick={() => setAberta(true)}
        className={cn(
          "shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-default",
          podeAmpliar && "cursor-zoom-in transition-opacity hover:opacity-90",
        )}
      >
        {avatar}
      </button>
      <Dialog open={aberta} onOpenChange={setAberta}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="num truncate pr-8">{nome}</DialogTitle>
            <DialogDescription className="sr-only">Foto de perfil do WhatsApp</DialogDescription>
          </DialogHeader>
          <img src={src} alt={`Foto de ${nome}`} className="aspect-square w-full rounded-md bg-muted object-cover" />
        </DialogContent>
      </Dialog>
    </>
  );
}
