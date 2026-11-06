"use client";

import { BotaoCompartilhar } from "@/components/escopo/botao-compartilhar";
import { compartilharFluxoAction } from "./actions";

/** Coluna "Visível para" da lista de fluxos (F4). */
export function CompartilharFluxo({ id, compartilhado, podeMudar }: { id: string; compartilhado: boolean; podeMudar: boolean }) {
  return <BotaoCompartilhar compartilhado={compartilhado} podeMudar={podeMudar} rotulo="fluxo" acao={(v) => compartilharFluxoAction(id, v)} />;
}
