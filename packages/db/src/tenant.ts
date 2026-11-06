import { Prisma } from "@prisma/client";

/**
 * Modelos tenant-scoped (têm coluna teamId). Team é a raiz do tenant e NÃO
 * recebe injeção. Manter em sincronia com o schema.prisma.
 */
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  "User",
  "Goal",
  "Contact",
  "Activity",
  "Conversation",
  "Message",
  "Funnel",
  "Stage",
  "Deal",
  "Flow",
  "FlowNode",
  "Enrollment",
  // FlowVersion — grafo congelado do fluxo, deduplicado por hash (item 2.7).
  "FlowVersion",
  "FlowStepExecution",
  "Integration",
  // KnowledgeDoc: base de conhecimento da empresa (IA). teamId em toda query.
  "KnowledgeDoc",
  // Methodology: metodologias de abordagem da IA (Integrações → IA). teamId em toda query.
  "Methodology",
  // ConsultaDocumento: registro de consulta paga de dado de pessoa (LGPD). teamId em toda query.
  "ConsultaDocumento",
  "ChannelIdentifier",
  "ChannelAccount",
  // Call chegou na migration 20260723083411_add_call_model — tenant-scoped como
  // o restante (teamId em toda query). Sem isto, db().call.* não receberia o
  // filtro/injeção de teamId e vazar para outros times. Mantém §12 em sincronia
  // com o schema.prisma (todo model com teamId DEVE estar aqui).
  "Call",
  // TeamConfig — config 1:1 do time (horário comercial/feriados). tenant-scoped:
  // teamId é a chave única. Sem isto, getTeamConfig de um time veria config
  // alheia e o upsert/write burlaria o filtro de tenant (§12).
  "TeamConfig",
  // Tag / ContactTag — tags nomeáveis (migration add_tags). tenant-scoped: teamId
  // em toda query. Sem isto, listTags/createTag/setContactTag não receberiam o
  // filtro/injeção de teamId e vazariam entre times (§12).
  "Tag",
  "ContactTag",
  // Uso diário por conta (Fase B — controle de ritmo). tenant-scoped: teamId em toda
  // query; o motor incrementa o contador por conta/dia do time.
  "ChannelAccountUsage",
  // Empresa + vínculo pessoa↔empresa (multi-empresa). tenant-scoped: teamId em
  // toda query. Sem isto, Company/ContactCompany vazariam entre times (§12).
  "Company",
  "ContactCompany",
  // Appointment — agenda/compromissos. tenant-scoped: teamId em toda query.
  // Sem isto, a Agenda de um time veria/gravaria compromissos de outro (§12).
  "Appointment",
  "ProspectDraft",
  "EmailSignature",
  "AiConversation",
  "RelayAgentToken",
  // EnrichmentFact — proveniência append-only do pipeline de enriquecimento.
  // tenant-scoped: teamId em toda query. Sem isto, os Facts de um time vazariam
  // para outro e o reconciler leria proveniência alheia (§12).
  "EnrichmentFact",
  // Invite — convite de acesso (auth/invites.ts). tenant-scoped: a emissão usa
  // db() e confia na injeção de teamId. Estava FORA da lista: emitir convite
  // quebrava (teamId ausente) e, se alguém passasse o teamId à mão, listInvites/
  // revokeInvite passariam a enxergar convites de todos os times (auditoria S2).
  // O teste de DMMF (core/src/tenancy/tenant-extension.test.ts) cobra que todo
  // model com coluna teamId esteja aqui.
  "Invite",
  // ImportJob — importação de contatos em 4 passos (produto §C). tenant-scoped:
  // um time nunca vê nem cancela o job de outro.
  "ImportJob",
  // Campanhas (produto §A). tenant-scoped: um time nunca vê, inicia nem conta
  // destinatários de campanha alheia. WhatsAppNumberCheck é GLOBAL (sem teamId).
  "Campaign",
  "CampaignRecipient",
  // Camadas do mapa (produto §B): tenant-scoped; sem isto, camadas de um time apareceriam para outro.
  "MapaCamada",
  // Web Push: assinatura do navegador de um usuário. tenant-scoped: o envio
  // lista as assinaturas pelo db() do time do contexto — o push de um time
  // nunca chega ao navegador de outro.
  "PushSubscription",
  // Tarefa do dia marcada como feita (produto §F). tenant-scoped: a marca de um
  // time nunca esconde tarefa de outro.
  "DailyTaskState",
  // Google Agenda + Meet (28/09): convidados, conexão OAuth por pessoa (tokens
  // cifrados), estado da sincronização, vínculo com o evento externo e o bloco
  // "Ocupado". tenant-scoped: a agenda de um time nunca aparece em outro.
  "AppointmentAttendee",
  "OAuthConnection",
  "CalendarSync",
  "AppointmentLink",
  "CalendarBusyBlock",
  // Token (cifrado) aguardando a revogação no Google: o worker lê cruzando
  // times (basePrisma) e grava no contexto do time da linha.
  "OAuthRevogacaoPendente",
  // WhatsAppLid — mapa @lid → telefone (30/09). tenant-scoped: o par de um time
  // nunca é lido nem usado por outro (a unificação de conversas confia nele).
  "WhatsAppLid",
  // EmailEncaminhamento — endereço de encaminhamento de caixa de e-mail (#178).
  // tenant-scoped: um time nunca vê, gera nem desliga o endereço de outro.
  "EmailEncaminhamento",
  // LinhaDeLigacao: por onde um vendedor (ou o time) liga (F1B-05, plano de ligação). tenant-scoped:
  // uma empresa nunca lê, pausa nem troca a linha de outra. A chave única (provedor, contaExterna,
  // idExterno) é do sistema todo, de propósito: o time de um aviso sai da linha.
  "LinhaDeLigacao",
]);

const READ_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);
const WHERE_OPS = new Set(["update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"]);
const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);

/**
 * Todas as operações que a extensão sabe tratar. Qualquer outra num model tenant
 * é recusada (FAIL-CLOSED, auditoria S3): antes, `findUniqueOrThrow`,
 * `findFirstOrThrow` e `updateManyAndReturn` passavam SEM filtro de time, e uma
 * operação nova do Prisma entraria do mesmo jeito sem ninguém perceber.
 */
export const TENANT_KNOWN_OPERATIONS: ReadonlySet<string> = new Set([
  ...READ_OPS,
  ...WHERE_OPS,
  ...CREATE_OPS,
]);

/**
 * Extensão que injeta `teamId` (capturado no CLOSURE) em leituras e escritas.
 *
 * Por que closure e não AsyncLocalStorage lido aqui dentro: o `$allOperations`
 * do Prisma roda LAZY (no momento do await). Em ambientes bundled (Next), o ALS
 * se perde nesse caminho lazy (findUnique com include etc.). Capturando o teamId
 * no closure (eager, no momento de criar o client), o valor persiste independente
 * do ALS na execução lazy. A leitura eager do ALS acontece em `db()` (client.ts),
 * que é síncrona e confiável.
 *
 * Requisitos da PARTE 0 (§12): a) where.teamId leituras; b) teamId em create/upsert;
 * c) relações aninhadas cobertas transitivamente; d) teamId do contexto (via closure
 * alimentado por ALS em db()); e) FAIL-CLOSED em db(); f) raw SQL não interceptado
 * (proibido em tabelas tenant).
 */
export function tenantExtension(teamId: string) {
  return Prisma.defineExtension((client) =>
    client.$extends({
      query: {
        $allModels: {
          async $allOperations({ args, query, operation, model }) {
            if (!model || !TENANT_MODELS.has(model as string)) {
              return query(args);
            }

            const op = operation as string;
            const a = args as Record<string, unknown>;

            if (!TENANT_KNOWN_OPERATIONS.has(op)) {
              throw new TenantUnknownOperationError(op, model as string);
            }

            if (READ_OPS.has(op)) {
              a.where = { ...(a.where as object | undefined), teamId };
            }

            if (op === "create") {
              a.data = { ...(a.data as object | undefined), teamId };
            } else if (op === "createMany" || op === "createManyAndReturn") {
              const data = a.data;
              a.data = Array.isArray(data)
                ? data.map((d) => ({ ...d, teamId }))
                : { ...(data as object), teamId };
            } else if (op === "upsert") {
              a.where = { ...(a.where as object | undefined), teamId };
              a.create = { ...(a.create as object | undefined), teamId };
              // update NÃO sobrescreve teamId (impede trocar o dono do registro).
              exigirMesmoTime(a.update, teamId, op, model as string);
            } else if (WHERE_OPS.has(op)) {
              a.where = { ...(a.where as object | undefined), teamId };
              if (op !== "delete" && op !== "deleteMany") exigirMesmoTime(a.data, teamId, op, model as string);
            }

            return query(args);
          },
        },
      },
    }),
  );
}

/**
 * Defesa em profundidade (auditoria de isolamento 09/2026): o `where` de uma
 * atualização já é do time do contexto, mas o `data` podia trazer outro
 * `teamId` (ou `team: { connect }`) e MOVER o registro para outro time. Nenhum
 * serviço faz isso hoje (o zod descarta campos desconhecidos), então a regra
 * não muda comportamento — só fecha a porta: trocar o time numa atualização é
 * sempre recusado; o mesmo `teamId` do contexto passa.
 */
function exigirMesmoTime(data: unknown, teamId: string, operation: string, model: string): void {
  if (data == null || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  if ((d.teamId !== undefined && d.teamId !== teamId) || d.team !== undefined) {
    throw new TenantMismatchError(operation, model);
  }
}

/** Atualização que tentou trocar o time do registro (recusada, ver `exigirMesmoTime`). */
export class TenantMismatchError extends Error {
  constructor(operation: string, model: string) {
    super(`TenantMismatch: ${operation} em ${model} tentou trocar o teamId do registro.`);
    this.name = "TenantMismatchError";
  }
}

/**
 * Operação do Prisma que a extensão de tenancy não conhece, num model tenant.
 * Recusada de propósito: deixar passar significaria rodar SEM filtro de teamId.
 * Se aparecer, ensine a operação à extensão (READ_OPS/WHERE_OPS/CREATE_OPS).
 */
export class TenantUnknownOperationError extends Error {
  constructor(operation: string, model: string) {
    super(`TenantUnknownOperation: ${operation} em ${model} não é tratada pela extensão de tenancy.`);
    this.name = "TenantUnknownOperationError";
  }
}

export class TenantContextRequiredError extends Error {
  constructor(operation: string, model: string) {
    super(
      `TenantContextRequired: ${operation} em ${model} sem teamId no contexto.`,
    );
    this.name = "TenantContextRequiredError";
  }
}
