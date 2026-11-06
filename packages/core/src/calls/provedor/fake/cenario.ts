import { randomUUID } from "node:crypto";
import type { WebhookCru } from "../comum";
import type { CapacidadesDeLigacao } from "../capacidades";
import { LimiteDeRequisicoesDeLigacao, NaoSuportadoDeLigacao, RecusadoPeloProvedorDeLigacao } from "../erros";
import type { CausaDeLigacao, RefDaLinhaDeLigacao } from "../fato";
import type { ContextoDaLigacao } from "../interface";
import { ligarParaTeste } from "../contrato/cenas";
import type { CenarioDeContratoDeLigacao, ProvocacaoDeErroDeLigacao } from "../contrato/tipos";
import { FakeProvedorDeLigacao, type DesfechoDeLigacaoDoFake } from "./fake-provedor";
import { PREFIXO_DA_CHAVE_DO_FAKE_DE_LIGACAO, descritorDoFakeDeLigacao, type ComportamentoDoPerfilDeLigacao, type PerfilDoFakeDeLigacao } from "./perfis";

/**
 * O cenário da suíte de contrato para o Fake, e o GERADOR DE SITUAÇÕES para os testes ponta a ponta
 */

export const SEGREDO_DO_AVISO_DO_FAKE_DE_LIGACAO = "segredo-do-aviso-do-fake-0001";

export type OpcoesDoCenarioDoFakeDeLigacao = {
  chave?: string;
  capacidades?: CapacidadesDeLigacao;
  comportamento?: Partial<ComportamentoDoPerfilDeLigacao>;
};

/** O contexto de uma linha do Fake: a conta, o ramal, as credenciais abertas e o segredo do aviso (quando a matriz tem). */
export function contextoDoFakeDeLigacao(fake: FakeProvedorDeLigacao, descritorAmbiente = fake.capacidades.sandbox ? ("teste" as const) : ("producao" as const)): ContextoDaLigacao {
  return {
    ambiente: descritorAmbiente,
    credenciais: { apiKey: `${PREFIXO_DA_CHAVE_DO_FAKE_DE_LIGACAO[descritorAmbiente]}abcdef0123456789` },
    segredoWebhook: fake.capacidades.webhook === "assinatura_do_provedor" ? { atual: SEGREDO_DO_AVISO_DO_FAKE_DE_LIGACAO } : null,
    linha: { contaExterna: "conta-fake", idExterno: "1001", credenciais: { ramal: "1001" } },
  };
}

/**
 * O cenário que a suíte de contrato roda para o Fake em cada perfil (e para o "conector de brinquedo": um
 * segundo Fake com outra chave e matriz própria).
 */
export function cenarioDeContratoDoFakeDeLigacao(perfil: PerfilDoFakeDeLigacao, opcoes: OpcoesDoCenarioDoFakeDeLigacao = {}): CenarioDeContratoDeLigacao {
  const fake = new FakeProvedorDeLigacao({ perfil, chave: opcoes.chave, capacidades: opcoes.capacidades, comportamento: opcoes.comportamento });
  const descritor = descritorDoFakeDeLigacao(perfil, opcoes.chave ?? "fake_ligacao", opcoes.capacidades);
  const ctx = contextoDoFakeDeLigacao(fake, descritor.ambientes[0]!);
  const ctxComCredencialErrada: ContextoDaLigacao = { ...ctx, credenciais: { apiKey: "chave-errada-que-nao-vale-nada" } };
  let n = 0;

  // As provocações chamam `c.provedor` sempre que possível (a suíte pode trocar o adaptador por um defeituoso);
  // só o que é script do Fake (queda, falha pontual) usa o `fake` direto.
  const respostasDeErro = (c: CenarioDeContratoDeLigacao): ProvocacaoDeErroDeLigacao[] => [
    { nome: "chave recusada", esperado: "credencial_invalida", provocar: () => c.provedor.testarConexao(c.ctxComCredencialErrada) },
    {
      nome: "provedor fora do ar",
      esperado: "provedor_indisponivel",
      provocar: async () => {
        fake.roteiro.foraDoAr(true);
        try {
          return await c.provedor.testarConexao(c.ctx);
        } finally {
          fake.roteiro.foraDoAr(false);
        }
      },
    },
    {
      nome: "429 do provedor",
      esperado: "limite_de_requisicoes",
      provocar: () => {
        fake.roteiro.falharProxima("originar", new LimiteDeRequisicoesDeLigacao(fake.chave, 1000));
        return ligarParaTeste(c);
      },
    },
    {
      nome: "número que o provedor não aceita",
      esperado: "destino_invalido",
      provocar: () =>
        c.provedor.originar(c.ctx, {
          callId: randomUUID(),
          destinoE164: "12345",
          modo: c.provedor.capacidades.originar[0]!,
          linha: { contaExterna: c.ctx.linha!.contaExterna, idExterno: c.ctx.linha!.idExterno },
          gravar: false,
          urlDoCallback: null,
        }),
    },
    {
      nome: "conta sem saldo",
      esperado: "recusado_pelo_provedor",
      provocar: () => {
        fake.roteiro.falharProxima("originar", new RecusadoPeloProvedorDeLigacao(fake.chave, "sem_saldo"));
        return ligarParaTeste(c);
      },
    },
    {
      nome: "linha já numa ligação",
      esperado: "linha_ocupada",
      provocar: async () => {
        const primeira = await ligarParaTeste(c);
        try {
          return await ligarParaTeste(c);
        } finally {
          await c.provedor.encerrar(c.ctx, primeira.providerCallId);
        }
      },
    },
    { nome: "ligação desconhecida", esperado: "nao_encontrado", provocar: () => c.provedor.encerrar(c.ctx, "pc_que_nao_existe") },
    {
      nome: "operação que o provedor não faz",
      esperado: "nao_suportado",
      provocar: () => {
        fake.roteiro.falharProxima("originar", new NaoSuportadoDeLigacao(fake.chave, "originar"));
        return ligarParaTeste(c);
      },
    },
  ];

  return {
    nome: `fake/${perfil}${opcoes.chave ? `(${opcoes.chave})` : ""}`,
    provedor: fake,
    descritor,
    ctx,
    ctxComCredencialErrada,
    segredos: [ctx.credenciais.apiKey!, ...(ctx.segredoWebhook ? [ctx.segredoWebhook.atual] : [])],
    roteiro: {
      novoCallId: () => randomUUID(),
      novoDestino: () => `+55119${String(10_000_000 + (n += 1))}`,
      permitirDestino: (destino) => fake.roteiro.permitirDestino(destino),
      conduzir: async (id, desfecho) => fake.roteiro.conduzir(id, desfecho),
      avancar: async (ms) => fake.roteiro.avancar(ms),
      sacarAvisos: async () => fake.roteiro.sacarAvisos(ctx),
      avisoQueOCrmAgroNaoEntende: async () => fake.roteiro.avisoQueOCrmAgroNaoEntende(ctx),
      adulterar: (req: WebhookCru): WebhookCru => {
        // Troca um caractere do id da ligação no corpo (o JSON continua válido; a assinatura deixa de bater).
        const corpo = req.corpo.replace(/"ligacaoId":"([^"])/, (_m, c: string) => `"ligacaoId":"${c === "z" ? "y" : "z"}`);
        return { ...req, corpo };
      },
      respostasDeErro,
      // O Fake é honesto por construção: a prova vale o que a matriz declara.
      comprovar: { causaDoFimGarantida: async () => fake.capacidades.causaDoFimGarantida },
      ...(fake.responderVerificacao ? { queryDeVerificacao: (desafio: string, certa: boolean) => fake.roteiro.queryDeVerificacao(ctx, desafio, certa) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// SITUAÇÕES: o que o provedor faz de feio, pronto para os testes ponta a ponta
// ---------------------------------------------------------------------------------------------------

export const SITUACOES_DE_LIGACAO = [
  "atendida",
  "nao_atendeu",
  "ocupado",
  "recusou",
  "numero_inexistente",
  "caixa_postal",
  "falha_ao_originar",
  "toque_longo",
  "duplicata",
  "ordem_trocada",
  "aviso_forjado",
  "destino_divergente",
  "aviso_atrasado",
  "sinal_efemero",
] as const;
export type SituacaoDeLigacao = (typeof SITUACOES_DE_LIGACAO)[number];

/** Um aviso como o provedor o mandaria: o corpo cru, os cabeçalhos assinados e a ponta que o corpo traz. */
export type AvisoGeradoDeLigacao = {
  req: WebhookCru;
  /** Quanto tempo depois do fim da ligação o aviso chega ao CRM Agro (0 = na hora). */
  entregarDepoisDeMs: number;
  /** O tipo do evento no corpo cru. Só para o teste ficar legível. */
  evento: string;
  /** O destino e a origem que o corpo traz (o adaptador os devolve como ponta). Nulo quando o perfil não traz. */
  ponta: { destinoE164?: string; origemExterna?: string } | null;
};

export type SituacaoGeradaDeLigacao = {
  nome: SituacaoDeLigacao;
  providerCallId: string;
  callId: string;
  destinoE164: string;
  linha: RefDaLinhaDeLigacao;
  /** O que chega ao CRM Agro nesta situação, na ordem de chegada. */
  avisos: AvisoGeradoDeLigacao[];
  /** O que o provedor mandaria se não houvesse o defeito da situação (para comparar `idEvento`). */
  avisosReais: AvisoGeradoDeLigacao[];
  /** A verdade: como a ligação terminou de fato (é o que a consulta ao provedor diria). */
  real: { causa: CausaDeLigacao; atendida: boolean };
};

const DESFECHO_DA_SITUACAO: Readonly<Record<SituacaoDeLigacao, DesfechoDeLigacaoDoFake>> = {
  atendida: { causa: "atendida" },
  nao_atendeu: { causa: "nao_atendeu" },
  ocupado: { causa: "ocupado" },
  recusou: { causa: "recusou" },
  numero_inexistente: { causa: "numero_inexistente" },
  caixa_postal: { causa: "caixa_postal" },
  falha_ao_originar: { causa: "falha_de_rede", falhouAoOriginar: true },
  toque_longo: { causa: "nao_atendeu", toqueS: 58 },
  duplicata: { causa: "atendida" },
  ordem_trocada: { causa: "atendida" },
  // No aviso forjado a ligação NÃO foi atendida: quem mente é o aviso.
  aviso_forjado: { causa: "nao_atendeu" },
  destino_divergente: { causa: "atendida" },
  aviso_atrasado: { causa: "atendida" },
  sinal_efemero: { causa: "atendida" },
};

/** Três horas depois do fim: passa do prazo em que um aviso de webhook ainda vale. */
export const ATRASO_DO_AVISO_ATRASADO_MS = 3 * 3_600_000;
export const DESTINO_DO_AVISO_DIVERGENTE = "+5511911112222";

function avisoGerado(req: WebhookCru, entregarDepoisDeMs = 0): AvisoGeradoDeLigacao {
  const corpo = JSON.parse(req.corpo) as { evento: string; destino?: string; origem?: string };
  return {
    req,
    entregarDepoisDeMs,
    evento: corpo.evento,
    ponta: corpo.destino || corpo.origem ? { ...(corpo.destino ? { destinoE164: corpo.destino } : {}), ...(corpo.origem ? { origemExterna: corpo.origem } : {}) } : null,
  };
}

const ehFim = (a: AvisoGeradoDeLigacao): boolean => a.evento === "fim" || a.evento === "falhou";

/**
 * Faz o Fake ligar, conduz a ligação até o fim e devolve os avisos da SITUAÇÃO pedida, assinados como o perfil
 * assina. Gera: atendida, não atendeu, ocupado, recusou, número inexistente, caixa postal, falha ao originar,
 * toque longo, duplicata, ordem trocada, aviso forjado (assinatura válida, fim diferente do real), destino
 * divergente (ponta com outro número), aviso atrasado (3 h depois do fim) e sinal efêmero.
 *
 * Nos perfis que só avisam o fim, "ordem trocada" tem um aviso só: a ordem não muda. Quem precisa do caso de
 * verdade usa o perfil `ao_vivo` ou `sem_consulta`.
 *
 * Em `url_assinada` a prova da origem é o endereço, não o corpo: o teste que passa pela rota monta o endereço
 * assinado por conta própria. Aqui o `req` vem sem assinatura.
 */
export async function gerarSituacaoDeLigacao(
  fake: FakeProvedorDeLigacao,
  ctx: ContextoDaLigacao,
  nome: SituacaoDeLigacao,
  opcoes: { callId?: string; destinoE164?: string; gravar?: boolean } = {},
): Promise<SituacaoGeradaDeLigacao> {
  if (!ctx.linha) throw new Error("A situação precisa de uma linha no contexto.");
  const callId = opcoes.callId ?? randomUUID();
  const destinoE164 = opcoes.destinoE164 ?? "+5511988887777";
  const linha: RefDaLinhaDeLigacao = { contaExterna: ctx.linha.contaExterna, idExterno: ctx.linha.idExterno };
  fake.roteiro.permitirDestino(destinoE164);
  fake.roteiro.sacarAvisos(ctx); // joga fora o que sobrou de uma situação anterior

  const { providerCallId } = await fake.originar(ctx, { callId, destinoE164, modo: fake.capacidades.originar[0]!, linha, gravar: opcoes.gravar ?? false, urlDoCallback: null });
  if (nome === "sinal_efemero") fake.roteiro.emitirSdp(providerCallId);
  const desfecho = DESFECHO_DA_SITUACAO[nome];
  fake.roteiro.conduzir(providerCallId, desfecho);

  const reais = fake.roteiro.sacarAvisos(ctx).map((r) => avisoGerado(r));
  const fim = reais.find(ehFim);
  let avisos = reais;

  switch (nome) {
    case "duplicata": {
      // O provedor reentrega o aviso de fim, igualzinho (mesmos bytes, mesma assinatura).
      if (!fim) throw new Error("A situação duplicata precisa de um aviso de fim.");
      const i = reais.indexOf(fim);
      avisos = [...reais.slice(0, i + 1), { ...fim, req: structuredClone(fim.req) }, ...reais.slice(i + 1)];
      break;
    }
    case "ordem_trocada": {
      // O aviso de fim chega ANTES dos de toque e de atendimento.
      if (!fim) throw new Error("A situação ordem_trocada precisa de um aviso de fim.");
      avisos = [fim, ...reais.filter((a) => a !== fim)];
      break;
    }
    case "aviso_forjado": {
      // Assinatura válida, mas o fim é outro: diz que a ligação foi atendida e durou 2 minutos.
      if (!fim) throw new Error("A situação aviso_forjado precisa de um aviso de fim.");
      const corpo = JSON.parse(fim.req.corpo) as { idDoAviso?: string; ocorridoEm: string };
      const forjado = fake.roteiro.reemitir(ctx, fim.req, {
        causa: "atendida",
        duracaoS: 120,
        codigo: "NORMAL_CLEARING",
        // Um id novo: o forjado e o real da mesma ligação têm `idEvento` diferentes.
        idDoAviso: corpo.idDoAviso !== undefined ? `forjado_${providerCallId}` : undefined,
        atendidaEm: fake.capacidades.eventosAoVivo ? new Date(Date.parse(corpo.ocorridoEm) - 120_000).toISOString() : undefined,
      });
      avisos = [avisoGerado(forjado)];
      break;
    }
    case "destino_divergente": {
      // O aviso é autêntico e a ligação existe, mas a ponta do destino é de outro número.
      avisos = reais.map((a) => (ehFim(a) ? avisoGerado(fake.roteiro.reemitir(ctx, a.req, { destino: DESTINO_DO_AVISO_DIVERGENTE })) : a));
      break;
    }
    case "aviso_atrasado": {
      avisos = reais.map((a) => (ehFim(a) ? { ...a, entregarDepoisDeMs: ATRASO_DO_AVISO_ATRASADO_MS } : a));
      break;
    }
    default:
      break;
  }

  return {
    nome,
    providerCallId,
    callId,
    destinoE164,
    linha,
    avisos,
    avisosReais: reais,
    real: { causa: desfecho.causa, atendida: desfecho.causa === "atendida" },
  };
}
