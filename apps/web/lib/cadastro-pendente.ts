import { cookies } from "next/headers";
import { z } from "zod";

/**
 * Cookie do cadastro com e-mail e senha esperando a confirmação (tela
 * /confirmar-email). Guarda o id do pedido (para o "Reenviar o link") e o
 * e-mail digitado (para a tela mostrar para onde o link foi — e a pessoa
 * perceber um erro de digitação).
 *
 * É gravado IGUAL exista ou não conta com o e-mail (o core devolve um id em
 * todos os casos): a tela nunca revela se o e-mail já tem conta. O id é
 * aleatório e só serve para pedir outro link para o MESMO e-mail do pedido.
 */
// `__Host-` em produção, como o cookie de "Registrar com Google": só HTTPS, só este host, path /.
export const COOKIE_CADASTRO = process.env.NODE_ENV === "production" ? "__Host-crmagro_cadastro" : "crmagro_cadastro";

const cadastroSchema = z.object({ id: z.string().uuid(), email: z.string().email().max(254) });
export type CadastroNoCookie = z.infer<typeof cadastroSchema>;

/** 24 h: a vida máxima de um pedido (depois não dá mais para reenviar). */
const MAX_AGE_S = 24 * 60 * 60;

/** Lê e valida; qualquer coisa estranha = sem cadastro esperando. */
export async function lerCadastroPendente(): Promise<CadastroNoCookie | null> {
  const valor = (await cookies()).get(COOKIE_CADASTRO)?.value;
  if (!valor) return null;
  try {
    const r = cadastroSchema.safeParse(JSON.parse(valor));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Grava (server action). */
export async function guardarCadastroPendente(c: CadastroNoCookie): Promise<void> {
  (await cookies()).set(COOKIE_CADASTRO, JSON.stringify(c), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

/** Apaga com os MESMOS atributos (senão o navegador ignora para cookie `__Host-`). */
export async function esquecerCadastroPendente(): Promise<void> {
  (await cookies()).set(COOKIE_CADASTRO, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
