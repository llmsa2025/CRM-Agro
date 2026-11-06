"use client";

import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Fronteira de erro da árvore de páginas.
 *
 * Causa raiz nº1 em produção: `ChunkLoadError` (ex.: "Loading chunk 4146
 * failed"). Ocorre na janela de deploy — o HTML servido referencia hashes de
 * chunk que o `.next/static` no disco (ou outra instância atrás do load
 * balancer) ainda não tem, então o /_next/static responde 400/404 e o React
 * estoura com a tela crua "Application error". A recuperação correta é
 * recarregar UMA vez para buscar o HTML/manifesto novo — com trava anti-loop
 * (sessionStorage) para nunca recarregar em ciclo se o erro persistir.
 */
export default function Error({
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
    if (!isChunkError) return;
    const KEY = "crmagro:chunk-reload";
    // Recarrega só uma vez por sessão para evitar loop de reload.
    if (typeof window !== "undefined" && !sessionStorage.getItem(KEY)) {
      sessionStorage.setItem(KEY, String(Date.now()));
      window.location.reload();
    }
  }, [isChunkError]);

  useEffect(() => {
    // Se a página carregou de fato, limpa a trava para o próximo deploy.
    if (!isChunkError && typeof window !== "undefined") {
      sessionStorage.removeItem("crmagro:chunk-reload");
    }
  }, [isChunkError]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="space-y-1.5">
        <h1 className="text-h3 font-semibold tracking-tight">
          {isChunkError ? "Atualizando o aplicativo…" : "Algo deu errado"}
        </h1>
        <p className="max-w-md text-body text-muted-foreground">
          {isChunkError
            ? "Uma nova versão foi publicada. Estamos recarregando esta página automaticamente."
            : "Não foi possível carregar esta tela. Tente novamente; se persistir, recarregue a página."}
        </p>
      </div>
      <Button
        variant="outline"
        onClick={() => {
          sessionStorage.removeItem("crmagro:chunk-reload");
          if (isChunkError) window.location.reload();
          else reset();
        }}
      >
        <RotateCcw className="h-4 w-4" />
        {isChunkError ? "Recarregar agora" : "Tentar novamente"}
      </Button>
    </div>
  );
}
