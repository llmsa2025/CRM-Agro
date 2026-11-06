import { Prisma } from "@prisma/client";
import { basePrisma, runAsSystem, db, tenantData } from "@crmagro/db";
import {
  executeNode,
  scheduleStep,
  concluirPasso,
  reagendarPeloPonteiro,
  jobNoPonteiro,
  tratarFalhaDoPasso,
  retomarPassoInterrompido,
  encerrarPorLoop,
  aplicarStatusDoFluxo,
  entregarEnvioSocial,
  estadoDoEnvioSocial,
  FLOW_MAX_STEPS,
  EFEITO_EXTERNO,
  lerNoDoSnapshot,
  lerJanelaEnvio,
  snapshotDaInscricao,
  reservarVezDoTime,
  custoDoPasso,
  adiamentoDoPassoSemFicha,
  primaryEmail,
  primaryTelefone,
  lerCpf,
  logger,
  type StepJob,
} from "@crmagro/core";

/**
 * Handler do BullMQ — executa UM passo de um enrollment.
 *
 * O worker NÃO tem ALS de request. O teamId vem do `Enrollment.teamId`
 * (carregado cross-team via basePrisma); o handler abre `runWithTeam` antes de
 * tocar o banco com `db()`. Mesmo padrão do `receiveInbound` (webhook).
 *
 * Idempotência: o claim inicial cria uma `FlowStepExecution` com
 * `@@unique([enrollmentId, nodeId, round])`. P2002 (conflito) = já executei
 * este round → skip silencioso (não erro, senão o retry BullMQ explode).
 */

const TERMINAL = new Set(["done", "failed"]);

/**
 * Nós que produzem efeito FORA do banco de forma NÃO idempotente (mensagem no
 * WhatsApp, HTTP). Se um deles for interrompido no meio, não há como saber se o
 * efeito ocorreu — reexecutar pode duplicar. Os demais (espera, condição, tag,
 * etapa, nota) são seguros de repetir.
 *
 * `typing` saiu daqui: agora é não-bloqueante (dispara a presença em background
 * e devolve delayMs). Reenviar a presença "digitando" é inofensivo, então uma
 * retomada é segura — não trava mais o contato num passo de efeito externo.
 */
// send_email (SMTP) e send_social (DM Instagram/LinkedIn) também produzem efeito
// externo NÃO idempotente: reexecutar reenvia o e-mail/DM e reconsome cota
// (risco de ban). Precisam estar aqui para não repetir numa retomada de job.
// ai_agent também ENVIA WhatsApp (mensagem gerada pela IA): efeito externo NÃO
// idempotente — reexecutar reenviaria e reconsumiria cota (risco de ban).
// EFEITO_EXTERNO vem do core (flows/fase-envio.ts) — mesma lista do tratamento de falha.

/**
 * Passo de ENVIO que ficou atrasado mais que isto (worker parado, fila
 * represada) NÃO é executado: o contato é SEGURADO para revisão. Sem isso, ao
 * religar o worker depois de dias parado, todas as mensagens vencidas saíam de
 * uma vez — fora de contexto ("bom dia" à noite, follow-up de 3 dias atrás) e
 * em rajada, que é sinal de ban. Ajustável por env (horas).
 */
const PASSO_VENCIDO_MS = Number(process.env.FLOW_STALE_HOURS ?? 6) * 3_600_000;

/** `adiarMs`: o passo não rodou (sem vez do time) — o worker devolve o job à fila. */
export type DesfechoDoJob = { adiarMs?: number } | void;

export async function handleStepJob(
  jobId: string | undefined,
  data: StepJob,
  opts?: { plannedAt?: number },
): Promise<DesfechoDoJob> {
  const { enrollmentId, nodeId, round } = data;

  // 1. Carrega enrollment cross-team (sem ALS no worker).
  const enr = await basePrisma.enrollment.findUnique({
    where: { id: enrollmentId },
    include: {
      // Status do fluxo (item 1.5): pausado segura, arquivado encerra.
      flow: { select: { status: true, triggerConfig: true } },
      contact: {
        select: {
          id: true,
          teamId: true,
          nome: true,
          tags: true,
          ownerId: true,
          sobrenome: true,
          empresa: true,
          cargo: true,
          cidade: true,
          estado: true,
          cpfCifrado: true,
          cnpj: true,
          site: true,
          relacionamentoStatus: true,
          identifiers: { select: { canal: true, valor: true, valorCifrado: true, isPrimary: true } },
          companies: {
            take: 1,
            orderBy: { createdAt: "asc" },
            select: {
              company: {
                select: {
                  nome: true, cnpj: true, ie: true, cidade: true, estado: true,
                  site: true, telefone: true, email: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!enr) {
    logger.warn({ enrollmentId, nodeId }, "[flow] inscrição não existe — job descartado");
    return;
  }
  if (TERMINAL.has(enr.status)) return; // safety: não reviva enrollment terminado.

  // Job obsoleto (item 1.9, MF-17): a inscrição não está mais neste passo
  // ("definir destino" clicado duas vezes, job velho que sobreviveu no Redis).
  // Antes o handler executava QUALQUER nó e duas linhas corriam na mesma
  // inscrição. Round 0 = inscrição anterior à coluna currentRound.
  if (!jobNoPonteiro(enr, nodeId, round)) {
    await runAsSystem(enr.teamId, async () => {
      // Retry do NOSSO job que fechou o passo e caiu antes de agendar o
      // próximo (MF-01): o ponteiro já andou e diz o que falta.
      const passo = await db().flowStepExecution.findFirst({
        where: { enrollmentId, nodeId, round },
        select: { status: true, jobId: true },
      });
      if (passo?.status === "done" && (!passo.jobId || !jobId || passo.jobId === jobId)) await reagendarPeloPonteiro(enrollmentId);
    });
    logger.info(
      { enrollmentId, nodeId, round, ponteiro: { nodeId: enr.currentNodeId, round: enr.currentRound } },
      "[flow] job obsoleto: a inscrição não está neste passo",
    );
    return;
  }

  // Fluxo pausado/arquivado (item 1.5, MF-07): antes o handler nunca olhava o
  // status e "Pausar" não parava nada. Pausado segura no passo; arquivado encerra.
  if (enr.flow.status !== "active") {
    const decisao = await runAsSystem(enr.teamId, () =>
      aplicarStatusDoFluxo({ enrollmentId, nodeId, round, flowStatus: enr.flow.status }),
    );
    // "seguir": o fluxo voltou ao ar entre a leitura do status e a segurada (pausa e reativação seguidas). O passo
    // roda normalmente; segurar agora deixaria a inscrição parada com o fluxo no ar.
    if (decisao !== "seguir") {
      logger.info({ enrollmentId, nodeId, flowStatus: enr.flow.status, decisao }, "[flow] passo não executado: fluxo fora do ar");
      return;
    }
  }

  // Teto de passos (item 1.4, MF-08): ciclo sem espera (envia → tag → envia)
  // rodava até esgotar a cota do número no MESMO contato.
  if (enr.stepNumber >= FLOW_MAX_STEPS) {
    await runAsSystem(enr.teamId, () => encerrarPorLoop({ enrollmentId, nodeId, round, jobId }));
    return;
  }

  // 1b. S1: o enrollment é lido por basePrisma (sem filtro de time) e o contato
  // vem pelo include. Contato de OUTRO time não recebe nada: marca falha e para.
  // (O `enroll` já recusa esse caso; isto cobre inscrições antigas.)
  if (enr.contact.teamId !== enr.teamId) {
    logger.error({ enrollmentId, nodeId }, "[flow] contato de outro time — inscrição marcada como falha");
    await runAsSystem(enr.teamId, async () => {
      // Retry do mesmo job cai no unique (enrollmentId, nodeId, round): ignora.
      await db()
        .flowStepExecution.create({
          data: tenantData<Prisma.FlowStepExecutionUncheckedCreateInput>({
            enrollmentId,
            nodeId,
            round,
            jobId: jobId ?? null,
            status: "failed",
            error: "contato de outro time",
            finishedAt: new Date(),
          }),
        })
        .catch(() => undefined);
      await db().enrollment.update({ where: { id: enrollmentId }, data: { status: "failed", nextRunAt: null } });
    });
    return;
  }

  // 2. Resolve SÓ o nó corrente no snapshot (item 1.9, MF-18), pela versão em
  // que a inscrição nasceu. Antes: o snapshot inteiro era validado a cada passo
  // (mudar o schema derrubava as inscrições em voo, motivo só no console) e nó
  // ausente encerrava como `done` ("concluído" no painel). Agora é falha
  // VISÍVEL, com o motivo no log do fluxo.
  // O grafo vem da FlowVersion (inscrição nova — cache em memória por versão,
  // sem ler o banco a cada passo) ou do próprio flowSnapshot (antiga) — item 2.7.
  const snapshot = await runAsSystem(enr.teamId, () => snapshotDaInscricao(enr));
  const leitura = lerNoDoSnapshot(snapshot, nodeId, enr.snapshotVersion);
  if (!leitura.ok) {
    logger.error({ enrollmentId, nodeId, motivo: leitura.motivo, err: leitura.erro }, "[flow] passo impossível — inscrição falhou");
    await runAsSystem(enr.teamId, async () => {
      try {
        await db().flowStepExecution.create({
          data: tenantData<Prisma.FlowStepExecutionUncheckedCreateInput>({
            enrollmentId,
            nodeId,
            round,
            jobId: jobId ?? null,
            status: "failed",
            error: leitura.erro,
            finishedAt: new Date(),
          }),
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
        await db().flowStepExecution.updateMany({
          where: { enrollmentId, nodeId, round },
          data: { status: "failed", error: leitura.erro, finishedAt: new Date() },
        });
      }
      await db().enrollment.update({ where: { id: enrollmentId }, data: { status: "failed", nextRunAt: null } });
    });
    return;
  }
  const node = leitura.node;

  // 2b. Passo de envio VENCIDO → segura para revisão humana em vez de disparar.
  // Aparece na aba Histórico do fluxo (waiting sem nextRunAt), onde o vendedor
  // decide reenviar/redirecionar. Nós sem efeito externo seguem normalmente.
  const atraso = opts?.plannedAt ? Date.now() - opts.plannedAt : 0;
  if (EFEITO_EXTERNO.has(node.tipo) && atraso > PASSO_VENCIDO_MS) {
    logger.warn(
      { enrollmentId, nodeId, tipo: node.tipo, atrasoHoras: Math.round(atraso / 3_600_000) },
      "[flow] passo de envio vencido — segurado para revisão",
    );
    await runAsSystem(enr.teamId, async () => {
      try {
        await db().flowStepExecution.create({
          data: tenantData<Prisma.FlowStepExecutionUncheckedCreateInput>({
            enrollmentId,
            nodeId,
            round,
            jobId: jobId ?? null,
            status: "skipped",
            error: `passo vencido há ${Math.round(atraso / 3_600_000)}h e foi segurado para revisão`,
            finishedAt: new Date(),
          }),
        });
      } catch (e) {
        // Retentativa do mesmo job: a execução já foi registrada.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      }
      await db().enrollment.update({
        where: { id: enrollmentId },
        data: { status: "waiting", nextRunAt: null, currentNodeId: nodeId },
      });
    });
    return;
  }

  // 2c. Justiça entre times (item 1.9, MF-20): sem ficha no balde do time, o
  // passo volta para a fila em ~5 s SEM claim — os outros times seguem.
  const espera = await reservarVezDoTime(enr.teamId, { custo: custoDoPasso(node) });
  if (espera > 0) return { adiarMs: adiamentoDoPassoSemFicha(espera) };

  // 3. Executa dentro do contexto do time.
  await runAsSystem(enr.teamId, async () => {
    const prisma = db();

    // Claim idempotente.
    try {
      await prisma.flowStepExecution.create({
        data: tenantData<Prisma.FlowStepExecutionUncheckedCreateInput>({
          enrollmentId,
          nodeId,
          round,
          jobId: jobId ?? null,
          status: "running",
        }),
      });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;

      // Conflito de claim. Antes isto era sempre "skip", o que ANULAVA o retry:
      // se a 1ª tentativa morria no meio, a 2ª batia aqui, retornava normalmente
      // (job "concluído") e o enrollment ficava "active" para sempre, sem próximo
      // passo agendado e sem nunca ser marcado como falho.
      const anterior = await prisma.flowStepExecution.findFirst({
        where: { enrollmentId, nodeId, round },
      });

      // Já concluído de verdade. Se foi a NOSSA tentativa anterior que fechou o
      // passo e morreu antes de agendar o próximo (MF-01), o ponteiro da
      // inscrição diz o que falta — reagenda (idempotente pelo jobId).
      if (!anterior || anterior.status === "done" || anterior.status === "skipped") {
        if (anterior?.status === "done" && (!anterior.jobId || !jobId || anterior.jobId === jobId)) {
          await reagendarPeloPonteiro(enrollmentId);
        }
        return;
      }
      // Outro job cuidando deste passo → não interferir.
      if (anterior.jobId && jobId && anterior.jobId !== jobId) return;
      // Já marcado como falho → não reprocessar em silêncio.
      if (anterior.status === "failed") return;
      // DM deste passo ainda vivo na fila `social` (item 1.8): quem fecha o
      // passo é ele — reexecutar gastaria cota e enfileiraria de novo.
      if (node.tipo === "send_social") {
        const social = await estadoDoEnvioSocial(enrollmentId, nodeId, round);
        if (social && social !== "completed" && social !== "failed") return;
      }

      // Sobrou: `running` do NOSSO job = tentativa anterior morreu no meio.
      // Item 1.2: a marca de fase gravada no passo decide — "enviado" avança,
      // "enviando" segura para revisão, sem marca (caiu antes de chamar o
      // canal) é seguro refazer. Antes todo envio interrompido virava `failed`.
      if (await retomarPassoInterrompido({ enrollmentId, nodeId, round, node, result: anterior.result })) return;
      // Seguro reexecutar.
      await prisma.flowStepExecution.update({
        where: { id: anterior.id },
        data: { status: "running", error: null, startedAt: new Date() },
      });
    }

    // Achata o contato + resolve email/telefone/instagram/linkedin dos identifiers
    // para as variáveis de mensagem ({empresa}, {cidade}, {email}, …).
    const ids = enr.contact.identifiers ?? [];
    const co = enr.contact.companies?.[0]?.company ?? null;
    const contactVars = {
      id: enr.contact.id,
      nome: enr.contact.nome,
      tags: enr.contact.tags,
      ownerId: enr.contact.ownerId,
      sobrenome: enr.contact.sobrenome,
      relacionamentoStatus: enr.contact.relacionamentoStatus,
      empresa: co?.nome ?? enr.contact.empresa, // empresa principal (fallback legado)
      cargo: enr.contact.cargo,
      cidade: enr.contact.cidade,
      estado: enr.contact.estado,
      cpf: lerCpf(enr.contact.cpfCifrado),
      cnpj: enr.contact.cnpj,
      site: enr.contact.site,
      email: primaryEmail(ids),
      telefone: primaryTelefone(ids),
      instagram: ids.find((i) => i.canal === "instagram")?.valor ?? null,
      linkedin: ids.find((i) => i.canal === "linkedin")?.valor ?? null,
      empresaCnpj: co?.cnpj ?? enr.contact.cnpj,
      empresaIe: co?.ie ?? null,
      empresaCidade: co?.cidade ?? null,
      empresaEstado: co?.estado ?? null,
      empresaSite: co?.site ?? enr.contact.site,
      empresaTelefone: co?.telefone ?? null,
      empresaEmail: co?.email ?? null,
    };

    // Executa o nó. Erro → tratamento classificado (item 1.2): avança se o
    // envio saiu, segura se é incerto, pula se é impossível, repete com backoff
    // se não saiu; erro comum sem marca libera o claim e volta para o BullMQ.
    let result: Awaited<ReturnType<typeof executeNode>>;
    try {
      result = await executeNode(
        {
          id: enr.id,
          teamId: enr.teamId,
          contactId: enr.contactId,
          lastOutboundAt: enr.lastOutboundAt,
          contact: contactVars,
          round,
          profundidade: enr.profundidade,
          // Horário de envio do fluxo (lido ao vivo: mudar o horário vale para quem já está em curso).
          janelaEnvio: lerJanelaEnvio(enr.flow.triggerConfig),
        },
        node,
      );
    } catch (err) {
      const desfecho = await tratarFalhaDoPasso({ enrollmentId, nodeId, round, node, erro: err });
      logger.warn(
        { enrollmentId, nodeId, tipo: node.tipo, desfecho, err: err instanceof Error ? err.message : String(err) },
        "[flow] passo falhou",
      );
      if (desfecho === "relancar") throw err;
      return;
    }

    const now = new Date();

    // Envio SOCIAL (Instagram/LinkedIn), item 1.8: o DM vai para a fila
    // `social` (worker primário, uma conta por vez, um navegador por vez) e a
    // inscrição ESPERA ali. É o job social que fecha o passo e move o ponteiro.
    // Antes o Playwright rodava aqui, dentro da fila `flow` (concorrência 12).
    if (result.social) {
      await entregarEnvioSocial({
        enrollmentId,
        nodeId,
        round,
        teamId: enr.teamId,
        contactId: enr.contactId,
        social: result.social,
        agora: now,
      });
      return;
    }

    // Fecha o passo E move o ponteiro da inscrição numa transação só (MF-01).
    // Não gravamos um "note" por passo na timeline do contato: o histórico
    // mostra só toques reais (send_message → Activity whatsapp; update_stage →
    // stage_change). O passo-a-passo fica em FlowStepExecution (aba Logs).
    // Passo travado (hold) põe a inscrição em `waiting` sem reagendar.
    const proximo = await concluirPasso({ enrollmentId, nodeId, round, result, agora: now });

    // Agenda DEPOIS do commit. Se o Redis falhar aqui, o job falha e é
    // retentado (o retry acha o passo `done` e reagenda pelo ponteiro); no pior
    // caso a varredura de órfãs reagenda em até ~10 min.
    if (proximo) await scheduleStep(enrollmentId, proximo.nodeId, proximo.round, proximo.delayMs);
  });
}
