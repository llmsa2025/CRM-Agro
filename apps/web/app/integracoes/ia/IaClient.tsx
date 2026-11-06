"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Trash2, ShieldCheck } from "lucide-react";
import { LogoFerramenta } from "@/components/brand-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { saveAiIntegrationAction, deleteAiIntegrationAction, setAiModeAction } from "./actions";
import { mensagemDoMotivoDaChave, mostrarCampoDaChave } from "./chave";

type AiProvider = "anthropic" | "openai" | "glm";
type AiMode = "off" | "read_only" | "read_write";

type IntegrationDTO = {
  provider: AiProvider;
  connected: boolean;
  status: string;
  maskedKey: string | null;
  updatedAt: string | null;
};

const PROVIDERS: { id: AiProvider; nome: string; hint: string }[] = [
  { id: "anthropic", nome: "Anthropic (Claude)", hint: "console.anthropic.com → API Keys" },
  { id: "openai", nome: "OpenAI", hint: "platform.openai.com → API Keys" },
  { id: "glm", nome: "GLM (z.ai)", hint: "z.ai → API Keys (endpoint Anthropic-compatível)" },
];

const MODES: { id: AiMode; nome: string; desc: string }[] = [
  { id: "off", nome: "Desligada", desc: "A IA não faz nenhuma chamada." },
  { id: "read_only", nome: "Só leitura", desc: "Analisa e sugere, mas não escreve no banco." },
  { id: "read_write", nome: "Leitura e escrita", desc: "Pode escrever, sempre marcado como feito pela IA (tags “IA:”)." },
];

export function IaClient({ integrations, mode }: { integrations: IntegrationDTO[]; mode: AiMode }) {
  return (
    <div className="space-y-6">
      <GovernanceCard mode={mode} />
      <div className="space-y-2">
        <h2 className="text-h3 font-semibold tracking-tight">Provedores</h2>
        <div className="grid gap-3">
          {PROVIDERS.map((p) => {
            const dto = integrations.find((i) => i.provider === p.id);
            return <ProviderCard key={p.id} meta={p} dto={dto} />;
          })}
        </div>
      </div>
    </div>
  );
}

function GovernanceCard({ mode }: { mode: AiMode }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState<AiMode>(mode);

  function pick(m: AiMode) {
    const anterior = value;
    setValue(m);
    start(async () => {
      const res = await setAiModeAction(m);
      if (res.ok) toast.success("Governança atualizada");
      else {
        setValue(anterior);
        toast.error("Falha ao atualizar", { description: res.error });
      }
      router.refresh();
    });
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-brand-600" />
          <h2 className="text-h3 font-semibold tracking-tight">Governança</h2>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={pending}
              onClick={() => pick(m.id)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                value === m.id ? "border-brand-400 bg-brand-50 dark:bg-brand-500/10" : "hover:bg-muted/60"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-body font-medium">{m.nome}</span>
                {value === m.id && <Check className="h-4 w-4 text-brand-600" />}
              </div>
              <p className="mt-0.5 text-caption text-muted-foreground">{m.desc}</p>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderCard({
  meta,
  dto,
}: {
  meta: { id: AiProvider; nome: string; hint: string };
  dto?: IntegrationDTO;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [key, setKey] = useState("");
  // "Trocar a chave": com a chave conectada o campo some, e este botão traz de volta.
  const [trocando, setTrocando] = useState(false);
  const connected = dto?.connected ?? false;
  const status = dto?.status ?? "disconnected";

  function salvar() {
    if (!key.trim()) {
      toast.error("Cole a chave de API");
      return;
    }
    start(async () => {
      const res = await saveAiIntegrationAction(meta.id, key.trim());
      if (res.ok) {
        setKey("");
        if (res.connected) {
          setTrocando(false);
          toast.success(`${meta.nome} conectado`);
        } else toast.warning("Chave salva, mas o teste de conexão falhou", { description: mensagemDoMotivoDaChave(meta.id, res.motivo) });
        router.refresh();
      } else toast.error("Falha ao salvar", { description: res.error });
    });
  }

  function remover() {
    start(async () => {
      const res = await deleteAiIntegrationAction(meta.id);
      if (res.ok) {
        toast.success(`${meta.nome} removido`);
        router.refresh();
      } else toast.error("Falha ao remover", { description: res.error });
    });
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            {/* Provedor sem logo próprio cai no brilho genérico de IA. */}
            <LogoFerramenta id={meta.id} padrao="ia" />
            <span className="text-body font-medium">{meta.nome}</span>
          </div>
          {connected ? (
            <Badge variant="success">Conectado</Badge>
          ) : status === "error" ? (
            <Badge variant="destructive">Erro na chave</Badge>
          ) : (
            <Badge variant="outline-muted">Não conectado</Badge>
          )}
        </div>

        {dto?.maskedKey && (
          <p className="text-caption text-muted-foreground">
            Chave atual: <span className="font-mono">{dto.maskedKey}</span>
          </p>
        )}

        {mostrarCampoDaChave({ connected, trocando }) ? (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-caption">{connected ? "Nova chave" : "Chave de API"}</Label>
              <Input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={meta.hint}
                autoComplete="off"
              />
            </div>
            <Button onClick={salvar} disabled={pending || !key.trim()}>
              {pending ? "Testando..." : connected ? "Atualizar" : "Conectar"}
            </Button>
            {trocando ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setTrocando(false);
                  setKey("");
                }}
                disabled={pending}
              >
                Cancelar
              </Button>
            ) : null}
            {!trocando && (connected || status === "error") && (
              <Button variant="ghost" size="icon" onClick={remover} disabled={pending} aria-label="Remover">
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="text-caption text-muted-foreground">Chave conectada e testada. Para usar outra, troque a chave.</p>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => setTrocando(true)} disabled={pending}>
                Trocar a chave
              </Button>
              <Button variant="ghost" size="icon" onClick={remover} disabled={pending} aria-label="Remover">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
