import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import bcrypt from "bcryptjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "@/components/auth-shell";
import { verifyPasswordResetToken, consumePasswordReset } from "@crmagro/core";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";

/**
 * Redefinir senha a partir do link de e-mail (?token=...).
 *
 * Fluxo: valida o token no carregamento (verifyPasswordResetToken) e, no submit,
 * confere a confirmação, calcula o HASH (bcrypt mora no app web) e chama
 * consumePasswordReset (consumo único). O texto puro do token nunca é persistido.
 */
export default async function RedefinirSenhaPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const params = await searchParams;
  const token = params.token ?? "";
  const error = params.error;

  const check = await verifyPasswordResetToken(token);

  async function submit(formData: FormData) {
    "use server";
    const tk = String(formData.get("token") ?? "");
    const senha = String(formData.get("senha") ?? "");
    const confirmar = String(formData.get("confirmar") ?? "");

    if (senha.length < 8) {
      return redirect(`/redefinir-senha?token=${encodeURIComponent(tk)}&error=short`);
    }
    if (senha !== confirmar) {
      return redirect(`/redefinir-senha?token=${encodeURIComponent(tk)}&error=mismatch`);
    }

    try {
      const hash = await bcrypt.hash(senha, 10);
      const ok = await consumePasswordReset(tk, hash);
      if (!ok) {
        return redirect(`/redefinir-senha?token=${encodeURIComponent(tk)}&error=invalid`);
      }
    } catch (e) {
      if (isRedirectError(e)) throw e;
      return redirect(`/redefinir-senha?token=${encodeURIComponent(tk)}&error=unknown`);
    }
    redirect("/login?reset=1");
  }

  if (!check.valid) {
    return (
      <AuthShell
        title="Link inválido ou expirado"
        subtitle="Este link de redefinição não é mais válido. Solicite um novo."
        footer={
          <>
            <Link href="/esqueci-senha" className="text-foreground underline-offset-4 hover:underline">
              Pedir um novo link
            </Link>
          </>
        }
      >
        <div className="flex items-start gap-3 rounded-lg border bg-card p-5 shadow-sm">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger-700" />
          <p className="text-body text-muted-foreground">
            Links de redefinição expiram em 45 minutos e só podem ser usados uma vez.
          </p>
        </div>
      </AuthShell>
    );
  }

  const msg =
    error === "short"
      ? "A senha precisa ter ao menos 8 caracteres."
      : error === "mismatch"
        ? "As senhas não coincidem."
        : error === "invalid"
          ? "Link inválido ou expirado. Solicite um novo."
          : error
            ? "Não foi possível redefinir a senha. Tente novamente."
            : null;

  return (
    <AuthShell title="Criar nova senha" subtitle="Escolha uma senha nova para a sua conta.">
      <form action={submit} className="space-y-4">
        <input type="hidden" name="token" value={token} />

        <div className="space-y-1">
          <Label htmlFor="senha">Nova senha</Label>
          <Input
            id="senha"
            name="senha"
            type="password"
            autoComplete="new-password"
            required
            autoFocus
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
          Salvar nova senha
        </Button>
      </form>
    </AuthShell>
  );
}
