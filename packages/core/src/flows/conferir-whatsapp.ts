import { env } from "@crmagro/config";
import { db } from "@crmagro/db";
import { checkWhatsAppNumbers, normalizePhone } from "@crmagro/channels";
import { requireCan } from "../auth/authz";
import { adiamentoPorQueda, quandoCaiu } from "../channels-limit/service";
import { valorDe } from "../contacts/identificadores-cifra";
import { logger } from "../logger/index";
import { adiamentoForaDaJanela, adiamentoParaProximoDia } from "../motor-do-dia/send-window";
import { redisEstado } from "../shared/redis-cache";
import { devolverAoTeto, gravarNoCache, instanciaDaConta, lerDoCache, reservarNoTeto } from "../campaigns/tem-whatsapp";
import { ConsultaWhatsAppIndisponivel } from "./errors";
import type { JanelaEnvio } from "./janela";

/**
 * Condição "Tem WhatsApp" no modo "Conferir no WhatsApp" (`has_whatsapp` com `modo: "verificar"`): pergunta ao
 * WhatsApp se o número TEM CONTA, sem enviar mensagem e sem abrir conversa (o mesmo `POST /chat/whatsappNumbers` das
 * Campanhas). Ordem da decisão, parando no primeiro que responde:
 *
 * 1. Sem número válido no cadastro = "não", sem consultar.
 * 2. Cache global `WhatsAppNumberCheck` dentro da validade = responde sem consultar.
 * 3. Consulta nova, UM número por vez, pela conta de WhatsApp (Evolution) do próprio time (a conectada e sem pausa mais
 *    antiga), com tudo isto na frente:
 *    horário de envio do fluxo, conta conectada, teto diário (o MESMO contador das campanhas, `WA_CHECAGEM_DIA`) e
 *    ritmo mínimo entre consultas da conta (3 a 6 s sorteados).
 *
 * Quando não dá para saber, o passo NUNCA escolhe ramo no escuro:
 * - horário, conta caída ou pausada, teto do dia, ritmo: ADIA (`adiar`), igual aos envios. Não é falha e não gasta tentativa;
 * - time sem NENHUMA conta de WhatsApp no CRM Agro: SEGURA (`segurar`), como o passo "Enviar mensagem". Adiar de dia em dia
 *   gastaria os 200 passos da inscrição sem ninguém ser avisado;
 * - Evolution fora, lenta ou resposta ilegível: `ConsultaWhatsAppIndisponivel`, que o motor repete com espera crescente e,
 *   no fim, segura para revisão (`tratarFalhaDoPasso`).
 *
 * "Não" só desvia o ramo: NÃO marca o número como errado no cadastro e NÃO vai para o cache global. A consulta
 * unitária não tem o filtro de "lote suspeito" das campanhas, e um "não" errado ali tiraria um cliente de verdade das
 * campanhas de TODOS os times (o cache é global). Quem tem a palavra final é o envio real (400 `exists:false` marca o
 * número). Já o "sim" pode ir ao cache (com o `jid`), para a mesma consulta não se repetir.
 */

export type ConferenciaDoWhatsApp =
  | { resposta: boolean; origem: "cadastro" | "cache" | "lembrado" | "consulta" }
  | { adiar: { delayMs: number; motivo: string } }
  // Não há o que esperar sozinho (o time não tem conta de WhatsApp no CRM Agro): segura para a pessoa decidir.
  | { segurar: { motivo: string } };

/** Motivos de adiamento (aparecem no log do fluxo). */
export const MOTIVO_FORA_DO_HORARIO = "fora do horário de envio";
export const MOTIVO_SEM_CONTA = "Sem conta de WhatsApp no CRM Agro. Conecte um número e retome o passo.";
export const MOTIVO_CONTA_CAIDA = "conta de WhatsApp desconectada, o número não foi conferido";
export const MOTIVO_CONTA_PAUSADA = "conta de WhatsApp pausada, o número não foi conferido";
export const MOTIVO_TETO_DO_DIA = "limite diário de consultas ao WhatsApp da conta";
export const MOTIVO_RITMO = "ritmo entre consultas ao WhatsApp da conta";

/** Ritmo mínimo entre duas consultas da MESMA conta: sorteado entre estes dois valores (segundos). */
export const RITMO_PADRAO_MIN_S = 3;
export const RITMO_PADRAO_MAX_S = 6;
/** Quanto uma vaga marcada pode chegar antes da hora e ainda valer (a fila atrasada do BullMQ não é exata). */
const TOLERANCIA_DA_VEZ_MS = 1_000;
/**
 * Vaga marcada que o passo só resgata MUITO depois da hora (worker reiniciou, conta caiu, fluxo pausado)
 * não vale: todos os passos voltariam juntos e consultariam de uma vez, logo depois de a sessão reconectar. Vencida,
 * ela é descartada e o passo entra na fila de novo (sem pagar o teto outra vez, a unidade já foi gasta).
 */
const VAGA_VENCE_APOS_MS = 60_000;
/** Quanto o CRM Agro lembra do "não" de um número dentro da MESMA inscrição e do MESMO passo. */
const MEMORIA_DO_NAO_MS = 24 * 3_600_000;
/** A vaga marcada fica no Redis até passar a hora dela mais esta folga. */
const FOLGA_DA_VEZ_MS = 6 * 3_600_000;

/** `FLOW_CONFERIR_WHATSAPP=off` desliga a consulta ao WhatsApp: o modo "conferir" passa a olhar só o cadastro. */
export function conferirWhatsAppLigado(): boolean {
  return (process.env.FLOW_CONFERIR_WHATSAPP ?? "on").trim().toLowerCase() !== "off";
}

function numeroDoEnv(nome: string, padrao: number): number {
  const n = Number(process.env[nome]);
  return process.env[nome] !== undefined && process.env[nome] !== "" && Number.isFinite(n) && n >= 0 ? n : padrao;
}

/** Sorteia o intervalo mínimo desta reserva, em ms (entre `WA_CONFERIR_RITMO_MIN_S` e `WA_CONFERIR_RITMO_MAX_S`). */
export function sortearRitmoMs(aleatorio: () => number = Math.random): number {
  const min = numeroDoEnv("WA_CONFERIR_RITMO_MIN_S", RITMO_PADRAO_MIN_S);
  const max = Math.max(min, numeroDoEnv("WA_CONFERIR_RITMO_MAX_S", RITMO_PADRAO_MAX_S));
  return Math.round((min + aleatorio() * (max - min)) * 1000);
}

/**
 * O número que o passo "Enviar mensagem" usaria, em E.164: o válido primeiro, depois o primário, depois o mais antigo
 * (a mesma ordem de `getWhatsAppNumber`), mas SÓ entre os que não foram marcados como errados. `null` = não tem número
 * que dê para usar (nenhum no cadastro, todos marcados como errados ou que não são telefone).
 */
export async function numeroParaConferir(contactId: string): Promise<string | null> {
  const linhas = await db().channelIdentifier.findMany({
    where: { contactId, canal: "whatsapp", invalido: false },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { valor: true, valorCifrado: true },
  });
  for (const l of linhas) {
    const normalizado = normalizePhone(valorDe(l));
    if (normalizado) return normalizado;
  }
  return null;
}

type ContaDeConsulta = { id: string; instance: string; status: string; paused: boolean; caiuEm: Date | null };

/**
 * A conta de WhatsApp (Evolution) do time pela qual a consulta sai: a conectada e não pausada mais antiga (a mesma
 * escolha da condição "Já tem histórico"). Sem nenhuma assim, devolve a mais antiga que exista, só para o motivo do
 * adiamento dizer se ela está caída ou pausada; `null` = o time não tem conta de WhatsApp.
 */
async function contaParaConsultar(): Promise<ContaDeConsulta | null> {
  const contas = await db().channelAccount.findMany({
    where: { canal: "whatsapp", provider: "evolution" },
    orderBy: { createdAt: "asc" },
    select: { id: true, externalId: true, credentials: true, status: true, paused: true, desconectadaEm: true, updatedAt: true },
  });
  const comInstancia = contas.flatMap((c) => {
    const instance = instanciaDaConta(c);
    return instance ? [{ id: c.id, instance, status: c.status as string, paused: c.paused, caiuEm: quandoCaiu(c) }] : [];
  });
  return comInstancia.find((c) => c.status === "connected" && !c.paused) ?? comInstancia[0] ?? null;
}

/**
 * Vaga na fila de consultas da conta, atômica: a próxima hora livre = max(agora, depois da última vaga) e a vaga
 * seguinte fica `gap` ms depois. Devolve quantos ms faltam para a vaga (0 = pode consultar já) e, se há espera,
 * grava a vaga do passo (`KEYS[2]`) para ele a resgatar quando voltar.
 *
 * Por que fila e não "tenta e, se ocupado, tenta de novo": 500 contatos chegando juntos virariam 500 passos voltando a
 * cada poucos segundos, cada volta gastando uma ficha do time e um dos 200 passos da inscrição (`FLOW_MAX_STEPS`).
 * Com a vaga marcada, cada contato espera UMA vez, o tempo exato.
 */
const VAGA_LUA = `
local agora = tonumber(ARGV[1])
local gap = tonumber(ARGV[2])
local folga = tonumber(ARGV[3])
local prox = tonumber(redis.call('GET', KEYS[1])) or 0
local vaga = math.max(agora, prox)
local espera = vaga - agora
redis.call('SET', KEYS[1], tostring(vaga + gap), 'PX', espera + gap + 60000)
if espera > 0 then
  redis.call('SET', KEYS[2], tostring(vaga), 'PX', espera + folga)
end
return espera
`;

type Vez = { ok: true } | { teto: true } | { esperaMs: number };

/**
 * Pede a vez de consultar pela conta: resgata a vaga que o passo já marcou (voltou da espera) ou, sem vaga, gasta uma
 * consulta do teto do dia e marca uma na fila. Redis fora: libera (a fila do motor também depende dele).
 */
async function pedirVez(contaId: string, enrollmentId: string, nodeId: string, agora: Date): Promise<Vez> {
  const agoraMs = agora.getTime();
  try {
    const r = redisEstado();
    const chaveDaVez = `wa:conferir:vez:${contaId}:${enrollmentId}:${nodeId}`;
    const marcada = Number(await r.get(chaveDaVez));
    let jaPagou = false;
    if (marcada > 0) {
      if (agoraMs - marcada <= VAGA_VENCE_APOS_MS) {
        if (marcada <= agoraMs + TOLERANCIA_DA_VEZ_MS) {
          await r.del(chaveDaVez);
          return { ok: true };
        }
        return { esperaMs: marcada - agoraMs };
      }
      // Vaga vencida: volta para o fim da fila. O teto desta consulta já foi pago quando a vaga foi marcada.
      await r.del(chaveDaVez);
      jaPagou = true;
    }
    // Contador compartilhado com as campanhas e a captação (mesma chave `wa:checagem:*`).
    if (!jaPagou && (await reservarNoTeto(contaId, 1, agora)) < 1) return { teto: true };
    const espera = Number(
      await r.eval(VAGA_LUA, 2, `wa:conferir:prox:${contaId}`, chaveDaVez, String(agoraMs), String(sortearRitmoMs()), String(FOLGA_DA_VEZ_MS)),
    );
    if (!Number.isFinite(espera)) throw new Error("resposta inesperada do Redis");
    return espera > 0 ? { esperaMs: espera } : { ok: true };
  } catch (e) {
    logger.warn({ contaId, err: e instanceof Error ? e.message : String(e) }, "[conferir-whatsapp] ritmo indisponível, liberando");
    return { ok: true };
  }
}

/**
 * O "não" não vai para o cache global, então o próprio passo lembra dele (Redis, só desta inscrição e deste nó, 24 h).
 * Sem isto, o nó que se reavalia (dois ramos "conferir" no mesmo nó, ou um ramo "Respondeu?" com janela ao lado)
 * consultaria o mesmo número outra vez a cada volta, gastando teto, ritmo e passos da inscrição. Melhor esforço.
 */
const chaveDoNao = (enrollmentId: string, nodeId: string, numero: string) => `wa:conferir:nao:${enrollmentId}:${nodeId}:${numero.replace(/\D/g, "")}`;

async function lembraDoNao(enrollmentId: string, nodeId: string, numero: string): Promise<boolean> {
  try {
    return (await redisEstado().get(chaveDoNao(enrollmentId, nodeId, numero))) !== null;
  } catch {
    return false;
  }
}

async function lembrarDoNao(enrollmentId: string, nodeId: string, numero: string): Promise<void> {
  try {
    await redisEstado().set(chaveDoNao(enrollmentId, nodeId, numero), "1", "PX", MEMORIA_DO_NAO_MS);
  } catch {
    /* só evita consulta repetida; sem Redis, consulta de novo */
  }
}

const adiar = (delayMs: number, motivo: string): ConferenciaDoWhatsApp => ({ adiar: { delayMs, motivo } });

/**
 * Decide "tem WhatsApp?" de UM contato conferindo no WhatsApp. Roda no contexto do time (motor, `runAsSystem`).
 * Lança `ConsultaWhatsAppIndisponivel` quando a Evolution não deu resposta.
 */
export async function conferirTemWhatsApp(input: {
  contactId: string;
  enrollmentId: string;
  nodeId: string;
  /** Horário de envio do fluxo (ausente = o da empresa). */
  janelaEnvio?: JanelaEnvio;
  agora?: Date;
}): Promise<ConferenciaDoWhatsApp> {
  requireCan("messages.send");
  const agora = input.agora ?? new Date();

  // 1) Cadastro: sem número que dê para usar, a resposta é "não" e não há o que perguntar.
  const numero = await numeroParaConferir(input.contactId);
  if (!numero) return { resposta: false, origem: "cadastro" };

  // 2) Cache global (30 dias o "tem", 7 o "não tem"). Não guarda nome nem time.
  const guardado = (await lerDoCache([numero], agora)).get(numero);
  if (guardado !== undefined) return { resposta: guardado, origem: "cache" };
  if (await lembraDoNao(input.enrollmentId, input.nodeId, numero)) return { resposta: false, origem: "lembrado" };

  // 3) Consulta nova. Consulta em rajada de madrugada parece robô, e o envio que vem depois ficaria segurado do mesmo jeito.
  const foraDoHorario = await adiamentoForaDaJanela(agora, input.janelaEnvio);
  if (foraDoHorario !== null) return adiar(foraDoHorario, MOTIVO_FORA_DO_HORARIO);

  const conta = await contaParaConsultar();
  // Sem nenhuma conta de WhatsApp (Evolution) no CRM Agro, esperar não resolve: segura para alguém conectar um número.
  if (!conta) return { segurar: { motivo: MOTIVO_SEM_CONTA } };
  if (conta.status !== "connected" || conta.paused) {
    // Caiu há pouco: tenta de novo logo (o Baileys costuma voltar sozinho). Pausada à mão ou queda longa: próximo dia.
    const curto = conta.status === "disconnected" ? adiamentoPorQueda(conta.caiuEm, agora) : null;
    return adiar(curto ?? (await adiamentoParaProximoDia(agora)), conta.status === "connected" ? MOTIVO_CONTA_PAUSADA : MOTIVO_CONTA_CAIDA);
  }

  const vez = await pedirVez(conta.id, input.enrollmentId, input.nodeId, agora);
  if ("teto" in vez) return adiar(await adiamentoParaProximoDia(agora), MOTIVO_TETO_DO_DIA);
  if ("esperaMs" in vez) return adiar(Math.max(1_000, vez.esperaMs), MOTIVO_RITMO);

  let respostas;
  try {
    respostas = await checkWhatsAppNumbers({
      apiUrl: env.EVOLUTION_API_URL,
      apiKey: env.EVOLUTION_API_KEY,
      instance: conta.instance,
      numbers: [numero],
    });
  } catch (e) {
    await devolverAoTeto(conta.id, 1, agora);
    // O texto técnico fica no log do processo; o log do fluxo (que o time lê) leva só a frase.
    logger.warn({ accountId: conta.id, err: e instanceof Error ? e.message : String(e) }, "[conferir-whatsapp] a Evolution não respondeu");
    throw new ConsultaWhatsAppIndisponivel("o WhatsApp não respondeu");
  }
  const achada = respostas.find((r) => r.numero === numero);
  if (!achada) {
    // Lista vazia ou sem o número: resposta que não dá para ler. Não é "não": tenta de novo.
    await devolverAoTeto(conta.id, 1, agora);
    throw new ConsultaWhatsAppIndisponivel("o WhatsApp devolveu uma resposta que não dá para ler");
  }

  // Só o "sim" vai ao cache. O nome que a instância conhece (`achada.nome`) é do time e não sai daqui.
  if (!achada.existe) await lembrarDoNao(input.enrollmentId, input.nodeId, numero);
  if (achada.existe) {
    await gravarNoCache([{ numero, existe: true, jid: achada.jid }], agora).catch((err) =>
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[conferir-whatsapp] não deu para guardar o \"sim\" no cache"),
    );
  }
  logger.info({ accountId: conta.id, existe: achada.existe }, "[conferir-whatsapp] número conferido");
  return { resposta: achada.existe, origem: "consulta" };
}
