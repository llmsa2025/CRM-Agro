"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { env } from "@crmagro/config";
import { cadastroEmpresaAberto, dadosEmpresaSchema, iniciarCadastroComSenha, type CampoDoCadastro } from "@crmagro/core";
import { signIn } from "@/auth";
import { ipDaRequisicao } from "@/lib/auth-guard";
import { guardarCadastroPendente } from "@/lib/cadastro-pendente";
import { COOKIE_NOVA_EMPRESA } from "@/lib/nova-empresa";

/**
 * Ações de /criar-empresa (tela PÚBLICA, sem sessão — não usa `acaoDaTela`).
 * O POST passa antes pelo limite por IP das telas de conta (middleware); o
 * core ainda limita por IP e por e-mail no Redis.
 *
 * Um formulário, duas opções (`via`: a tela abre uma de cada vez e tem um só
 * botão de enviar, que carrega a opção):
 * - `google`: guarda os dados da empresa num cookie de 10 min e segue para o
 *   Google; o `auth.ts` lê o cookie e cria o time com o e-mail comprovado.
 * - `senha`: `iniciarCadastroComSenha` — NADA nasce ainda: o link de
 *   confirmação vai por e-mail e a conta só existe depois dele
 *   (/confirmar-email). A resposta é a mesma com ou sem conta no e-mail.
 */

/**
 * O que volta para o formulário: a mensagem, o campo, o que foi digitado (menos
 * as senhas) e a opção escolhida (`via`) — para a tela seguir aberta na mesma
 * opção depois de um erro.
 */
export type EstadoDoCadastro = {
  erro?: string;
  campo?: CampoDoCadastro;
  valores: Partial<Record<"empresa" | "cidade" | "estado" | "cnpj" | "nome" | "email", string>>;
  via?: "google" | "senha";
};

const texto = (formData: FormData, nome: string) => String(formData.get(nome) ?? "");

export async function criarEmpresaAction(_anterior: EstadoDoCadastro, formData: FormData): Promise<EstadoDoCadastro> {
  const valores = {
    empresa: texto(formData, "empresa"),
    cidade: texto(formData, "cidade"),
    estado: texto(formData, "estado"),
    cnpj: texto(formData, "cnpj"),
    nome: texto(formData, "nome"),
    email: texto(formData, "email"),
  };
  const empresa = { nome: valores.empresa, cidade: valores.cidade, estado: valores.estado, cnpj: valores.cnpj };
  // A opção que a pessoa escolheu na tela: volta em TODA resposta (inclusive nos
  // erros) para o formulário continuar aberto nela.
  const via = texto(formData, "via") === "google" ? "google" : "senha";

  if (!cadastroEmpresaAberto()) {
    return { erro: "O cadastro de empresas está fechado no momento. Fale com o suporte.", valores, via };
  }

  if (via === "google") {
    if (!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)) return { erro: "\"Registrar com Google\" não está disponível agora.", valores, via };
    const dados = dadosEmpresaSchema.safeParse(empresa);
    if (!dados.success) {
      const campo = dados.error.issues[0]?.path[0];
      return {
        erro: "Confira os dados da empresa: nome (ao menos 2 letras), CNPJ com 14 dígitos (ou em branco) e UF com 2 letras.",
        campo: campo === "cnpj" || campo === "estado" || campo === "cidade" ? campo : "empresa",
        valores,
        via,
      };
    }
    // O Google volta pelo /api/auth/callback: o auth.ts lê isto para criar o
    // time com o nome da empresa (e só então aceita um e-mail sem convite).
    (await cookies()).set(COOKIE_NOVA_EMPRESA, JSON.stringify(dados.data), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    await signIn("google", { redirectTo: "/" });
    return { valores, via };
  }

  const r = await iniciarCadastroComSenha(
    { empresa, nome: valores.nome, email: valores.email, senha: texto(formData, "senha"), confirmar: texto(formData, "confirmar") },
    { ip: await ipDaRequisicao(), hashSenha: (s) => bcrypt.hash(s, 10) },
  );
  if (!r.ok) return { erro: r.mensagem, campo: r.campo, valores, via };
  await guardarCadastroPendente({ id: r.handle, email: r.email });
  redirect("/confirmar-email");
}
