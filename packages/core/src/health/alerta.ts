import { env } from "@crmagro/config";
import { runAsSystem } from "@crmagro/db";
import { logger } from "../logger/index";
import { modeloAlertaSaude } from "../email/modelos";
import {
  enviarEmailDaPlataforma,
  erroParaLog,
  plataformaConfigurada,
  rodapeDeResposta,
  type TipoDeEmailDaPlataforma,
} from "../email/plataforma";
import { enviarPush, type ResultadoPush } from "../push/service";
import { redisEstado } from "../shared/redis-cache";
import type { HealthReport } from "./check";
import {
  categoriaDoMotivo,
  configEfetiva,
  esperaEmSegundos,
  registrarAlertaEnviado,
  type ConfigEfetiva,
} from "./alertas-config";

/**
 * Alerta de saúde (item 1.10 — MF-24): quando a plataforma fica `degraded` ou
 * `unhealthy` (fila atrasada, órfãs, worker parado, Evolution fora, remetente
 * da plataforma inválido), avisa a operação:
 * - Web Push: no máximo 1 vez a cada 30 min POR MOTIVO (não custa nada);
 * - e-mail: por motivo, com espera CRESCENTE (30 min, 2 h e depois a cada 6 h)
 *   enquanto o motivo persistir. Antes era a cada 30 min: um incidente longo
 *   mandava ~48 e-mails por dia por destinatário e esgotava sozinho a cota
 *   diária do remetente da plataforma (Resend Free: 100/dia para TUDO, reset
 *   de senha inclusive). A contagem zera 12 h depois do último e-mail do motivo.
 *
 * A saúde da PLATAFORMA é assunto de quem opera, não dos donos de cada time:
 * - e-mail para os endereços da operação, pelo remetente da plataforma
 *   (PLATFORM_SMTP_*); sem ele, pela caixa do time de operação, como antes;
 * - Web Push para owner/admin do MESMO time de operação, nos navegadores em
 *   que ativaram os avisos.
 * Sem configuração: só o log de erro.
 *
 * QUEM MANDA NA CONFIGURAÇÃO (`alertas-config.ts`): a linha salva no banco, quando existe. Sem ela (nunca salvou,
 * ou banco fora) vale o `.env` (`ALERT_EMAILS` e `ALERT_TEAM_ID`). Cada alerta enviado é registrado (categoria,
 * canal, resultado; nunca o texto do erro).
 */

const REPETE_APOS_S = 30 * 60;
/** Espera até o próximo e-mail do MESMO motivo: 1º → 30 min, 2º → 2 h, depois 6 h. */
export const ESPERAS_DO_EMAIL_S = [30 * 60, 2 * 60 * 60, 6 * 60 * 60] as const;
const CONTAGEM_DO_EMAIL_ZERA_APOS_S = 12 * 60 * 60;

export type EnviarAlerta = (
  para: string[],
  assunto: string,
  texto: string,
  html?: string,
) => Promise<void>;
/** Devolve o resultado do push quando sabe (o padrão sabe); `void` = deu certo (os testes injetam espiões simples). */
export type AvisarPorPush = (titulo: string, corpo: string) => Promise<ResultadoPush | null | void>;

/** Motivos do relatório, um por dependência/métrica fora do normal. */
export type MotivoDoAlerta = {
  /** Chave da trava no Redis (o texto sem os números). */
  chave: string;
  texto: string;
  /** Categoria que a tela liga e desliga (`MOTIVOS_DO_ALERTA`). */
  categoria: string;
};

export function motivosDoRelatorio(r: HealthReport): MotivoDoAlerta[] {
  const motivos: MotivoDoAlerta[] = [];
  for (const [nome, c] of Object.entries(r.checks)) {
    if (c.status === "healthy") continue;
    if (nome === "motor" && "motivos" in c && Array.isArray(c.motivos) && c.motivos.length) {
      for (const m of c.motivos as string[]) {
        motivos.push({
          chave: `motor:${m.replace(/\d+/g, "#")}`,
          texto: `motor: ${m}`,
          categoria: categoriaDoMotivo(nome, m),
        });
      }
    } else {
      motivos.push({
        chave: nome,
        texto: `${nome}: ${c.error ?? "fora do ar"}`,
        categoria: categoriaDoMotivo(nome),
      });
    }
  }
  return motivos;
}

export type ResultadoDoEnvio = { enviados: number; falhas: number; erro?: string };

/** Mensagem de erro de envio que PODE ir à tela: sem endereço de e-mail e sem o usuário/senha do SMTP, curta. */
export function erroSeguroDeEnvio(e: unknown): string {
  let msg = erroParaLog(e);
  for (const segredo of [
    env.PLATFORM_SMTP_PASS,
    env.PLATFORM_SMTP_USER,
    process.env.PLATFORM_SMTP_PASS,
    process.env.PLATFORM_SMTP_USER,
  ]) {
    if (segredo && segredo.length >= 3) msg = msg.split(segredo).join("***");
  }
  return msg.replace(/\s+/g, " ").trim().slice(0, 200) || "falha no envio";
}

/**
 * Envia o e-mail da operação a cada endereço, UM por vez, e conta o que saiu.
 * Remetente da plataforma (não depende de time nem da caixa de ninguém); sem
 * ele, pela caixa do time de operação (como antes). Um endereço com problema
 * não impede os outros. Nunca lança; o erro volta já sem segredo.
 */
export async function enviarEmailDeOperacao(
  para: string[],
  assunto: string,
  texto: string,
  html: string | undefined,
  tipo: TipoDeEmailDaPlataforma,
  cfg?: Pick<ConfigEfetiva, "timeOperacaoId">,
): Promise<ResultadoDoEnvio> {
  let enviados = 0;
  let falhas = 0;
  let erro: string | undefined;
  const falhou = (e: unknown) => {
    falhas++;
    erro ??= erroSeguroDeEnvio(e);
  };
  if (plataformaConfigurada()) {
    for (const to of para) {
      try {
        if (
          await enviarEmailDaPlataforma({
            to,
            subject: assunto,
            text: texto,
            ...(html ? { html } : {}),
            tipo,
          })
        )
          enviados++;
        else falhou(new Error("remetente da plataforma desligado"));
      } catch (e) {
        falhou(e);
      }
    }
    return { enviados, falhas, ...(erro ? { erro } : {}) };
  }
  const teamId = (cfg ?? (await configEfetiva())).timeOperacaoId;
  if (!teamId)
    return {
      enviados: 0,
      falhas: para.length,
      erro: "sem remetente: falta o e-mail da plataforma (PLATFORM_SMTP_*) ou o time de operação",
    };
  const { sendTransactionalEmail } = await import("../email/service");
  await runAsSystem(teamId, async () => {
    for (const to of para) {
      try {
        if (
          await sendTransactionalEmail({
            to,
            subject: assunto,
            text: texto,
            ...(html ? { html } : {}),
          })
        )
          enviados++;
        else falhou(new Error("o time de operação não tem e-mail conectado"));
      } catch (e) {
        falhou(e);
      }
    }
  });
  return { enviados, falhas, ...(erro ? { erro } : {}) };
}

async function enviarPorEmail(
  para: string[],
  assunto: string,
  texto: string,
  html?: string,
): Promise<void> {
  const r = await enviarEmailDeOperacao(para, assunto, texto, html, "alerta");
  if (r.falhas) throw new Error(`${r.falhas} de ${para.length} e-mails de alerta não saíram`);
}

/**
 * Web Push para owner/admin do time de operação (a configuração da tela, ou o
 * `ALERT_TEAM_ID` do `.env`). Respeita o interruptor geral e o canal Web Push
 * da tela. `null` = nada tentado (desligado, canal desligado ou sem time).
 */
export async function pushParaOperacao(
  titulo: string,
  corpo: string,
): Promise<ResultadoPush | null> {
  const cfg = await configEfetiva();
  if (!cfg.ligado || !cfg.canais.push || !cfg.timeOperacaoId) return null;
  return runAsSystem(cfg.timeOperacaoId, () =>
    enviarPush({ papelMinimo: "admin" }, { titulo, corpo, url: "/", tag: "saude-plataforma" }),
  );
}

// ─── Travas com plano B (Redis fora) ──────────────────────────────────────────
//
// Com o Redis fora, a trava por motivo falhava no primeiro `set` e o alerta
// morria mudo (justamente quando o Redis é o motivo). Agora a falha do Redis
// cai numa trava em MEMÓRIA do processo, com a mesma espera: o alerta sai e não
// repete a cada checagem. Com N processos (web e worker) o aviso pode sair uma
// vez por processo; é o preço de não ficar mudo.

const travasEmMemoria = new Map<string, number>();
const contagensEmMemoria = new Map<string, { n: number; ate: number }>();
let avisouRedisFora = 0;

/** Só para teste: esquece as travas em memória. */
export function limparTravasDoAlertaEmMemoriaParaTeste(): void {
  travasEmMemoria.clear();
  contagensEmMemoria.clear();
  avisouRedisFora = 0;
}

function redisForaDoAlerta(e: unknown): void {
  // Um log a cada 10 min, não a cada checagem.
  if (Date.now() - avisouRedisFora < 10 * 60_000) return;
  avisouRedisFora = Date.now();
  logger.warn(
    { err: erroParaLog(e) },
    "[alerta] Redis fora: travas do alerta em memória (o aviso sai mesmo assim)",
  );
}

/** Trava atômica por chave (SET NX com validade); Redis fora, cai na memória. `true` = pode avisar. */
async function travar(chave: string, ttlS: number): Promise<boolean> {
  try {
    return !!(await redisEstado().set(chave, "1", "EX", ttlS, "NX"));
  } catch (e) {
    redisForaDoAlerta(e);
    const agora = Date.now();
    if ((travasEmMemoria.get(chave) ?? 0) > agora) return false;
    travasEmMemoria.set(chave, agora + ttlS * 1000);
    return true;
  }
}

async function lerContagem(chave: string): Promise<number> {
  try {
    return Number((await redisEstado().get(chave)) ?? 0);
  } catch {
    const c = contagensEmMemoria.get(chave);
    return c && c.ate > Date.now() ? c.n : 0;
  }
}

async function somarContagem(chave: string): Promise<void> {
  try {
    await redisEstado().multi().incr(chave).expire(chave, CONTAGEM_DO_EMAIL_ZERA_APOS_S).exec();
  } catch {
    const c = contagensEmMemoria.get(chave);
    const n = c && c.ate > Date.now() ? c.n : 0;
    contagensEmMemoria.set(chave, {
      n: n + 1,
      ate: Date.now() + CONTAGEM_DO_EMAIL_ZERA_APOS_S * 1000,
    });
  }
}

/**
 * Motivos cujo e-mail já pode sair (trava por motivo com espera crescente).
 * O SET NX é atômico: web e worker avaliando juntos não mandam dois e-mails.
 * `intervaloMinimoMin` (da tela) é o piso de cada degrau da espera.
 */
async function motivosParaEmail(
  motivos: MotivoDoAlerta[],
  intervaloMinimoMin: number,
): Promise<MotivoDoAlerta[]> {
  const devidos: MotivoDoAlerta[] = [];
  for (const m of motivos) {
    const contagem = `alerta:saude:email:n:${m.chave}`;
    const n = await lerContagem(contagem);
    const espera = esperaEmSegundos(
      ESPERAS_DO_EMAIL_S[Math.min(n, ESPERAS_DO_EMAIL_S.length - 1)]!,
      intervaloMinimoMin,
    );
    if (!(await travar(`alerta:saude:email:${m.chave}`, espera))) continue;
    await somarContagem(contagem);
    devidos.push(m);
  }
  return devidos;
}

/** Categorias distintas, na ordem em que aparecem. */
const categoriasDe = (motivos: MotivoDoAlerta[]) => [...new Set(motivos.map((m) => m.categoria))];

/**
 * Avalia o relatório e dispara o alerta dos motivos NOVOS: Web Push com trava
 * de 30 min por motivo; e-mail com espera crescente por motivo. Respeita a
 * configuração (ligado, canais, motivos, destinatários, intervalo mínimo) e
 * registra cada envio. Nunca lança: alerta que falha não derruba o health.
 * Devolve os motivos avisados por push.
 */
export async function alertarSeDegradado(
  r: HealthReport,
  enviar: EnviarAlerta = enviarPorEmail,
  avisarPorPush: AvisarPorPush = pushParaOperacao,
): Promise<string[]> {
  if (r.status === "healthy") return [];
  try {
    const cfg = await configEfetiva();
    // Desligado na tela: nem log de erro, nem trava, nem envio (a saúde segue em /api/health).
    if (!cfg.ligado) return [];
    const motivos = motivosDoRelatorio(r).filter(
      (m) => !cfg.motivosDesligados.includes(m.categoria),
    );
    if (!motivos.length) return [];
    const pushEsperaS = esperaEmSegundos(REPETE_APOS_S, cfg.intervaloMinimoMin);
    const novos: MotivoDoAlerta[] = [];
    for (const m of motivos) {
      if (await travar(`alerta:saude:${m.chave}`, pushEsperaS)) novos.push(m);
    }
    if (novos.length) {
      logger.error(
        { status: r.status, motivos: novos.map((m) => m.texto) },
        "[alerta] plataforma fora do normal",
      );
      if (cfg.canais.push) {
        const resultado = await avisarPorPush(
          `CRM Agro ${r.status}: ${novos[0]!.texto}`,
          novos.map((m) => m.texto).join(" · "),
        ).then(
          (res) => res,
          (e) => {
            logger.warn({ err: erroParaLog(e) }, "[alerta] push não saiu");
            return "falhou" as const;
          },
        );
        // Push: só vira registro se alguém recebeu ou se deu erro (sem navegador inscrito não houve alerta).
        // `null` = nada foi tentado (canal sem time ou desligado); `undefined` = espião simples que deu certo.
        const entregues =
          resultado === "falhou" || resultado === null
            ? 0
            : resultado === undefined
              ? 1
              : resultado.enviados;
        const falhas =
          resultado === "falhou"
            ? 1
            : resultado === null || resultado === undefined
              ? 0
              : resultado.falhas;
        if (entregues > 0 || falhas > 0) {
          for (const categoria of categoriasDe(novos)) {
            await registrarAlertaEnviado({
              canal: "push",
              motivo: categoria,
              status: r.status,
              resultado: entregues > 0 ? "enviado" : "falhou",
            });
          }
        }
      }
    }
    const para = cfg.emails;
    const paraEmail =
      cfg.canais.email && para.length
        ? await motivosParaEmail(motivos, cfg.intervaloMinimoMin)
        : [];
    if (paraEmail.length) {
      const base = env.APP_PUBLIC_URL ?? env.AUTH_URL;
      const email = modeloAlertaSaude({
        status: r.status,
        quando: r.timestamp,
        motivos: paraEmail.map((m) => m.texto),
        linkDaSaude: base ? `${base.replace(/\/$/, "")}/api/health` : null,
        resposta: rodapeDeResposta(),
      });
      let resultado: "enviado" | "falhou" = "enviado";
      await enviar(para, email.subject, email.text, email.html).catch((e) => {
        resultado = "falhou";
        logger.warn({ err: erroParaLog(e) }, "[alerta] e-mail não saiu");
      });
      for (const categoria of categoriasDe(paraEmail)) {
        await registrarAlertaEnviado({
          canal: "email",
          motivo: categoria,
          status: r.status,
          resultado,
          destinatarios: para.length,
        });
      }
    }
    return novos.map((m) => m.texto);
  } catch (e) {
    logger.warn({ err: erroParaLog(e) }, "[alerta] falha ao avaliar alerta");
    return [];
  }
}
