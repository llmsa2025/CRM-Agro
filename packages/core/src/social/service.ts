import type { Prisma, Canal } from "@prisma/client";
import { escopoCanal } from "../conversations/escopo";
import { db, tenantData, encryptCredentials, decryptCredentials } from "@crmagro/db";
import type { SocialNetwork } from "@crmagro/channels";
import { requireCan } from "../auth/authz";

import { donoPadrao } from "../tenancy/escopo";
/**
 * Contas sociais (Instagram/LinkedIn) via automação de navegador (cookie de
 * sessão). Guardadas cifradas como ChannelAccount (provider `<canal>_browser`).
 * O cookie NUNCA volta pra UI (só status/rótulo/proxy mascarado).
 */
type SocialProxy = { server: string; username?: string; password?: string };

type SocialCredentials = {
  cookie: string; // cookie de sessão primário (li_at / sessionid) — compat BrowserProvider
  cookies?: Record<string, string>; // bundle completo p/ APIs autenticadas (JSESSIONID, bcookie…)
  proxy?: SocialProxy;
  // @usuário (IG) / publicIdentifier (LinkedIn) da sessão, descoberto pela
  // extensão ao conectar (item 1.8, INT-08): amarra a conta ao navegador certo.
  username?: string;
  // Quem conectou a conta. "extensao" = pela extensão do navegador (sessão lida do
  // navegador do usuário). O SERVIDOR não valida nem reabre uma conta assim: a
  // sessão é conferida pela própria extensão, no IP de quem usa (o Playwright do
  // worker, num IP de datacenter, é o que leva a checkpoint). Ausente = cookie
  // colado à mão (comportamento antigo, o worker ainda valida a cada 6 h).
  origem?: "extensao";
};

export type ConnectSocialInput = {
  canal: SocialNetwork; // instagram | linkedin
  label: string;
  cookie: string;
  cookies?: Record<string, string>;
  proxy?: SocialProxy;
  username?: string;
};

/**
 * Opções que NÃO vêm do cliente: só o servidor as passa (a rota da extensão).
 * Ficam fora de `ConnectSocialInput` para o formulário manual, cujo input vem
 * do navegador, não conseguir marcar uma conta como "só pela extensão".
 */
export type OpcoesConexaoSocial = {
  /** "extensao": veio da extensão do navegador (rota /api/relay/connect-social). Ver SocialCredentials.origem. */
  origem?: "extensao";
};

/**
 * A conta foi conectada pela extensão e o servidor não deve validar a sessão
 * dela? Recebe as credenciais JÁ decifradas. Só o valor exato "extensao" vale
 * (qualquer outro, ou ausente, é conta antiga ou colada à mão: segue validada).
 */
export function contaSoPelaExtensao(cfg: { origem?: unknown } | null | undefined): boolean {
  return cfg?.origem === "extensao";
}

function providerFor(canal: SocialNetwork): string {
  return `${canal}_browser`;
}

/** Normaliza um @usuário para comparação (sem @, minúsculo). */
function normalizarUsername(u: string | null | undefined): string {
  return (u ?? "").trim().replace(/^@/, "").toLowerCase();
}

/**
 * @usuário de uma conta social: o gravado no connect ou, em conta antiga, o do
 * rótulo "@fulano" (o connect pela extensão sempre usou esse rótulo).
 */
function usernameDaConta(credentials: unknown, label: string): string | null {
  const cfg = decryptCredentials(credentials) as Partial<SocialCredentials> | null;
  const salvo = normalizarUsername(cfg?.username);
  if (salvo) return salvo;
  const m = /^@([\w.-]+)$/.exec(label.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Conecta (ou atualiza) uma conta social: verifica o cookie, cifra e salva. */
export async function connectSocialAccount(
  input: ConnectSocialInput,
  opcoes: OpcoesConexaoSocial = {},
): Promise<{ connected: boolean; error?: string }> {
  requireCan("social.connect");
  const cookie = input.cookie.trim();
  if (!cookie) throw new Error("cookie de sessão obrigatório");
  const proxy = input.proxy?.server?.trim() ? input.proxy : undefined;

  // A verificação do cookie (Playwright) roda no WORKER — o web não pode carregar
  // o playwright-core. Aqui apenas salvamos cifrado; o worker valida e ajusta o
  // status (connected/error) no próximo ciclo. Exceção: conta conectada pela
  // extensão (`origem: "extensao"`), que o worker não valida (ver contaSoPelaExtensao).
  const prisma = db();
  // Só mantém entradas de cookie com valor de texto (defesa contra payload torto).
  const cookies =
    input.cookies && typeof input.cookies === "object"
      ? Object.fromEntries(
          Object.entries(input.cookies)
            .filter(([k, v]) => k && typeof v === "string" && v.trim())
            .map(([k, v]) => [k, String(v).trim()]),
        )
      : undefined;
  const username = normalizarUsername(input.username);
  const creds: SocialCredentials = {
    cookie,
    ...(cookies && Object.keys(cookies).length ? { cookies } : {}),
    ...(proxy ? { proxy } : {}),
    ...(username ? { username } : {}),
    ...(opcoes.origem === "extensao" ? { origem: "extensao" as const } : {}),
  };
  const credentials = encryptCredentials(creds) as unknown as Prisma.InputJsonValue;
  const status = "connected";
  const provider = providerFor(input.canal);

  // Com @usuário (connect pela extensão): uma conta por @ — o 2º vendedor que
  // conecta o PRÓPRIO Instagram não sobrescreve mais a conta do 1º (INT-08).
  // Sem @ (cookie colado à mão): comportamento antigo, uma conta por canal.
  // F3: só as contas de quem conecta (a de um colega com o mesmo @ não é adotada).
  const doCanal = await prisma.channelAccount.findMany({
    where: { AND: [{ canal: input.canal as Canal, provider }, escopoCanal({ escrita: true })] },
    select: { id: true, label: true, credentials: true },
    orderBy: { createdAt: "asc" },
  });
  let existing: { id: string } | undefined;
  if (username) {
    const comUsername = doCanal.map((a) => ({ id: a.id, u: usernameDaConta(a.credentials, a.label) }));
    existing = comUsername.find((a) => a.u === username);
    // Conta antiga sem @ conhecido e única no canal: é esta sessão (adota).
    if (!existing && comUsername.length === 1 && !comUsername[0]!.u) existing = comUsername[0];
  } else {
    existing = doCanal[0];
  }
  if (existing) {
    await prisma.channelAccount.update({
      where: { id: existing.id },
      data: { label: input.label.trim() || input.canal, credentials, status, paused: false },
    });
  } else {
    await prisma.channelAccount.create({
      data: tenantData<Prisma.ChannelAccountUncheckedCreateInput>({
        canal: input.canal as Canal,
        provider,
        ownerId: donoPadrao(), // F3: quem conectou (vê as conversas; + master/admin/"ver tudo")
        label: input.label.trim() || input.canal,
        credentials,
        status,
      }),
    });
  }
  return { connected: true };
}

export type SocialAccountDTO = {
  id: string;
  canal: string;
  label: string;
  status: string;
  connected: boolean;
  hasProxy: boolean;
};

/** Lista as contas sociais (mascarado — nunca o cookie). */
export async function listSocialAccounts(): Promise<SocialAccountDTO[]> {
  const prisma = db();
  const rows = await prisma.channelAccount.findMany({
    where: { AND: [{ provider: { in: ["instagram_browser", "linkedin_browser"] } }, escopoCanal()] },
    select: { id: true, canal: true, label: true, status: true, credentials: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => {
    const cfg = decryptCredentials(r.credentials) as Partial<SocialCredentials> | null;
    return {
      id: r.id,
      canal: r.canal,
      label: r.label,
      status: r.status,
      connected: r.status === "connected",
      hasProxy: Boolean(cfg?.proxy?.server),
    };
  });
}

/** Resolve o id da conta social conectada de um canal (para o motor de fluxo). */
export async function resolveSocialAccountId(
  canal: SocialNetwork,
  preferId?: string,
): Promise<string | null> {
  const prisma = db();
  const provider = providerFor(canal);
  if (preferId) {
    const acc = await prisma.channelAccount.findFirst({ where: { AND: [{ id: preferId, provider }, escopoCanal({ escrita: true })] } });
    if (acc) return acc.id;
  }
  const acc = await prisma.channelAccount.findFirst({
    where: { AND: [{ canal: canal as Canal, provider, status: "connected" }, escopoCanal({ escrita: true })] },
    orderBy: { createdAt: "asc" },
  });
  return acc?.id ?? null;
}

/**
 * Contas sociais do time que o navegador da extensão tem logadas (item 1.8):
 * casa o @usuário que a extensão descobriu com o de cada conta. A extensão só
 * recebe DM das contas devolvidas aqui. Roda no contexto do time do token.
 */
export async function resolverContasDoNavegador(
  contas: Array<{ network: string; username: string }>,
): Promise<string[]> {
  const pedidas = new Set(
    contas
      .filter((c) => (c.network === "instagram" || c.network === "linkedin") && normalizarUsername(c.username))
      .map((c) => `${c.network}:${normalizarUsername(c.username)}`),
  );
  if (!pedidas.size) return [];
  // F3: a extensão de cada pessoa só recebe o trabalho das contas DELA.
  const rows = await db().channelAccount.findMany({
    where: { AND: [{ provider: { in: ["instagram_browser", "linkedin_browser"] } }, escopoCanal({ escrita: true })] },
    select: { id: true, canal: true, label: true, credentials: true },
  });
  return rows
    .filter((r) => {
      const u = usernameDaConta(r.credentials, r.label);
      return u !== null && pedidas.has(`${r.canal}:${u}`);
    })
    .map((r) => r.id);
}

/** @usuário esperado de uma conta social (null = desconhecido). Contexto do time. */
export async function usernameEsperadoDaConta(accountId: string): Promise<string | null> {
  const acc = await db().channelAccount.findFirst({
    where: { AND: [{ id: accountId, provider: { in: ["instagram_browser", "linkedin_browser"] } }, escopoCanal()] },
    select: { label: true, credentials: true },
  });
  return acc ? usernameDaConta(acc.credentials, acc.label) : null;
}

export async function deleteSocialAccount(id: string): Promise<void> {
  requireCan("social.connect");
  await db().channelAccount.deleteMany({
    where: { AND: [{ id, provider: { in: ["instagram_browser", "linkedin_browser"] } }, escopoCanal({ escrita: true })] },
  });
}
