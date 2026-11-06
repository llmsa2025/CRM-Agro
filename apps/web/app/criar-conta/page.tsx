import Link from "next/link";
import { TriangleAlert, Mail } from "lucide-react";
import bcrypt from "bcryptjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "@/components/auth-shell";
import { verifyInvite, acceptInvite } from "@crmagro/core";
import { signIn } from "@/auth";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { AuthError } from "next-auth";

/**
 * Criar conta — SOMENTE POR CONVITE (não self-service).
 *
 * - Sem `?token=` válido: a tela orienta a pedir acesso (e oferece o Google, que
 *   é a porta self-service que cria um time novo).
 * - Com convite válido: define nome + senha, aceita o convite (entra no time que
 *   convidou) e já autentica. O HASH da senha é calculado aqui (bcrypt no web).
 */
export default async function CriarContaPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const params = await searchParams;
  const token = params.token ?? "";
  const error = params.error;

  const invite = token ? await verifyInvite(token) : { valid: false as const };

  async function submit(formData: FormData) {
    "use server";
    const tk = String(formData.get("token") ?? "");
    const name = String(formData.get("name") ?? "").trim();
    const senha = String(formData.get("senha") ?? "");
    const confirmar = String(formData.get("confirmar") ?? "");

    if (senha.length < 8) {
      return redirect(`/criar-conta?token=${encodeURIComponent(tk)}&error=short`);
    }
    if (senha !== confirmar) {
      return redirect(`/criar-conta?token=${encodeURIComponent(tk)}&error=mismatch`);
    }

    let email: string;
    try {
      const hash = await bcrypt.hash(senha, 10);
      const res = await acceptInvite(tk, { name, passwordHash: hash });
      if (!res.ok) {
        const reason = res.reason === "email_in_other_team" ? "other_team" : "invalid";
        return redirect(`/criar-conta?token=${encodeURIComponent(tk)}&error=${reason}`);
      }
      email = res.email;
    } catch (e) {
      if (isRedirectError(e)) throw e;
      return redirect(`/criar-conta?token=${encodeURIComponent(tk)}&error=unknown`);
    }

    // Conta criada → autentica direto (melhor UX que mandar de volta ao login).
    try {
      await signIn("credentials", { email, senha, redirectTo: "/" });
    } catch (e) {
      if (isRedirectError(e)) throw e;
      if (e instanceof AuthError) return redirect("/login?created=1");
      return redirect("/login?created=1");
    }
  }

  // Sem convite válido: orienta a pedir acesso.
  if (!invite.valid) {
    const invalidToken = Boolean(token);
    return (
      <AuthShell
        title="Criar conta"
        subtitle={
          invalidToken
            ? "Este convite é inválido ou expirou."
            : "O acesso ao CRM Agro é por convite."
        }
        footer={
          <>
            Já tem uma conta?{" "}
            <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
              Entrar
            </Link>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border bg-card p-5 shadow-sm">
            <Mail className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <p className="text-body text-muted-foreground">
              {invalidToken
                ? "Peça um novo convite ao administrador do seu time."
                : "Peça um convite ao administrador do seu time para criar uma conta com e-mail e senha."}
            </p>
          </div>

          {/* Empresa nova: a porta explícita é /criar-empresa (o Google sozinho,
              com o cadastro fechado, recusa e-mail sem convite). */}
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-caption text-muted-foreground">ou comece a sua empresa</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button asChild variant="outline" className="w-full">
            <Link href="/criar-empresa">Criar a conta da minha empresa</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  const msg =
    error === "short"
      ? "A senha precisa ter ao menos 8 caracteres."
      : error === "mismatch"
        ? "As senhas não coincidem."
        : error === "other_team"
          ? "Este e-mail já pertence a outro time. Fale com o suporte."
          : error === "invalid"
            ? "Convite inválido ou expirado."
            : error
              ? "Não foi possível criar a conta. Tente novamente."
              : null;

  return (
    <AuthShell
      title="Criar sua conta"
      subtitle={`Convite para ${invite.email}${invite.teamName ? ` (time ${invite.teamName})` : ""}.`}
    >
      <form action={submit} className="space-y-4">
        <input type="hidden" name="token" value={token} />

        <div className="space-y-1">
          <Label htmlFor="name">Seu nome</Label>
          <Input id="name" name="name" type="text" autoComplete="name" required autoFocus placeholder="Nome e sobrenome" />
        </div>

        <div className="space-y-1">
          <Label htmlFor="senha">Senha</Label>
          <Input
            id="senha"
            name="senha"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            placeholder="Ao menos 8 caracteres"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="confirmar">Confirmar senha</Label>
          <Input id="confirmar" name="confirmar" type="password" autoComplete="new-password" required minLength={8} />
        </div>

        {msg && (
          <p role="alert" className="flex items-center gap-2 text-caption text-danger-700">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            {msg}
          </p>
        )}

        <Button type="submit" className="w-full">
          Criar conta e entrar
        </Button>
      </form>
    </AuthShell>
  );
}
