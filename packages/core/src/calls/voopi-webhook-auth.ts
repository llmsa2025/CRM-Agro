import crypto from "node:crypto";

/**
 * Autenticação do webhook da Voopi (auditoria do #138).
 *
 * O `callbackUrl` de cada ligação vai no pedido feito com a conta Voopi DO
 * TIME — quem vê essa URL (painel ou log da Voopi) não pode ganhar acesso às
 * ligações de outros times. Por isso ele NUNCA leva o segredo global
 * (`VOOPI_WEBHOOK_TOKEN`): leva `ref=<id da nossa Call>&sig=<assinatura>`, com
 * a assinatura = HMAC-SHA256(segredo, "voopi-webhook:" + ref). Ela só vale
 * para AQUELA ligação, e o evento assinado só pode tocar a Call `ref` (ver
 * `applyVoopiWebhookEvent`, opção `soDaLigacao`).
 *
 * O segredo global (`?token=` ou header `x-webhook-token`) continua aceito —
 * é o caso do webhook configurado à mão no painel da Voopi. Sem segredo:
 * produção recusa tudo; dev aceita (como antes).
 */

export function assinaturaDaLigacaoVoopi(callId: string, segredo: string): string {
  return crypto.createHmac("sha256", segredo).update(`voopi-webhook:${callId}`).digest("hex");
}

function iguais(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export type AutenticacaoVoopi =
  | { ok: true; via: "segredo" | "sem_token_dev" }
  | { ok: true; via: "assinado"; ref: string }
  | { ok: false; motivo: "sem_segredo_em_producao" | "token_invalido" };

/**
 * Decide se o POST veio da Voopi. `opts` só existe para o teste; em produção
 * vale o env (segredo e NODE_ENV), lido na hora.
 */
export function autenticarWebhookVoopi(
  e: { token: string | null; ref: string | null; sig: string | null },
  opts: { segredo?: string | null; producao?: boolean } = {},
): AutenticacaoVoopi {
  const segredo = opts.segredo !== undefined ? opts.segredo : process.env.VOOPI_WEBHOOK_TOKEN || null;
  const producao = opts.producao ?? process.env.NODE_ENV === "production";
  if (!segredo) {
    return producao ? { ok: false, motivo: "sem_segredo_em_producao" } : { ok: true, via: "sem_token_dev" };
  }
  if (e.token && iguais(e.token, segredo)) return { ok: true, via: "segredo" };
  if (e.ref && e.sig && iguais(e.sig, assinaturaDaLigacaoVoopi(e.ref, segredo))) {
    return { ok: true, via: "assinado", ref: e.ref };
  }
  return { ok: false, motivo: "token_invalido" };
}
