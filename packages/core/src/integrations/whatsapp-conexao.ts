import { randomUUID } from "node:crypto";
import { env } from "@crmagro/config";
import { basePrisma, db, runAsSystem } from "@crmagro/db";
import { getEvolutionQR, verifyEvolutionInstance, type EvolutionVerifyResult } from "@crmagro/channels";
import { requireCan } from "../auth/authz";
import { assertOwned } from "../tenancy/assert-owned";
import { publishRealtime } from "../events/redis-bus";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import { invalidarStatusWhatsApp } from "../channels-limit/service";
import { enviarPush } from "../push/service";

/**
 * Estado da conexão do WhatsApp visível e reconexão (item 1.6 — INT-04/INT-19).
 *
 * Antes: o celular deslogava ou a sessão do Baileys caía, a instância ficava
 * `close` e NADA mudava — /integracoes mostrava "Conectado", todo envio falhava
 * e ninguém era avisado. Para reconectar era preciso criar instância e conta
 * NOVAS (a antiga seguia "conectada" e os fluxos com a conta fixa falhando).
 *
 * Agora:
 * - evento `connection.update` (webhook) e a verificação periódica do worker
 *   aplicam o estado na conta: caiu → `disconnected` + `paused` (os fluxos
 *   ADIAM em vez de falhar) + evento `channel:disconnected` (banner) + Web Push
 *   para owner/admin do time (chega com o CRM Agro fechado); voltou →
 *   `connected` e despausa (só se a pausa foi da queda — pausa manual fica);
 * - "Reconectar" usa a MESMA instância (`/instance/connect`), com QR novo via
 *   `qrcode.updated` → evento `channel:qr`.
 */

const ESTADOS_CAIDOS = new Set(["close", "closed", "refused", "logout"]);

type Conta = { id: string; teamId: string; label: string; status: string; paused: boolean };

async function contaDaInstancia(instance: string): Promise<Conta | null> {
  return basePrisma.channelAccount.findUnique({
    where: { provider_externalId: { provider: "evolution", externalId: instance } },
    select: { id: true, teamId: true, label: true, status: true, paused: true },
  });
}

/** Aplica o estado informado pela Evolution na conta dona da instância. */
export async function aplicarEstadoDaConexao(input: {
  instance: string;
  state: string | null;
}): Promise<"desconectou" | "reconectou" | "sem_mudanca" | "desconhecida"> {
  const state = (input.state ?? "").toLowerCase();
  const conta = await contaDaInstancia(input.instance);
  if (!conta) return "desconhecida";

  if (ESTADOS_CAIDOS.has(state) && conta.status !== "disconnected") {
    await runAsSystem(conta.teamId, async () => {
      await db().channelAccount.update({
        where: { id: conta.id },
        // `desconectadaEm` marca a hora da QUEDA (o adiamento dos envios conta
        // a partir dela; o `updatedAt` anda com qualquer mudança da conta).
        data: { status: "disconnected", paused: true, desconectadaEm: new Date() },
      });
      await invalidarStatusWhatsApp(conta.teamId); // bloco do menu (item 2.9)
      publishRealtime({ type: "channel:disconnected", channelAccountId: conta.id, label: conta.label });
      // Sem await: o aviso não segura o webhook/verificação (enviarPush nunca
      // lança). A tag por conta faz o aviso repetido substituir o anterior.
      void enviarPush(
        { papelMinimo: "admin" },
        {
          titulo: "WhatsApp desconectado",
          corpo: `O número "${conta.label}" caiu. Os envios dele estão pausados até reconectar.`,
          url: "/integracoes",
          tag: `wa-caiu-${conta.id}`,
        },
      );
    });
    logger.warn({ channelAccountId: conta.id, instance: input.instance, state }, "[whatsapp] instância desconectada");
    return "desconectou";
  }
  if (state === "open" && conta.status !== "connected") {
    await runAsSystem(conta.teamId, async () => {
      // Só despausa se estava parada pela queda (status disconnected/error).
      await db().channelAccount.update({
        where: { id: conta.id },
        data: { status: "connected", paused: false, desconectadaEm: null },
      });
      await invalidarStatusWhatsApp(conta.teamId); // bloco do menu (item 2.9)
      publishRealtime({ type: "channel:connected", channelAccountId: conta.id, label: conta.label });
    });
    logger.info({ channelAccountId: conta.id, instance: input.instance }, "[whatsapp] instância reconectada");
    return "reconectou";
  }
  return "sem_mudanca";
}

/**
 * QR novo durante a (re)conexão → evento para a tela do time dono. A instância
 * pode já ser conta (reconexão) ou estar no onboarding (chave do item 0.5).
 */
export async function publicarQrAtualizado(input: { instance: string; qrBase64: string }): Promise<void> {
  const conta = await contaDaInstancia(input.instance);
  const teamId = conta?.teamId ?? (await redisEstado().get(`wa:onboard:${input.instance}`).catch(() => null));
  if (!teamId) return;
  publishRealtime({ type: "channel:qr", instance: input.instance, qrBase64: input.qrBase64 }, teamId);
}

export const TRAVA_VERIFICACAO = "wa:verificacao:rodada";

/** Apaga a trava só se o valor ainda for o token de quem pegou (mesmo padrão do `email:poll:<conta>`). */
const SOLTAR_SE_MINHA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Rede de segurança (worker primário, 5 min): confere o estado de TODAS as
 * contas Evolution. Evolution fora do ar (estado desconhecido) não muda nada.
 */
export async function verificarConexoesWhatsApp(
  verificar: (instance: string) => Promise<EvolutionVerifyResult> = (instance) =>
    verifyEvolutionInstance({ apiUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY, instance }),
): Promise<{ verificadas: number; mudancas: number }> {
  // Uma rodada por vez (auditoria do #66): com muitas contas lentas (até 8 s
  // cada), a rodada passava de 5 min e o setInterval começava outra por cima.
  // A trava leva um token (auditoria do #98): uma rodada que passa dos 280 s
  // perde a trava para a seguinte e, ao terminar, NÃO pode apagá-la.
  const token = randomUUID();
  if (!(await redisEstado().set(TRAVA_VERIFICACAO, token, "EX", 280, "NX"))) return { verificadas: 0, mudancas: 0 };
  try {
    const contas = await basePrisma.channelAccount.findMany({
      where: { canal: "whatsapp", provider: "evolution", externalId: { not: null } },
      select: { externalId: true },
    });
    let mudancas = 0;
    // Até 4 instâncias ao mesmo tempo (a Evolution é local; não martela).
    for (let i = 0; i < contas.length; i += 4) {
      await Promise.all(
        contas.slice(i, i + 4).map(async (c) => {
          const v = await verificar(c.externalId!);
          if (!v.state) return; // não sei → não mexe
          const r = await aplicarEstadoDaConexao({ instance: c.externalId!, state: v.state });
          if (r === "desconectou" || r === "reconectou") mudancas++;
        }),
      );
    }
    return { verificadas: contas.length, mudancas };
  } finally {
    // Solta só se ainda for nossa; senão expira sozinha.
    await redisEstado().eval(SOLTAR_SE_MINHA, 1, TRAVA_VERIFICACAO, token).catch(() => undefined);
  }
}

async function instanciaDaConta(accountId: string): Promise<string> {
  requireCan("integrations.manage");
  await assertOwned("channelAccount", accountId);
  const conta = await db().channelAccount.findUnique({
    where: { id: accountId },
    select: { externalId: true, provider: true, credentials: true },
  });
  const instance = conta?.externalId ?? (conta?.credentials as { instance?: string } | null)?.instance;
  if (!conta || conta.provider !== "evolution" || !instance) throw new Error("conta sem instância do WhatsApp");
  return instance;
}

/**
 * "Reconectar" na MESMA instância: pede a conexão à Evolution. Já aberta →
 * marca conectada; senão devolve o QR (e os próximos chegam por `channel:qr`).
 */
export async function reconectarContaWhatsApp(
  accountId: string,
): Promise<{ conectado: true } | { conectado: false; qrBase64: string | null; error?: string }> {
  const instance = await instanciaDaConta(accountId);
  const qr = await getEvolutionQR({ apiUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY, instance });
  if (!qr.ok) return { conectado: false, qrBase64: null, error: qr.error ?? "Evolution não respondeu" };
  if (qr.state === "open") {
    await aplicarEstadoDaConexao({ instance, state: "open" });
    return { conectado: true };
  }
  return { conectado: false, qrBase64: qr.qrBase64 };
}

/** O modal consulta até o QR ser lido; quando abre, a conta volta a enviar. */
export async function conferirReconexao(accountId: string): Promise<{ conectado: boolean; state: string | null }> {
  const instance = await instanciaDaConta(accountId);
  const v = await verifyEvolutionInstance({ apiUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY, instance });
  if (v.ok) await aplicarEstadoDaConexao({ instance, state: "open" });
  return { conectado: v.ok, state: v.state };
}
