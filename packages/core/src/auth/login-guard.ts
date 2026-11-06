import { peekRateLimit, rateLimit, resetRateLimit } from "../rate-limit/service";

/**
 * Limite de tentativas de login (auditoria S8; ajuste da auditoria do #52).
 * Roda ANTES do bcrypt: cada tentativa custa ~70 ms de CPU, e o VPS divide 2
 * vCPUs com outros apps.
 *
 * Antes, o limite por e-mail consumia em TODA tentativa, certa ou errada, de
 * qualquer IP: quem soubesse o e-mail do dono mandava 10 POSTs errados a cada
 * 15 min e o dono não entrava mais. Agora só FALHA conta (consulta com `peek`
 * antes do bcrypt; consome depois da senha errada) e o acerto zera o par:
 * - par (e-mail, IP), falhas: 10 / 15 min — quem chuta a senha de uma conta de
 *   um lugar só tranca a si mesmo; o dono, de outro IP, entra;
 * - e-mail (todos os IPs), falhas: 50 / 15 min — força bruta distribuída; para
 *   trancar o dono é preciso errar 50 vezes de 5+ IPs a cada 15 min;
 * - IP, falhas: 20 / 15 min — robô varrendo e-mails;
 * - IP, TODAS as tentativas: 60 / 15 min — teto de CPU (as falhas são contadas
 *   depois do bcrypt; sem este teto, uma rajada simultânea passaria inteira).
 *   Folgado para um escritório atrás do mesmo NAT no começo do dia.
 *
 * Redis fora do ar → permite (fail-open do rateLimit): não trava o login.
 */
const QUINZE_MIN = 15 * 60 * 1000;
export const LOGIN_LIMITES = {
  falhasPorEmailEIp: { max: 10, janelaMs: QUINZE_MIN },
  falhasPorEmail: { max: 50, janelaMs: QUINZE_MIN },
  falhasPorIp: { max: 20, janelaMs: QUINZE_MIN },
  tentativasPorIp: { max: 60, janelaMs: QUINZE_MIN },
} as const;

type Entrada = { ip: string | null | undefined; email: string };

function chaves({ ip, email }: Entrada) {
  const e = email.trim().toLowerCase();
  const i = ip || "sem-ip";
  return {
    par: `auth:login:falha:par:${e}:${i}`,
    email: `auth:login:falha:email:${e}`,
    ipFalhas: ip ? `auth:login:falha:ip:${ip}` : null,
    ipTentativas: ip ? `auth:login:ip:${ip}` : null,
  };
}

const LIVRE = { allowed: true, remaining: 0, retryAfterMs: 0 };

/**
 * Pode tentar? Consulta as falhas (sem consumir) e consome 1 do teto de
 * tentativas do IP. Chamar ANTES do bcrypt; depois, `registrarFalhaDeLogin` ou
 * `registrarSucessoDeLogin`.
 */
export async function checkLoginRateLimit(input: Entrada): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const k = chaves(input);
  const L = LOGIN_LIMITES;
  const [par, email, ipFalhas] = await Promise.all([
    peekRateLimit(k.par, L.falhasPorEmailEIp.max, L.falhasPorEmailEIp.janelaMs),
    peekRateLimit(k.email, L.falhasPorEmail.max, L.falhasPorEmail.janelaMs),
    k.ipFalhas ? peekRateLimit(k.ipFalhas, L.falhasPorIp.max, L.falhasPorIp.janelaMs) : Promise.resolve(LIVRE),
  ]);
  const bloqueios = [par, email, ipFalhas].filter((r) => !r.allowed);
  if (bloqueios.length) return { allowed: false, retryAfterMs: Math.max(...bloqueios.map((r) => r.retryAfterMs)) };
  // Só consome o teto de CPU quem vai de fato rodar o bcrypt.
  const tentativas = k.ipTentativas
    ? await rateLimit(k.ipTentativas, L.tentativasPorIp.max, L.tentativasPorIp.janelaMs)
    : LIVRE;
  return { allowed: tentativas.allowed, retryAfterMs: tentativas.retryAfterMs };
}

/** Senha errada (ou e-mail inexistente): conta a falha no par, no e-mail e no IP. */
export async function registrarFalhaDeLogin(input: Entrada): Promise<void> {
  const k = chaves(input);
  const L = LOGIN_LIMITES;
  await Promise.all([
    rateLimit(k.par, L.falhasPorEmailEIp.max, L.falhasPorEmailEIp.janelaMs),
    rateLimit(k.email, L.falhasPorEmail.max, L.falhasPorEmail.janelaMs),
    k.ipFalhas ? rateLimit(k.ipFalhas, L.falhasPorIp.max, L.falhasPorIp.janelaMs) : Promise.resolve(LIVRE),
  ]);
}

/**
 * Login certo: zera as falhas do PAR (os erros de digitação do próprio dono).
 * As falhas do e-mail e do IP ficam: zerar daria um orçamento novo a quem está
 * atacando de vários IPs.
 */
export async function registrarSucessoDeLogin(input: Entrada): Promise<void> {
  const k = chaves(input);
  await resetRateLimit(k.par, LOGIN_LIMITES.falhasPorEmailEIp.janelaMs);
}
