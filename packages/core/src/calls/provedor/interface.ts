import type { ResultadoDoTeste, ContextoDoProvedor, WebhookCru } from "./comum";
import type { CapacidadesDeLigacao, ChaveDeProvedorDeLigacao, ModoDeOriginarDeLigacao } from "./capacidades";
import type { RefDaLinhaDeLigacao, ResultadoDaConsultaDeLigacao, ResultadoDaNormalizacaoDeLigacao } from "./fato";

/**
 * A interface `ProvedorDeLigacao`.
 *
 * Um adaptador por provedor, métodos pequenos, todos com o contexto (credenciais já abertas, ambiente,
 * linha). O que o provedor não faz, ele DECLARA na matriz de capacidades e OMITE o método: a presença
 * dos métodos opcionais tem de bater com a matriz (o registro e a suíte de contrato conferem os dois lados).
 *
 * Regras que todo adaptador cumpre:
 * - o adaptador só TRADUZ, nunca decide desfecho. Quem calcula o resultado é o aplicador, pela tabela de causas;
 * - só lança erros neutros (`ErroDeLigacao`); o texto do provedor nunca sai daqui;
 * - o `idEvento` do adaptador é estável para o mesmo aviso: o mesmo aviso duas vezes dá o mesmo id
 *   (a caixa de entrada acrescenta a origem: `webhook`, `consulta` ou `crmagro`);
 * - `pontas` (destino e origem que o aviso traz) NUNCA vai para banco nem para log, e o fato nunca as leva;
 * - nunca loga credencial, token, telefone, SDP nem corpo de aviso.
 */

/** A linha do vendedor no provedor, com as credenciais do escopo "linha" já abertas. NUNCA logar. */
export interface LinhaDoContextoDeLigacao {
  contaExterna: string;
  idExterno: string;
  credenciais: Readonly<Record<string, string>>;
}

/**
 * O contexto do provedor (`ambiente`, `credenciais` da conta já abertas, `segredoWebhook` com a janela de
 * rotação) mais a `linha`. A linha é nula nas operações de nível conta: `testarConexao`, `provisionarLinha`
 * e a verificação do aviso quando a linha ainda não foi resolvida.
 */
export interface ContextoDaLigacao extends ContextoDoProvedor {
  readonly linha: LinhaDoContextoDeLigacao | null;
}

/** O pedido de originar uma ligação. O destino vem sempre do banco, nunca do navegador. */
export interface PedidoDeOriginacaoDeLigacao {
  /** O id da Call no CRM Agro (uuid). Volta nos avisos como `refDaLigacao`, quando o provedor o repete. */
  callId: string;
  /** Em E.164. */
  destinoE164: string;
  modo: ModoDeOriginarDeLigacao;
  linha: RefDaLinhaDeLigacao;
  gravar: boolean;
  /** O endereço de aviso, quando a matriz pede um por ligação. Nulo quando o provedor tem um só por conta. */
  urlDoCallback: string | null;
}

export interface ResultadoDaOriginacaoDeLigacao {
  providerCallId: string;
}

/** O pedido de criar uma linha no provedor. Só com `capacidades.provisionarLinha` diferente de "manual". */
export interface PedidoDeLinhaDeLigacao {
  /** Nome curto da linha na tela (ex.: o nome da pessoa). */
  rotulo: string;
}

export interface LinhaProvisionadaDeLigacao {
  idExterno: string;
  /** Os campos de escopo "linha" recém-criados. Quem recebe cifra e nunca loga. */
  credenciais: Readonly<Record<string, string>>;
}

/** A resposta síncrona que o provedor espera ao pedir o destino (Twilio). */
export interface RespostaDeOriginacaoDeLigacao {
  contentType: string;
  corpo: string;
}

export interface GravacaoDeLigacao {
  /** Os bytes, em fluxo: a cópia conta o tamanho e o sha256 enquanto lê. */
  stream: AsyncIterable<Uint8Array>;
  mime: string;
  /** O hash que o provedor informou, em hex. Nulo quando ele não informa. */
  sha256Esperado: string | null;
}

export type MotivoDeRecusaDoAvisoDeLigacao = "sem_assinatura" | "assinatura_invalida" | "fora_do_prazo";

export interface ProvedorDeLigacao {
  readonly chave: ChaveDeProvedorDeLigacao;
  /** A matriz (estática). O CRM Agro a consulta antes de agir. */
  readonly capacidades: Readonly<CapacidadesDeLigacao>;

  /** Só leitura. Credencial errada: `CredencialInvalidaDeLigacao`. Nunca cria nada. */
  testarConexao(ctx: ContextoDaLigacao): Promise<ResultadoDoTeste>;

  /**
   * Pede ao provedor que ligue. O modo pedido precisa estar em `capacidades.originar`; senão lança
   * `NaoSuportadoDeLigacao`. Devolve o id da ligação no provedor.
   */
  originar(ctx: ContextoDaLigacao, pedido: PedidoDeOriginacaoDeLigacao): Promise<ResultadoDaOriginacaoDeLigacao>;

  /** Pede ao provedor que desligue. O fim real chega depois, por aviso ou consulta. */
  encerrar(ctx: ContextoDaLigacao, providerCallId: string): Promise<void>;

  // Só com a capacidade correspondente. Sem ela, o método não existe.

  /** Só com `capacidades.consulta.porId`. Devolve o fim real da ligação, visto pelo provedor. */
  consultar?(ctx: ContextoDaLigacao, providerCallId: string): Promise<ResultadoDaConsultaDeLigacao>;
  /** Só com `capacidades.provisionarLinha` diferente de "manual". */
  provisionarLinha?(ctx: ContextoDaLigacao, pedido: PedidoDeLinhaDeLigacao): Promise<LinhaProvisionadaDeLigacao>;
  /** Só com `capacidades.originacaoSincrona`. O destino vem do banco: quem chama lê da Call do time autenticado. */
  responderOriginacao?(ctx: ContextoDaLigacao, dados: { callId: string; destinoE164: string }): RespostaDeOriginacaoDeLigacao;
  /** Só com `capacidades.gravacao.entrega` diferente de "nenhuma". */
  obterGravacao?(ctx: ContextoDaLigacao, ref: string): Promise<GravacaoDeLigacao>;
  /** Só com `capacidades.gravacao.apagavel`. */
  apagarGravacao?(ctx: ContextoDaLigacao, ref: string): Promise<void>;

  // Aviso do provedor (webhook)

  /** Confere a origem (URL assinada ou assinatura do provedor). Em tempo constante. Nunca loga o corpo. */
  verificarWebhook(ctx: ContextoDaLigacao, req: WebhookCru): { autentico: boolean; motivo?: MotivoDeRecusaDoAvisoDeLigacao };
  /**
   * PURA (sem rede nem banco). Devolve os fatos, os sinais efêmeros e as pontas. Corpo fora do schema:
   * lança. Evento que o CRM Agro não entende simplesmente não vira fato.
   */
  normalizarWebhook(corpo: unknown): ResultadoDaNormalizacaoDeLigacao;
  /**
   * O aperto de mão do GET (Meta). Devolve o desafio a repetir na resposta, ou nulo para recusar. Recebe o
   * contexto porque o token de verificação é um segredo (`ctx.segredoWebhook`).
   */
  responderVerificacao?(ctx: ContextoDaLigacao, query: Readonly<Record<string, string>>): string | null;
}

/** O contrato mínimo de uma fábrica de adaptador (o registro guarda uma por provedor). */
export type FabricaDeProvedorDeLigacao = () => ProvedorDeLigacao;
