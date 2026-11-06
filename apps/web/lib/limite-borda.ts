/**
 * Limite de tentativas NA BORDA (middleware) para as telas de conta sem sessão:
 * "criar conta" e "redefinir senha" (auditoria do #52). O POST dessas telas
 * (server action) roda bcrypt (~70 ms de CPU num VPS de 2 vCPUs): sem limite,
 * uma série de POSTs anônimos derrubava o web. O "esqueci a senha" entrou na
 * lista porque cada POST pode virar um e-mail pelo remetente da plataforma,
 * cuja cota é uma só para todos os times. O "criar empresa" e o "confirmar
 * e-mail" do cadastro com senha também (e-mail da plataforma e bcrypt).
 *
 * O middleware roda no Edge Runtime, sem ioredis: o contador é em MEMÓRIA do
 * processo web (janela fixa por IP e por tela). Com 1 instância web (hoje), é o
 * limite exato; com N instâncias, até N× — ainda corta a rajada. A barreira
 * compartilhada (Redis, 10 / 15 min por IP) está no core
 * (`aceitarConviteComSenha` / `redefinirSenhaComToken` com `{ ip }`).
 */

export const LIMITE_CONTA_BORDA = { max: 10, janelaMs: 15 * 60 * 1000 } as const;
/** Caminhos cujo POST passa pelo limite. */
export const TELAS_DE_CONTA = new Set(["/criar-conta", "/redefinir-senha", "/criar-empresa", "/esqueci-senha", "/confirmar-email"]);

const MAX_CHAVES = 10_000;
const contadores = new Map<string, { n: number; fim: number }>();

/** Solta as janelas vencidas; se ainda estiver cheio (ataque de muitos IPs), recomeça. */
function podar(agora: number): void {
  for (const [k, v] of contadores) if (v.fim <= agora) contadores.delete(k);
  if (contadores.size >= MAX_CHAVES) contadores.clear();
}

/**
 * Conta 1 tentativa de `ip` em `tela`. Devolve `retryAfterMs` > 0 quando passou
 * do limite. Sem IP (dev, sem proxy), permite.
 */
export function tentativaNaBorda(
  tela: string,
  ip: string | null,
  agora = Date.now(),
): { permitido: boolean; retryAfterMs: number } {
  if (!ip) return { permitido: true, retryAfterMs: 0 };
  if (contadores.size >= MAX_CHAVES) podar(agora);
  const k = `${tela}|${ip}`;
  const atual = contadores.get(k);
  if (!atual || atual.fim <= agora) {
    contadores.set(k, { n: 1, fim: agora + LIMITE_CONTA_BORDA.janelaMs });
    return { permitido: true, retryAfterMs: 0 };
  }
  atual.n += 1;
  if (atual.n <= LIMITE_CONTA_BORDA.max) return { permitido: true, retryAfterMs: 0 };
  return { permitido: false, retryAfterMs: atual.fim - agora };
}

/** IP do cliente atrás do Caddy (1º valor do X-Forwarded-For), como no login. */
export function ipDoPedido(headers: Headers): string | null {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || null;
}
