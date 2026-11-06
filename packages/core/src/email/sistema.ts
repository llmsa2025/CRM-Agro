import { enviarEmailDaPlataforma, plataformaConfigurada, type EmailDaPlataforma } from "./plataforma";
import { sendTransactionalEmail } from "./service";

/**
 * E-mail de CONTA/SISTEMA (redefinir senha, convite de equipe, alerta): por
 * onde sai.
 *
 * - Remetente da plataforma ligado (qualquer PLATFORM_* no .env): SÓ por ele.
 *   Se o envio falhar, passar de um teto ou a configuração estiver inválida, o
 *   erro sobe — nunca cai na caixa de uma pessoa do time (fecha o S-05 da
 *   auditoria de isolamento).
 * - Sem configuração: como antes, pela caixa do time (`sendTransactionalEmail`
 *   com fallback "doTime") — por isso roda no contexto do time
 *   (`runWithTeam`/`runAsSystem`).
 *
 * O convite de compromisso da Agenda NÃO passa por aqui: é conversa da pessoa
 * com o contato e sai da caixa dela (`sendCalendarInvite`).
 */
export type ViaDoEmail = "plataforma" | "caixa-do-time" | "nenhuma";

export async function enviarEmailDoSistema(input: EmailDaPlataforma): Promise<{ enviado: boolean; via: ViaDoEmail }> {
  if (plataformaConfigurada()) {
    return { enviado: await enviarEmailDaPlataforma(input), via: "plataforma" };
  }
  const enviado = await sendTransactionalEmail({ to: input.to, subject: input.subject, text: input.text, ...(input.html ? { html: input.html } : {}) });
  return { enviado, via: enviado ? "caixa-do-time" : "nenhuma" };
}
