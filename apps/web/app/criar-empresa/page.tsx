import Link from "next/link";
import { env } from "@crmagro/config";
import { cadastroComSenhaDisponivel, cadastroEmpresaAberto } from "@crmagro/core";
import { AuthShell } from "@/components/auth-shell";
import { CriarEmpresaForm } from "./form";

/**
 * "Criar a conta da minha empresa" (plano-equipe-permissoes F1) — a porta
 * explícita de cadastro. Nasce o time com o nome da empresa, quem cria vira o
 * master (dono) e o time já vem com o funil "Vendas" e a meta do mês.
 *
 * A tela começa com dois botões iguais e, ao escolher um, abrem só os campos
 * daquela opção (com o Google, só os da empresa). As duas opções têm o e-mail
 * COMPROVADO antes de a conta existir:
 * - "Registrar com Google": o Google prova o e-mail na hora.
 * - "Registrar com e-mail": a conta só nasce depois do link de confirmação
 *   enviado pelo remetente da plataforma (/confirmar-email). Só aparece com o
 *   remetente configurado e com cota de e-mail de cadastro no dia
 *   (`cadastroComSenhaDisponivel`): sem isso não há como provar o e-mail, e a
 *   opção some (fail-safe).
 * Com uma opção só disponível, a tela já abre nela (sem a escolha).
 *
 * As ações ficam em `actions.ts`; o formulário é cliente (`form.tsx`) para um
 * erro não apagar o que foi digitado nem fechar a opção escolhida. O POST passa
 * pelo limite por IP das telas de conta (middleware).
 */
export const dynamic = "force-dynamic";

const ERROS: Record<string, string> = {
  fechado: "O cadastro de empresas está fechado no momento. Fale com o suporte.",
  dados: "Confira os dados da empresa: nome, CNPJ (14 dígitos) e UF (2 letras).",
};

export default async function CriarEmpresaPage({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  const { erro } = await searchParams;
  const google = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const comSenha = await cadastroComSenhaDisponivel();
  const aberto = cadastroEmpresaAberto() && (google || comSenha);

  return (
    <AuthShell
      title="Criar a conta da sua empresa"
      subtitle="Você será o master: vê tudo e convida a sua equipe depois."
      footer={
        <>
          Já tem uma conta?{" "}
          <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
            Entrar
          </Link>
        </>
      }
    >
      {!aberto ? (
        <p className="text-body text-ink-2">{ERROS.fechado}</p>
      ) : (
        <CriarEmpresaForm google={google} comSenha={comSenha} erroInicial={erro ? (ERROS[erro] ?? null) : null} />
      )}
    </AuthShell>
  );
}
