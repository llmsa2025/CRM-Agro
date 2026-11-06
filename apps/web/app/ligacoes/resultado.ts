import type { CallOutcome } from "@crmagro/core";

/**
 * Texto do toast depois de registrar o resultado da ligação (produto §D):
 * caixa postal marca um retorno em 2 dias úteis; número errado invalida o
 * número e manda o contato para "Revisar dados".
 *
 * Os rótulos ficam aqui (e não vêm de `ROTULO_RESULTADO` do core) porque este
 * arquivo entra no bundle do NAVEGADOR: importar um valor do `@crmagro/core`
 * arrasta bullmq/web-push para o cliente e quebra o build.
 */
const ROTULO = {
  answered: "Atendeu",
  no_answer: "Não atendeu",
  busy: "Ocupado",
  voicemail: "Caixa postal",
  wrong_number: "Número errado",
  skip: "Pulada",
} satisfies Record<CallOutcome, string>;

const Data = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });
const Hora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

export function mensagemDoResultado(res: {
  outcome?: CallOutcome;
  retorno?: { appointmentId: string; inicio: string | Date } | null;
  numerosInvalidados?: number;
}): string {
  if (res.outcome === "voicemail" && res.retorno) {
    const d = new Date(res.retorno.inicio);
    return `Caixa postal · retorno marcado para ${Data.format(d).replace(".", "")} às ${Hora.format(d)}`;
  }
  if (res.outcome === "wrong_number") {
    return "Número marcado como errado. O contato foi para Revisar dados";
  }
  return `${res.outcome ? ROTULO[res.outcome] : "Resultado"} registrado`;
}
