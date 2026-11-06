import type { Prisma } from "@prisma/client";
import { basePrisma, db, runAsSystem } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { FlowNotFound } from "./errors";
import { acordarPasso, flowJobId, removeStepJob, scheduleStep } from "./queue";
import { logger } from "../logger/index";
import { escopoFluxo } from "./escopo";
import { assertOwned } from "../tenancy/assert-owned";

/**
 * Controle operacional do fluxo (item 1.5 — MF-07).
 *
 * Antes, "Pausar" só trocava `Flow.status`: o handler nunca olhava o status e
 * as inscrições em curso CONTINUAVAM enviando (os waits venciam, as condições
 * reagendavam) — o vendedor via "Fluxo pausado" e a mensagem errada saindo.
 * Não havia como parar tudo de uma vez.
 *
 * Agora o worker confere o status do fluxo a cada passo:
 * - `paused`: segura a inscrição NO PASSO (ponteiro guardado, marca
 *   `waitingFor = "fluxo_pausado"`); reativar reagenda de onde parou. Ao pausar, `segurarInscricoesDoFluxo`
 *   segura todas na hora (o worker só pega as que vencem durante a pausa). Pausar, retomar e a varredura
 *   (`varrerSeguradasComFluxoNoAr`) trabalham em lotes e conferem o status ATUAL do fluxo: nunca sobra inscrição
 *   segurada com o fluxo no ar;
 * - `archived`: encerra a inscrição.
 * E `encerrarInscricoesDoFluxo` é o botão de parar tudo.
 */

export const MARCA_FLUXO_PAUSADO = "fluxo_pausado";

export type DecisaoDoFluxo = "seguir" | "segurado" | "encerrado";

/**
 * Decide o passo conforme o status do fluxo (chamado pelo worker, no contexto do time).
 *
 * `flowStatus` é o que o worker LEU no começo do passo, e já pode ter mudado (incidente de 02/10/2026: o fluxo foi
 * pausado e reativado várias vezes enquanto havia centenas de passos na fila). Por isso a segurada confere o status
 * ATUAL do fluxo na própria escrita: se ele voltou ao ar, nada é segurado e a resposta é "seguir". Sem isso, o
 * passo que leu "pausado" segurava DEPOIS da retomada, e a inscrição ficava para sempre em `fluxo_pausado` com o
 * fluxo no ar (ninguém mais a retomava).
 */
export async function aplicarStatusDoFluxo(input: {
  enrollmentId: string;
  nodeId: string;
  round: number;
  flowStatus: string;
}): Promise<DecisaoDoFluxo> {
  if (input.flowStatus === "active") return "seguir";
  const prisma = db();
  if (input.flowStatus === "archived") {
    await prisma.enrollment.updateMany({
      where: { id: input.enrollmentId, status: { in: ["active", "waiting"] } },
      data: { status: "done", nextRunAt: null, waitingFor: null, waitingUntil: null },
    });
    return "encerrado";
  }
  // paused (ou rascunho): segura com o ponteiro no passo devido, SE o fluxo ainda estiver fora do ar.
  const { count } = await prisma.enrollment.updateMany({
    where: { id: input.enrollmentId, status: { in: ["active", "waiting"] }, flow: { status: { not: "active" } } },
    data: {
      status: "waiting",
      nextRunAt: null,
      currentNodeId: input.nodeId,
      currentRound: input.round,
      waitingFor: MARCA_FLUXO_PAUSADO,
      waitingUntil: null,
    },
  });
  if (count === 0) {
    // Não segurou: ou o fluxo voltou ao ar entre a leitura e a escrita (segue o passo), ou a inscrição já não está em curso.
    const atual = await prisma.enrollment.findUnique({ where: { id: input.enrollmentId }, select: { status: true, flow: { select: { status: true } } } });
    if (atual?.flow.status === "active" && (atual.status === "active" || atual.status === "waiting")) return "seguir";
  }
  return "segurado";
}

/** Inscrições lidas e gravadas por vez ao pausar e ao retomar: um `SELECT` e um `UPDATE` por lote, não um par por inscrição. */
export const LOTE_DA_PAUSA = 200;
/** Passos devolvidos ao Redis ao mesmo tempo na retomada (não afoga a conexão; a ordem entre lotes é mantida). */
const AGENDAR_EM_PARALELO = 20;
/** Gravações em paralelo das inscrições que têm prazo de espera a guardar (poucas: só quem estava num "Esperar"). */
const GRAVAR_EM_PARALELO = 10;
const EM_CURSO = ["active", "waiting"] as const;

/**
 * Dois `updateMany` em lote sobre as mesmas inscrições, ao mesmo tempo (duas retomadas, ou pausar durante uma
 * retomada), podem pegar as linhas em ordens diferentes e o Postgres derruba um deles com "deadlock detected"
 * (40P01). A gravação é condicional (confere o status), então repetir depois do aborto é seguro e idempotente:
 * a que perdeu tenta de novo e encontra o que a outra já soltou (ou segurou) como está. O erro que não é de
 * deadlock sobe como sempre.
 */
export async function comRetentativaDeDeadlock<T>(gravar: () => Promise<T>, tentativas = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await gravar();
    } catch (e) {
      const texto = e instanceof Error ? e.message : String(e);
      const deadlock = texto.includes("40P01") || texto.includes("deadlock detected");
      if (!deadlock || i >= tentativas) throw e;
      // Espera curta e diferente a cada tentativa, para as duas não voltarem juntas.
      await new Promise((r) => setTimeout(r, 20 * i + Math.floor(Math.random() * 60)));
    }
  }
}

/** Roda `itens` em grupos de `n` ao mesmo tempo, na ordem. Falha de um não derruba os outros: devolve quantas falharam. */
async function emGrupos<T>(itens: readonly T[], n: number, fn: (item: T) => Promise<unknown>): Promise<number> {
  let falhas = 0;
  for (let i = 0; i < itens.length; i += n) {
    const r = await Promise.allSettled(itens.slice(i, i + n).map(fn));
    falhas += r.filter((x) => x.status === "rejected").length;
  }
  return falhas;
}

/**
 * PAUSAR o fluxo segura, NA HORA, toda inscrição em andamento no passo em que está (antes, só as que venciam
 * durante a pausa eram seguradas, e as outras seguiam "Aguardando, próximo em 8 horas" como se nada tivesse
 * parado). O ponteiro (nó e round) fica como está. Se a inscrição esperava um prazo de verdade (passo
 * "Esperar"), o tempo que faltava fica guardado em `waitingUntil` (relativo à hora da pausa, `updatedAt`) e é
 * respeitado na retomada. Adiamento (fora do horário, cota, limite) e espera por resposta não guardam nada:
 * ao voltar, o passo roda de novo e confere tudo outra vez.
 *
 * Fica de fora a inscrição que espera o envio de um DM social (`waitingFor = "social"`): o DM já está na fila
 * `social`, que trata a pausa sozinha.
 *
 * Em lotes (`LOTE_DA_PAUSA`): quem não tem prazo a guardar (a grande maioria) vai numa gravação só por lote. Antes
 * eram duas idas ao banco por inscrição, em série, dentro da requisição: 1.132 inscrições levaram 21 s. Cada
 * gravação confere que o fluxo CONTINUA fora do ar: se alguém o reativou no meio, o resto do lote não é segurado
 * (senão ficaria parado para sempre com o fluxo no ar).
 */
export async function segurarInscricoesDoFluxo(flowId: string, agora = new Date()): Promise<number> {
  const prisma = db();
  let n = 0;
  let ultimo = "";
  for (;;) {
    const lote = await prisma.enrollment.findMany({
      // `OR` com `null` explícito: `NOT IN` do SQL descarta quem tem a coluna vazia, e a maioria tem.
      where: {
        flowId,
        id: { gt: ultimo },
        status: { in: [...EM_CURSO] },
        OR: [{ waitingFor: null }, { waitingFor: { notIn: [MARCA_FLUXO_PAUSADO, "social"] } }],
      },
      orderBy: { id: "asc" },
      take: LOTE_DA_PAUSA,
      select: { id: true, currentNodeId: true, currentRound: true, nextRunAt: true, waitingFor: true },
    });
    if (lote.length === 0) break;
    ultimo = lote[lote.length - 1]!.id;
    // Só o prazo de um passo "Esperar" (sem marca de resposta) conta; adiamento do passo anterior não.
    const comPrazo = lote.filter((e) => e.nextRunAt && e.nextRunAt > agora && !e.waitingFor);
    const idsComPrazo = new Set(comPrazo.map((e) => e.id));
    const semPrazo = lote.filter((e) => !idsComPrazo.has(e.id));
    const soSeContinuaFora = { flow: { status: { not: "active" as const } } };
    if (semPrazo.length > 0) {
      const { count } = await comRetentativaDeDeadlock(() =>
        prisma.enrollment.updateMany({
          where: { id: { in: semPrazo.map((e) => e.id) }, status: { in: [...EM_CURSO] }, OR: [{ waitingFor: null }, { waitingFor: { not: MARCA_FLUXO_PAUSADO } }], ...soSeContinuaFora },
          data: {
            status: "waiting",
            nextRunAt: null,
            waitingFor: MARCA_FLUXO_PAUSADO,
            waitingUntil: null,
            updatedAt: agora, // a hora da pausa: o tempo que faltava é `waitingUntil - updatedAt`
          },
        }),
      );
      n += count;
    }
    await emGrupos(comPrazo, GRAVAR_EM_PARALELO, async (e) => {
      let restanteMs = 0;
      const anterior =
        e.currentRound > 1
          ? await prisma.flowStepExecution.findFirst({
              where: { enrollmentId: e.id, nodeId: e.currentNodeId, round: e.currentRound - 1 },
              select: { result: true },
            })
          : null;
      const adiado = (anterior?.result as { deferred?: boolean } | null)?.deferred === true;
      if (!adiado) restanteMs = e.nextRunAt!.getTime() - agora.getTime();
      const { count } = await prisma.enrollment.updateMany({
        where: { id: e.id, status: { in: [...EM_CURSO] }, OR: [{ waitingFor: null }, { waitingFor: { not: MARCA_FLUXO_PAUSADO } }], ...soSeContinuaFora },
        data: {
          status: "waiting",
          nextRunAt: null,
          waitingFor: MARCA_FLUXO_PAUSADO,
          waitingUntil: restanteMs > 0 ? new Date(agora.getTime() + restanteMs) : null,
          updatedAt: agora,
        },
      });
      n += count;
    });
  }
  if (n) logger.info({ flowId, seguradas: n }, "[flow] inscrições seguradas ao pausar o fluxo");
  return n;
}

/**
 * Retoma as inscrições seguradas pela pausa (ao reativar o fluxo). Cada uma volta exatamente ao passo em que
 * foi segurada: roda agora, ou depois do tempo de espera que ainda faltava quando o fluxo foi pausado.
 * Roda no contexto do time.
 *
 * Idempotente e em lotes (`LOTE_DA_PAUSA`), na ordem em que as inscrições entraram (`createdAt`): quem entrou
 * primeiro volta primeiro. A gravação no banco vem ANTES do Redis: se o Redis falhar, a inscrição já está `active`
 * com `nextRunAt` vencido e a varredura de órfãs a agenda em até ~5 min (nada fica para trás). Rodar de novo (ou
 * duas retomadas ao mesmo tempo) não agenda em dobro: a gravação só pega quem ainda está segurado e o `jobId` do
 * passo é único. Só retoma com o fluxo NO AR; se ele for pausado no meio, o resto fica segurado.
 *
 * `limite` corta o trabalho de uma chamada (a varredura usa; o resto fica para a próxima rodada).
 */
export async function retomarInscricoesSeguradas(flowId: string, agora = new Date(), opts: { limite?: number } = {}): Promise<number> {
  const prisma = db();
  const limite = opts.limite ?? Number.POSITIVE_INFINITY;
  let n = 0;
  let cursor: { createdAt: Date; id: string } | null = null;
  let falhasNaFila = 0;
  while (n < limite) {
    // O fluxo precisa estar no ar a cada lote: pausar no meio da retomada para o que falta.
    const fluxo = await prisma.flow.findUnique({ where: { id: flowId }, select: { status: true } });
    if (fluxo?.status !== "active") break;
    const filtroDoCursor: Prisma.EnrollmentWhereInput = cursor
      ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] }
      : {};
    const lote = await prisma.enrollment.findMany({
      where: { flowId, status: "waiting", waitingFor: MARCA_FLUXO_PAUSADO, ...filtroDoCursor },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: LOTE_DA_PAUSA,
      select: { id: true, createdAt: true, currentNodeId: true, currentRound: true, waitingUntil: true, updatedAt: true },
    });
    if (lote.length === 0) break;
    const ultima = lote[lote.length - 1]!;
    cursor = { createdAt: ultima.createdAt, id: ultima.id };

    const comEspera: Array<(typeof lote)[number] & { restanteMs: number }> = [];
    const jaRoda: typeof lote = [];
    for (const e of lote) {
      const restanteMs = e.waitingUntil ? Math.max(0, e.waitingUntil.getTime() - e.updatedAt.getTime()) : 0;
      if (restanteMs > 0) comEspera.push({ ...e, restanteMs });
      else jaRoda.push(e);
    }

    // Quem roda já: uma gravação para o lote todo.
    if (jaRoda.length > 0) {
      const { count } = await comRetentativaDeDeadlock(() =>
        prisma.enrollment.updateMany({
          where: { id: { in: jaRoda.map((e) => e.id) }, status: "waiting", waitingFor: MARCA_FLUXO_PAUSADO, flow: { status: "active" } },
          data: { status: "active", nextRunAt: agora, waitingFor: null, waitingUntil: null },
        }),
      );
      n += count;
      if (count > 0) {
        // Agenda quem está `active` agora. Lote inteiro solto (o normal): é tudo. Se outra retomada soltou parte ao
        // mesmo tempo, os que ela soltou entram também: agendar de novo é inofensivo (`acordarPasso` é idempotente
        // pelo jobId) e, se ela morrer antes de agendar, ninguém fica sem job.
        const soltas =
          count === jaRoda.length
            ? jaRoda
            : await prisma.enrollment.findMany({
                where: { id: { in: jaRoda.map((e) => e.id) }, status: "active", waitingFor: null },
                select: { id: true, createdAt: true, currentNodeId: true, currentRound: true, waitingUntil: true, updatedAt: true },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              });
        // `acordarPasso`, não `scheduleStep`: o job deste passo pode já existir (concluído, ou adiado) e um `add`
        // com o mesmo jobId seria ignorado. Se está adiado, sobe para rodar já.
        falhasNaFila += await emGrupos(
          soltas.filter((e) => e.currentRound >= 1), // round 0 (inscrição antiga): a varredura de órfãs acha o round pelo histórico
          AGENDAR_EM_PARALELO,
          (e) => acordarPasso(e.id, e.currentNodeId, e.currentRound),
        );
      }
    }

    // Quem ainda tinha espera a cumprir: o job deste passo existe com o horário de ANTES da pausa; sai, e entra um
    // com o tempo que faltava.
    await emGrupos(comEspera, GRAVAR_EM_PARALELO, async (e) => {
      const { count } = await prisma.enrollment.updateMany({
        where: { id: e.id, status: "waiting", waitingFor: MARCA_FLUXO_PAUSADO, flow: { status: "active" } },
        data: { status: "waiting", nextRunAt: new Date(agora.getTime() + e.restanteMs), waitingFor: null, waitingUntil: null },
      });
      if (count !== 1) return;
      n++;
      if (e.currentRound < 1) return;
      try {
        await removeStepJob(flowJobId(e.id, e.currentNodeId, e.currentRound));
        await scheduleStep(e.id, e.currentNodeId, e.currentRound, e.restanteMs, agora.getTime() + e.restanteMs);
      } catch {
        falhasNaFila++;
      }
    });
  }
  if (falhasNaFila) {
    logger.warn({ flowId, falhasNaFila }, "[flow] retomada: parte dos passos não foi para a fila; a varredura de órfãs agenda em até 5 min");
  }
  if (n) logger.info({ flowId, retomadas: n }, "[flow] inscrições seguradas pela pausa retomadas");
  return n;
}

/**
 * Rede de segurança (worker, a cada varredura): inscrição segurada pela pausa (`fluxo_pausado`) cujo fluxo está NO
 * AR não deveria existir; ninguém mais a retomaria (a retomada roda uma vez, ao ativar). Aparece quando o fluxo é
 * pausado e reativado várias vezes com passos ainda na fila (02/10/2026), ou quando uma retomada é interrompida no
 * meio. Aqui elas voltam, em lotes, com a mesma regra da retomada. Cross-team por natureza (como a varredura de
 * órfãs): acha os fluxos pelo `basePrisma` e retoma cada um no contexto do próprio time.
 *
 * `carenciaMs`: só pega o que está parado há mais que isto (uma ativação em andamento não é atropelada).
 * `teamId`: limita a um time (a varredura do worker não passa; serve a testes e a quem roda à mão).
 */
export async function varrerSeguradasComFluxoNoAr(
  opts: { agora?: Date; carenciaMs?: number; fluxos?: number; limitePorFluxo?: number; teamId?: string } = {},
): Promise<{ fluxos: number; retomadas: number }> {
  const agora = opts.agora ?? new Date();
  const parados = await basePrisma.enrollment.groupBy({
    by: ["teamId", "flowId"],
    where: {
      status: "waiting",
      waitingFor: MARCA_FLUXO_PAUSADO,
      updatedAt: { lt: new Date(agora.getTime() - (opts.carenciaMs ?? CARENCIA_DA_RETOMADA_MS)) },
      flow: { status: "active" },
      ...(opts.teamId ? { teamId: opts.teamId } : {}),
    },
    orderBy: [{ teamId: "asc" }, { flowId: "asc" }],
    take: opts.fluxos ?? 50,
  });
  let retomadas = 0;
  for (const g of parados) {
    try {
      const n = await runAsSystem(g.teamId, () => retomarInscricoesSeguradas(g.flowId, agora, { limite: opts.limitePorFluxo ?? LIMITE_DA_VARREDURA }));
      if (n > 0) logger.warn({ flowId: g.flowId, retomadas: n }, "[flow] inscrições seguradas com o fluxo no ar: retomadas pela varredura");
      retomadas += n;
    } catch (err) {
      logger.error({ flowId: g.flowId, err: err instanceof Error ? err.message : String(err) }, "[flow] varredura das seguradas falhou");
    }
  }
  return { fluxos: parados.length, retomadas };
}

/** Quanto tempo uma inscrição segurada com o fluxo no ar espera antes de a varredura a retomar. */
const CARENCIA_DA_RETOMADA_MS = 2 * 60_000;
/** Teto de inscrições retomadas por fluxo em cada varredura (o resto fica para a próxima rodada de 5 min). */
const LIMITE_DA_VARREDURA = 2_000;

/**
 * Botão "parar tudo": encerra TODAS as inscrições em curso do fluxo. Os jobs que
 * ainda estão na fila acham a inscrição encerrada e não fazem nada.
 */
export async function encerrarInscricoesDoFluxo(flowId: string): Promise<{ encerradas: number }> {
  requireCan("flows.write");
  const prisma = db();
  const flow = await prisma.flow.findFirst({ where: { AND: [{ id: flowId }, escopoFluxo()] }, select: { id: true } });
  if (!flow) throw new FlowNotFound(flowId);
  await assertOwned("flow", flowId); // escrita: parar tudo no fluxo do colega pede "Ver e editar"
  const { count } = await prisma.enrollment.updateMany({
    where: { flowId, status: { in: ["active", "waiting"] } },
    data: INSCRICAO_ENCERRADA,
  });
  logger.warn({ flowId, encerradas: count }, "[flow] inscrições encerradas manualmente");
  return { encerradas: count };
}

/** Dados que encerram uma inscrição: some a espera, a marca de resposta e o próximo passo. */
export const INSCRICAO_ENCERRADA = { status: "done" as const, nextRunAt: null, waitingFor: null, waitingUntil: null };
