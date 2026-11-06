import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { WebhookCru, ResultadoDoTeste } from "../comum";
import { fabricarIdDeEvento, iguaisEmTempoConstante, confereComSegredo } from "../comum";
import { MODOS_DE_ORIGINAR_DE_LIGACAO, definirCapacidadesDeLigacao, type CapacidadesDeLigacao, type ChaveDeProvedorDeLigacao, type ModoDeOriginarDeLigacao } from "../capacidades";
import {
  CredencialInvalidaDeLigacao,
  DestinoInvalidoDeLigacao,
  ErroDeLigacao,
  LimiteDeRequisicoesDeLigacao,
  LinhaOcupadaDeLigacao,
  NaoEncontradoDeLigacao,
  NaoSuportadoDeLigacao,
  ProvedorIndisponivelDeLigacao,
  RecusadoPeloProvedorDeLigacao,
} from "../erros";
import {
  CausaDeLigacaoSchema,
  type CausaDeLigacao,
  type FatoDeLigacao,
  type PontaDeLigacao,
  type RefDaLinhaDeLigacao,
  type ResultadoDaConsultaDeLigacao,
  type ResultadoDaNormalizacaoDeLigacao,
  type SinalEfemeroDeLigacao,
} from "../fato";
import type {
  ContextoDaLigacao,
  GravacaoDeLigacao,
  LinhaProvisionadaDeLigacao,
  MotivoDeRecusaDoAvisoDeLigacao,
  PedidoDeLinhaDeLigacao,
  PedidoDeOriginacaoDeLigacao,
  ProvedorDeLigacao,
  RespostaDeOriginacaoDeLigacao,
  ResultadoDaOriginacaoDeLigacao,
} from "../interface";
import { PREFIXO_DA_CHAVE_DO_FAKE_DE_LIGACAO, capacidadesDoPerfilDeLigacao, comportamentoDoPerfilDeLigacao, type ComportamentoDoPerfilDeLigacao, type PerfilDoFakeDeLigacao } from "./perfis";

/**
 * O FAKE DE LIGAÇÃO: o provedor de brinquedo, EM MEMÓRIA, SEM REDE.
 *
 * Implementa `ProvedorDeLigacao` e aceita um PERFIL que imita a forma de um candidato real (`so_no_fim`,
 * `ao_vivo`, `sem_consulta`). Serve a três coisas:
 * 1. ser o alvo da suíte de contrato (`contrato/suite.ts`);
 * 2. provar o núcleo de prova ponta a ponta (webhook, caixa, aplicador) antes de existir adaptador;
 * 3. dar a base de teste dos casos feios: aviso duplicado, fora de ordem, forjado, atrasado, com destino trocado.
 *
 * O Fake NÃO decide desfecho. Ele diz o que a rede fez, como o provedor diria (a causa neutra). Quem calcula
 * status e resultado é o aplicador (F1B-08), pela tabela de causas.
 *
 * O ROTEIRO provoca o que a rede faria sozinha (tocar, atender, recusar, encerrar, a gravação ficar pronta) e
 * GERA os avisos como o adaptador os esperaria, assinados quando a matriz pede assinatura do provedor.
 * O relógio é virtual: só anda pelo `roteiro.avancar`.
 *
 * Nada aqui liga para ninguém.
 */

export type MetodoDoProvedorDeLigacao = "testarConexao" | "originar" | "encerrar" | "consultar" | "provisionarLinha" | "obterGravacao" | "apagarGravacao";

/** O que a rede faz com a ligação. Só o roteiro usa. */
export type DesfechoDeLigacaoDoFake = {
  causa: CausaDeLigacao;
  /** Segundos de conversa (só com `atendida`). Padrão 75. */
  duracaoS?: number;
  /** Segundos de toque antes do atendimento ou do fim. O padrão varia com a causa. */
  toqueS?: number;
  /** O provedor conta o fim como falha ao originar (só tem efeito onde o perfil avisa ao vivo). */
  falhouAoOriginar?: boolean;
};

export type OpcoesDoFakeDeLigacao = {
  perfil: PerfilDoFakeDeLigacao;
  /** Padrão `fake_ligacao`. Use outra chave para ter dois Fakes no mesmo registro. */
  chave?: ChaveDeProvedorDeLigacao;
  /** Matriz própria no lugar da do perfil (conector de brinquedo). Validada. */
  capacidades?: CapacidadesDeLigacao;
  /** Troca pontual do comportamento do perfil. */
  comportamento?: Partial<ComportamentoDoPerfilDeLigacao>;
};

// ---------------------------------------------------------------------------------------------------
// O formato do aviso do Fake (o "corpo cru"). Existe só aqui: o adaptador real tem o do provedor dele.
// ---------------------------------------------------------------------------------------------------

const IdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/);
const InstanteSchema = z.string().datetime({ offset: true });
const E164Schema = z.string().regex(/^\+[1-9]\d{6,14}$/);

const baseDoAviso = {
  idDoAviso: IdSchema.max(100).optional(),
  ligacaoId: IdSchema,
  ocorridoEm: InstanteSchema,
  refDaLigacao: z.string().uuid().optional(),
  linha: z.object({ conta: IdSchema, id: IdSchema }).strict().optional(),
  destino: E164Schema.optional(),
  origem: IdSchema.optional(),
};

const AvisoSchema = z.discriminatedUnion("evento", [
  z.object({ ...baseDoAviso, evento: z.literal("chamando") }).strict(),
  z.object({ ...baseDoAviso, evento: z.literal("atendida") }).strict(),
  z.object({ ...baseDoAviso, evento: z.literal("recusada") }).strict(),
  z
    .object({
      ...baseDoAviso,
      evento: z.literal("fim"),
      causa: CausaDeLigacaoSchema,
      atendidaEm: InstanteSchema.optional(),
      duracaoS: z.number().int().min(0).max(86_400).optional(),
      codigo: z.string().min(1).max(40).optional(),
    })
    .strict(),
  z.object({ ...baseDoAviso, evento: z.literal("falhou"), causa: CausaDeLigacaoSchema }).strict(),
  z
    .object({
      ...baseDoAviso,
      evento: z.literal("gravacao"),
      ref: IdSchema.max(300),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      mime: z.string().max(80),
      expiraEm: InstanteSchema.optional(),
    })
    .strict(),
  z.object({ ...baseDoAviso, evento: z.literal("sdp"), sdp: z.string().min(1).max(16 * 1024) }).strict(),
]);
type CorpoDoAviso = z.infer<typeof AvisoSchema>;

const EVENTOS_CONHECIDOS: readonly string[] = ["chamando", "atendida", "recusada", "fim", "falhou", "gravacao", "sdp"];
const EnvelopeSchema = z.object({ evento: z.string().min(1).max(60) }).passthrough();
const LoteSchema = z.object({ avisos: z.array(z.unknown()).max(200) }).strict();

/** O código curto que o provedor de brinquedo manda junto do fim. Nunca parece telefone. */
const CODIGO_POR_CAUSA: Readonly<Record<CausaDeLigacao, string>> = {
  atendida: "NORMAL_CLEARING",
  nao_atendeu: "NO_ANSWER",
  ocupado: "USER_BUSY",
  recusou: "CALL_REJECTED",
  caixa_postal: "VOICEMAIL",
  numero_inexistente: "UNALLOCATED_NUMBER",
  cancelada_por_quem_ligou: "ORIGINATOR_CANCEL",
  falha_de_rede: "NETWORK_FAILURE",
  sem_permissao: "NO_PERMISSION",
  destino_nao_recebe: "DESTINATION_UNREACHABLE",
  desconhecida: "UNSPECIFIED",
};

/** A gravação fica pronta este tempo depois do fim da ligação. */
export const ESPERA_DA_GRAVACAO_DO_FAKE_MS = 30_000;
/** O Fake guarda, no máximo, esta quantidade de bytes por gravação (alguns KB bastam para provar o hash). */
const TAMANHO_DE_PEDACO = 1024;

type GravacaoFake = { ref: string; bytes: Buffer; sha256: string; mime: string; prontaEm: Date; expiraEm: Date | null; apagada: boolean };

type LigacaoFake = {
  providerCallId: string;
  callId: string;
  destinoE164: string;
  linha: RefDaLinhaDeLigacao;
  modo: ModoDeOriginarDeLigacao;
  gravar: boolean;
  urlDoCallback: string | null;
  criadaEm: Date;
  tocouEm?: Date;
  atendidaEm?: Date;
  encerradaEm?: Date;
  estado: "criada" | "chamando" | "atendida" | "encerrada";
  causa?: CausaDeLigacao;
  falhou: boolean;
  gravacaoPrevistaEm?: Date;
  gravacao?: GravacaoFake;
};

export class FakeProvedorDeLigacao implements ProvedorDeLigacao {
  readonly chave: ChaveDeProvedorDeLigacao;
  readonly capacidades: Readonly<CapacidadesDeLigacao>;
  readonly perfil: PerfilDoFakeDeLigacao;
  readonly comportamento: Readonly<ComportamentoDoPerfilDeLigacao>;

  // Métodos que só existem quando a matriz os declara (o registro e a suíte conferem os dois lados).
  readonly consultar?: ProvedorDeLigacao["consultar"];
  readonly provisionarLinha?: ProvedorDeLigacao["provisionarLinha"];
  readonly responderOriginacao?: ProvedorDeLigacao["responderOriginacao"];
  readonly obterGravacao?: ProvedorDeLigacao["obterGravacao"];
  readonly apagarGravacao?: ProvedorDeLigacao["apagarGravacao"];
  /** O aperto de mão do GET existe só no perfil `sem_consulta` (forma da Meta). */
  readonly responderVerificacao?: ProvedorDeLigacao["responderVerificacao"];

  private seq = 0;
  private agora = new Date("2026-01-15T12:00:00.000Z");
  private readonly ligacoes = new Map<string, LigacaoFake>();
  private readonly gravacoes = new Map<string, GravacaoFake>();
  private readonly permitidos = new Set<string>();
  private readonly fila: CorpoDoAviso[] = [];
  private readonly falhasPontuais = new Map<MetodoDoProvedorDeLigacao, ErroDeLigacao[]>();
  private readonly consultasPorMinuto = new Map<number, number>();
  private foraDoAr = false;
  /** Quantas chamadas chegaram em cada método (para os testes provarem "uma só tentativa"). */
  readonly chamadas = new Map<MetodoDoProvedorDeLigacao, number>();

  constructor(opcoes: OpcoesDoFakeDeLigacao) {
    this.perfil = opcoes.perfil;
    this.chave = opcoes.chave ?? "fake_ligacao";
    this.capacidades = opcoes.capacidades ? definirCapacidadesDeLigacao(opcoes.capacidades) : capacidadesDoPerfilDeLigacao(opcoes.perfil);
    this.comportamento = Object.freeze({ ...comportamentoDoPerfilDeLigacao(opcoes.perfil), ...opcoes.comportamento });
    const c = this.capacidades;

    if (c.consulta.porId) this.consultar = (ctx, id) => this.rodar("consultar", ctx, () => this.fazerConsulta(id));
    if (c.provisionarLinha !== "manual") this.provisionarLinha = (ctx, pedido) => this.rodar("provisionarLinha", ctx, () => this.fazerProvisionamento(pedido));
    if (c.originacaoSincrona) this.responderOriginacao = (ctx, dados) => this.fazerRespostaDeOriginacao(ctx, dados);
    if (c.gravacao.entrega !== "nenhuma") this.obterGravacao = (ctx, ref) => this.rodar("obterGravacao", ctx, () => this.fazerObtencaoDaGravacao(ref));
    if (c.gravacao.apagavel) this.apagarGravacao = (ctx, ref) => this.rodar("apagarGravacao", ctx, () => this.fazerApagamentoDaGravacao(ref));
    if (opcoes.perfil === "sem_consulta") this.responderVerificacao = (ctx, query) => this.fazerVerificacaoPorGet(ctx, query);
  }

  // -------------------------------------------------------------------------------------------------
  // Mecânica comum: fora do ar, autenticação, falha pontual
  // -------------------------------------------------------------------------------------------------

  private proximoId(prefixo: string): string {
    this.seq += 1;
    return `${prefixo}_${this.seq}`;
  }

  private autenticar(ctx: ContextoDaLigacao): void {
    const chave = ctx.credenciais.apiKey;
    const prefixo = PREFIXO_DA_CHAVE_DO_FAKE_DE_LIGACAO[ctx.ambiente];
    if (typeof chave !== "string" || !chave.startsWith(prefixo) || chave.length < 16) throw new CredencialInvalidaDeLigacao(this.chave);
  }

  private async rodar<T>(metodo: MetodoDoProvedorDeLigacao, ctx: ContextoDaLigacao, fn: () => T): Promise<T> {
    this.chamadas.set(metodo, (this.chamadas.get(metodo) ?? 0) + 1);
    if (this.foraDoAr) throw new ProvedorIndisponivelDeLigacao(this.chave);
    this.autenticar(ctx);
    const falha = this.falhasPontuais.get(metodo)?.shift();
    if (falha) throw falha;
    return fn();
  }

  private ligacao(providerCallId: string): LigacaoFake {
    const l = this.ligacoes.get(providerCallId);
    if (!l) throw new NaoEncontradoDeLigacao(this.chave);
    return l;
  }

  // -------------------------------------------------------------------------------------------------
  // Interface ProvedorDeLigacao
  // -------------------------------------------------------------------------------------------------

  testarConexao(ctx: ContextoDaLigacao): Promise<ResultadoDoTeste> {
    return this.rodar("testarConexao", ctx, () => ({ ok: true as const, ambienteDetectado: ctx.ambiente }));
  }

  originar(ctx: ContextoDaLigacao, pedido: PedidoDeOriginacaoDeLigacao): Promise<ResultadoDaOriginacaoDeLigacao> {
    return this.rodar("originar", ctx, () => {
      if (!(MODOS_DE_ORIGINAR_DE_LIGACAO as readonly string[]).includes(pedido.modo) || !this.capacidades.originar.includes(pedido.modo)) {
        throw new NaoSuportadoDeLigacao(this.chave, "originar");
      }
      if (!E164Schema.safeParse(pedido.destinoE164).success) throw new DestinoInvalidoDeLigacao(this.chave);
      // A linha do pedido é a do contexto: um aviso de outra conta nunca nasce de uma credencial alheia.
      if (!ctx.linha || ctx.linha.contaExterna !== pedido.linha.contaExterna || ctx.linha.idExterno !== pedido.linha.idExterno) {
        throw new CredencialInvalidaDeLigacao(this.chave);
      }
      if (!this.capacidades.ligaAFrio && !this.permitidos.has(pedido.destinoE164)) throw new RecusadoPeloProvedorDeLigacao(this.chave, "sem_permissao");
      const ocupada = [...this.ligacoes.values()].some(
        (l) => l.estado !== "encerrada" && l.linha.contaExterna === pedido.linha.contaExterna && l.linha.idExterno === pedido.linha.idExterno,
      );
      if (ocupada) throw new LinhaOcupadaDeLigacao(this.chave);

      const providerCallId = this.proximoId("pc");
      this.ligacoes.set(providerCallId, {
        providerCallId,
        callId: pedido.callId,
        destinoE164: pedido.destinoE164,
        linha: { contaExterna: pedido.linha.contaExterna, idExterno: pedido.linha.idExterno },
        modo: pedido.modo,
        gravar: pedido.gravar,
        urlDoCallback: pedido.urlDoCallback,
        criadaEm: this.agora,
        estado: "criada",
        falhou: false,
      });
      return { providerCallId };
    });
  }

  encerrar(ctx: ContextoDaLigacao, providerCallId: string): Promise<void> {
    return this.rodar("encerrar", ctx, () => {
      const l = this.ligacao(providerCallId);
      if (l.estado === "encerrada") return;
      this.finalizar(l, l.estado === "atendida" ? "atendida" : "cancelada_por_quem_ligou", false);
    });
  }

  private fazerProvisionamento(_pedido: PedidoDeLinhaDeLigacao): LinhaProvisionadaDeLigacao {
    this.seq += 1;
    const ramal = String(1000 + this.seq);
    return { idExterno: ramal, credenciais: { ramal } };
  }

  private fazerRespostaDeOriginacao(ctx: ContextoDaLigacao, dados: { callId: string; destinoE164: string }): RespostaDeOriginacaoDeLigacao {
    this.autenticar(ctx);
    if (!E164Schema.safeParse(dados.destinoE164).success) throw new DestinoInvalidoDeLigacao(this.chave);
    // O destino vai só aqui, na resposta síncrona que o provedor pediu, nunca num aviso.
    return { contentType: "text/xml", corpo: `<Response><Dial>${dados.destinoE164}</Dial></Response>` };
  }

  private fazerObtencaoDaGravacao(ref: string): GravacaoDeLigacao {
    this.liberarGravacoes();
    const g = this.gravacoes.get(ref);
    if (!g || g.apagada || (g.expiraEm !== null && this.agora.getTime() > g.expiraEm.getTime())) throw new NaoEncontradoDeLigacao(this.chave);
    const bytes = g.bytes;
    async function* pedacos(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < bytes.length; i += TAMANHO_DE_PEDACO) yield new Uint8Array(bytes.subarray(i, i + TAMANHO_DE_PEDACO));
    }
    return { stream: pedacos(), mime: g.mime, sha256Esperado: this.comportamento.informaOHash ? g.sha256 : null };
  }

  private fazerApagamentoDaGravacao(ref: string): void {
    const g = this.gravacoes.get(ref);
    if (!g || g.apagada) throw new NaoEncontradoDeLigacao(this.chave);
    g.apagada = true;
  }

  private fazerVerificacaoPorGet(ctx: ContextoDaLigacao, query: Readonly<Record<string, string>>): string | null {
    if (query["hub.mode"] !== "subscribe") return null;
    if (!confereComSegredo(query["hub.verify_token"], ctx.segredoWebhook)) return null;
    const desafio = query["hub.challenge"];
    // Só ecoa um desafio de aparência inofensiva: nunca devolve texto de fora sem olhar.
    return typeof desafio === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(desafio) ? desafio : null;
  }

  // -------------------------------------------------------------------------------------------------
  // Consulta: o fim REAL, visto pelo provedor (nunca o que um aviso disse)
  // -------------------------------------------------------------------------------------------------

  private fazerConsulta(providerCallId: string): ResultadoDaConsultaDeLigacao {
    const minuto = Math.floor(this.agora.getTime() / 60_000);
    const n = (this.consultasPorMinuto.get(minuto) ?? 0) + 1;
    this.consultasPorMinuto.clear();
    this.consultasPorMinuto.set(minuto, n);
    const teto = this.capacidades.consulta.porMinuto;
    if (teto !== null && n > teto) throw new LimiteDeRequisicoesDeLigacao(this.chave, (minuto + 1) * 60_000 - this.agora.getTime());

    this.liberarGravacoes();
    const l = this.ligacao(providerCallId);
    const cap = this.capacidades;
    const base = (tipo: string, ocorridoEm: Date, parte = "") => ({
      // O id é estável entre consultas repetidas: depende do fato, nunca de quando se perguntou.
      idEvento: fabricarIdDeEvento(this.chave, "consulta", l.providerCallId, tipo, ocorridoEm.toISOString(), parte),
      ocorridoEm: ocorridoEm.toISOString(),
      providerCallId: l.providerCallId,
      refDaLinha: { contaExterna: l.linha.contaExterna, idExterno: l.linha.idExterno },
      ...(this.comportamento.repeteARefDaLigacao ? { refDaLigacao: l.callId } : {}),
    });
    const fatos: FatoDeLigacao[] = [];
    const pontas: PontaDeLigacao[] = [];
    const ponta = (idEvento: string): PontaDeLigacao | null => {
      if (!cap.pontasNoAviso.destino && !cap.pontasNoAviso.origem) return null;
      return { idEvento, ...(cap.pontasNoAviso.destino ? { destinoE164: l.destinoE164 } : {}), ...(cap.pontasNoAviso.origem ? { origemExterna: l.linha.idExterno } : {}) };
    };

    if (l.atendidaEm && cap.consulta.trazAtendimento) fatos.push({ tipo: "atendida", ...base("atendida", l.atendidaEm) });
    if (l.estado === "encerrada" && l.encerradaEm && l.causa) {
      const b = base("encerrada", l.encerradaEm, l.causa);
      if (l.falhou) fatos.push({ tipo: "falhou_ao_originar", ...b, causa: l.causa });
      else {
        fatos.push({
          tipo: "encerrada",
          ...b,
          causa: l.causa,
          ...(l.atendidaEm && cap.consulta.trazAtendimento ? { atendidaEm: l.atendidaEm.toISOString() } : {}),
          ...(l.atendidaEm && cap.duracaoDesdeAtendimento ? { duracaoConectadaS: this.segundosConectados(l) } : {}),
          codigoDoProvedor: CODIGO_POR_CAUSA[l.causa],
        });
      }
      const p = ponta(b.idEvento);
      if (p) pontas.push(p);
    }
    const g = l.gravacao;
    if (cap.gravacao.entrega === "consulta" && g && !g.apagada) fatos.push(this.fatoDaGravacao(g, base("gravacao", g.prontaEm, g.ref)));
    return { fatos, pontas };
  }

  private fatoDaGravacao(g: GravacaoFake, b: { idEvento: string; ocorridoEm: string; providerCallId: string; refDaLinha?: RefDaLinhaDeLigacao; refDaLigacao?: string }): FatoDeLigacao {
    return {
      tipo: "gravacao_pronta",
      ...b,
      refGravacao: g.ref,
      ...(this.comportamento.informaOHash ? { sha256: g.sha256 } : {}),
      mime: g.mime,
      ...(g.expiraEm ? { expiraEm: g.expiraEm.toISOString() } : {}),
    };
  }

  private segundosConectados(l: LigacaoFake): number {
    if (!l.atendidaEm || !l.encerradaEm) return 0;
    return Math.max(0, Math.round((l.encerradaEm.getTime() - l.atendidaEm.getTime()) / 1000));
  }

  // -------------------------------------------------------------------------------------------------
  // Webhook
  // -------------------------------------------------------------------------------------------------

  verificarWebhook(ctx: ContextoDaLigacao, req: WebhookCru): { autentico: boolean; motivo?: MotivoDeRecusaDoAvisoDeLigacao } {
    // Na URL assinada, quem prova a origem é o endereço (a rota o confere pelo `ref`, a versão e a assinatura da
    // query). O corpo não tem assinatura própria: o adaptador sozinho NÃO autentica e fecha por padrão.
    if (this.capacidades.webhook === "url_assinada") return { autentico: false, motivo: "sem_assinatura" };
    const recebida = req.cabecalhos["x-fake-assinatura"];
    const segredo = ctx.segredoWebhook;
    if (!recebida || !segredo) return { autentico: false, motivo: "sem_assinatura" };
    // A assinatura vale com o segredo atual OU com o anterior (janela de rotação), sem curto-circuito.
    const candidatos = [segredo.atual, ...(segredo.anterior ? [segredo.anterior] : [])];
    const ok = candidatos.map((s) => iguaisEmTempoConstante(recebida, this.assinatura(req.corpo, s))).some(Boolean);
    return ok ? { autentico: true } : { autentico: false, motivo: "assinatura_invalida" };
  }

  /** PURA: lê o corpo e devolve fatos, sinais e pontas. Corpo fora do formato lança; evento desconhecido é ignorado. */
  normalizarWebhook(corpo: unknown): ResultadoDaNormalizacaoDeLigacao {
    const itens = this.itensDoCorpo(corpo);
    const fatos: FatoDeLigacao[] = [];
    const sinais: SinalEfemeroDeLigacao[] = [];
    const pontas: PontaDeLigacao[] = [];

    for (const item of itens) {
      const nome = EnvelopeSchema.parse(item).evento;
      if (!EVENTOS_CONHECIDOS.includes(nome)) continue; // O CRM Agro não entende este evento: não vira fato.
      const a = AvisoSchema.parse(item);
      const idEvento = a.idDoAviso ? `av_${a.idDoAviso}` : fabricarIdDeEvento(this.chave, a.ligacaoId, a.evento, a.ocorridoEm, "causa" in a ? a.causa : "ref" in a ? a.ref : "");
      const base = {
        idEvento,
        ocorridoEm: a.ocorridoEm,
        providerCallId: a.ligacaoId,
        ...(a.linha ? { refDaLinha: { contaExterna: a.linha.conta, idExterno: a.linha.id } } : {}),
        ...(a.refDaLigacao ? { refDaLigacao: a.refDaLigacao } : {}),
      };

      if (a.evento === "sdp") {
        sinais.push({ tipo: "sdp_resposta", valor: a.sdp, providerCallId: a.ligacaoId, ...(a.refDaLigacao ? { refDaLigacao: a.refDaLigacao } : {}) });
        continue;
      }
      switch (a.evento) {
        case "chamando":
          fatos.push({ tipo: "chamando", ...base });
          break;
        case "atendida":
          fatos.push({ tipo: "atendida", ...base });
          break;
        case "recusada":
          fatos.push({ tipo: "recusada", ...base });
          break;
        case "fim":
          fatos.push({
            tipo: "encerrada",
            ...base,
            causa: a.causa,
            ...(a.atendidaEm ? { atendidaEm: a.atendidaEm } : {}),
            // Só vira "conectada" quando o provedor conta a partir do atendimento. Senão a duração inclui o toque.
            ...(this.capacidades.duracaoDesdeAtendimento && a.duracaoS !== undefined ? { duracaoConectadaS: a.duracaoS } : {}),
            ...(a.codigo ? { codigoDoProvedor: a.codigo } : {}),
          });
          break;
        case "falhou":
          fatos.push({ tipo: "falhou_ao_originar", ...base, causa: a.causa });
          break;
        case "gravacao":
          fatos.push({ tipo: "gravacao_pronta", ...base, refGravacao: a.ref, ...(a.sha256 ? { sha256: a.sha256 } : {}), mime: a.mime, ...(a.expiraEm ? { expiraEm: a.expiraEm } : {}) });
          break;
      }
      // A ponta (destino e origem que o aviso trouxe) vive à parte do fato, só em memória.
      if (a.destino || a.origem) pontas.push({ idEvento, ...(a.destino ? { destinoE164: a.destino } : {}), ...(a.origem ? { origemExterna: a.origem } : {}) });
    }
    return { fatos, sinais, pontas };
  }

  private itensDoCorpo(corpo: unknown): unknown[] {
    const lote = LoteSchema.safeParse(corpo);
    return lote.success ? lote.data.avisos : [corpo];
  }

  /** Assinatura do corpo (imita um HMAC calculado pelo provedor). */
  private assinatura(corpo: string, segredo: string): string {
    return `sha256=${createHmac("sha256", segredo).update(corpo, "utf8").digest("hex")}`;
  }

  private assinar(ctx: ContextoDaLigacao, corpo: unknown): WebhookCru {
    const texto = JSON.stringify(corpo);
    const cabecalhos: Record<string, string> = { "content-type": "application/json" };
    if (this.capacidades.webhook === "assinatura_do_provedor") {
      if (!ctx.segredoWebhook) throw new Error("O Fake precisa do segredo do aviso para assinar.");
      cabecalhos["x-fake-assinatura"] = this.assinatura(texto, ctx.segredoWebhook.atual);
    }
    return { metodo: "POST", cabecalhos, corpo: texto };
  }

  // -------------------------------------------------------------------------------------------------
  // O que a REDE faz (transições da ligação) e os avisos que isso gera
  // -------------------------------------------------------------------------------------------------

  /** O corpo comum de todo aviso, como o perfil o monta: só traz o que o perfil e a matriz dizem que trazem. */
  private corpoBase(l: LigacaoFake, ocorridoEm: Date) {
    const cap = this.capacidades;
    const comp = this.comportamento;
    return {
      ...(comp.avisoComId ? { idDoAviso: this.proximoId("aviso") } : {}),
      ligacaoId: l.providerCallId,
      ocorridoEm: ocorridoEm.toISOString(),
      ...(comp.repeteARefDaLigacao ? { refDaLigacao: l.callId } : {}),
      ...(comp.trazALinha ? { linha: { conta: l.linha.contaExterna, id: l.linha.idExterno } } : {}),
      ...(cap.pontasNoAviso.destino ? { destino: l.destinoE164 } : {}),
      ...(cap.pontasNoAviso.origem ? { origem: l.linha.idExterno } : {}),
    };
  }

  private tocar(l: LigacaoFake): void {
    if (l.estado !== "criada") throw new Error(`A ligação ${l.providerCallId} já tocou.`);
    l.estado = "chamando";
    l.tocouEm = this.agora;
    if (this.capacidades.eventosAoVivo) this.fila.push({ evento: "chamando", ...this.corpoBase(l, this.agora) });
  }

  private atender(l: LigacaoFake): void {
    if (l.estado !== "chamando") throw new Error(`A ligação ${l.providerCallId} não está tocando.`);
    l.estado = "atendida";
    l.atendidaEm = this.agora;
    if (this.capacidades.eventosAoVivo) this.fila.push({ evento: "atendida", ...this.corpoBase(l, this.agora) });
  }

  private recusar(l: LigacaoFake): void {
    if (l.estado === "criada") this.tocar(l);
    if (l.estado !== "chamando") throw new Error(`A ligação ${l.providerCallId} não está tocando.`);
    if (this.capacidades.eventosAoVivo) this.fila.push({ evento: "recusada", ...this.corpoBase(l, this.agora) });
    this.finalizar(l, "recusou", false);
  }

  private finalizar(l: LigacaoFake, causa: CausaDeLigacao, falhouAoOriginar: boolean): void {
    if (l.estado === "encerrada") throw new Error(`A ligação ${l.providerCallId} já terminou.`);
    const aoVivo = this.capacidades.eventosAoVivo;
    l.estado = "encerrada";
    l.encerradaEm = this.agora;
    l.causa = causa;
    // Quem não avisa ao vivo não tem como dizer "falhou ao originar": a falha chega como um fim com a causa.
    l.falhou = falhouAoOriginar && aoVivo;
    const base = this.corpoBase(l, this.agora);
    if (l.falhou) this.fila.push({ evento: "falhou", ...base, causa });
    else {
      const total = Math.round((this.agora.getTime() - (l.tocouEm ?? l.criadaEm).getTime()) / 1000);
      this.fila.push({
        evento: "fim",
        ...base,
        causa,
        // Só quem avisa ao vivo repete a hora do atendimento no fim.
        ...(aoVivo && l.atendidaEm ? { atendidaEm: l.atendidaEm.toISOString() } : {}),
        // `duracaoS` conta desde o atendimento ou desde o toque, conforme o perfil (o adaptador só repassa a primeira).
        duracaoS: this.capacidades.duracaoDesdeAtendimento ? this.segundosConectados(l) : total,
        codigo: CODIGO_POR_CAUSA[causa],
      });
    }
    if (l.atendidaEm && l.gravar && this.capacidades.gravacao.entrega !== "nenhuma") {
      l.gravacaoPrevistaEm = new Date(this.agora.getTime() + ESPERA_DA_GRAVACAO_DO_FAKE_MS);
    }
  }

  /** Cria a gravação das ligações cujo prazo de ficar pronta já passou, e avisa por webhook se a matriz manda. */
  private liberarGravacoes(): void {
    for (const l of this.ligacoes.values()) {
      if (l.gravacao || !l.gravacaoPrevistaEm || l.gravacaoPrevistaEm.getTime() > this.agora.getTime()) continue;
      const bytes = Buffer.from(`FAKE-AUDIO ${l.providerCallId}\n`.repeat(200), "utf8");
      const prazo = this.capacidades.gravacao.prazoHoras;
      const g: GravacaoFake = {
        ref: this.proximoId("rec"),
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mime: "audio/mpeg",
        prontaEm: l.gravacaoPrevistaEm,
        expiraEm: prazo === null ? null : new Date(l.gravacaoPrevistaEm.getTime() + prazo * 3_600_000),
        apagada: false,
      };
      l.gravacao = g;
      this.gravacoes.set(g.ref, g);
      if (this.capacidades.gravacao.entrega === "webhook") {
        this.fila.push({
          evento: "gravacao",
          ...this.corpoBase(l, g.prontaEm),
          ref: g.ref,
          ...(this.comportamento.informaOHash ? { sha256: g.sha256 } : {}),
          mime: g.mime,
          ...(g.expiraEm ? { expiraEm: g.expiraEm.toISOString() } : {}),
        });
      }
    }
  }

  // -------------------------------------------------------------------------------------------------
  // O ROTEIRO: o que o mundo real faria, provocado de fora
  // -------------------------------------------------------------------------------------------------

  readonly roteiro = {
    /** O relógio do Fake só anda por aqui. */
    avancar: (ms: number): void => {
      this.agora = new Date(this.agora.getTime() + ms);
      this.liberarGravacoes();
    },
    agora: (): Date => new Date(this.agora.getTime()),
    /** O contato deu permissão para esta ligação (só importa quando a matriz diz que não liga a frio). */
    permitirDestino: (destinoE164: string): void => {
      this.permitidos.add(destinoE164);
    },
    tocar: (providerCallId: string): void => this.tocar(this.ligacao(providerCallId)),
    atender: (providerCallId: string): void => this.atender(this.ligacao(providerCallId)),
    recusar: (providerCallId: string): void => this.recusar(this.ligacao(providerCallId)),
    /** A rede termina a ligação com esta causa. */
    terminar: (providerCallId: string, causa: CausaDeLigacao, opcoes: { falhouAoOriginar?: boolean } = {}): void =>
      this.finalizar(this.ligacao(providerCallId), causa, opcoes.falhouAoOriginar === true),
    /** Conduz a ligação até o fim, andando o relógio, e gera os avisos que o perfil manda. */
    conduzir: (providerCallId: string, d: DesfechoDeLigacaoDoFake): void => {
      const l = this.ligacao(providerCallId);
      const s = (n: number) => n * 1000;
      switch (d.causa) {
        case "atendida":
          this.tocar(l);
          this.roteiro.avancar(s(d.toqueS ?? 8));
          this.atender(l);
          this.roteiro.avancar(s(d.duracaoS ?? 75));
          this.finalizar(l, "atendida", false);
          break;
        case "recusou":
          this.tocar(l);
          this.roteiro.avancar(s(d.toqueS ?? 5));
          this.recusar(l);
          break;
        case "nao_atendeu":
        case "ocupado":
        case "caixa_postal":
        case "cancelada_por_quem_ligou":
        case "desconhecida":
          this.tocar(l);
          this.roteiro.avancar(s(d.toqueS ?? (d.causa === "ocupado" ? 2 : d.causa === "caixa_postal" ? 20 : 25)));
          this.finalizar(l, d.causa, false);
          break;
        case "numero_inexistente":
        case "falha_de_rede":
        case "sem_permissao":
        case "destino_nao_recebe":
          // A rede nem chega a tocar.
          this.roteiro.avancar(s(d.toqueS ?? 1));
          this.finalizar(l, d.causa, d.falhouAoOriginar === true);
          break;
      }
      // Deixa a gravação pronta, para quem só quer provar o caminho feliz.
      if (l.gravacaoPrevistaEm) this.roteiro.avancar(ESPERA_DA_GRAVACAO_DO_FAKE_MS);
    },
    /** Um aviso de resposta SDP (ligação pelo navegador). Vai como sinal efêmero, nunca como fato. */
    emitirSdp: (providerCallId: string, sdp = "v=0\r\no=fake 0 0 IN IP4 127.0.0.1\r\ns=fake\r\n"): void => {
      const l = this.ligacao(providerCallId);
      this.fila.push({ evento: "sdp", ...this.corpoBase(l, this.agora), sdp });
    },
    /** Os avisos acumulados desde a última coleta, no formato do perfil, assinados como o adaptador espera. */
    sacarAvisos: (ctx: ContextoDaLigacao): WebhookCru[] => {
      this.liberarGravacoes();
      return this.fila.splice(0, this.fila.length).map((c) => this.assinar(ctx, c));
    },
    /**
     * Pega um aviso HONESTO (o que `sacarAvisos` devolveu), troca campos do corpo e o assina de novo, como o
     * perfil assina. Serve ao aviso FORJADO (assinatura válida, conteúdo falso), ao de DESTINO TROCADO e ao
     * ATRASADO. Chave com `undefined` sai do corpo. O resultado ainda precisa ser um aviso bem formado.
     */
    reemitir: (ctx: ContextoDaLigacao, req: WebhookCru, troca: Readonly<Record<string, unknown>>): WebhookCru => {
      const corpo: Record<string, unknown> = { ...(JSON.parse(req.corpo) as Record<string, unknown>) };
      for (const [chave, valor] of Object.entries(troca)) {
        if (valor === undefined) delete corpo[chave];
        else corpo[chave] = valor;
      }
      return this.assinar(ctx, AvisoSchema.parse(corpo));
    },
    /** Um evento que o provedor manda e o CRM Agro não entende (ex.: "em espera"). Assinado, e não vira fato. */
    avisoQueOCrmAgroNaoEntende: (ctx: ContextoDaLigacao, providerCallId = "pc_desconhecida"): WebhookCru =>
      this.assinar(ctx, { evento: "em_espera", ligacaoId: providerCallId, ocorridoEm: this.agora.toISOString() }),
    /** A query do aperto de mão do GET (só no perfil que o tem). */
    queryDeVerificacao: (ctx: ContextoDaLigacao, desafio: string, certa = true): Record<string, string> => ({
      "hub.mode": "subscribe",
      "hub.verify_token": certa ? (ctx.segredoWebhook?.atual ?? "") : "token-que-nao-e-o-certo",
      "hub.challenge": desafio,
    }),
    /** O provedor sai do ar (todo método falha com `provedor_indisponivel`) até `foraDoAr(false)`. */
    foraDoAr: (sim: boolean): void => {
      this.foraDoAr = sim;
    },
    /** O PRÓXIMO uso do método falha com este erro (uma vez). */
    falharProxima: (metodo: MetodoDoProvedorDeLigacao, erro: ErroDeLigacao): void => {
      const fila = this.falhasPontuais.get(metodo) ?? [];
      fila.push(erro);
      this.falhasPontuais.set(metodo, fila);
    },
    /** O estado de uma ligação, para os testes conferirem sem passar pela interface. */
    estadoDe: (providerCallId: string): { estado: LigacaoFake["estado"]; causa: CausaDeLigacao | null; atendida: boolean; callId: string; destinoE164: string; urlDoCallback: string | null } => {
      const l = this.ligacao(providerCallId);
      return { estado: l.estado, causa: l.causa ?? null, atendida: l.atendidaEm !== undefined, callId: l.callId, destinoE164: l.destinoE164, urlDoCallback: l.urlDoCallback };
    },
    /** Os bytes que o Fake deu para a gravação (os testes comparam com o que a cópia recebeu). */
    bytesDaGravacao: (ref: string): Buffer | null => {
      const g = this.gravacoes.get(ref);
      return g ? Buffer.from(g.bytes) : null;
    },
    total: (): number => this.ligacoes.size,
  };
}
