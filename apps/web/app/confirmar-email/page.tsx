import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import bcrypt from "bcryptjs";
import { MailCheck, TriangleAlert } from "lucide-react";
import { confirmarCadastro, reenviarConfirmacao, verificarLinkDeCadastro, CONFIRMACAO_TTL_MS } from "@crmagro/core";
import { signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "@/components/auth-shell";
import { ipDaRequisicao } from "@/lib/auth-guard";
import { esquecerCadastroPendente, lerCadastroPendente } from "@/lib/cadastro-pendente";

/**
 * Confirmação do e-mail do cadastro com e-mail e senha (tela PÚBLICA, sem
 * sessão — core/auth/cadastro-com-senha.ts).
 *
 * - Sem `token`: "Confira o seu e-mail" depois do cadastro (ou pela dica da
 *   tela de login, `motivo=login`), com "Reenviar o link". O e-mail mostrado e
 *   o id do pedido vêm do cookie, gravado igual com ou sem conta no e-mail — a
 *   tela não revela se o e-mail já tem conta, nem se o pedido ainda existe (o
 *   "reenviado" é neutro: "se o cadastro ainda estiver pendente…").
 * - Com `token` (o link do e-mail): pede a SENHA do cadastro. O token prova a
 *   caixa; a senha prova quem preencheu. Só os dois juntos criam a conta, e
 *   ela já entra logada. O GET não muda nada (o robô do provedor de e-mail
 *   que abre os links não confirma sozinho).
 *
 * O POST passa pelo limite por IP das telas de conta (middleware); o core
 * limita por IP e por pedido no Redis.
 */
export const dynamic = "force-dynamic";

const HORAS = Math.round(CONFIRMACAO_TTL_MS / 3_600_000);

const ERROS: Record<string, string> = {
  senha: "A senha não confere com a que você escolheu no cadastro.",
  limite: "Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.",
  fechado: "O cadastro de empresas está fechado no momento. Fale com o suporte.",
  erro: "Não foi possível confirmar agora. Tente de novo.",
};

function Aviso({ tipo, children }: { tipo: "erro" | "ok"; children: React.ReactNode }) {
  const Icone = tipo === "erro" ? TriangleAlert : MailCheck;
  return (
    <p role={tipo === "erro" ? "alert" : "status"} className={`flex items-start gap-2 text-small ${tipo === "erro" ? "text-danger-700" : "text-ink-2"}`}>
      <Icone className={`mt-0.5 h-4 w-4 shrink-0 ${tipo === "erro" ? "" : "text-brand-500"}`} />
      <span>{children}</span>
    </p>
  );
}

export default async function ConfirmarEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; erro?: string; motivo?: string; reenviado?: string }>;
}) {
  const params = await searchParams;
  const token = (params.token ?? "").trim();
  const pendente = await lerCadastroPendente();

  async function reenviar() {
    "use server";
    const c = await lerCadastroPendente();
    const r = await reenviarConfirmacao(c?.id, { ip: await ipDaRequisicao() });
    if (!r.ok) redirect(`/confirmar-email?erro=${r.motivo}`);
    redirect("/confirmar-email?reenviado=1");
  }

  async function confirmar(formData: FormData) {
    "use server";
    const tk = String(formData.get("token") ?? "");
    const senha = String(formData.get("senha") ?? "");
    const volta = (erro: string) => `/confirmar-email?token=${encodeURIComponent(tk)}&erro=${erro}`;
    let email: string;
    try {
      const r = await confirmarCadastro(tk, senha, { ip: await ipDaRequisicao(), compararSenha: (s, h) => bcrypt.compare(s, h) });
      if (!r.ok) {
        if (r.motivo === "ja_tem_conta") {
          // O pedido já morreu (a conta nasceu por outro caminho): o cookie não serve mais.
          await esquecerCadastroPendente();
          redirect("/login?erro=ja-tem-conta");
        }
        redirect(volta(r.motivo));
      }
      email = r.email;
    } catch (e) {
      if (isRedirectError(e)) throw e;
      redirect(volta("erro"));
    }
    await esquecerCadastroPendente();
    // Conta criada e e-mail comprovado → entra direto.
    try {
      await signIn("credentials", { email, senha, redirectTo: "/" });
    } catch (e) {
      if (isRedirectError(e)) throw e;
      if (e instanceof AuthError) redirect("/login?confirmado=1");
      redirect("/login?confirmado=1");
    }
  }

  // ─── Com o link do e-mail ───────────────────────────────────────────────────
  if (token) {
    const link = await verificarLinkDeCadastro(token);
    if (!link.valido) {
      return (
        <AuthShell
          title="Link inválido ou expirado"
          subtitle={`O link de confirmação vale por ${HORAS} horas e só pode ser usado uma vez.`}
          footer={
            <>
              Quer começar de novo?{" "}
              <Link href="/criar-empresa" className="text-foreground underline-offset-4 hover:underline">
                Criar a conta da empresa
              </Link>
            </>
          }
        >
          <div className="space-y-4">
            {/* Pode já ter sido usado (em outro aparelho, por exemplo): o caminho de entrar vem sempre. */}
            <p className="text-body text-ink-2">
              Já ativou a conta?{" "}
              <Link href="/login" className="text-foreground underline underline-offset-4">
                Entre com o seu e-mail e senha
              </Link>
              .
            </p>
            {pendente && (
              <form action={reenviar} className="space-y-3">
                <p className="text-small text-ink-2">
                  Ainda não ativou? Peça um link novo para <span className="font-medium text-foreground">{pendente.email}</span>.
                </p>
                <Button type="submit" variant="outline" className="w-full">
                  Reenviar o link
                </Button>
              </form>
            )}
          </div>
        </AuthShell>
      );
    }

    const msg = params.erro ? (ERROS[params.erro] ?? ERROS.erro) : null;
    return (
      <AuthShell title="Confirme o seu e-mail" subtitle="Digite a senha que você escolheu no cadastro para ativar a conta.">
        <form action={confirmar} className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <dl className="space-y-1 border-y border-line py-3 text-small">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-3">Empresa</dt>
              <dd className="truncate text-right text-foreground">{link.empresa}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-3">E-mail</dt>
              <dd className="truncate text-right text-foreground">{link.email}</dd>
            </div>
          </dl>
          {/* O gerenciador de senhas do navegador preenche pelo e-mail. */}
          <input type="email" name="email" value={link.email} autoComplete="username" readOnly hidden />
          <div className="space-y-1">
            <Label htmlFor="senha">Senha</Label>
            <Input id="senha" name="senha" type="password" autoComplete="current-password" required autoFocus />
          </div>
          {msg && <Aviso tipo="erro">{msg}</Aviso>}
          <Button type="submit" className="w-full">
            Confirmar e entrar
          </Button>
          <p className="text-caption text-ink-3">
            Não foi você que pediu esta conta? Não digite nada: sem a confirmação, ela não é criada.
          </p>
        </form>
      </AuthShell>
    );
  }

  // ─── Depois do cadastro (ou do login de um cadastro não confirmado) ──────────
  const doLogin = params.motivo === "login";
  const erro = params.erro === "limite" || params.erro === "fechado" ? params.erro : null;
  const mensagemErro =
    erro === "limite"
      ? "Você já pediu vários links. Confira a caixa de spam ou aguarde alguns minutos."
      : erro === "fechado"
        ? "O envio de e-mails está indisponível agora. Tente mais tarde ou use \"Registrar com Google\"."
        : null;

  return (
    <AuthShell
      title={doLogin ? "Confirme o seu e-mail" : "Confira o seu e-mail"}
      subtitle={
        doLogin
          ? "Quem cria a conta da empresa com e-mail e senha só entra depois de abrir o link que enviamos por e-mail."
          : "Enviamos um link para ativar a conta da sua empresa."
      }
      footer={
        <>
          {doLogin ? "O link venceu ou não chegou?" : "Errou o e-mail?"}{" "}
          <Link href="/criar-empresa" className="text-foreground underline-offset-4 hover:underline">
            Criar de novo
          </Link>
          {" · "}
          <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
            Entrar
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        {pendente && (
          <p className="text-body text-ink-2">
            O link foi para <span className="font-medium text-foreground">{pendente.email}</span>. Ele vale por {HORAS} horas e pede a senha
            que você escolheu.
          </p>
        )}
        {!pendente && <p className="text-body text-ink-2">Abra o e-mail que enviamos e siga o link. Ele vale por {HORAS} horas.</p>}
        <p className="text-small text-ink-3">Não chegou em alguns minutos? Confira a caixa de spam ou de promoções.</p>

        {/* Neutro: a tela não sabe (nem diz) se o pedido ainda existe — o e-mail pode já ter conta. */}
        {params.reenviado === "1" && (
          <Aviso tipo="ok">Se o cadastro ainda estiver pendente, enviamos um novo link{pendente ? ` para ${pendente.email}` : ""}. Use sempre o mais recente.</Aviso>
        )}
        {mensagemErro && <Aviso tipo="erro">{mensagemErro}</Aviso>}

        {pendente && (
          <form action={reenviar}>
            <Button type="submit" variant="outline" className="w-full">
              Reenviar o link
            </Button>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
