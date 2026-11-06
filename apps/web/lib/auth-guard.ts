import { headers } from "next/headers";
import { rateLimit } from "@crmagro/core";

/**
 * Limite de tentativas para as telas de conta SEM sessão (criar conta por
 * convite, redefinir senha) — auditoria S8 e auditoria do #52.
 *
 * Três barreiras, da mais barata para a mais cara:
 *   1. o middleware limita o POST dessas telas por IP (memória do processo —
 *      `lib/limite-borda.ts`);
 *   2. o core, com `{ ip }`, limita no Redis (compartilhado entre instâncias);
 *   3. o core valida o token ANTES do bcrypt.
 *
 * Uso nas telas (a senha vai PURA; o hash é injetado):
 *   const ip = await ipDaRequisicao();
 *   const res = await aceitarConviteComSenha(token, { name, senha }, { ip, hashSenha: (s) => bcrypt.hash(s, 10) });
 *   const res = await redefinirSenhaComToken(token, senha, { ip, hashSenha: (s) => bcrypt.hash(s, 10) });
 * `tentativaDeContaPermitida` fica para outras telas sem sessão que precisem do limite.
 */

/** IP do cliente (primeiro valor do X-Forwarded-For montado pelo Caddy). */
export async function ipDaRequisicao(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

/** 10 tentativas / 15 min por IP e por tela. Sem IP (dev), permite. */
export async function tentativaDeContaPermitida(
  tela: "criar-conta" | "redefinir-senha",
  ip: string | null,
): Promise<boolean> {
  if (!ip) return true;
  const rl = await rateLimit(`auth:${tela}:ip:${ip}`, 10, 15 * 60 * 1000);
  return rl.allowed;
}
