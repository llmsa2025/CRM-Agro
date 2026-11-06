import { createHash, randomBytes } from "node:crypto";
import { env } from "@crmagro/config";
import { basePrisma, runAsSystem } from "@crmagro/db";
import { forgetSessionCache } from "./session";
import { rateLimit } from "../rate-limit/service";
import { enviarEmailDoSistema } from "../email/sistema";
import { modeloRedefinirSenha } from "../email/modelos";
import { erroParaLog, mascararEmail, rodapeDeResposta } from "../email/plataforma";
import { logger } from "../logger/index";
import { SENHA_MIN, type HashDeSenha } from "./invites";

/**
 * "Esqueci a senha" — token de reset com HASH (sha256), expiração curta e
 * consumo único. Espelha o padrão de `packages/core/src/relay/tokens.ts`: o
 * TEXTO PURO do token só existe no link enviado por e-mail; no banco fica só o
 * sha256. O e-mail sai pelo remetente da PLATAFORMA quando configurado
 * (PLATFORM_SMTP_*) e, com ele, NUNCA pela caixa de uma pessoa do time (S-05);
 * sem ele, pela caixa do time, como antes (`enviarEmailDoSistema`).
 *
 * Segurança:
 * - Anti-enumeração: `requestPasswordReset` resolve NA HORA e SEMPRE sem
 *   erro, exista ou não o e-mail (o trabalho roda em segundo plano, então nem
 *   o tempo de resposta denuncia a conta). A resposta ao usuário é sempre
 *   genérica ("se existe, enviamos").
 * - Rate-limit por e-mail e por IP (Redis) para não virar oráculo/spam de
 *   envio; o remetente da plataforma ainda tem o teto por destinatário e o
 *   teto diário (`enviarEmailDaPlataforma`).
 * - Sem sessão: resolve o usuário/time via `basePrisma` (autoridade = hash único),
 *   depois abre `runAsSystem(teamId)` (necessário só no envio legado, pela
 *   caixa do time).
 * - A troca de senha invalida os demais tokens do usuário (consumo único).
 *
 * O HASH da senha NÃO é feito aqui (o `bcryptjs` mora no app web, junto do
 * NextAuth). O chamador (server action) calcula o hash e o passa para
 * `consumePasswordReset`.
 */

/** Validade do token de reset: 45 minutos (dentro da faixa 30–60min pedida). */
export const PASSWORD_RESET_TTL_MS = 45 * 60 * 1000;
const VALIDADE_MIN = Math.round(PASSWORD_RESET_TTL_MS / 60_000);
const RESET_PREFIX = "prt_";
/** Pedidos de reset por e-mail e por IP (Redis, janela fixa). */
export const RESET_POR_EMAIL = { max: 3, janelaMs: 60 * 60 * 1000 } as const;
export const RESET_POR_IP = { max: 10, janelaMs: 60 * 60 * 1000 } as const;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return RESET_PREFIX + randomBytes(32).toString("base64url");
}

/** Base pública para montar o link do e-mail (AUTH_URL, senão APP_PUBLIC_URL). */
function publicBaseUrl(): string | null {
  return env.AUTH_URL ?? env.APP_PUBLIC_URL ?? null;
}

/** Pedidos em segundo plano (só para os testes e o encerramento esperarem). */
const pedidosEmAndamento = new Set<Promise<void>>();

/**
 * Solicita a redefinição de senha para um e-mail. Resolve NA HORA e SEMPRE
 * sem erro (anti-enumeração): limite, busca da conta, token e envio rodam em
 * SEGUNDO PLANO. Antes a action esperava tudo, e o tempo de resposta
 * denunciava quem tem conta: e-mail inexistente respondia em milissegundos,
 * o existente esperava o SMTP (e a fila de 1 conexão do transporte). O web é
 * um servidor de longa duração (custom server no pm2), então o envio termina
 * depois da resposta. Efeitos (token + e-mail) só acontecem se o e-mail
 * existir, passar nos limites e houver por onde enviar — nada disso vaza.
 */
export async function requestPasswordReset(rawEmail: string, opts: { ip?: string | null } = {}): Promise<void> {
  const tarefa = processarPedidoDeReset(rawEmail, opts).catch((e: unknown) => {
    logger.warn({ err: erroParaLog(e) }, "[password-reset] falha ao processar o pedido");
  });
  pedidosEmAndamento.add(tarefa);
  void tarefa.finally(() => pedidosEmAndamento.delete(tarefa));
}

/** Espera os pedidos de reset em segundo plano terminarem (testes, encerramento). */
export async function aguardarPedidosDeReset(): Promise<void> {
  while (pedidosEmAndamento.size) await Promise.allSettled([...pedidosEmAndamento]);
}

async function processarPedidoDeReset(rawEmail: string, opts: { ip?: string | null }): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return;

  // Por IP (quando o chamador informa): uma lista de e-mails testada do mesmo
  // lugar não vira rajada de envio pela plataforma (a cota do provedor é uma só).
  if (opts.ip) {
    const porIp = await rateLimit(`pwreset:ip:${opts.ip}`, RESET_POR_IP.max, RESET_POR_IP.janelaMs);
    if (!porIp.allowed) return;
  }
  // Por e-mail: no máx. 3 pedidos por hora (antes 5 a cada 15 min = até 480
  // e-mails por dia para a mesma conta).
  const rl = await rateLimit(`pwreset:${email}`, RESET_POR_EMAIL.max, RESET_POR_EMAIL.janelaMs);
  if (!rl.allowed) return;

  const user = await basePrisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, teamId: true },
  });
  if (!user) return; // e-mail inexistente: silêncio (anti-enumeração)

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  await basePrisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt },
  });

  const base = publicBaseUrl();
  if (!base) {
    logger.warn("[password-reset] AUTH_URL/APP_PUBLIC_URL ausentes — link não montado");
    return;
  }
  const link = `${base.replace(/\/$/, "")}/redefinir-senha?token=${encodeURIComponent(token)}`;
  const mensagem = modeloRedefinirSenha({
    nome: user.name,
    email,
    link,
    validadeMin: VALIDADE_MIN,
    resposta: rodapeDeResposta(),
  });

  // Plataforma configurada: só por ela (S-05). Sem ela: caixa do time, como
  // antes (fail-soft: sem caixa conectada, não envia).
  try {
    const r = await runAsSystem(user.teamId, () => enviarEmailDoSistema({ to: email, ...mensagem, tipo: "reset" }));
    if (!r.enviado) logger.warn({ para: mascararEmail(email) }, "[password-reset] sem remetente: e-mail não enviado");
  } catch (e) {
    // Não propaga: o usuário recebe sempre a mesma resposta genérica.
    logger.warn({ err: erroParaLog(e) }, "[password-reset] falha ao enviar e-mail");
  }
}

/** Resultado da validação de um token de reset (sem revelar o usuário). */
export type ResetTokenCheck = { valid: boolean };

/** Verifica se um token de reset é válido (existe, não usado, não expirado). */
export async function verifyPasswordResetToken(rawToken: string): Promise<ResetTokenCheck> {
  const token = rawToken?.trim();
  if (!token) return { valid: false };
  const row = await basePrisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { usedAt: true, expiresAt: true },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return { valid: false };
  return { valid: true };
}

/**
 * Consome um token de reset e grava a nova senha (hash já calculado pelo app web).
 * Validação: token existe, não usado, não expirado. Efeitos: seta o passwordHash,
 * marca o token como usado e invalida os demais tokens do usuário. Retorna false
 * se o token for inválido/expirado (o chamador mostra erro genérico).
 */
export async function consumePasswordReset(
  rawToken: string,
  passwordHash: string,
  opts: { ip?: string | null } = {},
): Promise<boolean> {
  const token = rawToken?.trim();
  if (!token || !passwordHash) return false;
  // S8: com o IP do chamador, limita tentativas (10 / 15 min por IP).
  if (opts.ip) {
    const rl = await rateLimit(`auth:reset:ip:${opts.ip}`, 10, 15 * 60 * 1000);
    if (!rl.allowed) return false;
  }
  const tokenHash = hashToken(token);

  const row = await basePrisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, usedAt: true, expiresAt: true },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return false;

  // Transação: consome ESTE token de forma atômica (dois cliques simultâneos no
  // link não gravam duas senhas), grava a senha, invalida os demais tokens e
  // sobe a sessionVersion — quem roubou o cookie cai junto (S12).
  const agora = new Date();
  const ok = await basePrisma.$transaction(async (tx) => {
    const { count } = await tx.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: agora } },
      data: { usedAt: agora },
    });
    if (count !== 1) return false;
    await tx.user.update({
      where: { id: row.userId },
      // NÃO comprova o e-mail: sem o remetente da plataforma, o link sai pelo
      // SMTP do time, que o master/admin controla (auditoria do #148, B2). Só o
      // login Google comprova.
      data: { passwordHash, sessionVersion: { increment: 1 } },
    });
    await tx.passwordResetToken.updateMany({
      where: { userId: row.userId, usedAt: null },
      data: { usedAt: agora },
    });
    return true;
  });
  if (ok) await forgetSessionCache(row.userId);
  return ok;
}

/**
 * "Redefinir senha" recebendo a senha PURA (auditoria do #52). Limite por IP
 * (10 / 15 min, a mesma chave do `consumePasswordReset`), tamanho da senha e
 * token válido vêm ANTES do bcrypt; só então calcula o hash (`hashSenha`,
 * injetado pelo web) e consome o token.
 */
export async function redefinirSenhaComToken(
  rawToken: string,
  senha: string,
  opts: { ip?: string | null; hashSenha: HashDeSenha },
): Promise<{ ok: true } | { ok: false; reason: "invalid" | "rate_limited" | "senha_curta" }> {
  const token = rawToken?.trim();
  if (!token) return { ok: false, reason: "invalid" };
  if (opts.ip) {
    const rl = await rateLimit(`auth:reset:ip:${opts.ip}`, 10, 15 * 60 * 1000);
    if (!rl.allowed) return { ok: false, reason: "rate_limited" };
  }
  if ((senha ?? "").length < SENHA_MIN) return { ok: false, reason: "senha_curta" };
  if (!(await verifyPasswordResetToken(token)).valid) return { ok: false, reason: "invalid" };
  const hash = await opts.hashSenha(senha);
  // Sem `ip`: o limite já foi contado acima.
  return (await consumePasswordReset(token, hash)) ? { ok: true } : { ok: false, reason: "invalid" };
}
