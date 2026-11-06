"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Copy, Plus, Trash2, KeyRound, Check, TriangleAlert, Loader2, Download, Puzzle } from "lucide-react";
import type { RelayTokenDTO } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  createRelayTokenAction,
  listRelayTokensAction,
  revokeRelayTokenAction,
} from "./actions";
import { copiarTexto } from "@/lib/copiar";

function quando(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function ExtensaoClient({ initialTokens, versao }: { initialTokens: RelayTokenDTO[]; versao: string | null }) {
  const [tokens, setTokens] = useState<RelayTokenDTO[]>(initialTokens);
  const [label, setLabel] = useState("");
  const [gerando, setGerando] = useState(false);
  const [novoToken, setNovoToken] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  async function recarregar() {
    setTokens(await listRelayTokensAction());
  }

  async function gerar() {
    const nome = label.trim();
    if (!nome || gerando) return;
    setGerando(true);
    setNovoToken(null);
    try {
      const res = await createRelayTokenAction(nome);
      if (res.ok && res.token) {
        setNovoToken(res.token.token);
        setLabel("");
        await recarregar();
      } else {
        toast.error("Falha ao gerar token", { description: res.error });
      }
    } finally {
      setGerando(false);
    }
  }

  async function copiar(txt: string) {
    // `copiarTexto` cai no plano B (página sem HTTPS, navegador antigo) e nunca lança.
    const ok = await copiarTexto(txt);
    if (!ok) {
      toast.error("Não consegui copiar. Selecione o token e copie manualmente.");
      return;
    }
    setCopiado(true);
    toast.success("Token copiado");
    setTimeout(() => setCopiado(false), 2000);
  }

  async function revogar(id: string, nome: string) {
    if (!window.confirm(`Revogar o token "${nome}"? A extensão que o usa vai parar de funcionar.`)) return;
    const res = await revokeRelayTokenAction(id);
    if (res.ok) {
      toast.success("Token revogado");
      await recarregar();
    } else {
      toast.error("Falha ao revogar", { description: res.error });
    }
  }

  const ativos = tokens.filter((t) => !t.revokedAt);

  return (
    <div className="space-y-5">
      {/* Instalar a extensão */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2">
          <Puzzle className="h-4 w-4 text-brand-600" />
          <h2 className="text-h3 font-semibold tracking-tight">Instalar a extensão</h2>
        </div>
        <p className="mt-1 text-caption text-muted-foreground">
          Baixe a extensão e carregue no Chrome (leva 1 minuto). O download já vem com o endereço do CRM Agro e
          um token, então é só clicar em Ligar. Não precisa colar nada.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <a href="/api/extension/download" download>
            <Button className="gap-2">
              <Download className="h-4 w-4" />
              Baixar extensão (.zip)
            </Button>
          </a>
          {versao && <span className="text-caption text-muted-foreground">Versão {versao}</span>}
        </div>
        <ol className="mt-4 space-y-1.5 text-caption text-muted-foreground [counter-reset:step]">
          {[
            <>Descompacte o arquivo .zip numa pasta que você não vai apagar.</>,
            <>
              No Chrome, abra <code className="[font-family:monospace]">chrome://extensions</code>
            </>,
            <>Ligue o “Modo do desenvolvedor” (canto superior direito).</>,
            <>Clique em “Carregar sem compactação” e escolha a pasta descompactada.</>,
            <>Abra a extensão do CRM Agro na barra do Chrome e clique em Ligar.</>,
          ].map((passo, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground">
                {i + 1}
              </span>
              <span>{passo}</span>
            </li>
          ))}
        </ol>
        <div className="mt-4 border-t pt-3">
          <h3 className="text-body font-semibold">Para atualizar</h3>
          <p className="mt-1 text-caption text-muted-foreground">
            Baixe o arquivo de novo e troque os arquivos da mesma pasta pelos do novo .zip. Depois, em{" "}
            <code className="[font-family:monospace]">chrome://extensions</code>, clique em Recarregar na extensão do
            CRM Agro. Use sempre o arquivo baixado por último: o token de um download antigo que ainda não foi usado
            deixa de valer quando você baixa outro.
          </p>
        </div>
      </div>

      {/* Gerar novo token */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-brand-600" />
          <h2 className="text-h3 font-semibold tracking-tight">Gerar token</h2>
        </div>
        <p className="mt-1 text-caption text-muted-foreground">
          Dê um nome para identificar (ex.: “Meu notebook”, “Chrome do escritório”). O token é
          mostrado uma única vez.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                gerar();
              }
            }}
            placeholder="Nome do dispositivo/navegador"
            className="sm:max-w-xs"
          />
          <Button onClick={gerar} disabled={gerando || !label.trim()} className="gap-2">
            {gerando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Gerar token
          </Button>
        </div>

        {/* Token recém-gerado (exibido UMA vez) */}
        {novoToken && (
          <div className="mt-4 rounded-md border border-warning-300 bg-warning-50 p-3 dark:bg-warning-950/30">
            <p className="flex items-center gap-1.5 text-caption font-medium text-warning-700 dark:text-warning-400">
              <TriangleAlert className="h-3.5 w-3.5" /> Copie e guarde agora. Não será mostrado de novo.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-background px-2 py-1.5 text-caption [font-family:monospace]">
                {novoToken}
              </code>
              <Button variant="outline" size="icon" onClick={() => copiar(novoToken)} aria-label="Copiar token">
                {copiado ? <Check className="h-4 w-4 text-success-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="mt-2 text-caption text-muted-foreground">
              Abra a extensão do CRM Agro no navegador, cole este token e clique em <strong>Ligar</strong>.
            </p>
          </div>
        )}
      </div>

      {/* Lista de tokens */}
      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-h3 font-semibold tracking-tight">Seus tokens</h2>
        </div>
        {tokens.length === 0 ? (
          <p className="px-4 py-10 text-center text-caption text-muted-foreground">
            Nenhum token ainda. Gere um acima para conectar a extensão.
          </p>
        ) : (
          <ul className="divide-y">
            {tokens.map((t) => {
              const revogado = !!t.revokedAt;
              return (
                <li key={t.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={"truncate text-body " + (revogado ? "text-muted-foreground line-through" : "")}>
                        {t.label}
                      </span>
                      {revogado ? (
                        <Badge variant="outline-muted">revogado</Badge>
                      ) : (
                        <Badge variant="info">ativo</Badge>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      <code className="[font-family:monospace]">{t.tokenPrefix}…</code> · criado {quando(t.createdAt)} ·
                      último uso {quando(t.lastUsedAt)}
                    </div>
                  </div>
                  {!revogado && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => revogar(t.id, t.label)}
                      aria-label="Revogar token"
                      title="Revogar"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {ativos.length > 0 && (
          <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">
            {ativos.length} token(s) ativo(s). Revogue os que não usa mais.
          </p>
        )}
      </div>
    </div>
  );
}
