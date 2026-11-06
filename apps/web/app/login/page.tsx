import Link from "next/link";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { cadastroEmpresaComSenhaAberto } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "@/components/auth-shell";
import { GoogleIcon } from "@/components/google-icon";
import { signIn } from "@/auth";
import { env } from "@crmagro/config";
import { AuthError } from "next-auth";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { redirect } from "next/navigation";

/**
 * Página de login (redesign, layout dividido via AuthShell).
 *
 * Mantém o form nativo (e-mail/senha) com server action + signIn() do NextAuth v5
 * (o CSRF é tratado internamente quando chamado de um server action). Acrescenta:
 * - "Entrar com Google" (só quando GOOGLE_CLIENT_ID/SECRET existem no env);
 * - link "Esqueci a senha";
 * - nota de que conta nova é por convite ou pela conta da empresa (/criar-empresa).
 *
 * Cadastro com senha ainda NÃO confirmado: o login responde o mesmo "e-mail ou
 * senha inválidos" de qualquer falha (uma resposta própria revelava quais
 * e-mails têm conta — revisão do #177). Com a opção de senha no ar, a
 * mensagem traz a dica de abrir o link e leva a /confirmar-email (lá o
 * "Reenviar o link" usa o cookie do cadastro, no mesmo navegador).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; erro?: string; confirmado?: string; reset?: string; created?: string }>;
}) {
  const params = await searchParams;
  // Avisos de sucesso vindos de outras telas de conta.
  const aviso =
    params.confirmado === "1"
      ? "E-mail confirmado e conta criada. Entre com o seu e-mail e senha."
      : params.reset === "1"
        ? "Senha redefinida. Entre com a senha nova."
        : params.created === "1"
          ? "Conta criada. Entre com o seu e-mail e senha."
          : null;
  const next = params.next ?? "/";
  // `error` vem do NextAuth (senha/OAuth); `erro` é nosso (Google sem conta nem convite).
  const error = params.error ?? params.erro;
  const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  // Estado GLOBAL (não diz nada sobre o e-mail digitado).
  const dicaDoCadastro = cadastroEmpresaComSenhaAberto();

  async function authenticate(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "");
    const senha = String(formData.get("senha") ?? "");

    if (!email || !senha) {
      return redirect("/login?error=MissingFields");
    }

    try {
      await signIn("credentials", { email, senha, redirectTo: next });
    } catch (e) {
      if (isRedirectError(e)) throw e;
      if (e instanceof AuthError) {
        // Códigos nossos do provider de senha: limite de tentativas e conta desativada.
        const code = (e as AuthError & { code?: string }).code;
        return redirect(`/login?error=${code === "desativado" || code === "rate_limited" ? code : "CredentialsSignin"}`);
      }
      return redirect("/login?error=Unknown");
    }
  }

  async function authenticateGoogle() {
    "use server";
    await signIn("google", { redirectTo: next });
  }

  return (
    <AuthShell
      title="Entrar"
      subtitle="Use a conta do seu time no CRM Agro."
      footer={
        <>
          <p className="font-semibold text-foreground">Não tem conta?</p>
          <p>
            Peça um convite ao administrador do seu time ou{" "}
            <Link href="/criar-empresa" className="text-foreground underline underline-offset-4">
              crie a conta da sua empresa
            </Link>
            .
          </p>
        </>
      }
    >
      <div className="space-y-4">
        {googleEnabled && (
          <>
            <form action={authenticateGoogle}>
              <Button type="submit" variant="outline" className="w-full">
                <GoogleIcon className="h-4 w-4" />
                Entrar com Google
              </Button>
            </form>

            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-caption text-muted-foreground">ou</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          </>
        )}

        <form action={authenticate} className="space-y-4">
          <input type="hidden" name="next" value={next} />

          {aviso && !error && (
            <p role="status" className="flex items-start gap-2 text-small text-ink-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
              {aviso}
            </p>
          )}

          <div className="space-y-1">
            <Label htmlFor="email">E-mail</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              placeholder="voce@empresa.com.br"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="senha">Senha</Label>
              <Link
                href="/esqueci-senha"
                className="text-small text-ink-2 underline-offset-4 hover:text-foreground hover:underline"
              >
                Esqueci a senha
              </Link>
            </div>
            <Input id="senha" name="senha" type="password" autoComplete="current-password" placeholder="Sua senha" required />
          </div>

          {error && (
            <div role="alert" className="space-y-1">
              <p className="flex items-center gap-2 text-small text-danger-500">
                <TriangleAlert className="h-4 w-4 shrink-0" />
                {error === "MissingFields"
                  ? "Preencha e-mail e senha."
                  : error === "desativado"
                    ? "Sua conta foi desativada pela equipe. Fale com o administrador da sua empresa."
                    : error === "rate_limited"
                      ? "Muitas tentativas. Aguarde alguns minutos e tente de novo."
                  : error === "sem-convite"
                    ? "Este e-mail ainda não tem conta nem convite. Peça um convite ao administrador do seu time ou crie a conta da sua empresa (link abaixo)."
                  : error === "ja-tem-conta"
                    ? "Este e-mail já tem uma conta no CRM Agro. Entre com ela ou use “Esqueci a senha”."
                    : error === "AccessDenied" || error === "Configuration" || error === "OAuthCallbackError" || error === "OAuthSignin"
                      ? "Não deu para entrar com o Google. Tente de novo ou use e-mail e senha."
                      : "E-mail ou senha inválidos."}
              </p>
              {dicaDoCadastro && error === "CredentialsSignin" && (
                <p className="pl-6 text-small text-ink-2">
                  Criou a conta agora com e-mail e senha? Ela só é ativada pelo link que enviamos (confira o spam).{" "}
                  <Link href="/confirmar-email?motivo=login" className="text-foreground underline underline-offset-4">
                    Ver como confirmar
                  </Link>
                </p>
              )}
            </div>
          )}

          <Button type="submit" className="w-full">
            Entrar
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}
