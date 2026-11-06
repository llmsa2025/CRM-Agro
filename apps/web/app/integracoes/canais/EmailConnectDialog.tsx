"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Mail, Pencil, Loader2, CheckCircle2, XCircle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { connectEmailAction, getEmailAccountConfigAction, testEmailAction } from "../email/actions";
import { HREF_CONECTAR_GMAIL, opcoesDeConexaoDeEmail, type EstadoDoEnvioPeloGmail, type OpcaoDeConexaoDeEmail } from "./gmail";

type TestState = { smtp: { ok: boolean; error?: string }; imap?: { ok: boolean; error?: string } };

type Form = {
  label: string; host: string; port: string; secure: boolean;
  user: string; pass: string; from: string;
  imapHost: string; imapPort: string; imapSecure: boolean;
  signature: string;
};

const EMPTY: Form = {
  label: "", host: "", port: "587", secure: false, user: "", pass: "", from: "",
  imapHost: "", imapPort: "993", imapSecure: true, signature: "",
};

/** Preenche os servidores do Gmail (SMTP SSL 465 + IMAP SSL 993). */
const GMAIL: Partial<Form> = {
  host: "smtp.gmail.com", port: "465", secure: true,
  imapHost: "imap.gmail.com", imapPort: "993", imapSecure: true,
};

/** Linha de resultado de teste (SMTP ou IMAP): ícone + rótulo + motivo da falha. */
function TestLine({ label, r }: { label: string; r: { ok: boolean; error?: string } }) {
  return (
    <div className="flex items-start gap-2">
      {r.ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      )}
      <div className="min-w-0">
        <span className="font-medium">{label}: </span>
        <span className={r.ok ? "text-success-700" : "text-destructive"}>
          {r.ok ? "OK" : (r.error ?? "falhou")}
        </span>
      </div>
    </div>
  );
}

/** Dialog com o formulário de e-mail (SMTP + IMAP). Serve para criar e editar. */
function EmailFormDialog({
  open, onOpenChange, initial, editId, hasPass,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: Form;
  editId?: string;
  hasPass?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestState | null>(null);
  const [f, setF] = useState<Form>(initial);
  const set = (k: keyof Form) => (v: string | boolean) => {
    setTest(null); // qualquer mudança invalida o último teste
    setF((s) => {
      const next = { ...s, [k]: v };
      // Evita a pegadinha porta × SSL: 465 = SSL direto; 587/outras = STARTTLS.
      if (k === "port") next.secure = String(v).trim() === "465";
      return next;
    });
  };
  const editing = Boolean(editId);

  function preencherGmail() {
    setTest(null);
    setF((s) => ({ ...s, ...GMAIL }));
  }

  function payload() {
    return {
      ...(editId ? { id: editId } : {}),
      label: f.label.trim() || f.user.trim(),
      host: f.host.trim(),
      port: Number(f.port) || 587,
      secure: f.secure,
      user: f.user.trim(),
      pass: f.pass, // vazio na edição = mantém a atual
      from: f.from.trim() || undefined,
      imapHost: f.imapHost.trim() || undefined,
      imapPort: Number(f.imapPort) || 993,
      imapSecure: f.imapSecure,
      signature: f.signature,
    };
  }

  async function testar() {
    if (!f.host.trim() || !f.user.trim()) {
      toast.error("Preencha host e usuário");
      return;
    }
    setTesting(true);
    setTest(null);
    const res = await testEmailAction(payload());
    setTesting(false);
    if (res.error || !res.result) {
      toast.error("Não consegui testar", { description: res.error });
      return;
    }
    setTest(res.result);
  }

  function salvar() {
    if (!f.host.trim() || !f.user.trim() || (!editing && !f.pass)) {
      toast.error("Preencha host, usuário e senha");
      return;
    }
    start(async () => {
      const res = await connectEmailAction(payload());
      if (res.ok) {
        if (res.connected) {
          toast.success(editing ? "Conta atualizada" : "E-mail conectado");
          onOpenChange(false);
          router.refresh();
        } else {
          // Salvou mas o SMTP recusou — mostra o motivo dentro do pop-up.
          setTest({ smtp: { ok: false, error: res.error } });
          toast.warning("Salvo, mas a verificação falhou");
        }
      } else toast.error("Falha ao salvar", { description: res.error });
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar caixa de e-mail (nome e configuração)" : "Conectar por IMAP e SMTP"}</DialogTitle>
        </DialogHeader>

        <div className="rounded-md border bg-muted/40 p-3">
          <div className="flex items-start justify-between gap-3">
            <details className="group min-w-0 flex-1">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-caption font-medium">
                <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
                Usa Gmail? Veja como conectar (senha de app)
              </summary>
              <ol className="mt-2 space-y-1 text-caption text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">1.</span> Ative a{" "}
              <a
                href="https://myaccount.google.com/signinoptions/twosv"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                verificação em 2 etapas
              </a>{" "}
              (obrigatório antes do passo 2).
            </li>
            <li>
              <span className="font-medium text-foreground">2.</span> Gere a{" "}
              <a
                href="https://myaccount.google.com/apppasswords"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                senha de app
              </a>{" "}
              (16 letras). Dê um nome como “CRM Agro”.
            </li>
            <li>
              <span className="font-medium text-foreground">3.</span> Clique em{" "}
              <span className="font-medium text-foreground">Preencher Gmail</span>, cole a senha de app no
              campo Senha e clique em Testar conexão.
            </li>
          </ol>
              <p className="mt-1.5 text-caption text-muted-foreground/80">
                Mais detalhes no{" "}
                <a
                  href="https://support.google.com/mail/answer/7104828?hl=pt-BR"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  manual do Gmail
                </a>
                .
              </p>
            </details>
            <Button variant="outline" size="sm" onClick={preencherGmail} className="shrink-0">
              Preencher Gmail
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2">
            <Label className="text-caption">Nome (rótulo)</Label>
            <Input value={f.label} onChange={(e) => set("label")(e.target.value)} placeholder="E-mail comercial" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-caption">Servidor SMTP (host)</Label>
            <Input value={f.host} onChange={(e) => set("host")(e.target.value)} placeholder="smtp.gmail.com" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-caption">Porta SMTP</Label>
            <Input value={f.port} onChange={(e) => set("port")(e.target.value)} placeholder="465" inputMode="numeric" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-caption">Usuário (e-mail completo)</Label>
            <Input value={f.user} onChange={(e) => set("user")(e.target.value)} placeholder="voce@gmail.com" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-caption">{editing ? "Senha (em branco = manter)" : "Senha (senha de app)"}</Label>
            <Input
              type="password"
              value={f.pass}
              onChange={(e) => set("pass")(e.target.value)}
              autoComplete="off"
              placeholder={editing && hasPass ? "•••••••• (mantém a atual)" : "senha de app do Gmail"}
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label className="text-caption">Remetente “De” (opcional)</Label>
            <Input value={f.from} onChange={(e) => set("from")(e.target.value)} placeholder="Seu Nome <voce@gmail.com>" />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Checkbox checked={f.secure} onCheckedChange={(v) => set("secure")(v === true)} />
            SMTP com TLS direto (porta 465). Desmarcado = STARTTLS (587).
          </label>

          <div className="sm:col-span-2 mt-1 border-t pt-3">
            <p className="text-caption font-medium text-muted-foreground">
              Recebimento (IMAP): opcional, para receber as respostas
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-caption">Servidor IMAP (host)</Label>
            <Input value={f.imapHost} onChange={(e) => set("imapHost")(e.target.value)} placeholder="imap.gmail.com" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-caption">Porta IMAP</Label>
            <Input value={f.imapPort} onChange={(e) => set("imapPort")(e.target.value)} placeholder="993" inputMode="numeric" />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Checkbox checked={f.imapSecure} onCheckedChange={(v) => set("imapSecure")(v === true)} />
            IMAP com TLS (993). Usuário/senha do IMAP = os mesmos do SMTP.
          </label>
        </div>

        {test ? (
          <div className="space-y-1.5 rounded-md border p-3 text-sm">
            <TestLine label="SMTP (envio)" r={test.smtp} />
            {test.imap ? (
              <TestLine label="IMAP (recebimento)" r={test.imap} />
            ) : (
              <p className="text-caption text-muted-foreground">
                IMAP não informado: a conta só envia e não recebe respostas.
              </p>
            )}
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={testar} disabled={testing || pending}>
            {testing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Testar conexão
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>Cancelar</Button>
            <Button onClick={salvar} disabled={pending || testing}>
              {pending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {editing ? "Salvar" : "Conectar"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Uma linha do pop-up "Conectar e-mail": a forma de conectar, o que ela é e, se não der, por quê. */
function OpcaoDeConexao({ opcao, acao }: { opcao: OpcaoDeConexaoDeEmail; acao: { href: string } | { onClick: () => void } }) {
  const base = "flex w-full items-start justify-between gap-3 px-4 py-3 text-left";
  const texto = (
    <span className="min-w-0">
      <span className={cn("block text-body font-medium", !opcao.habilitada && "text-ink-2")}>{opcao.titulo}</span>
      <span className="mt-0.5 block text-small text-ink-2">{opcao.descricao}</span>
      {opcao.aviso ? <span className="mt-1.5 block text-small text-ink-3">{opcao.aviso}</span> : null}
      {opcao.avisoLink ? (
        <Link href={opcao.avisoLink.href} className="mt-1 inline-block text-small underline underline-offset-2 hover:text-foreground">
          {opcao.avisoLink.texto}
        </Link>
      ) : null}
    </span>
  );

  // Sem como escolher agora: a linha fica à vista, sem clique, com o motivo escrito.
  if (!opcao.habilitada) {
    return (
      <div className={base} aria-disabled="true">
        {texto}
      </div>
    );
  }
  const clicavel = cn(base, "transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/30");
  const seta = <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-3" aria-hidden />;
  return "href" in acao ? (
    // Navegação inteira (`<a>`, sem prefetch): a rota `conectar` põe o cookie e manda para o Google.
    <a href={acao.href} className={clicavel}>
      {texto}
      {seta}
    </a>
  ) : (
    <button type="button" onClick={acao.onClick} className={clicavel}>
      {texto}
      {seta}
    </button>
  );
}

/**
 * "Conectar e-mail" em Canais: abre o pop-up com as duas formas, sem senha (Gmail) e IMAP e SMTP
 * (senha de app). Cada endereço usa só uma (`opcoesDeConexaoDeEmail` diz o que está bloqueado).
 */
export function NewEmailConnection({
  envioGmail,
  enderecoGoogle,
  senhaNoEnderecoDoGoogle,
}: {
  envioGmail: EstadoDoEnvioPeloGmail;
  enderecoGoogle: string | null;
  senhaNoEnderecoDoGoogle: boolean;
}) {
  const [aberto, setAberto] = useState<"escolha" | "imap" | null>(null);
  const opcoes = opcoesDeConexaoDeEmail({ envioGmail, enderecoGoogle, senhaNoEnderecoDoGoogle });
  return (
    <div className="mt-4">
      <Button variant="outline" size="sm" onClick={() => setAberto("escolha")}>
        <Mail className="mr-1.5 h-4 w-4" /> Conectar e-mail
      </Button>
      <Dialog open={aberto === "escolha"} onOpenChange={(v) => setAberto(v ? "escolha" : null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Conectar e-mail</DialogTitle>
            <DialogDescription>Escolha uma forma. Cada endereço usa só uma delas.</DialogDescription>
          </DialogHeader>
          <div className="divide-y divide-line rounded-md border border-line-strong">
            <OpcaoDeConexao opcao={opcoes.semSenha} acao={{ href: HREF_CONECTAR_GMAIL }} />
            <OpcaoDeConexao opcao={opcoes.imap} acao={{ onClick: () => setAberto("imap") }} />
          </div>
        </DialogContent>
      </Dialog>
      {aberto === "imap" ? <EmailFormDialog open onOpenChange={(v) => setAberto(v ? "imap" : null)} initial={EMPTY} /> : null}
    </div>
  );
}

/**
 * O lápis da caixa de e-mail já conectada: um diálogo só com o NOME e a
 * configuração (SMTP/IMAP) — antes a linha tinha dois lápis (este e o das
 * assinaturas). Carrega a config sem a senha.
 */
export function EditEmailConnection({ accountId, label }: { accountId: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [initial, setInitial] = useState<Form | null>(null);
  const [hasPass, setHasPass] = useState(false);

  async function abrir() {
    setLoading(true);
    const res = await getEmailAccountConfigAction(accountId);
    setLoading(false);
    if (res.error || !res.config) {
      toast.error("Não consegui carregar a conta", { description: res.error });
      return;
    }
    const c = res.config;
    setInitial({
      label: c.label, host: c.host, port: String(c.port), secure: c.secure,
      user: c.user, pass: "", from: c.from,
      imapHost: c.imapHost, imapPort: String(c.imapPort), imapSecure: c.imapSecure, signature: c.signature,
    });
    setHasPass(c.hasPass);
    setOpen(true);
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={abrir}
        disabled={loading}
        aria-label={label ? `Editar nome e configuração de ${label}` : "Editar nome e configuração"}
        title="Editar nome e configuração"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
      </Button>
      {open && initial ? (
        <EmailFormDialog open={open} onOpenChange={setOpen} initial={initial} editId={accountId} hasPass={hasPass} />
      ) : null}
    </>
  );
}
