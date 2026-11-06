import { basePrisma, decryptCredentials } from "@crmagro/db";
import { logger } from "../logger/index";
import { contaSoPelaExtensao } from "./service";

/**
 * Verificação periódica das sessões das contas sociais (Instagram/LinkedIn):
 * a decisão de QUEM verificar e o que fazer com o resultado. O ato de verificar
 * (abrir um Chromium com o cookie) fica no worker e entra por `verificar`, porque
 * o Playwright não pode entrar no bundle do web.
 *
 * Conta conectada pela EXTENSÃO (`origem: "extensao"`) fica de fora: o servidor
 * não abre navegador com o cookie dela. A sessão é conferida pela própria
 * extensão, no IP e no navegador de quem usa; o Playwright do worker roda num IP
 * de datacenter, que é justamente o padrão que leva a checkpoint no Instagram e
 * no LinkedIn (relay por conta).
 */

export type ResultadoVerificacao = { ok: true } | { ok: false; motivo: "deslogado" | "rede"; error: string };

export interface ContaParaVerificar {
  canal: string;
  cookie: string;
  proxy?: { server: string; username?: string; password?: string };
}

export type VerificadorDeSessao = (conta: ContaParaVerificar) => Promise<ResultadoVerificacao>;

type CredenciaisSociais = {
  cookie?: string;
  origem?: string;
  proxy?: { server: string; username?: string; password?: string };
};

const PROVIDERS_SOCIAIS = ["instagram_browser", "linkedin_browser"];

/**
 * Verifica as contas e ajusta o status. Só "deslogado" marca erro e pausa; falha
 * de rede (timeout, proxy, datacenter barrado) mantém o status e tenta na próxima
 * rodada. `onde` restringe as contas (teste); em produção vai vazio.
 */
export async function verificarSessoesSociais(
  verificar: VerificadorDeSessao,
  opcoes: { onde?: { teamId?: string } } = {},
): Promise<{ verificadas: number; puladasPelaExtensao: number }> {
  const contas = await basePrisma.channelAccount.findMany({
    // Conta já marcada com ERRO não é re-verificada: a sessão morreu e só volta
    // quando o usuário reconecta (o connect grava status "connected" de novo).
    where: { provider: { in: PROVIDERS_SOCIAIS }, status: { not: "error" }, ...(opcoes.onde ?? {}) },
    select: { id: true, canal: true, credentials: true },
  });
  let verificadas = 0;
  let puladasPelaExtensao = 0;
  for (const acc of contas) {
    const cfg = decryptCredentials(acc.credentials) as CredenciaisSociais | null;
    if (!cfg?.cookie) continue;
    if (contaSoPelaExtensao(cfg)) {
      puladasPelaExtensao++;
      continue;
    }
    verificadas++;
    try {
      const r = await verificar({ canal: acc.canal, cookie: cfg.cookie, proxy: cfg.proxy });
      if (r.ok) {
        await basePrisma.channelAccount.update({ where: { id: acc.id }, data: { status: "connected" } });
      } else if (r.motivo === "deslogado") {
        await basePrisma.channelAccount.update({ where: { id: acc.id }, data: { status: "error", paused: true } });
        logger.warn({ id: acc.id, canal: acc.canal, error: r.error }, "[social] sessão deslogada — conta pausada até reconectar");
      } else {
        logger.warn({ id: acc.id, canal: acc.canal, error: r.error }, "[social] verificação sem rede — status mantido");
      }
    } catch (err) {
      logger.error({ id: acc.id, err: err instanceof Error ? err.message : String(err) }, "[social] verify falhou");
    }
  }
  return { verificadas, puladasPelaExtensao };
}
