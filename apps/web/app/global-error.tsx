"use client";

import { useEffect } from "react";

/**
 * Fronteira de erro GLOBAL (substitui o layout raiz quando o próprio layout
 * falha). Precisa renderizar suas próprias tags <html>/<body>.
 *
 * Além de dar uma tela de erro decente, a presença deste arquivo faz o Next
 * gerar a página de erro pelo App Router — sem ele, o `next build` cai no
 * fallback do pages/_error (que importa `<Html>`) e quebra com
 * "Html should not be imported outside of pages/_document", impedindo o deploy.
 *
 * Também recupera o `ChunkLoadError` (janela de deploy: HTML novo referencia
 * chunks que ainda não estão no disco/instância) recarregando UMA vez.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isChunkError =
    error?.name === "ChunkLoadError" ||
    /Loading chunk [\d]+ failed|Loading CSS chunk|ChunkLoadError/i.test(
      error?.message ?? "",
    );

  useEffect(() => {
    if (!isChunkError || typeof window === "undefined") return;
    const KEY = "crmagro:chunk-reload";
    if (!sessionStorage.getItem(KEY)) {
      sessionStorage.setItem(KEY, String(Date.now()));
      window.location.reload();
    }
  }, [isChunkError]);

  return (
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          textAlign: "center",
          padding: "1.5rem",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>
          {isChunkError ? "Atualizando o aplicativo…" : "Algo deu errado"}
        </h1>
        <p style={{ maxWidth: "28rem", color: "#666", margin: 0 }}>
          {isChunkError
            ? "Uma nova versão foi publicada. Recarregando esta página automaticamente."
            : "Não foi possível carregar o aplicativo. Tente novamente."}
        </p>
        <button
          onClick={() => {
            if (typeof window !== "undefined") {
              sessionStorage.removeItem("crmagro:chunk-reload");
            }
            if (isChunkError) window.location.reload();
            else reset();
          }}
          style={{
            padding: "0.5rem 1rem",
            borderRadius: "0.375rem",
            border: "1px solid #ccc",
            background: "transparent",
            cursor: "pointer",
          }}
        >
          {isChunkError ? "Recarregar agora" : "Tentar novamente"}
        </button>
      </body>
    </html>
  );
}
