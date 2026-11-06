import { z } from "zod";
import { getCurrentTeamId } from "@crmagro/db";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import type { ContinuacaoDaBusca } from "./busca-tipos";

/**
 * Status visível de uma captação (item 3.2, INT-11/INT-12). Antes a tela só
 * fazia poll do staging: Maps bloqueado pelo Google, sessão do Instagram caída
 * ou job travado apareciam como "0 leads", sem explicação, e o job terminava
 * "concluído". Agora cada lote tem um status no Redis que o worker atualiza e a
 * tela lê: `captacao:status:<teamId>:<lote>` (por time — o lote de um time
 * nunca é lido por outro), TTL de 3 dias.
 */

export type OrigemCaptura = "maps" | "instagram" | "cnpj";

/**
 * - `na_fila` → `rodando` → um estado final:
 * - `concluida`: terminou com pelo menos 1 rascunho;
 * - `vazia`: terminou normalmente com 0 (termo sem resultado) — NÃO é sucesso;
 * - `parcial`: parou no meio (bloqueio, teto de tempo, 429, queda) com o que já
 *   veio gravado;
 * - `falhou`: parou sem nada gravado;
 * - `interrompida`: a leitura feita PELA EXTENSÃO parou por um motivo (Instagram
 *   pediu para esperar, sessão caiu, extensão desligada...), com ou sem contatos
 *   já gravados (`criados` diz quantos). É o estado final de tudo o que não
 *   terminou no caminho da extensão; `parcial` e `falhou` seguem sendo do worker.
 */
export type EstadoCaptura = "na_fila" | "rodando" | "concluida" | "vazia" | "parcial" | "falhou" | "interrompida";

/** A captura ainda vai andar (na fila ou rodando)? Os outros estados são finais. */
export function estadoEmAndamento(estado: EstadoCaptura): boolean {
  return estado === "na_fila" || estado === "rodando";
}

export type MotivoCaptura =
  | "bloqueio_google"
  | "tempo_esgotado"
  | "limite_instagram"
  | "sessao_instagram"
  | "perfil_nao_encontrado"
  | "perfil_privado"
  | "interrompida"
  | "sem_resultados"
  // Busca por filtro: leu muito e quase nada passou nos filtros.
  | "filtros_apertados"
  // Busca por filtro: a pessoa clicou em "Parar" / a fonte acabou antes da quantidade pedida.
  | "parada_pelo_usuario"
  | "fonte_esgotada"
  // Leitura pela extensão (Instagram):
  | "extensao_offline" // ninguém pegou a tarefa a tempo, ou a extensão parou no meio
  | "extensao_desatualizada" // a extensão instalada não conhece a tarefa (versão anterior à 0.5.0)
  | "cota_diaria" // teto de leituras do dia da conta, guardado na extensão
  | "conta_errada" // o Chrome está logado em outro Instagram que o da conta conectada
  | "erro";

export type StatusCaptura = {
  lote: string;
  origem: OrigemCaptura;
  estado: EstadoCaptura;
  /** CNPJ: itens da lista; Maps/Instagram: o limite pedido. */
  total: number | null;
  /** Itens lidos até agora (fichas do Maps, seguidores, CNPJs consultados). */
  processados: number;
  /** Rascunhos gravados no staging. */
  criados: number;
  falhas: number;
  /** Até 20 falhas com o motivo (CNPJ inválido, não encontrado…). */
  falhasAmostra: { item: string; motivo: string }[];
  motivo: MotivoCaptura | null;
  /** Texto pronto para a tela. */
  mensagem: string | null;
  /**
   * Instante (ISO) antes do qual não adianta tentar de novo: a extensão guarda
   * uma espera depois de um pedido do Instagram para aguardar. A tela mostra
   * "tente depois das HH:MM" no fuso de quem está olhando.
   */
  tentarDepoisDe?: string | null;
  /** Busca por filtro que parou antes do fim da fonte: de onde "Buscar mais" continua. Só vai ao servidor, nunca ao cliente. */
  continuacao?: ContinuacaoDaBusca | null;
  /** Só na resposta para a tela: dá para pedir "Buscar mais" (a `continuacao` fica no servidor). */
  podeContinuar?: boolean;
  iniciadoEm: string | null;
  atualizadoEm: string;
};

/** O status que a tela recebe: sem a continuação (cursor e filtros ficam no servidor), só o aviso de que dá para continuar. */
export function statusParaATela(st: StatusCaptura): StatusCaptura {
  const { continuacao, ...resto } = st;
  return continuacao ? { ...resto, podeContinuar: true } : resto;
}

export const STATUS_CAPTURA_TTL_S = 3 * 24 * 60 * 60;
const chave = (teamId: string, lote: string) => `captacao:status:${teamId}:${lote}`;

const loteSchema = z.string().uuid();

const statusSchema = z
  .object({
    lote: z.string(),
    origem: z.enum(["maps", "instagram", "cnpj"]),
    estado: z.enum(["na_fila", "rodando", "concluida", "vazia", "parcial", "falhou", "interrompida"]),
  })
  .passthrough();

/** Por onde a captura rodou: muda o "o que fazer" do texto (o Chrome de quem pediu, ou o servidor). */
export type ViaDaCaptura = "servidor" | "extensao";

/**
 * Mensagem padrão por motivo (a tela mostra `mensagem`; o `detalhe` técnico vai
 * junto). Diz o que aconteceu e o que fazer, em frase curta.
 */
export function mensagemDaCaptura(
  motivo: MotivoCaptura,
  origem: OrigemCaptura,
  detalhe?: string | null,
  via: ViaDaCaptura = "servidor",
): string {
  const d = detalhe ? ` (${detalhe})` : "";
  const extensao = via === "extensao";
  switch (motivo) {
    case "bloqueio_google":
      return "O Google bloqueou a busca deste servidor (tráfego incomum/captcha). Tente de novo mais tarde.";
    case "tempo_esgotado":
      return `A captura passou do tempo máximo e foi interrompida${d}. O que já foi coletado está na fila.`;
    case "limite_instagram":
      return extensao
        ? "O Instagram pediu para esperar. Paramos para não arriscar a sua conta. Tente de novo mais tarde."
        : "O Instagram limitou as requisições. Paramos para não arriscar a conta; o que já veio está na fila.";
    case "sessao_instagram":
      return extensao
        ? "A sessão do Instagram neste Chrome caiu. Entre de novo no Instagram e tente outra vez."
        : "A sessão do Instagram caiu. Reconecte a conta em Integrações → Canais.";
    case "perfil_nao_encontrado":
      return "Perfil não encontrado. Confira o @ e tente de novo.";
    case "perfil_privado":
      return "Este perfil é privado. Só dá para ler os seguidores de um perfil público ou de um que a sua conta segue.";
    case "extensao_offline":
      return "A extensão do CRM Agro não respondeu. Abra o Chrome com a extensão ligada e tente de novo.";
    case "extensao_desatualizada":
      return "A extensão do CRM Agro está desatualizada. Baixe a versão nova em Integrações, Extensão do navegador, troque os arquivos e recarregue.";
    case "cota_diaria":
      return "Chegou ao limite de leituras do dia nesta conta do Instagram. Tente amanhã ou peça menos contatos por busca.";
    case "conta_errada":
      return "Este Chrome está com outra conta do Instagram. Entre na conta conectada ao CRM Agro e tente de novo.";
    case "filtros_apertados":
      return `Leitura encerrada${d}. Deixe os filtros mais amplos ou use Buscar mais para continuar. O que passou já está na fila.`;
    case "parada_pelo_usuario":
      return "Você parou a busca. O que já veio está na fila, e dá para continuar depois com Buscar mais.";
    case "fonte_esgotada":
      return detalhe ? `Só havia ${detalhe} com esses filtros. A fonte não tem mais.` : "A fonte não tem mais empresas com esses filtros.";
    case "interrompida":
      return "A captura foi interrompida (o servidor reiniciou). O que já foi coletado está na fila.";
    case "sem_resultados":
      return origem === "maps"
        ? "Nenhum resultado para este termo (ou o Google mudou a página)."
        : origem === "instagram"
          ? "O perfil não tem seguidores visíveis."
          : "Nenhuma empresa encontrada.";
    case "erro":
      return extensao ? `A busca parou por um erro${d}. Tente de novo.` : `A captura parou por um erro${d}.`;
  }
}

export function novoStatusCaptura(p: {
  lote: string;
  origem: OrigemCaptura;
  estado: EstadoCaptura;
  total?: number | null;
}): StatusCaptura {
  return {
    lote: p.lote,
    origem: p.origem,
    estado: p.estado,
    total: p.total ?? null,
    processados: 0,
    criados: 0,
    falhas: 0,
    falhasAmostra: [],
    motivo: null,
    mensagem: null,
    iniciadoEm: null,
    atualizadoEm: new Date().toISOString(),
  };
}

/**
 * Grava o status (inteiro) do lote no time `teamId`. Nunca lança: o status é
 * aviso para a tela; uma falha do Redis não pode derrubar a captura.
 */
export async function salvarStatusCaptura(teamId: string, st: StatusCaptura): Promise<void> {
  try {
    st.atualizadoEm = new Date().toISOString();
    await redisEstado().set(chave(teamId, st.lote), JSON.stringify(st), "EX", STATUS_CAPTURA_TTL_S);
  } catch (err) {
    logger.warn({ lote: st.lote, err: err instanceof Error ? err.message : String(err) }, "[captura] não gravei o status");
  }
}

/** Lê o status de um lote de um time explícito (worker/sistema). Null se não há. */
export async function lerStatusCaptura(teamId: string, lote: string): Promise<StatusCaptura | null> {
  try {
    const raw = await redisEstado().get(chave(teamId, lote));
    if (!raw) return null;
    const r = statusSchema.safeParse(JSON.parse(raw));
    return r.success ? (r.data as unknown as StatusCaptura) : null;
  } catch (err) {
    logger.warn({ lote, err: err instanceof Error ? err.message : String(err) }, "[captura] não li o status");
    return null;
  }
}

/**
 * Status de um lote do time ATUAL (tela). O teamId vem do contexto, nunca do
 * cliente; sem contexto → null (fail-closed). Lote que não é uuid → null.
 */
export async function statusDaCaptura(lote: string): Promise<StatusCaptura | null> {
  const teamId = getCurrentTeamId();
  if (!teamId || !loteSchema.safeParse(lote).success) return null;
  return lerStatusCaptura(teamId, lote);
}


// ---------------------------------------------------------------------------
// "Parar" a busca em andamento
// ---------------------------------------------------------------------------

const chaveParar = (teamId: string, lote: string) => `captacao:parar:${teamId}:${lote}`;

/** Pede ao worker que pare a busca do lote (ele confere o pedido a cada página e a cada poucas consultas). */
export async function pedirParadaDaCaptura(teamId: string, lote: string): Promise<void> {
  await redisEstado().set(chaveParar(teamId, lote), "1", "EX", 60 * 60);
}

/** Alguém pediu para parar este lote? Falha de Redis = não (a busca segue). */
export async function paradaPedida(teamId: string, lote: string): Promise<boolean> {
  try {
    return (await redisEstado().exists(chaveParar(teamId, lote))) === 1;
  } catch {
    return false;
  }
}
