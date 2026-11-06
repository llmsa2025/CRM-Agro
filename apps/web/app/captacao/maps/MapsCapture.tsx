"use client";

import { useState } from "react";
import Link from "next/link";
import { MapPin, Search, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { botaoDaCaptura } from "@/lib/captacao-estado";
import { startMapsCaptureAction } from "../actions";
import { ProspectStaging } from "../ProspectStaging";
import { GiroDeBusca, ResultadoDaBusca, useBuscaEmAndamento } from "../andamento-da-busca";

export function MapsCapture() {
  const [termo, setTermo] = useState("");
  // O estado da busca vem do servidor: o botão fica desativado por ele (vale ao recarregar e em outra aba).
  const { atual, iniciando, setIniciando, recarregar, andando } = useBuscaEmAndamento("maps");
  const botao = botaoDaCaptura({ iniciando, atual }, "Buscar");

  async function buscar() {
    if (botao.desativado) return;
    if (!termo.trim()) {
      toast.error("Digite o que buscar (ex.: “supermercado em Sorriso MT”)");
      return;
    }
    setIniciando(true);
    const r = await startMapsCaptureAction(termo.trim());
    if (r.error) {
      setIniciando(false);
      return toast.error("Falha ao iniciar", { description: r.error });
    }
    // Relê o estado ANTES de liberar o botão: ele já nasce desativado ("na fila") pelo servidor.
    await recarregar();
    setIniciando(false);
    toast.success("Busca iniciada", { description: "Os resultados aparecem na fila em instantes (pode levar de 1 a 2 min)." });
  }

  return (
    <div className="space-y-5">
      <div>
        <Link href="/captacao" className="mb-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Captação
        </Link>
        <h1 className="flex items-center gap-2 text-h1 font-semibold tracking-tight">
          <MapPin className="h-5 w-5" /> Captação no Google Maps
        </h1>
        <p className="text-body text-muted-foreground">
          Digite o que procura; o CRM Agro busca no Maps e traz as empresas (nome, telefone, local) para você revisar e importar.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap gap-2">
          <Input
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && buscar()}
            placeholder="Ex.: agropecuária em Sorriso MT"
            className="flex-1 min-w-[240px]"
            disabled={botao.desativado}
          />
          <Button onClick={buscar} disabled={botao.desativado} aria-busy={botao.desativado}>
            {botao.desativado ? <GiroDeBusca /> : <Search className="mr-1.5 h-4 w-4" />}
            {botao.rotulo}
          </Button>
          {botao.andamento && (
            <span className="num self-center text-caption text-muted-foreground" role="status" aria-live="polite">
              {botao.andamento}
            </span>
          )}
        </div>
        <p className="mt-2 text-caption text-muted-foreground">
          ⚠️ Scraping do Google (não oficial): pode falhar por bloqueio de IP. A busca roda no servidor, em segundo plano.
        </p>
      </div>

      <ResultadoDaBusca atual={atual} />

      <ProspectStaging origem="maps" atualizando={andando} />
    </div>
  );
}
