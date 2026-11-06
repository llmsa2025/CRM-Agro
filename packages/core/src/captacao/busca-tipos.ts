import type { FiltrosDaFonte, FiltrosLocais } from "@crmagro/captation";
import type { OpcoesDeEmail } from "./email-filtros";

/**
 * Tipos da busca de empresas POR FILTRO (aba "Por filtros" da captação por CNPJ).
 * Arquivo sem dependência de banco nem de fila: o job (queue.ts), o status
 * (status.ts) e o coletor (busca-filtros.ts) importam daqui, sem ciclo.
 */

/** Opções da busca que o coletor aplica ANTES de contar a quantidade pedida (o que a fonte não filtra). */
export type OpcoesDaBusca = OpcoesDeEmail & {
  /** Desligado (padrão): empresa que já é contato ou empresa de um contato do time fica fora, e não conta na quantidade. */
  incluirJaCadastradas: boolean;
};

/** Job antigo (sem `opcoes`) e busca por sócio: o comportamento de sempre, sem nenhum filtro novo. */
export const OPCOES_DA_BUSCA_ANTIGAS: OpcoesDaBusca = {
  incluirJaCadastradas: true,
  ignorarEmailContabilidade: false,
  soComEmail: false,
  emailDominio: [],
};

/** Filtros já resolvidos que vão no job: o worker não consulta nada além da fonte. */
export type FiltrosDoJob = {
  fonte: FiltrosDaFonte;
  locais: FiltrosLocais;
  /** Rótulos para mostrar ("Sorriso/MT"), só para a tela e para a origem do rascunho. */
  cidades: string[];
  /** Ausente nos jobs antigos e na busca por sócio: vale `OPCOES_DA_BUSCA_ANTIGAS`. */
  opcoes?: OpcoesDaBusca;
};

/**
 * Onde a busca parou, para "Buscar mais" continuar exatamente dali (a paginação
 * da fonte é por cursor opaco). `saltar` = quantos registros da página que
 * começa em `cursor` já foram lidos (a busca parou no meio dela ao bater o limite).
 */
export type ContinuacaoDaBusca = {
  cursor: string | null;
  saltar: number;
  /** Quantas empresas a fonte já devolveu (lidas, aprovadas ou não), somando as buscas anteriores. */
  lidasNaFonte: number;
  filtros: FiltrosDoJob;
  /** Busca por sócio: o motivo da primeira rodada continua valendo nas seguintes. */
  motivo?: string | null;
  /** A busca consultava o CNPJ de cada empresa (e-mail e sócios): "Buscar mais" continua do mesmo jeito. */
  completarContato?: boolean;
};
