import type { CapturaAtual, MotivoCaptura, OrigemCaptura, StatusCaptura } from "@crmagro/core";

/**
 * Regras PURAS de tela da Captação (Maps, Instagram e CNPJ): quando o botão "Buscar" fica
 * desativado, o que ele e a linha de andamento dizem, e o aviso de como a busca terminou (com o
 * motivo e o que fazer). O estado vem do SERVIDOR (o status do lote), não de uma variável do
 * navegador: por isso vale ao recarregar a página e numa segunda aba. Sem React, sem rede.
 */

/** O que a tela precisa do estado da busca (o mesmo formato da action `capturaAtualAction`). */
export type EntradaDoBotao = {
  /** A action que inicia a busca ainda não respondeu (ou a tela está recarregando o estado depois dela). */
  iniciando: boolean;
  /** A busca mais recente desta pessoa neste tipo, como o servidor devolveu. */
  atual: Pick<CapturaAtual, "emAndamento"> & { status: Pick<StatusCaptura, "estado" | "processados" | "total" | "origem"> } | null;
};

export type BotaoDaCaptura = {
  /** Botão desativado: há uma busca em andamento (ou acabando de ser pedida). */
  desativado: boolean;
  /** Texto do botão: "Buscando..." enquanto anda, senão o rótulo normal. */
  rotulo: string;
  /** "N de M" (ou "Na fila" quando o Chrome ainda não pegou). Vazio quando não há busca andando. */
  andamento: string | null;
};

/** "12 de 100". O primeiro número nunca passa do segundo (o servidor conta o que leu, não o que pediu). */
export function textoDeAndamento(st: Pick<StatusCaptura, "processados" | "total">): string {
  const lidos = Math.max(0, Math.floor(st.processados || 0));
  if (!st.total || st.total < 1) return String(lidos);
  return `${Math.min(lidos, st.total)} de ${st.total}`;
}

/**
 * Estado do botão de buscar. Regra única das três telas: desativado enquanto a busca anda, com
 * "Buscando..." e o andamento, e de volta ao normal quando termina ou falha (o servidor deixa de
 * dizer `emAndamento`, inclusive quando a busca do Instagram vence sem a extensão ter pegado).
 */
export function botaoDaCaptura(entrada: EntradaDoBotao, rotuloNormal: string): BotaoDaCaptura {
  const andando = Boolean(entrada.atual?.emAndamento);
  const desativado = entrada.iniciando || andando;
  return {
    desativado,
    rotulo: desativado ? "Buscando..." : rotuloNormal,
    andamento: andando && entrada.atual ? andamentoDaBusca(entrada.atual.status) : null,
  };
}

function andamentoDaBusca(st: Pick<StatusCaptura, "estado" | "processados" | "total" | "origem">): string {
  // Instagram pela extensão: "na fila" quer dizer que o Chrome ainda não pegou a busca.
  if (st.estado === "na_fila" && st.origem === "instagram") return "Esperando o Chrome";
  return textoDeAndamento(st);
}

// --- Aviso de como a busca terminou -------------------------------------------

export type TomDoAviso = "ok" | "info" | "aviso" | "erro";

export type AvisoDaBusca = {
  tom: TomDoAviso;
  titulo: string;
  /** Frase pronta (a do servidor, que já diz o que fazer). */
  texto: string;
  /** Contatos que já estão na fila, quando a busca parou no meio. */
  parcial: string | null;
  /** "Tente depois das 15:30" quando o Instagram pediu para esperar. */
  tentarDepois: string | null;
};

/** Título curto de cada motivo de parada. */
const TITULO_DO_MOTIVO: Record<MotivoCaptura, string> = {
  bloqueio_google: "O Google bloqueou a busca",
  tempo_esgotado: "A busca demorou demais",
  limite_instagram: "O Instagram pediu para esperar",
  sessao_instagram: "A sessão do Instagram caiu",
  perfil_nao_encontrado: "Perfil não encontrado",
  perfil_privado: "Perfil privado",
  interrompida: "A busca foi interrompida",
  sem_resultados: "Nada encontrado",
  filtros_apertados: "Poucas empresas passaram nos filtros",
  parada_pelo_usuario: "Busca parada",
  fonte_esgotada: "A fonte não tem mais",
  extensao_offline: "A extensão não respondeu",
  extensao_desatualizada: "Extensão desatualizada",
  cota_diaria: "Limite do dia atingido",
  conta_errada: "Outra conta do Instagram neste Chrome",
  erro: "A busca parou",
};

/** Um resultado só aparece na tela por este tempo depois de terminar (não fica para sempre). */
export const RESULTADO_VISIVEL_MS = 30 * 60_000;

/** "15:30" no fuso de quem está olhando, se o instante ainda está no futuro. */
export function tentarDepoisDas(iso: string | null | undefined, agora: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= agora) return null;
  return new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Aviso do que aconteceu com a última busca, ou null quando não há o que dizer: busca ainda andando
 * (o botão já mostra), nenhuma busca, ou resultado antigo demais. `agora` vem de fora (teste).
 */
export function avisoDaBusca(atual: CapturaAtual | null, agora: number): AvisoDaBusca | null {
  if (!atual || atual.emAndamento) return null;
  const st = atual.status;
  const ultimo = Date.parse(st.atualizadoEm);
  if (!Number.isFinite(ultimo) || agora - ultimo > RESULTADO_VISIVEL_MS) return null;
  if (st.estado === "na_fila" || st.estado === "rodando") return null; // parada sem sinal, e o servidor já não a conta como andando

  const n = st.criados;
  const contatos = n === 1 ? "1 contato" : `${n} contatos`;
  if (st.estado === "concluida" && st.motivo === "fonte_esgotada") {
    // Pediu mais do que a fonte tinha: o texto do servidor diz quantas havia.
    return { tom: "info", titulo: TITULO_DO_MOTIVO.fonte_esgotada, texto: `${st.mensagem ?? "A fonte não tem mais empresas com esses filtros."} ${contatos} na fila para revisar.`, parcial: null, tentarDepois: null };
  }
  if (st.estado === "concluida") {
    return { tom: "ok", titulo: "Busca concluída", texto: `${contatos} na fila para revisar.`, parcial: null, tentarDepois: null };
  }
  const motivo = st.motivo ?? "erro";
  return {
    // Nada encontrado é aviso; parou no meio com contatos já na fila é aviso; sem nada, erro.
    tom: st.motivo === "parada_pelo_usuario" ? "info" : st.estado === "vazia" ? "aviso" : n > 0 ? "aviso" : "erro",
    titulo: TITULO_DO_MOTIVO[motivo] ?? "A busca parou",
    texto: st.mensagem ?? "A busca parou. Tente de novo.",
    parcial: st.estado !== "vazia" && n > 0 ? `${contatos} já ${n === 1 ? "está" : "estão"} na fila.` : null,
    tentarDepois: tentarDepoisDas(st.tentarDepoisDe, agora),
  };
}

// --- Erro ao pedir a busca ------------------------------------------------------

/** Código que `startInstagramCaptureAction` devolve (o servidor recusou antes de começar). */
export type CodigoDoErroAoIniciar = "em_andamento" | "extensao_offline" | "conta_ausente" | "sem_conta" | "perfil_invalido" | "sem_permissao" | "erro";

const TITULO_DO_ERRO: Record<CodigoDoErroAoIniciar, string> = {
  em_andamento: "Já existe uma busca em andamento",
  extensao_offline: "Chrome ou extensão desligados",
  conta_ausente: "Instagram não encontrado neste Chrome",
  sem_conta: "Instagram não conectado",
  perfil_invalido: "Confira o @ do perfil",
  sem_permissao: "Sem permissão",
  erro: "Não deu para iniciar a busca",
};

/** Aviso para a recusa do servidor ao pedir uma busca. O texto é o do servidor (já diz o que fazer). */
export function avisoDoErroAoIniciar(codigo: string | undefined, texto: string): AvisoDaBusca {
  const conhecido = codigo !== undefined && Object.hasOwn(TITULO_DO_ERRO, codigo);
  return {
    tom: codigo === "em_andamento" ? "info" : "erro",
    titulo: conhecido ? TITULO_DO_ERRO[codigo as CodigoDoErroAoIniciar] : TITULO_DO_ERRO.erro,
    texto,
    parcial: null,
    tentarDepois: null,
  };
}

/** Origens que têm busca em segundo plano (as três da Captação). */
export const ORIGENS_DE_BUSCA: readonly OrigemCaptura[] = ["maps", "instagram", "cnpj"];
