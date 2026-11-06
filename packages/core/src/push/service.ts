import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "@crmagro/config";
import { basePrisma, db, getCurrentTeamId, tenantData } from "@crmagro/db";
import { ForbiddenError, requireCan, ROLES, type Role } from "../auth/authz";
import { logger } from "../logger/index";

/**
 * Web Push (VAPID) — avisos no navegador/celular do usuário, mesmo com a aba
 * fechada: WhatsApp caiu, motor degradado, lembrete da agenda.
 *
 * - O navegador assina (service worker `apps/web/public/sw-push.js` +
 *   `PushManager.subscribe` com a chave pública) e manda a assinatura para
 *   `POST /api/push/assinatura`; o time e o usuário vêm da SESSÃO.
 * - `enviarPush` roda no contexto do time (runAsSystem nos jobs) e só enxerga
 *   as assinaturas DESSE time (db() tenant): o push de um time nunca chega ao
 *   navegador de outro.
 * - Sem VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT o push fica desligado: um log no
 *   primeiro envio e nada quebra. Envio NUNCA lança — quem chama (webhook,
 *   job, alerta) segue igual se o serviço de push estiver fora.
 * - Assinatura morta (404/410 do serviço de push) é apagada no envio.
 */

/** Teto por envio: o timeout do web-push é de socket, não do pedido inteiro. */
const TIMEOUT_MS = 10_000;
/** Navegadores por usuário (celular, notebook, trabalho…); acima disso, sai a mais antiga. */
const MAX_POR_USUARIO = 10;
/** Assinaturas por envio (proteção contra time enorme num alerta só). */
const MAX_POR_ENVIO = 200;

/**
 * Serviços de push dos navegadores (Chrome/Edge/Opera/Samsung = FCM ou WNS,
 * Firefox = Mozilla, Safari = Apple). O servidor faz POST no endpoint: aceitar
 * qualquer URL do cliente viraria SSRF (POST para a rede interna a cada aviso).
 */
const SERVICOS_DE_PUSH = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

function endpointDeServicoConhecido(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.port && !u.username && SERVICOS_DE_PUSH.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

/** Formato de `PushSubscription.toJSON()` do navegador (o que o front manda). */
export const assinaturaPushSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine(endpointDeServicoConhecido, "endpoint fora dos serviços de push conhecidos"),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(128),
  }),
});

export const removerAssinaturaPushSchema = z.object({ endpoint: z.string().min(1).max(2048) });

export type PayloadPush = {
  titulo: string;
  corpo: string;
  /** Caminho aberto ao clicar (mesma origem; o service worker ignora outra). */
  url?: string;
  /** Mesma tag substitui o aviso anterior em vez de empilhar. */
  tag?: string;
};

export type AlvoPush = { userIds: string[] } | { papelMinimo: Role };

export type ResultadoPush = { enviados: number; removidas: number; falhas: number };

// ---------------------------------------------------------------------------
// VAPID / web-push (carregado sob demanda: sem chave, o módulo nem é lido)
// ---------------------------------------------------------------------------

type WebPush = typeof import("web-push");
let webPush: Promise<WebPush | null> | null = null;

function vapid(): { publicKey: string; privateKey: string; subject: string } | null {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

/** web-push configurado, ou null (push desligado — loga UMA vez por processo). */
function carregarWebPush(): Promise<WebPush | null> {
  webPush ??= (async () => {
    const chaves = vapid();
    if (!chaves) {
      logger.info("[push] desligado: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT ausentes");
      return null;
    }
    try {
      const mod = await import("web-push");
      const wp = ((mod as { default?: WebPush }).default ?? mod) as WebPush;
      wp.setVapidDetails(chaves.subject, chaves.publicKey, chaves.privateKey); // valida o formato
      return wp;
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.message : String(e) }, "[push] desligado: chaves VAPID inválidas");
      return null;
    }
  })();
  return webPush;
}

/** Só para testes: esquece o web-push carregado (troca de chaves entre casos). */
export function reiniciarPushParaTeste(): void {
  webPush = null;
}

/** Chave pública para o `PushManager.subscribe` do navegador; null = push desligado. */
export function chavePublicaPush(): { chave: string | null } {
  return { chave: vapid()?.publicKey ?? null };
}

// ---------------------------------------------------------------------------
// Assinatura (usuário logado)
// ---------------------------------------------------------------------------

/**
 * Grava a assinatura do navegador para o usuário da sessão. O `endpoint`
 * identifica o NAVEGADOR: se outra pessoa (de qualquer time) tinha assinado
 * nele antes, a linha dela sai — o aviso vai para quem está logado ali agora,
 * nunca para o time antigo.
 */
export async function salvarAssinaturaPush(
  input: unknown,
  userAgent?: string | null,
): Promise<{ ok: true }> {
  const ator = requireCan("push.subscribe");
  const d = db();
  // Assinatura é de pessoa: o motor (runAsSystem) não assina navegador.
  if (ator.system) throw new ForbiddenError();
  const s = assinaturaPushSchema.parse(input);
  // Cruza time de propósito (basePrisma): o endpoint veio do PushManager do
  // próprio navegador de quem chama, e só a linha com ESSE endpoint é tocada.
  await basePrisma.pushSubscription.deleteMany({
    where: { endpoint: s.endpoint, NOT: { teamId: ator.teamId, userId: ator.userId } },
  });
  const dados = {
    userId: ator.userId,
    p256dh: s.keys.p256dh,
    auth: s.keys.auth,
    userAgent: userAgent ? userAgent.slice(0, 300) : null,
  };
  await d.pushSubscription.upsert({
    where: { endpoint: s.endpoint },
    create: tenantData<Prisma.PushSubscriptionUncheckedCreateInput>({ ...dados, endpoint: s.endpoint }),
    // Reassinar (a tela reenvia a cada login) = navegador em uso: renova a data
    // que o teto por usuário usa para escolher quem sai.
    update: { ...dados, createdAt: new Date() },
  });
  // Teto por usuário: saem as usadas há mais tempo (navegador trocado ou
  // abandonado). "Uso" = último envio aceito ou, sem ele, a assinatura; a que
  // acabou de assinar nunca sai.
  const minhas = await d.pushSubscription.findMany({
    where: { userId: ator.userId },
    select: { id: true, endpoint: true, createdAt: true, ultimoOkEm: true },
  });
  if (minhas.length > MAX_POR_USUARIO) {
    const uso = (x: (typeof minhas)[number]) =>
      x.endpoint === s.endpoint ? Infinity : Math.max(x.createdAt.getTime(), x.ultimoOkEm?.getTime() ?? 0);
    const sobra = minhas.sort((a, b) => uso(b) - uso(a)).slice(MAX_POR_USUARIO);
    await d.pushSubscription.deleteMany({ where: { id: { in: sobra.map((x) => x.id) } } });
  }
  return { ok: true };
}

/** Remove a assinatura do navegador (só a do próprio usuário). */
export async function removerAssinaturaPush(input: unknown): Promise<{ removidas: number }> {
  const ator = requireCan("push.subscribe");
  const d = db();
  if (ator.system) throw new ForbiddenError();
  const { endpoint } = removerAssinaturaPushSchema.parse(input);
  const r = await d.pushSubscription.deleteMany({ where: { endpoint, userId: ator.userId } });
  return { removidas: r.count };
}

// ---------------------------------------------------------------------------
// Envio (motor, jobs, alertas — contexto do time)
// ---------------------------------------------------------------------------

function papeisAPartirDe(min: Role): Role[] {
  const i = ROLES.indexOf(min);
  // ROLES vai de owner (0) a viewer (3): "a partir de admin" = owner + admin.
  return i < 0 ? [] : ROLES.slice(0, i + 1);
}

function comPrazo<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const prazo = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`push: sem resposta em ${ms} ms`)), ms);
  });
  return Promise.race([p, prazo]).finally(() => clearTimeout(timer));
}

/**
 * Manda o aviso para os usuários do time DO CONTEXTO: por id (`userIds`) ou
 * por papel mínimo (`papelMinimo: "admin"` = owner + admin). Ids de outro time
 * não acham assinatura (db() tenant). Nunca lança.
 */
export async function enviarPush(
  alvo: AlvoPush,
  payload: PayloadPush,
  opcoes: { timeoutMs?: number } = {},
): Promise<ResultadoPush> {
  const timeoutMs = opcoes.timeoutMs ?? TIMEOUT_MS;
  const resultado: ResultadoPush = { enviados: 0, removidas: 0, falhas: 0 };
  try {
    const d = db(); // antes de qualquer await: o time fica no closure
    const wp = await carregarWebPush();
    if (!wp) return resultado;

    // Conta desativada pela equipe (F2a) nunca recebe: o aviso leva dado de cliente.
    const filtro =
      "userIds" in alvo
        ? { userId: { in: alvo.userIds.slice(0, MAX_POR_ENVIO) }, user: { desativadoEm: null } }
        : { user: { role: { in: papeisAPartirDe(alvo.papelMinimo) }, desativadoEm: null } };
    if ("userIds" in alvo && !alvo.userIds.length) return resultado;
    const assinaturas = await d.pushSubscription.findMany({
      where: filtro,
      select: { id: true, endpoint: true, p256dh: true, auth: true },
      take: MAX_POR_ENVIO,
    });
    if (!assinaturas.length) return resultado;

    const corpo = JSON.stringify({
      titulo: payload.titulo.slice(0, 120),
      corpo: payload.corpo.slice(0, 400),
      url: payload.url,
      tag: payload.tag,
    });
    const ok: string[] = [];
    const mortas: string[] = [];
    await Promise.all(
      assinaturas.map(async (a) => {
        try {
          await comPrazo(
            wp.sendNotification({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } }, corpo, {
              TTL: 60 * 60, // aviso de 1 h atrás já não serve
              urgency: "high",
              timeout: timeoutMs,
            }),
            timeoutMs,
          );
          ok.push(a.id);
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            mortas.push(a.id); // navegador desinstalado / permissão retirada
          } else {
            resultado.falhas++;
            logger.warn({ status, err: e instanceof Error ? e.message : String(e) }, "[push] envio falhou");
          }
        }
      }),
    );
    if (mortas.length) {
      resultado.removidas = (await d.pushSubscription.deleteMany({ where: { id: { in: mortas } } })).count;
    }
    if (ok.length) {
      await d.pushSubscription.updateMany({ where: { id: { in: ok } }, data: { ultimoOkEm: new Date() } });
    }
    resultado.enviados = ok.length;
    return resultado;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[push] falha ao enviar avisos");
    return resultado;
  }
}
