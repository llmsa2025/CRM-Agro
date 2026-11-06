import type { CodigoDeErroDaLigacao, FaseDaLigacao } from "./estado";
import type { CodigoDoMotor, MotivoLocalDoFim } from "./motor";

/**
 * Os textos da ligação na tela (AGENTS.md (texto da interface)): frase curta, sem travessão, sem exclamação, "o CRM Agro".
 * Tudo aqui é puro. O texto do selo "Comprovada pelo provedor" NÃO mora aqui: é de `lib/ligacao-selo.ts` (F1A-07).
 */

/** Segundos para `mm:ss` (ou `h:mm:ss` a partir de 1 hora). Valor ruim vira `00:00`. */
export function formatarDuracao(totalSegundos: number): string {
  const s = Number.isFinite(totalSegundos) ? Math.max(0, Math.floor(totalSegundos)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(seg).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Quantos segundos se passaram desde `inicio` (milissegundos). Zero se o instante vier ruim ou do futuro. */
export function segundosDesde(inicio: number | null, agora: number): number {
  if (inicio === null || !Number.isFinite(inicio) || !Number.isFinite(agora)) return 0;
  return Math.max(0, Math.floor((agora - inicio) / 1000));
}

/** O nome do erro que o `getUserMedia` lançou, sem confiar no tipo de quem lançou. */
function nomeDoErro(e: unknown): string {
  if (typeof e === "object" && e !== null && "name" in e) return String((e as { name: unknown }).name);
  return "";
}

/** O que o navegador disse sobre o microfone, em português do dia a dia. */
export function mensagemDoMicrofone(e: unknown): string {
  switch (nomeDoErro(e)) {
    case "NotAllowedError":
    case "SecurityError":
      return "O navegador bloqueou o microfone. Libere o microfone para o CRM Agro e tente de novo.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Não achei um microfone neste computador. Conecte um fone e tente de novo.";
    case "NotReadableError":
      return "O microfone está em uso por outro programa. Feche-o e tente de novo.";
    default:
      return "Não deu para abrir o microfone.";
  }
}

/** O erro do `getUserMedia` como código fechado do motor (para o motor lançar `ErroDoMotor`). */
export function codigoDoErroDeMicrofone(e: unknown): CodigoDoMotor {
  switch (nomeDoErro(e)) {
    case "NotAllowedError":
    case "SecurityError":
      return "microfone_negado";
    case "NotFoundError":
    case "OverconstrainedError":
    case "NotReadableError":
      return "sem_microfone";
    default:
      return "sem_audio";
  }
}

const MENSAGEM_POR_CODIGO: Record<CodigoDeErroDaLigacao, string> = {
  microfone_negado: "O navegador bloqueou o microfone. Libere o microfone para o CRM Agro e tente de novo.",
  sem_microfone: "Não achei um microfone disponível. Conecte um fone, feche os programas que usam o microfone e tente de novo.",
  navegador_sem_suporte: "Este navegador não faz ligação pelo CRM Agro. Use o Chrome, o Edge ou o Safari atualizados.",
  sem_audio: "Não deu para abrir o áudio da ligação. Tente de novo.",
  conexao_caiu: "A conexão caiu. Confira a internet e tente de novo.",
  provedor: "O provedor de ligação não respondeu como esperado. Tente de novo em instantes.",
  sem_resposta: "O CRM Agro não respondeu. Tente de novo em instantes.",
};

/** A frase para o vendedor de cada falha técnica da ligação. */
export function mensagemDoCodigoDoMotor(codigo: CodigoDeErroDaLigacao): string {
  return MENSAGEM_POR_CODIGO[codigo];
}

const ROTULO_DA_FASE: Record<FaseDaLigacao, string> = {
  livre: "Sem ligação",
  pedindo: "Pedindo a ligação",
  preparando: "Conectando",
  chamando: "Chamando",
  em_conversa: "Em ligação",
  encerrada: "Ligação encerrada",
  excecao: "Não foi possível ligar",
  erro: "Ligação com problema",
};

export function rotuloDaFase(fase: FaseDaLigacao): string {
  return ROTULO_DA_FASE[fase];
}

const ROTULO_DO_RESULTADO: Readonly<Record<string, string>> = {
  answered: "Atendida",
  no_answer: "Não atendeu",
  busy: "Ocupado",
  voicemail: "Caixa postal",
  wrong_number: "Número errado",
  rejected: "Recusada",
};

/** O resultado que o provedor confirmou, em palavras. Resultado que a tela não conhece vira "Sem resultado". */
export function rotuloDoResultado(outcome: string | null): string {
  if (outcome !== null && Object.hasOwn(ROTULO_DO_RESULTADO, outcome)) return ROTULO_DO_RESULTADO[outcome] ?? "Sem resultado";
  return "Sem resultado";
}

const ROTULO_DO_MOTIVO_LOCAL: Record<MotivoLocalDoFim, string> = {
  desligou: "Você desligou",
  contato_desligou: "O contato desligou",
  falha_de_rede: "A conexão caiu",
  desconhecido: "A ligação terminou",
};

export function rotuloDoMotivoLocal(motivo: MotivoLocalDoFim): string {
  return ROTULO_DO_MOTIVO_LOCAL[motivo];
}
