/**
 * Copiar texto para a área de transferência. Roda só no navegador: não importe
 * nada de servidor aqui (é usado por componentes "use client").
 */

/**
 * Plano B: `textarea` escondido + `execCommand("copy")`. Serve para navegador
 * antigo e para página sem HTTPS, onde `navigator.clipboard` não existe.
 * Devolve `false` (nunca lança) se o navegador também recusar.
 */
function copiarPorTextarea(texto: string): boolean {
  if (typeof document === "undefined") return false;
  const anterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const ta = document.createElement("textarea");
  ta.value = texto;
  // readonly evita abrir o teclado no celular; fixed/opacity 0 evitam pular a rolagem.
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, texto.length); // iOS ignora só o select()
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
    // O select() tirou o foco de quem clicou: devolve, para não perder o lugar no Tab.
    anterior?.focus({ preventScroll: true });
  }
}

/**
 * Copia `texto` para a área de transferência. Tenta a API moderna e, se ela não
 * existir ou falhar, cai no plano B. Devolve `true` se copiou; nunca lança erro.
 */
export async function copiarTexto(texto: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch {
    // Sem permissão, sem foco ou página insegura: tenta o plano B.
  }
  return copiarPorTextarea(texto);
}
