import type { CallStatus, Prisma } from "@prisma/client";
import { getCurrentTeamId, tenantData, type TenantPrismaClient } from "@crmagro/db";
import { ondeIdentificadorExato } from "../contacts/identificadores-cifra";
import { phoneVariants } from "@crmagro/channels";
import { getActor } from "../auth/authz";
import { getNextCallSlot, isBusinessHour } from "../motor-do-dia/business-hours";
import { toBusinessHoursOptions, type TeamConfigDTO } from "../motor-do-dia/team-config";
import { zonedParts, zonedTimeToUtc } from "../motor-do-dia/tz";
import type { CallOutcome } from "./schema";

/**
 * Resultado da ligação (produto §D): o que acontece ALÉM de gravar o status.
 *
 * Antes o resultado era só answered/no_answer/busy/skip: "caixa postal" virava
 * "não atendeu" sem retorno marcado, e "número errado" ficava num texto livre
 * — o número seguia nas campanhas e nos fluxos. Agora:
 *  - `voicemail` → compromisso `ligacao` (retorno) em 2 dias úteis do time,
 *    no mesmo horário da ligação (ou na abertura, se cair fora da janela);
 *  - `wrong_number` → o identificador discado fica `invalido` (com o motivo),
 *    tag `Número errado` no contato (entra em "Revisar dados") e quem ainda
 *    ia receber campanha nesse número é pulado. A lista da próxima campanha
 *    conta o número como "sem WhatsApp".
 *
 * Os efeitos rodam na MESMA transação que grava o resultado e só quando o
 * resultado MUDA (compare-and-set em `Call.outcome`): clicar duas vezes em
 * "caixa postal" não marca dois retornos.
 */

export const TAG_NUMERO_ERRADO = "Número errado";
export const MOTIVO_NUMERO_ERRADO = "número errado";
/** Retorno automático da caixa postal (dias úteis do time). */
export const DIAS_UTEIS_RETORNO_CAIXA_POSTAL = 2;

type TxDoTime = Parameters<Parameters<TenantPrismaClient["$transaction"]>[0]>[0];

/** Texto da Activity de ligação por resultado (os 4 antigos mantêm o texto de antes). */
export function textoDoResultado(outcome: CallOutcome): string {
  switch (outcome) {
    case "answered":
      return "Ligação atendida";
    case "no_answer":
      return "Ligação não atendida";
    case "busy":
      return "Ligação ocupado";
    case "voicemail":
      return "Ligação caiu na caixa postal";
    case "wrong_number":
      return "Ligação para número errado";
    case "skip":
      return "Ligação pulada";
  }
}

/**
 * Status da Call para os resultados novos (os antigos seguem o mapa de cada
 * tela). Caixa postal = ninguém atendeu; número errado = não chegou no contato.
 */
export const STATUS_DOS_RESULTADOS_NOVOS = {
  voicemail: "no_answer",
  wrong_number: "failed",
} as const satisfies Record<"voicemail" | "wrong_number", CallStatus>;

/**
 * Data do retorno: `dias` dias úteis depois de `agora` (dias úteis e feriados
 * da config do time — mesmo calendário do discador e da janela de envio), no
 * mesmo horário da ligação; fora da janela do time, na abertura daquele dia.
 */
export function retornoEmDiasUteis(agora: Date, dias: number, cfg: TeamConfigDTO): Date {
  const tz = cfg.timezone;
  // O calendário vale sempre aqui — o toggle `respectBusinessHours` é só do discador.
  const opts = { ...toBusinessHoursOptions(cfg), respectBusinessHours: true };
  let dia = agora;
  for (let i = 0; i < dias; i++) {
    const p = zonedParts(dia, tz);
    // Abertura do próximo dia útil (pula fim de semana e feriado).
    dia = getNextCallSlot(zonedTimeToUtc(p.year, p.month, p.day + 1, 0, 0, tz), opts);
  }
  const hora = zonedParts(agora, tz);
  const d = zonedParts(dia, tz);
  const mesmoHorario = zonedTimeToUtc(d.year, d.month, d.day, hora.hour, hora.minute, tz);
  return isBusinessHour(mesmoHorario, opts) ? mesmoHorario : dia;
}

export type EfeitosDoResultado = {
  /** Retorno marcado pela caixa postal (compromisso na Agenda). */
  retorno: { appointmentId: string; inicio: string } | null;
  /** Quantos identificadores do contato ficaram inválidos (número errado). */
  numerosInvalidados: number;
};

const SEM_EFEITO: EfeitosDoResultado = { retorno: null, numerosInvalidados: 0 };

const dataCurta = (d: Date, tz: string) =>
  d.toLocaleString("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * Efeitos do resultado, DENTRO da transação do time. Só roda quando o
 * resultado acabou de mudar (ver `registrarResultado`). `cfg` só é usado na
 * caixa postal.
 */
async function efeitosDoResultado(
  tx: TxDoTime,
  call: { id: string; contactId: string; phoneNumber: string },
  outcome: CallOutcome,
  ctx: { agora: Date; cfg: TeamConfigDTO | null; contatoNome: string },
): Promise<EfeitosDoResultado> {
  if (outcome === "voicemail" && ctx.cfg) {
    const inicio = retornoEmDiasUteis(ctx.agora, DIAS_UTEIS_RETORNO_CAIXA_POSTAL, ctx.cfg);
    // O retorno é de quem ligou (Agenda §E: lembrete e rota do dia são de uma
    // pessoa). Pelo sistema (webhook da Voopi) ou com sessão cujo usuário não
    // existe mais no time: fica "do time", sem responsável.
    const ator = getActor();
    const responsavelId =
      ator && !ator.system && (await tx.user.count({ where: { id: ator.userId } })) === 1 ? ator.userId : null;
    const a = await tx.appointment.create({
      data: tenantData<Prisma.AppointmentUncheckedCreateInput>({
        contactId: call.contactId,
        titulo: `Retornar ligação para ${ctx.contatoNome}`,
        descricao: `Caixa postal em ${dataCurta(ctx.agora, ctx.cfg.timezone)} (${call.phoneNumber}). Retorno marcado automaticamente.`,
        tipo: "ligacao",
        inicio,
        responsavelId,
      }),
      select: { id: true, inicio: true },
    });
    return { retorno: { appointmentId: a.id, inicio: a.inicio.toISOString() }, numerosInvalidados: 0 };
  }

  if (outcome === "wrong_number") {
    // O número discado, com e sem o nono dígito (é o mesmo celular).
    const variantes = phoneVariants(call.phoneNumber);
    const quando = ctx.agora.toISOString().slice(0, 10);
    const { count } = await tx.channelIdentifier.updateMany({
      where: { contactId: call.contactId, ...ondeIdentificadorExato(getCurrentTeamId() ?? "", "whatsapp", variantes), invalido: false },
      data: { invalido: true, invalidoMotivo: `${MOTIVO_NUMERO_ERRADO} (ligação de ${quando})` },
    });
    // Tag sem duplicar (mesmo padrão do opt-out): o UPDATE trava a linha e as
    // tags são lidas sob a trava.
    const { tags } = await tx.contact.update({
      where: { id: call.contactId },
      data: { updatedAt: ctx.agora },
      select: { tags: true },
    });
    if (!tags.includes(TAG_NUMERO_ERRADO)) {
      await tx.contact.update({ where: { id: call.contactId }, data: { tags: { set: [...tags, TAG_NUMERO_ERRADO] } } });
    }
    // Campanha que ainda ia mandar para esse número não manda mais. `sending`
    // fica com o worker (a mensagem já está saindo).
    await tx.campaignRecipient.updateMany({
      where: { contactId: call.contactId, telefone: { in: variantes }, status: { in: ["queued", "held"] } },
      data: { status: "skipped", motivo: MOTIVO_NUMERO_ERRADO },
    });
    return { retorno: null, numerosInvalidados: count };
  }

  return SEM_EFEITO;
}

/**
 * "Número errado" marcado por engano: ao TROCAR o resultado desta ligação para
 * outro, o número volta a valer (só os identificadores que esta marcação
 * invalidou — o mesmo número discado e o motivo "número errado", se nenhuma
 * outra ligação também o deu como errado) e a tag sai se não sobrou outro
 * número errado no contato. Destinatários de campanha já pulados continuam
 * pulados (a campanha pode ter andado).
 */
async function desfazerNumeroErrado(tx: TxDoTime, call: { id: string; contactId: string; phoneNumber: string }): Promise<void> {
  const variantes = phoneVariants(call.phoneNumber);
  // Outra ligação também deu esse número como errado: a marcação continua.
  const outraLigacao = await tx.call.count({
    where: { contactId: call.contactId, phoneNumber: { in: variantes }, outcome: "wrong_number", id: { not: call.id } },
  });
  if (outraLigacao > 0) return;
  await tx.channelIdentifier.updateMany({
    where: {
      contactId: call.contactId,
      ...ondeIdentificadorExato(getCurrentTeamId() ?? "", "whatsapp", variantes),
      invalido: true,
      invalidoMotivo: { startsWith: MOTIVO_NUMERO_ERRADO },
    },
    data: { invalido: false, invalidoMotivo: null },
  });
  const outroErrado = await tx.channelIdentifier.count({
    where: { contactId: call.contactId, canal: "whatsapp", invalido: true, invalidoMotivo: { startsWith: MOTIVO_NUMERO_ERRADO } },
  });
  if (outroErrado > 0) return;
  const { tags } = await tx.contact.update({ where: { id: call.contactId }, data: { updatedAt: new Date() }, select: { tags: true } });
  if (tags.includes(TAG_NUMERO_ERRADO)) {
    await tx.contact.update({ where: { id: call.contactId }, data: { tags: { set: tags.filter((t) => t !== TAG_NUMERO_ERRADO) } } });
  }
}

/**
 * Grava o resultado na Call e roda os efeitos SÓ se ele mudou (compare-and-set
 * em `Call.outcome`, dentro da transação de quem chama — que já travou a linha
 * da Call com o UPDATE do status). Trocar DE "número errado" para outro
 * resultado desfaz a marcação do número.
 *
 * `soSeVazio`: só grava se a ligação ainda não tem resultado — é o caso da
 * Voopi, que nunca passa por cima do que o vendedor marcou.
 */
export async function registrarResultado(
  tx: TxDoTime,
  call: { id: string; contactId: string; phoneNumber: string },
  outcome: CallOutcome,
  ctx: { agora: Date; cfg: TeamConfigDTO | null; contatoNome: string; soSeVazio?: boolean },
): Promise<EfeitosDoResultado & { mudou: boolean }> {
  const antes = await tx.call.findUnique({ where: { id: call.id }, select: { outcome: true } });
  const { count } = await tx.call.updateMany({
    where: ctx.soSeVazio
      ? { id: call.id, outcome: null }
      : { id: call.id, OR: [{ outcome: null }, { outcome: { not: outcome } }] },
    data: { outcome },
  });
  if (count !== 1) return { ...SEM_EFEITO, mudou: false };
  if (antes?.outcome === "wrong_number") await desfazerNumeroErrado(tx, call);
  return { ...(await efeitosDoResultado(tx, call, outcome, ctx)), mudou: true };
}
