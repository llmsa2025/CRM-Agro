"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, Briefcase, Loader2, ChevronRight, Download, Check, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { connectSocialAction } from "./social-actions";
import {
  conectarPelaExtensao,
  mensagemDoResultado,
  pingarExtensao,
  type CodigoDeErro,
  type IdentidadeDaPagina,
  type MensagemDeResultado,
} from "@/lib/extensao/ponte";

type Net = "instagram" | "linkedin";

const META: Record<Net, { label: string; cookie: string; icon: typeof Camera; help: string }> = {
  instagram: {
    label: "Instagram",
    cookie: "sessionid",
    icon: Camera,
    help: "instagram.com → F12 (DevTools) → Application → Cookies → copie o valor de sessionid.",
  },
  linkedin: {
    label: "LinkedIn",
    cookie: "li_at",
    icon: Briefcase,
    help: "linkedin.com → F12 (DevTools) → Application → Cookies → copie o valor de li_at.",
  },
};

/** Como a conexão está: automática (pela extensão) ou colando o cookie na mão. */
type Modo = "auto" | "manual";
/** Fases da conexão automática. */
type Fase = "verificando" | "ausente" | "sem_config" | "pronta" | "lendo" | "ok" | "erro";

/** Erros em que vale repetir o Conectar direto (o resto volta a procurar a extensão). */
const REPETIVEIS: readonly CodigoDeErro[] = ["sem_sessao", "sessao_expirada", "crmagro_indisponivel", "erro"];

/**
 * Botão + pop-up para conectar Instagram/LinkedIn pela sessão do navegador (não oficial).
 *
 * Caminho principal (assistido): a pessoa entra na conta em outra aba e clica em
 * Conectar; a extensão do CRM Agro lê a sessão DESTE navegador (cookie + nome do
 * perfil) e cadastra a conta sozinha. Sem a extensão, o pop-up ensina a instalar.
 * Colar o cookie na mão continua como alternativa.
 */
export function NewSocialConnection({ canal, identidade }: { canal: Net; identidade: IdentidadeDaPagina | null }) {
  const router = useRouter();
  const m = META[canal];
  const [open, setOpen] = useState(false);
  const [modo, setModo] = useState<Modo>(identidade ? "auto" : "manual");
  const [fase, setFase] = useState<Fase>("verificando");
  const [resultado, setResultado] = useState<MensagemDeResultado | null>(null);
  const [codigoErro, setCodigoErro] = useState<CodigoDeErro | null>(null);
  // Cada pergunta à extensão tem uma "geração": resposta de uma geração antiga (pop-up
  // fechado ou nova verificação no meio) não mexe na tela.
  const geracao = useRef(0);

  // Manual
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState("");
  const [cookie, setCookie] = useState("");
  const [proxy, setProxy] = useState("");
  const [proxyUser, setProxyUser] = useState("");
  const [proxyPass, setProxyPass] = useState("");

  const verificar = useCallback(async () => {
    const g = ++geracao.current;
    setFase("verificando");
    setResultado(null);
    setCodigoErro(null);
    const pong = await pingarExtensao(window);
    if (g !== geracao.current) return;
    setFase(!pong ? "ausente" : pong.configurada ? "pronta" : "sem_config");
  }, []);

  // Abriu o pop-up no modo automático: procura a extensão. Fechou: descarta respostas pendentes.
  useEffect(() => {
    if (!open) {
      geracao.current++;
      return;
    }
    if (modo === "auto") void verificar();
  }, [open, modo, verificar]);

  function aoAbrirOuFechar(v: boolean) {
    setOpen(v);
    if (v) setModo(identidade ? "auto" : "manual");
  }

  async function conectarAuto() {
    if (!identidade) return;
    const g = ++geracao.current;
    setFase("lendo");
    setResultado(null);
    setCodigoErro(null);
    const res = await conectarPelaExtensao(window, canal, identidade);
    const msg = mensagemDoResultado(res, canal);
    if (res.ok) {
      // Mesmo que a pessoa tenha fechado o pop-up no meio, a conta foi cadastrada.
      if (msg.tipo === "ok") toast.success(`${m.label} ${msg.texto.charAt(0).toLowerCase()}${msg.texto.slice(1)}`);
      else toast.warning(msg.texto);
      router.refresh();
    }
    if (g !== geracao.current) return;
    setResultado(msg);
    setCodigoErro(res.ok ? null : res.codigo);
    setFase(res.ok ? "ok" : "erro");
  }

  function tentarDeNovo() {
    if (codigoErro && REPETIVEIS.includes(codigoErro)) void conectarAuto();
    else void verificar();
  }

  async function conectarManual() {
    if (!cookie.trim()) {
      toast.error(`Cole o cookie ${m.cookie}`);
      return;
    }
    setSaving(true);
    const res = await connectSocialAction({
      canal,
      label: label.trim() || m.label,
      cookie: cookie.trim(),
      proxy: proxy.trim() ? { server: proxy.trim(), username: proxyUser.trim() || undefined, password: proxyPass.trim() || undefined } : undefined,
    });
    setSaving(false);
    if (res.ok) {
      if (res.connected) toast.success(`${m.label} conectado`);
      else toast.warning("Salvo, mas a sessão não validou", { description: res.error ?? "confira o cookie/proxy" });
      setCookie(""); setProxy(""); setProxyUser(""); setProxyPass("");
      setOpen(false);
      router.refresh();
    } else {
      toast.error("Falha ao conectar", { description: res.error });
    }
  }

  return (
    <Dialog open={open} onOpenChange={aoAbrirOuFechar}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="mt-4">
          <m.icon className="mr-1.5 h-4 w-4" /> Conectar {m.label} (assistido)
        </Button>
      </DialogTrigger>

      {modo === "auto" ? (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Conectar {m.label}</DialogTitle>
            <DialogDescription>
              Conecte na sua conta do {m.label} em outra aba e depois clique em Conectar.
            </DialogDescription>
          </DialogHeader>

          {fase === "verificando" && (
            <p className="flex items-center gap-2 text-caption text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Procurando a extensão do CRM Agro...
            </p>
          )}

          {fase === "ausente" && (
            <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-caption">
              <p className="font-medium text-primary">Antes, instale ou atualize a extensão do CRM Agro</p>
              <p className="mt-1 text-muted-foreground">
                Não encontrei a extensão neste navegador (ou ela é uma versão anterior à conexão automática).
              </p>
              <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-muted-foreground">
                <li>
                  <a href="/api/extension/download" download className="inline-flex items-center gap-1 font-medium text-brand-500 hover:underline">
                    <Download className="h-3.5 w-3.5" /> Baixe a extensão (.zip)
                  </a>
                  . Ela já vem ligada a este CRM Agro.
                </li>
                <li>Descompacte numa pasta. Se você já tinha a extensão, troque os arquivos da pasta antiga por estes.</li>
                <li>
                  No Chrome, abra <code className="[font-family:monospace]">chrome://extensions</code>, ative o Modo do
                  desenvolvedor e clique em Carregar sem compactar (ou em Recarregar, se ela já estava instalada).
                </li>
                <li>Volte aqui e clique em Verificar de novo.</li>
              </ol>
              <p className="mt-2 text-muted-foreground">
                Passo a passo completo na{" "}
                <Link href="/integracoes/extensao" className="text-brand-500 hover:underline">tela da extensão</Link>.
              </p>
            </div>
          )}

          {fase === "sem_config" && (
            <div className="rounded-md border border-warning-500/30 bg-warning-100 p-3 text-caption text-warning-700">
              <p className="font-medium">A extensão está instalada, mas ainda não está ligada a este CRM Agro.</p>
              <p className="mt-1">
                Baixe a extensão de novo pela{" "}
                <Link href="/integracoes/extensao" className="underline">tela da extensão</Link> (ela já vem configurada)
                e troque a pasta, ou abra a extensão e preencha a URL e o token.
              </p>
            </div>
          )}

          {(fase === "pronta" || fase === "lendo" || fase === "erro") && (
            <div className="grid gap-3">
              <div className="rounded-md border bg-muted/40 p-3 text-caption text-muted-foreground">
                <p className="font-medium text-foreground">O que o Conectar faz</p>
                <p className="mt-1">
                  Ao clicar em Conectar, você autoriza a extensão do CRM Agro a ler, neste navegador, o cookie de login do{" "}
                  {m.label} e o nome do seu perfil. Ela envia só isso ao CRM Agro, que guarda cifrado. Não lê suas
                  mensagens nem a sua senha.
                </p>
              </div>
              <div className="rounded-md border border-warning-500/30 bg-warning-100 p-3 text-caption text-warning-700">
                Conexão não oficial: usa a sua sessão logada e pode ir contra os termos do {m.label}. Há risco de
                restrição da conta. O CRM Agro envia devagar e com limites.
              </div>
            </div>
          )}

          {fase === "lendo" && (
            <p className="flex items-center gap-2 text-caption text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" /> Lendo sua sessão...
            </p>
          )}

          {fase === "ok" && resultado && (
            <p
              role="status"
              className={
                "flex items-start gap-2 rounded-md border p-3 text-caption " +
                (resultado.tipo === "ok"
                  ? "border-success-500/30 bg-success-100 text-success-700"
                  : "border-warning-500/30 bg-warning-100 text-warning-700")
              }
            >
              {resultado.tipo === "ok" ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />}
              {resultado.texto}
            </p>
          )}

          {fase === "erro" && resultado && (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-danger-500/30 bg-danger-100 p-3 text-caption text-danger-700">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              {resultado.texto}
            </p>
          )}

          {fase !== "lendo" && fase !== "ok" && (
            <button
              type="button"
              onClick={() => setModo("manual")}
              className="justify-self-start text-caption text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Prefiro colar o cookie manualmente
            </button>
          )}

          <DialogFooter>
            {fase === "ok" ? (
              <Button onClick={() => setOpen(false)}>Concluir</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
                {(fase === "ausente" || fase === "sem_config") && (
                  <Button variant="outline" onClick={() => void verificar()}>Verificar de novo</Button>
                )}
                {fase === "pronta" && <Button onClick={() => void conectarAuto()}>Conectar</Button>}
                {fase === "lendo" && (
                  <Button disabled>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Conectar
                  </Button>
                )}
                {fase === "erro" && <Button onClick={tentarDeNovo}>Tentar de novo</Button>}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      ) : (
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Conectar {m.label} (colando o cookie)</DialogTitle>
          </DialogHeader>

          <div className="rounded-md border border-warning-300 bg-warning-50 p-3 text-caption text-warning-800 dark:bg-warning-950/30">
            ⚠️ Conexão não-oficial usando sua sessão logada. Pode contrariar os termos da plataforma.
            Há risco de restrição ou ban. O CRM Agro envia devagar e com limites, mas o risco existe.
            Comece com volume baixo e, se possível, um proxy da sua região.
          </div>

          {identidade && (
            <button
              type="button"
              onClick={() => setModo("auto")}
              className="justify-self-start text-caption text-brand-500 underline-offset-4 hover:underline"
            >
              Voltar para a conexão automática pela extensão
            </button>
          )}

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label className="text-caption">Nome (rótulo)</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`${m.label} comercial`} />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-caption">Cookie de sessão ({m.cookie})</Label>
              <Input type="password" value={cookie} onChange={(e) => setCookie(e.target.value)} autoComplete="off" placeholder={`valor do cookie ${m.cookie}`} />
              <p className="text-caption text-muted-foreground">{m.help}</p>
            </div>

            <details className="group rounded-md border bg-muted/40 p-3">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-caption font-medium">
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                Proxy (opcional): sair pelo IP da sua região
              </summary>
              <div className="mt-2 grid gap-2">
                <Input value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="http://ip:porta  (ou socks5://ip:porta)" />
                <div className="grid grid-cols-2 gap-2">
                  <Input value={proxyUser} onChange={(e) => setProxyUser(e.target.value)} placeholder="usuário (se houver)" />
                  <Input type="password" value={proxyPass} onChange={(e) => setProxyPass(e.target.value)} placeholder="senha (se houver)" />
                </div>
                <p className="text-caption text-muted-foreground">
                  Deixe em branco para sair pelo IP do servidor.
                </p>
              </div>
            </details>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={conectarManual} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Conectar e verificar
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
