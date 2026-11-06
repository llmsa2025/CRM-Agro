import { dadosEmpresaSchema, type EmpresaNova } from "@crmagro/core";

/**
 * Cookie de "Registrar com Google" (plano-equipe-permissoes F1): a tela
 * /criar-empresa grava os dados da empresa aqui (10 min, httpOnly) antes de
 * seguir para o Google; o `auth.ts` lê na volta para aceitar o e-mail novo e
 * criar o time com o nome da empresa. Sem o cookie, e-mail desconhecido segue
 * recusado (cadastro fechado).
 */
// `__Host-` em produção (auditoria do #148, S4): só HTTPS, só este host, path /.
export const COOKIE_NOVA_EMPRESA = process.env.NODE_ENV === "production" ? "__Host-crmagro_nova_empresa" : "crmagro_nova_empresa";

/** Lê e valida o cookie; qualquer coisa estranha = sem intenção de criar empresa. */
export function empresaDoCookie(valor: string | undefined): EmpresaNova | null {
  if (!valor) return null;
  try {
    const r = dadosEmpresaSchema.safeParse(JSON.parse(valor));
    return r.success ? { nome: r.data.nome, cnpj: r.data.cnpj ?? null, cidade: r.data.cidade ?? null, estado: r.data.estado ?? null } : null;
  } catch {
    return null;
  }
}
