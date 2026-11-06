import { createHash } from "node:crypto";
import { isChannelSendFailed } from "@crmagro/channels";

/**
 * Envio de mídia com desfecho INCERTO (bug "imagem com erro, mas entregue").
 *
 * O envio de mídia é lento (o base64 sobe inteiro para a Evolution, que ainda
 * sobe para o WhatsApp). Se o nosso prazo estoura, ou a Evolution devolve um
 * erro DEPOIS de aceitar, a mensagem pode ter saído mesmo assim. Tratar isso
 * como falha definitiva mostrava o ícone vermelho numa imagem que já estava no
 * celular do destinatário — e, como a linha falha nascia sem o id do WhatsApp,
 * o recibo ✓✓ nunca a encontrava para corrigir.
 *
 * Regra: desfecho incerto grava a mensagem como `failed` (conservador para o
 * painel de saúde e para o histórico) MAS com a marca `meta.envio =
 * "nao_confirmado"`. Enquanto a marca é recente, a tela mostra "não
 * confirmado" (âmbar) em vez de "falhou" (vermelho), e o ECO `fromMe` da
 * própria Evolution (ou o recibo) promove a mensagem. Só sem nenhum sinal
 * dentro da janela é que a falha vale — e aí volta a ser vermelha.
 */

/** Valor de `Message.meta.envio` das mídias cujo envio não deu para confirmar. */
export const ENVIO_NAO_CONFIRMADO = "nao_confirmado";

/** Valor de `Message.meta.origem` nas linhas de saída gravadas a partir do eco `fromMe` do WhatsApp. */
export const ORIGEM_ECO = "eco";

/** Status que a UI recebe (só no DTO — o banco continua `failed`). */
export const STATUS_UI_NAO_CONFIRMADO = "unconfirmed";

/**
 * Quanto tempo um envio incerto espera pelo eco/recibo antes de valer como
 * falha. Também é a janela em que reenviar o MESMO arquivo pede confirmação.
 */
export const JANELA_CONFIRMACAO_MS = 10 * 60_000;

/**
 * O envio falhou, mas a mensagem PODE ter saído? Sim quando: o prazo estourou
 * ou a conexão caiu depois de aberta (`unknown`); a Evolution respondeu 5xx
 * (falhou no meio do caminho); ou o erro dela é o "Timed Out" do Baileys (o
 * servidor do WhatsApp não confirmou a tempo, mas a mensagem segue viva).
 * Erro de validação (4xx: número inexistente etc.) e conexão recusada não
 * saíram — continuam falha definitiva.
 */
export function envioPodeTerSaido(e: unknown): boolean {
  if (!isChannelSendFailed(e)) return false;
  if (e.outcome === "unknown") return true;
  if ((e.status ?? 0) >= 500) return true;
  return /timed?[\s_-]?out/i.test(e.message);
}

/** Impressão digital do arquivo (base64) — reconhece o MESMO arquivo reenviado. */
export function impressaoDoArquivo(base64: string): string {
  return createHash("sha256").update(base64).digest("hex");
}

/**
 * Status que a tela mostra. `failed` com a marca de incerto, ainda dentro da
 * janela, vira "unconfirmed"; qualquer outra coisa passa como está.
 */
export function statusExibido(status: string, meta: unknown, criadaEm: Date, agora = Date.now()): string {
  if (status !== "failed") return status;
  const envio = (meta as { envio?: unknown } | null | undefined)?.envio;
  if (envio === ENVIO_NAO_CONFIRMADO && agora - criadaEm.getTime() < JANELA_CONFIRMACAO_MS) {
    return STATUS_UI_NAO_CONFIRMADO;
  }
  return status;
}

/**
 * Reenvio do MESMO arquivo enquanto o anterior ainda não foi confirmado: pode
 * duplicar no celular do destinatário. A tela avisa e o usuário decide.
 */
export class EnvioAindaNaoConfirmado extends Error {
  constructor() {
    super(
      "EnvioAindaNaoConfirmado: o envio anterior deste mesmo arquivo ainda não foi confirmado e pode já ter chegado. Confira no WhatsApp antes de enviar de novo.",
    );
    this.name = "EnvioAindaNaoConfirmado";
  }
}
