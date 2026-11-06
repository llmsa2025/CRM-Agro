import NextAuth, { CredentialsSignin } from "next-auth";
import { cookies } from "next/headers";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { basePrisma } from "@crmagro/db";
import { env } from "@crmagro/config";
import {
  provisionUserFromGoogle,
  googleSignInPermitido,
  checkLoginRateLimit,
  registrarFalhaDeLogin,
  registrarSucessoDeLogin,
  getSessionState,
  sessionIsCurrent,
  SESSION_CHECK_MS,
  cadastroEmpresaAberto,
  contaDesativada,
  normalizarVerTudoEm,
  normalizarEditarTudoEm,
  verTudoEmDoLegado,
  editarTudoEmDoLegado,
  conferirSenhaDoLogin,
} from "@crmagro/core";
import { COOKIE_NOVA_EMPRESA, empresaDoCookie } from "@/lib/nova-empresa";

/**
 * Autenticação (NextAuth v5) — substitui o resolver de tenancy de desenvolvimento.
 *
 * A PARTE 0 (AGENTS.md) previu que o `teamId` viria da sessão assim que
 * o login existisse, trocando só o resolver. É o que acontece aqui: o `teamId`
 * do usuário entra no JWT no login e a sessão o expõe; `runAsUser` (lib/tenant.ts)
 * abre o `runWithTeam` com ele.
 *
 * Providers:
 * - **Credentials (e-mail/senha)**: entrada de quem já tem senha. Conta com
 *   senha nasce pelo convite (packages/core/src/auth/invites.ts) ou pelo
 *   cadastro da empresa com e-mail CONFIRMADO (auth/cadastro-com-senha.ts);
 *   este provider apenas autentica — nunca cria usuário. Cadastro com senha
 *   ainda não confirmado NÃO tem resposta própria (revisão do #177: "confirme
 *   o seu e-mail" só para quem não tem conta virava um oráculo de quais
 *   e-mails têm conta); a tela de login dá a dica de abrir o link.
 * - **Google (OAuth)**: entra em conta existente ou em convite pendente (no time
 *   do convite). E-mail desconhecido sem convite é recusado, a não ser com
 *   SIGNUP_ABERTO=true (aí cria um time novo). Só é registrado se
 *   GOOGLE_CLIENT_ID/SECRET existirem.
 *
 * Decisões:
 * - **JWT, sem adapter.** O JWT carrega `teamId`/`userId`, que é tudo que a
 *   tenancy precisa. A reconciliação do Google é por e-mail (User.email é único
 *   GLOBAL), feita no callback `jwt` — não há tabelas Account/Session do NextAuth.
 * - `basePrisma` (sem a extensão de tenancy) de propósito: no login ainda não há
 *   contexto de time — é justamente o que estamos descobrindo.
 * - Erro genérico em qualquer falha do Credentials: e-mail inexistente e senha
 *   errada devolvem a mesma mensagem, e com o mesmo trabalho (UMA comparação
 *   bcrypt em todos os casos — `conferirSenhaDoLogin`), para não revelar quais
 *   e-mails existem.
 */

const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/** Tentativas demais (S8). A tela de login recebe `code=rate_limited`. */
class LimiteDeTentativas extends CredentialsSignin {
  override code = "rate_limited";
}
/** Conta desativada pela equipe (F2a). Só é dito DEPOIS da senha certa (não vaza estado). */
class ContaDesativadaSignin extends CredentialsSignin {
  override code = "desativado";
}

/**
 * IP do cliente. Atrás do Caddy: o `X-Forwarded-For` que chega aqui é o que o
 * Caddy montou (ele descarta o do cliente quando não há proxy confiável antes
 * dele), então o PRIMEIRO valor é o IP real.
 */
function ipDoCliente(req: Request | undefined): string | null {
  const xff = req?.headers.get("x-forwarded-for");
  return xff?.split(",")[0]?.trim() || req?.headers.get("x-real-ip") || null;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true, // atrás do Caddy; o host vem do proxy
  // S12: 24 h (era 7 dias) e revalidação contra o banco no callback `jwt`.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24, updateAge: 60 * 60 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "E-mail", type: "email" },
        senha: { label: "Senha", type: "password" },
      },
      async authorize(creds, req) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        const senha = String(creds?.senha ?? "");
        if (!email || !senha) return null;

        // S8: limite ANTES do bcrypt (força bruta e CPU). Só FALHA conta para o
        // e-mail (auditoria do #52): acertar não gasta tentativa e zera o par.
        const ip = ipDoCliente(req);
        const rl = await checkLoginRateLimit({ ip, email });
        if (!rl.allowed) throw new LimiteDeTentativas();

        // UMA comparação bcrypt em todos os casos (com conta, sem conta, conta
        // sem senha, cadastro não confirmado): nem a resposta nem o tempo
        // revelam se o e-mail tem conta.
        const user = await conferirSenhaDoLogin(email, senha, { compararSenha: (s, h) => bcrypt.compare(s, h) });
        if (!user) {
          await registrarFalhaDeLogin({ ip, email });
          return null;
        }
        await registrarSucessoDeLogin({ ip, email });
        if (user.desativadoEm) throw new ContaDesativadaSignin();

        const agora = new Date();
        await basePrisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: agora },
        });

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          teamId: user.teamId,
          role: user.role,
          sessionVersion: user.sessionVersion,
          modulos: user.modulos,
          verTudoEm: user.verTudoEm,
          editarTudoEm: user.editarTudoEm,
        };
      },
    }),
    // Google só entra se as credenciais existirem no env (fail-soft).
    ...(googleEnabled
      ? [
          Google({
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
            // Não precisamos de refresh token offline; só identidade.
            authorization: { params: { scope: "openid email profile", prompt: "select_account" } },
          }),
        ]
      : []),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      // Google: só aceita e-mail VERIFICADO pelo provedor (evita associar/criar
      // time a partir de um e-mail não confirmado).
      if (account?.provider === "google") {
        if (!profile?.email || !profile.email_verified) return false;
        // Desativado pela equipe (F2a): mensagem própria em vez de "sem convite".
        if (await contaDesativada(profile.email)) return "/login?erro=desativado";
        // Cadastro fechado (item G): sem conta e sem convite pendente, não entra
        // (antes criava um time novo). A tela de login lê `erro=sem-convite`.
        // Exceção explícita: veio de "Criar a conta da minha empresa" (cookie).
        const criandoEmpresa = cadastroEmpresaAberto() && empresaDoCookie((await cookies()).get(COOKIE_NOVA_EMPRESA)?.value) !== null;
        if (!(await googleSignInPermitido(profile.email, criandoEmpresa ? { cadastroAberto: true } : {}))) return "/login?erro=sem-convite";
        return true;
      }
      return true;
    },
    async jwt({ token, user, account, profile }) {
      // Login por Google: resolve (ou cria) time+usuário por e-mail. `account` só
      // vem no momento do login — provisiona uma vez, não a cada request.
      if (account?.provider === "google" && profile?.email) {
        // "Registrar com Google" em /criar-empresa: o cookie traz o nome da empresa
        // e libera o time novo; é consumido aqui (vale para um login só).
        const jar = await cookies();
        const empresa = cadastroEmpresaAberto() ? empresaDoCookie(jar.get(COOKIE_NOVA_EMPRESA)?.value) : null;
        const { userId, teamId, role, sessionVersion } = await provisionUserFromGoogle(
          { email: profile.email, name: (profile.name as string | undefined) ?? null },
          empresa ? { cadastroAberto: true, empresa } : {},
        );
        if (empresa) {
          try {
            // Apagar com os MESMOS atributos: `delete(nome)` sai sem Secure e o
            // navegador ignora para cookie `__Host-` (revisão do #148).
            jar.set(COOKIE_NOVA_EMPRESA, "", {
              httpOnly: true,
              secure: process.env.NODE_ENV === "production",
              sameSite: "lax",
              path: "/",
              maxAge: 0,
            });
          } catch {
            /* fora de contexto que grava cookie: expira sozinho em 10 min */
          }
        }
        token.userId = userId;
        token.teamId = teamId;
        token.role = role; // RBAC: papel resolvido no provisionamento.
        token.sessionVersion = sessionVersion;
        // Telas (F2b): lidas no login; mudar derruba a sessão (volta aqui).
        const extra = await basePrisma.user.findUnique({ where: { id: userId }, select: { modulos: true, verTudoEm: true, editarTudoEm: true } });
        token.modulos = extra?.modulos ?? [];
        token.verTudoEm = normalizarVerTudoEm(extra?.verTudoEm ?? []);
        token.editarTudoEm = normalizarEditarTudoEm(extra?.editarTudoEm ?? [], token.verTudoEm);
        delete token.verTudo;
        token.checkedAt = Date.now();
        return token;
      }
      // Login por Credentials: `user` traz os campos já resolvidos no authorize.
      if (user) {
        token.userId = user.id;
        token.teamId = user.teamId;
        token.role = user.role; // RBAC.
        token.sessionVersion = user.sessionVersion;
        token.modulos = user.modulos ?? [];
        token.verTudoEm = normalizarVerTudoEm(user.verTudoEm ?? []);
        token.editarTudoEm = normalizarEditarTudoEm(user.editarTudoEm ?? [], token.verTudoEm);
        delete token.verTudo;
        token.checkedAt = Date.now();
        return token;
      }
      // Requests seguintes (S12): a cada ~60 s confere time, papel e versão da
      // sessão com o banco (cache Redis no core). Divergiu (senha trocada, papel
      // mudou, usuário removido) → null: o Auth.js limpa o cookie e a pessoa
      // volta ao login.
      if (!token.userId) return null;
      const agora = Date.now();
      if (typeof token.checkedAt !== "number" || agora - token.checkedAt >= SESSION_CHECK_MS) {
        const estado = await getSessionState(token.userId);
        if (!sessionIsCurrent(token, estado)) return null;
        token.checkedAt = agora;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = String(token.userId ?? "");
        session.user.teamId = String(token.teamId ?? "");
        // RBAC: papel na sessão. Se ausente no token, deixa undefined —
        // a autorização é fail-closed (sem papel → nega), nunca assume um default.
        session.user.role = token.role ? String(token.role) : undefined;
        session.user.modulos = Array.isArray(token.modulos) ? token.modulos : [];
        // "Ver tudo" por tela; token de antes da troca traz o booleano (= todas as telas).
        session.user.verTudoEm = verTudoEmDoLegado(token.verTudoEm, token.verTudo);
        // "Editar" por tela; token de antes da troca, sem a lista, edita onde vê (como era).
        session.user.editarTudoEm = editarTudoEmDoLegado(token.editarTudoEm, session.user.verTudoEm);
      }
      return session;
    },
  },
});
