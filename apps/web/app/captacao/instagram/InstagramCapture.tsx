"use client";

import { useState } from "react";
import Link from "next/link";
import { Camera, Search, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LIMITE_INSTAGRAM_MAX, LIMITE_INSTAGRAM_PADRAO, limiteDeCaptura } from "@/lib/captacao-limite";
import { avisoDoErroAoIniciar, botaoDaCaptura, type AvisoDaBusca as DadosDoAviso } from "@/lib/captacao-estado";
import { startInstagramCaptureAction } from "../actions";
import { ProspectStaging } from "../ProspectStaging";
import { AvisoDaBusca, GiroDeBusca, ResultadoDaBusca, useBuscaEmAndamento } from "../andamento-da-busca";

export function InstagramCapture() {
  const [perfil, setPerfil] = useState("");
  const [quantidade, setQuantidade] = useState(String(LIMITE_INSTAGRAM_PADRAO));
  const [recusa, setRecusa] = useState<DadosDoAviso | null>(null);
  // O estado da busca vem do servidor: o botão fica desativado por ele (vale ao recarregar e em outra aba).
  const { atual, iniciando, setIniciando, recarregar, andando } = useBuscaEmAndamento("instagram");
  const botao = botaoDaCaptura({ iniciando, atual }, "Buscar seguidores");

  async function buscar() {
    if (botao.desativado) return;
    if (!perfil.trim()) {
      toast.error("Informe o @ do perfil");
      return;
    }
    setIniciando(true);
    setRecusa(null);
    const limite = limiteDeCaptura(quantidade);
    setQuantidade(String(limite));
    const r = await startInstagramCaptureAction(perfil.trim(), limite);
    if (r.error) {
      // Recusa do servidor (extensão desligada, já há busca, sem conta...): fica na tela com o que fazer.
      if (r.codigo !== "em_andamento") setRecusa(avisoDoErroAoIniciar(r.codigo, r.error));
      await recarregar();
      setIniciando(false);
      return;
    }
    // Relê o estado ANTES de liberar o botão: ele já nasce desativado ("na fila") pelo servidor.
    await recarregar();
    setIniciando(false);
    toast.success("Busca iniciada", { description: "A extensão lê no seu Chrome, no ritmo de uma pessoa. Os seguidores aparecem na fila aos poucos." });
  }

  return (
    <div className="space-y-5">
      <div>
        <Link href="/captacao" className="mb-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Captação
        </Link>
        <h1 className="flex items-center gap-2 text-h1 font-semibold tracking-tight">
          <Camera className="h-5 w-5" /> Captação no Instagram
        </h1>
        <p className="text-body text-muted-foreground">
          Traz os seguidores de um perfil. A leitura sai do seu Chrome, pela extensão do CRM Agro, com a conta de Instagram conectada
          em Integrações, Canais. Deixe o Chrome aberto até terminar. O @ vira contato para o DM.
        </p>
      </div>

      <div className="rounded-lg border border-warning-500/30 bg-warning-100 p-3 text-caption text-warning-700">
        ⚠️ <strong>Alto risco (LGPD + ToS Meta):</strong> raspar seguidores trata dado pessoal de terceiro sem consentimento. O
        passivo é do operador. Use com responsabilidade, volume baixo e ofereça opt-out. Veja o SECURITY.md do projeto.
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap gap-2">
          <Input
            value={perfil}
            onChange={(e) => setPerfil(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && buscar()}
            placeholder="@perfil_alvo"
            className="flex-1 min-w-[240px]"
            disabled={botao.desativado}
          />
          <div className="flex items-center gap-2">
            <Label htmlFor="ig-quantidade" className="whitespace-nowrap text-caption text-muted-foreground">
              Quantidade
            </Label>
            <Input
              id="ig-quantidade"
              type="number"
              inputMode="numeric"
              min={1}
              max={LIMITE_INSTAGRAM_MAX}
              value={quantidade}
              onChange={(e) => setQuantidade(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && buscar()}
              aria-describedby="ig-quantidade-ajuda"
              className="w-24"
              disabled={botao.desativado}
            />
          </div>
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
        <p id="ig-quantidade-ajuda" className="mt-2 text-caption text-muted-foreground">
          Quantos seguidores trazer, de 1 a {LIMITE_INSTAGRAM_MAX}. Menos contatos por busca respeita os limites da plataforma.
        </p>
      </div>

      {/* Recusa do pedido de agora tem prioridade sobre o resultado da busca anterior. */}
      {recusa ? <AvisoDaBusca aviso={recusa} aoFechar={() => setRecusa(null)} /> : <ResultadoDaBusca atual={atual} />}

      <ProspectStaging origem="instagram" atualizando={andando} />
    </div>
  );
}
