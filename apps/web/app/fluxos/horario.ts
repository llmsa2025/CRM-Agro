/**
 * Regras de tela do horário de envio do fluxo. Sem "use client" e sem importar valor do `@crmagro/core`
 * (o cliente e o teste usam isto direto): só os tipos vêm de lá. Quem valida de verdade é o servidor
 * (`janelaEnvioSchema`, em `createFlow` e `updateFlow`); aqui fica só o aviso antes de salvar.
 */
import type { DiaDaSemana, JanelaEnvio } from "@crmagro/core";

export type JanelaPropria = Extract<JanelaEnvio, { modo: "propria" }>;
export type ModoDaJanela = JanelaEnvio["modo"];

/** Mesma ordem do formulário de horário da empresa (Dom a Sáb). */
export const DIAS: ReadonlyArray<{ id: DiaDaSemana; rotulo: string }> = [
  { id: "sun", rotulo: "Dom" },
  { id: "mon", rotulo: "Seg" },
  { id: "tue", rotulo: "Ter" },
  { id: "wed", rotulo: "Qua" },
  { id: "thu", rotulo: "Qui" },
  { id: "fri", rotulo: "Sex" },
  { id: "sat", rotulo: "Sáb" },
];

/** O que um fluxo NOVO traz já preenchido: seg a sex, 08:00 às 18:00, sem feriados. */
export function horarioPadraoDoFluxoNovo(): JanelaPropria {
  return { modo: "propria", abertura: "08:00", fechamento: "18:00", dias: ["mon", "tue", "wed", "thu", "fri"], feriados: true };
}

export const NOME_DO_MODO: Record<ModoDaJanela, string> = {
  propria: "Dias e horas deste fluxo",
  empresa: "Seguir o horário da empresa",
  livre: "A qualquer hora",
};

/**
 * Ao trocar de modo, "propria" volta com o que a pessoa já tinha digitado (se tinha) e, na primeira vez, com
 * o padrão. Assim, ir e voltar entre os modos não perde o horário que ela montou.
 */
export function trocarModo(atual: JanelaEnvio, modo: ModoDaJanela, ultimaPropria: JanelaPropria): JanelaEnvio {
  if (modo === atual.modo) return atual;
  if (modo === "propria") return ultimaPropria;
  return { modo };
}

/** Marca ou desmarca um dia, mantendo a ordem da semana. */
export function alternarDia(j: JanelaPropria, dia: DiaDaSemana, marcado: boolean): JanelaPropria {
  const dias = DIAS.map((d) => d.id).filter((d) => (d === dia ? marcado : j.dias.includes(d)));
  return { ...j, dias };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const emMinutos = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Mensagem para a pessoa corrigir antes de salvar, ou `null` se o horário está bom. */
export function erroDoHorario(j: JanelaEnvio): string | null {
  if (j.modo !== "propria") return null;
  if (j.dias.length === 0) return "Marque ao menos um dia.";
  if (!HHMM.test(j.abertura) || !HHMM.test(j.fechamento)) return "Preencha a abertura e o fechamento.";
  if (emMinutos(j.abertura) >= emMinutos(j.fechamento)) return "O fechamento precisa ser depois da abertura.";
  return null;
}

/** Linha curta para o nó do gatilho no canvas. */
export function rotuloCurtoDoHorario(j: JanelaEnvio): string {
  if (j.modo === "livre") return "Envia a qualquer hora";
  if (j.modo === "empresa") return "Horário da empresa";
  return `Envia das ${j.abertura} às ${j.fechamento}`;
}
