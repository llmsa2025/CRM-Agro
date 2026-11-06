import { db } from "@crmagro/db";
import { describeAckError } from "@crmagro/channels";

/**
 * Saúde do canal — os números que temos de VERDADE.
 *
 * Regra deste módulo: nada de limiar da Meta. A Meta não publica limiares de
 * banimento (verificado na doc da Cloud API), e o caminho Baileys não expõe
 * quality rating nem tier. Tudo aqui é medido na nossa própria base e
 * apresentado como POLÍTICA NOSSA, nunca como regra da plataforma.
 *
 * O sinal mais forte é o código de erro do ack (463 = trava de alcance a frio),
 * que só existe se `MESSAGES_UPDATE` estiver ligado no webhook da instância.
 */

export type NivelAlerta = "ok" | "atencao" | "critico";

export type Indicador = {
  chave: string;
  titulo: string;
  valor: number;
  total: number;
  percentual: number;
  nivel: NivelAlerta;
  descricao: string;
  /** null quando não há dado suficiente para julgar. */
  semDados: boolean;
};

/** Limiares — POLÍTICA NOSSA, ajustável. Não são números da Meta. */
export const LIMIARES = {
  naoEntregue: { atencao: 10, critico: 20 }, // % de enviadas que nunca entregaram
  erroAck: { atencao: 2, critico: 5 }, // % de enviadas com erro do servidor
  semResposta: { atencao: 85, critico: 95 }, // % de conversas iniciadas sem retorno
  optOut: { atencao: 3, critico: 8 }, // % de contatos marcados sem interesse/opt-out
} as const;

function nivelPor(pct: number, l: { atencao: number; critico: number }): NivelAlerta {
  if (pct >= l.critico) return "critico";
  if (pct >= l.atencao) return "atencao";
  return "ok";
}

function pct(parte: number, total: number): number {
  return total === 0 ? 0 : (parte / total) * 100;
}

/** Janela padrão de análise. */
const JANELA_DIAS = 7;

export async function saudeDoCanal(dias = JANELA_DIAS) {
  const prisma = db();
  const desde = new Date(Date.now() - dias * 86_400_000);

  const [enviadas, naoEntregues, comErro, errosPorCodigo, contatos, semInteresse, respondidas, iniciadas] =
    await Promise.all([
      prisma.message.count({ where: { direcao: "out", createdAt: { gte: desde } } }),
      // "sent" que nunca avançou — proxy de bloqueio/indisponibilidade.
      prisma.message.count({ where: { direcao: "out", status: "sent", createdAt: { gte: desde } } }),
      prisma.message.count({ where: { direcao: "out", status: "failed", createdAt: { gte: desde } } }),
      prisma.message.groupBy({
        by: ["errorCode"],
        where: { direcao: "out", errorCode: { not: null }, createdAt: { gte: desde } },
        _count: { _all: true },
      }),
      prisma.contact.count(),
      prisma.contact.count({ where: { OR: [{ interesse: "sem_interesse" }, { relacionamentoStatus: "opt_out" }] } }),
      // conversas que receberam resposta na janela
      prisma.conversation.count({
        where: { messages: { some: { direcao: "in", createdAt: { gte: desde } } } },
      }),
      prisma.conversation.count({
        where: { messages: { some: { direcao: "out", createdAt: { gte: desde } } } },
      }),
    ]);

  const indicadores: Indicador[] = [
    {
      chave: "nao_entregue",
      titulo: "Não entregues",
      valor: naoEntregues,
      total: enviadas,
      percentual: pct(naoEntregues, enviadas),
      nivel: enviadas === 0 ? "ok" : nivelPor(pct(naoEntregues, enviadas), LIMIARES.naoEntregue),
      descricao:
        "Mensagens que saíram mas nunca foram entregues no aparelho. É o indício mais próximo de bloqueio, mas também acontece com celular desligado ou número inexistente.",
      semDados: enviadas === 0,
    },
    {
      chave: "erro_ack",
      titulo: "Recusadas pelo servidor",
      valor: comErro,
      total: enviadas,
      percentual: pct(comErro, enviadas),
      nivel: enviadas === 0 ? "ok" : nivelPor(pct(comErro, enviadas), LIMIARES.erroAck),
      descricao:
        "O servidor do WhatsApp recusou o envio com código de erro. É o único sinal que vem da própria plataforma. O resto é estimativa nossa.",
      semDados: enviadas === 0,
    },
    {
      chave: "sem_resposta",
      titulo: "Conversas sem retorno",
      valor: Math.max(0, iniciadas - respondidas),
      total: iniciadas,
      percentual: pct(Math.max(0, iniciadas - respondidas), iniciadas),
      nivel: iniciadas === 0 ? "ok" : nivelPor(pct(Math.max(0, iniciadas - respondidas), iniciadas), LIMIARES.semResposta),
      descricao:
        "Muita mensagem saindo e pouca conversa acontecendo é o padrão que mais denuncia lista fria. Melhorar a lista vale mais que ajustar cadência.",
      semDados: iniciadas === 0,
    },
    {
      chave: "opt_out",
      titulo: "Recusas na base",
      valor: semInteresse,
      total: contatos,
      percentual: pct(semInteresse, contatos),
      nivel: contatos === 0 ? "ok" : nivelPor(pct(semInteresse, contatos), LIMIARES.optOut),
      descricao:
        "Contatos marcados como opt-out ou sem interesse. Insistir com eles é o caminho mais curto para denúncia. Mantenha-os fora dos fluxos.",
      semDados: contatos === 0,
    },
  ];

  const erros = errosPorCodigo
    .filter((e) => e.errorCode)
    .map((e) => ({
      codigo: e.errorCode as string,
      quantidade: e._count._all,
      ...describeAckError(e.errorCode as string)!,
    }))
    .sort((a, b) => b.quantidade - a.quantidade);

  // Rastreamento ligado? Se nada saiu do estado "sent", o MESSAGES_UPDATE
  // provavelmente não está configurado — e aí todo o painel é cego.
  const comStatusAvancado = await prisma.message.count({
    where: { direcao: "out", status: { in: ["delivered", "read", "failed"] } },
  });
  const rastreamentoAtivo = comStatusAvancado > 0 || enviadas === 0;

  return {
    dias,
    enviadas,
    indicadores,
    erros,
    rastreamentoAtivo,
    nivelGeral: indicadores.reduce<NivelAlerta>((pior, i) => {
      if (i.semDados) return pior;
      if (i.nivel === "critico" || pior === "critico") return "critico";
      if (i.nivel === "atencao") return "atencao";
      return pior;
    }, "ok"),
  };
}
