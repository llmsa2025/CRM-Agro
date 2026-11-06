/**
 * Regras puras do menu da mensagem (Copiar, Selecionar, Compartilhar) nas
 * Conversas. Sem DOM: o vitest do web roda sem jsdom, então o que dá para
 * decidir sem tela fica aqui e os componentes só chamam estas funções.
 */
import type { MessageDTO, ResultadoEncaminhamento } from "@crmagro/core";

/** Espelho de `encaminhar-limites.ts` do core (o teste confere os dois). O servidor é quem manda. */
export const MAX_DESTINOS_ENCAMINHAR = 5;
export const MAX_MENSAGENS_ENCAMINHAR = 10;

/** Toque longo (celular): tempo parado e quanto o dedo pode andar (px) antes de virar rolagem. */
export const TOQUE_LONGO_MS = 500;
export const TOQUE_LONGO_TOLERANCIA_PX = 10;

/** O que estas regras precisam saber de uma mensagem. */
export type MensagemDoMenu = Pick<MessageDTO, "id" | "tipo" | "conteudo" | "mediaUrl" | "status">;

/**
 * Texto que o copiar leva: o conteúdo puro da mensagem, exatamente como está
 * (sem hora nem nome). `null` = nada a copiar: documento (o conteúdo é só o nome
 * do arquivo) ou texto vazio/só espaços. Mídia com legenda copia a legenda.
 */
export function textoCopiavel(m: Pick<MessageDTO, "tipo" | "conteudo">): string | null {
  if (m.tipo === "doc") return null;
  if (!m.conteudo || m.conteudo.trim() === "") return null;
  return m.conteudo;
}

/**
 * Texto do "Copiar" do menu: se a pessoa tinha um trecho da PRÓPRIA mensagem
 * selecionado na hora do clique direito, copia o trecho; senão, a mensagem toda.
 */
export function textoParaCopiar(m: Pick<MessageDTO, "tipo" | "conteudo">, trechoSelecionado: string): string | null {
  if (trechoSelecionado.trim() !== "") return trechoSelecionado;
  return textoCopiavel(m);
}

/** Texto das mensagens escolhidas, na ordem da conversa, uma por bloco. `null` = nenhuma tem texto. */
export function textoDasMensagens(mensagens: readonly Pick<MessageDTO, "tipo" | "conteudo">[]): string | null {
  const textos = mensagens.map(textoCopiavel).filter((t): t is string => t !== null);
  return textos.length > 0 ? textos.join("\n\n") : null;
}

/** Mensagem que ainda só existe na tela (otimista, ainda subindo): não tem o que encaminhar. */
function aindaNaoGravada(m: Pick<MessageDTO, "id" | "status">): boolean {
  return m.id.startsWith("temp-") || m.status === "sending";
}

/**
 * Dá para compartilhar? Precisa estar gravada, e ter o que reenviar: texto com
 * conteúdo ou mídia com arquivo. (O servidor confere de novo; aqui só evita
 * oferecer o que vai falhar.)
 */
export function podeCompartilhar(m: MensagemDoMenu): boolean {
  if (aindaNaoGravada(m)) return false;
  if (m.tipo === "text") return Boolean(m.conteudo && m.conteudo.trim() !== "");
  return Boolean(m.mediaUrl);
}

/** As mensagens escolhidas, na ordem em que aparecem na conversa (a ordem em que a pessoa clicou não conta). */
export function selecionadasEmOrdem<T extends { id: string }>(mensagens: readonly T[], ids: ReadonlySet<string>): T[] {
  return mensagens.filter((m) => ids.has(m.id));
}

export type SituacaoDoCompartilhar = { ok: true } | { ok: false; motivo: string };

/** O botão "Compartilhar" da barra pode agir com estas mensagens escolhidas? Se não, o porquê. */
export function situacaoDoCompartilhar(escolhidas: readonly MensagemDoMenu[]): SituacaoDoCompartilhar {
  if (escolhidas.length === 0) return { ok: false, motivo: "Escolha ao menos uma mensagem." };
  if (escolhidas.length > MAX_MENSAGENS_ENCAMINHAR) {
    return { ok: false, motivo: `Para compartilhar, escolha até ${MAX_MENSAGENS_ENCAMINHAR} mensagens.` };
  }
  if (!escolhidas.every(podeCompartilhar)) return { ok: false, motivo: "Uma das mensagens ainda não pode ser compartilhada." };
  return { ok: true };
}

/** "1 selecionada", "3 selecionadas". */
export function rotuloDeSelecionadas(n: number): string {
  return n === 1 ? "1 selecionada" : `${n} selecionadas`;
}

/** Como a mensagem aparece no resumo do pop-up de compartilhar: o texto (curto) ou o tipo da mídia. */
export function rotuloDaMensagem(m: Pick<MessageDTO, "tipo" | "conteudo">, max = 80): string {
  const texto = (m.conteudo ?? "").replace(/\s+/g, " ").trim();
  const cortado = texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
  if (m.tipo === "text") return cortado || "Mensagem";
  const tipo = m.tipo === "image" ? "Imagem" : m.tipo === "audio" ? "Áudio" : "Documento";
  return m.tipo !== "doc" && cortado ? `${tipo}: ${cortado}` : tipo;
}

/** Tecla que abre o menu no teclado: a tecla de menu ou Shift+F10. */
export function ehTeclaDoMenu(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

/** Para onde vai o foco ao apertar uma seta na lista de mensagens. `null` = a tecla não é de navegação. */
export function proximoIndiceDaLista(atual: number, total: number, tecla: string): number | null {
  if (total <= 0) return null;
  if (tecla === "ArrowDown") return Math.min(total - 1, atual + 1);
  if (tecla === "ArrowUp") return Math.max(0, atual - 1);
  if (tecla === "Home") return 0;
  if (tecla === "End") return total - 1;
  return null;
}

/** O dedo andou demais para ser um toque longo (é rolagem)? */
export function dedoAndouDemais(dx: number, dy: number, tolerancia = TOQUE_LONGO_TOLERANCIA_PX): boolean {
  return Math.hypot(dx, dy) > tolerancia;
}

export type ResumoDoEncaminhamento = {
  /** ok = tudo saiu; parcial = saiu para alguns; erro = nada saiu. */
  tipo: "ok" | "parcial" | "erro";
  titulo: string;
  /** Uma linha por destino com problema: "Nome: o que houve". */
  detalhes: string[];
  /** Algum envio ficou sem confirmação do WhatsApp (pode já ter chegado). */
  aviso: string | null;
};

/** Frases do resultado do encaminhamento, para o toast e para o pop-up. */
export function resumoDoEncaminhamento(r: Pick<ResultadoEncaminhamento, "destinos" | "ok" | "falhas">, mensagens: number): ResumoDoEncaminhamento {
  const detalhes = r.destinos.filter((d) => d.erro).map((d) => `${d.nome}: ${d.erro}`);
  const naoConfirmadas = r.destinos.reduce((soma, d) => soma + d.naoConfirmadas, 0);
  const aviso = naoConfirmadas > 0 ? "Alguma mídia não foi confirmada pelo WhatsApp e pode já ter chegado. Confira antes de reenviar." : null;
  const total = r.destinos.length;
  if (r.falhas === 0) {
    const o = mensagens === 1 ? "Mensagem encaminhada" : `${mensagens} mensagens encaminhadas`;
    return { tipo: "ok", titulo: total > 1 ? `${o} para ${total} conversas` : o, detalhes, aviso };
  }
  if (r.destinos.every((d) => d.enviadas === 0)) {
    return { tipo: "erro", titulo: "Não foi possível encaminhar", detalhes, aviso };
  }
  // Saiu alguma coisa, mas nem tudo: conta os destinos completos, ou diz que foi só uma parte
  // (quando nenhum destino recebeu o pedido inteiro).
  const titulo = r.ok === 0 ? "Só uma parte foi encaminhada" : `Encaminhada para ${r.ok} de ${total} conversas`;
  return { tipo: "parcial", titulo, detalhes, aviso };
}
