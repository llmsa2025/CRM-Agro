import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "@/components/auth-shell";
import { requestPasswordReset } from "@crmagro/core";
import { redirect } from "next/navigation";
import { ipDaRequisicao } from "@/lib/auth-guard";

/**
 * "Esqueci a senha" — pede o e-mail e dispara o link de reset (remetente da
 * plataforma; sem ele, a caixa do time — packages/core/src/auth/password-reset.ts).
 *
 * Anti-enumeração: a resposta é SEMPRE a mesma tela de sucesso genérica, exista
 * ou não o e-mail. O serviço (packages/core/src/auth/password-reset.ts) faz o
 * rate-limit e o envio; aqui só coletamos o e-mail e mostramos a confirmação.
 */
export default async function EsqueciSenhaPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const params = await searchParams;
  const sent = params.sent === "1";

  async function submit(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "");
    try {
      // Com o IP (X-Forwarded-For do Caddy): limite por IP no Redis, além do
      // limite por e-mail e do limite na borda (middleware). Volta NA HORA: a
      // busca e o envio rodam em segundo plano, então o tempo de resposta não
      // denuncia se a conta existe.
      await requestPasswordReset(email, { ip: await ipDaRequisicao() });
    } catch {
      // Falha de infra não deve revelar nada nem travar o usuário: seguimos para
      // a mesma tela genérica de sucesso.
    }
    redirect("/esqueci-senha?sent=1");
  }

  if (sent) {
    return (
      <AuthShell
        title="Verifique o seu e-mail"
        subtitle="Se houver uma conta com esse e-mail, enviamos um link para redefinir a senha."
        footer={
          <>
            <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
              Voltar ao login
            </Link>
          </>
        }
      >
        <div className="flex items-start gap-3 rounded-lg border bg-card p-5 shadow-sm">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success-700" />
          <p className="text-body text-muted-foreground">
            O link expira em 45 minutos. Não recebeu? Confira a caixa de spam ou
            tente novamente em alguns minutos.
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Redefinir senha"
      subtitle="Informe o e-mail da sua conta e enviaremos um link para criar uma nova senha."
      footer={
        <>
          Lembrou a senha?{" "}
          <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
            Voltar ao login
          </Link>
        </>
      }
    >
      <form action={submit} className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="email">E-mail</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            placeholder="voce@empresa.com"
          />
        </div>
        <Button type="submit" className="w-full">
          Enviar link de redefinição
        </Button>
      </form>
    </AuthShell>
  );
}
