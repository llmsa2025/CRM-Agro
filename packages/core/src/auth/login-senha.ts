import type { User } from "@prisma/client";
import { basePrisma } from "@crmagro/db";

/**
 * Conferir e-mail e senha no login (provider Credentials do `apps/web/auth.ts`).
 *
 * Regra: o login responde IGUAL — mesma resposta e mesmo trabalho (UMA
 * comparação bcrypt) — com conta, sem conta, com conta sem senha (só Google) e
 * com um pedido de cadastro não confirmado no e-mail. Não olha a tabela
 * `CadastroPendente`: se olhasse, "a senha do MEU pedido + o e-mail alvo" dava
 * "confirme o seu e-mail" sem conta e "senha inválida" com conta — um oráculo
 * de quais e-mails têm conta, sem adivinhar nada (revisão do #177). Quem ainda
 * não confirmou vê "e-mail ou senha inválidos" com a dica de abrir o link.
 *
 * O bcrypt mora no web: `compararSenha` é injetado.
 */

export type CompararSenha = (senha: string, hash: string) => Promise<boolean>;

/**
 * Hash bcrypt VÁLIDO (60 caracteres, custo 10) de um texto aleatório que foi
 * descartado: não confere com senha nenhuma conhecida — e, mesmo se conferisse,
 * `conferirSenhaDoLogin` não devolve conta sem `passwordHash`. Comparar contra
 * ele custa o MESMO bcrypt que uma senha de verdade. O antigo tinha 65
 * caracteres: o bcryptjs devolvia `false` na hora (confere o tamanho antes),
 * sem bcrypt nenhum, e o e-mail sem conta respondia ~100 ms mais rápido.
 */
export const HASH_DE_SENHA_FALSO = "$2b$10$dXcj9hmZIL631TbxmfN1leFdiQnQp5zu82h.M0wANgBP75UFULf1a";

/**
 * A conta, se o e-mail tem conta COM senha e a senha confere; senão `null`.
 * Roda SEMPRE exatamente uma comparação (contra `HASH_DE_SENHA_FALSO` quando
 * não há conta ou a conta não tem senha).
 */
export async function conferirSenhaDoLogin(emailBruto: string, senha: string, opts: { compararSenha: CompararSenha }): Promise<User | null> {
  const email = (emailBruto ?? "").trim().toLowerCase();
  const user = email ? await basePrisma.user.findUnique({ where: { email } }) : null;
  const ok = await opts.compararSenha(senha ?? "", user?.passwordHash ?? HASH_DE_SENHA_FALSO);
  return user?.passwordHash && ok ? user : null;
}
