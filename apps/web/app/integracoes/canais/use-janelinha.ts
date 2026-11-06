"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Abre uma URL numa janelinha, sem tirar a pessoa do CRM Agro, e avisa quando ela fecha. A janelinha é do
 * Google (outro domínio): o CRM Agro não enxerga nem controla o que há dentro dela, só sabe se ela ainda
 * está aberta. Por isso o assistente avança por dois sinais: a janelinha fechar, ou a pessoa clicar.
 *
 * Só passe URL que o próprio CRM Agro montou ou validou (a tela de encaminhamento do Gmail e o link de
 * confirmação do Google, já filtrado por `linkDeConfirmacaoExibivel`).
 */
export function useJanelinha() {
  const janela = useRef<Window | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const pararDeOlhar = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  /** Fecha a janelinha, se ainda estiver aberta. Não chama o `aoFechar` (quem fechou foi o assistente). */
  const fechar = useCallback(() => {
    pararDeOlhar();
    const j = janela.current;
    janela.current = null;
    try {
      if (j && !j.closed) j.close();
    } catch {
      // sem importância: se não der para fechar, a pessoa fecha
    }
  }, [pararDeOlhar]);

  const abrir = useCallback(
    (url: string, aoFechar?: () => void) => {
      fechar();
      let j: Window | null = null;
      try {
        j = window.open(url, "crmagro-gmail", "popup=yes,width=1000,height=760");
      } catch {
        j = null;
      }
      if (!j) {
        // O navegador bloqueou a janelinha: abre numa aba normal. Sem como saber quando ela fecha.
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      janela.current = j;
      if (!aoFechar) return;
      timer.current = setInterval(() => {
        if (!janela.current || janela.current.closed) {
          pararDeOlhar();
          janela.current = null;
          aoFechar();
        }
      }, 600);
    },
    [fechar, pararDeOlhar],
  );

  // Ao desmontar, só para de olhar (não fecha a janelinha do Google debaixo da pessoa).
  useEffect(() => pararDeOlhar, [pararDeOlhar]);

  return { abrir, fechar };
}
