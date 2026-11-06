import { getCurrentTeamId, getCurrentUserId, getCurrentRole, getCurrentModulos, SYSTEM_USER_ID, SYSTEM_ROLE } from "@crmagro/db";
import { moduloDaAcao, temModulo } from "./modulos";

/**
 * Autorização por papel (RBAC) — a ÚNICA segurança real fica aqui, na camada de
 * serviço/action, espelhando a tenancy do `db()`.
 *
 * Princípio: FAIL-CLOSED. Sem papel válido no contexto (ALS) → NEGA. UI escondida
 * não é segurança; a checagem de verdade é `requireRole`/`can` no início de toda
 * ação sensível §1.2 e [[crmagro-seguranca]].
 *
 * Hierarquia (maior para menor): owner > admin > member > viewer.
 * - owner:  o MASTER do time — um só (`Team.masterId`, ver auth/master.ts):
 *           tudo + billing/excluir time + gerência de membros; ninguém mexe nele.
 * - admin:  opera tudo + convida/remove membros (menos owner) + configurações/integrações.
 * - member: dia a dia (contatos, conversas, funis, fluxos, captação, agenda, ligações).
 * - viewer: só leitura das telas operacionais.
 */

export type Role = "owner" | "admin" | "member" | "viewer";

/** Ranking numérico da hierarquia — maior = mais poder. */
const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/** Papéis válidos (para validar entrada de convite etc.). */
export const ROLES: readonly Role[] = ["owner", "admin", "member", "viewer"];

/** True se `value` é um papel conhecido. Desconhecido → false (fail-closed). */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (value as Role) in ROLE_RANK;
}

export type Actor = {
  teamId: string;
  userId: string;
  role: Role;
  /** true = motor/webhook/job agindo em nome do time (ver `runAsSystem`). */
  system?: boolean;
};

/** Erro nomeado de autorização negada — o caller mapeia para 401/403. */
export class ForbiddenError extends Error {
  constructor(message = "Acesso negado") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Retorna o ator atual (teamId+userId+role) ou `null` se a identidade/ papel
 * NÃO estiver completa no contexto. FAIL-CLOSED: papel ausente ou desconhecido
 * → `null` (nunca assume um papel padrão). Note que o teamId sozinho (sem
 * identidade) devolve `null` aqui — as checagens de RBAC exigem identidade.
 */
export function getActor(): Actor | null {
  const teamId = getCurrentTeamId();
  const userId = getCurrentUserId();
  const role = getCurrentRole();
  if (!teamId || !userId) return null;
  // Sistema (motor, webhooks, jobs): identidade explícita, com o poder do dono
  // DENTRO do time do contexto. Só vale com userId E papel de sistema juntos.
  if (userId === SYSTEM_USER_ID && role === SYSTEM_ROLE) {
    return { teamId, userId, role: "owner", system: true };
  }
  if (!isRole(role)) return null;
  return { teamId, userId, role };
}

/**
 * Comparação PURA de papéis (não lê o ALS): true se `role` é >= `min`. Papel
 * desconhecido/ausente → false (fail-closed). Útil para checar o papel da sessão
 * FORA de um contexto de tenancy (ex.: actions que não abrem `runWithTeam`).
 */
export function roleAtLeast(role: string | null | undefined, min: Role): boolean {
  if (!isRole(role)) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** True se o papel atual é >= `min`. Sem ator → false (fail-closed). */
export function hasRole(min: Role): boolean {
  const actor = getActor();
  if (!actor) return false;
  return ROLE_RANK[actor.role] >= ROLE_RANK[min];
}

/**
 * Exige papel >= `min`; lança `ForbiddenError` se não. FAIL-CLOSED: sem ator no
 * contexto → lança. Chamar no INÍCIO de toda ação mutante sensível, DENTRO do
 * escopo de `runWithTeam`/`runAsUserAction` (onde o papel já desceu ao ALS).
 * Devolve o ator para uso subsequente.
 */
export function requireRole(min: Role): Actor {
  const actor = getActor();
  if (!actor || ROLE_RANK[actor.role] < ROLE_RANK[min]) {
    throw new ForbiddenError();
  }
  return actor;
}

/**
 * Ações nomeadas → papel mínimo. Mapa central para `can`/enforcement, evitando
 * espalhar literais de papel pelas actions. Fail-closed por construção: ação
 * desconhecida cai no default `owner` (o mais restritivo).
 */
const ACTION_MIN_ROLE: Record<string, Role> = {
  // Operação do dia a dia (auditoria S7): `viewer` só lê; `member` opera;
  // destrutivo em massa, exportação e ativar fluxo (que dispara WhatsApp) é admin.
  "contacts.write": "member",
  "contacts.import": "member",
  "contacts.delete": "admin",
  "contacts.export": "admin",
  "contacts.merge": "admin",
  "flows.write": "member",
  "flows.activate": "admin",
  "funnels.write": "member",
  "deals.write": "member",
  "messages.send": "member",
  "conversations.delete": "admin",
  "tags.write": "member",
  "agenda.write": "member",
  // Conectar/desconectar a PRÓPRIA Agenda Google (decisão 3, 28/09): cada
  // pessoa conecta a dela, sem o administrador. Não tem tela única no mapa de
  // telas: o serviço exige a tela Agenda OU Integrações (agenda/google/conexao.ts).
  "conexao.propria": "member",
  "calls.write": "member",
  // Linhas de ligação (F1B-05): cadastrar, pausar, reativar e escolher a linha padrão de cada vendedor. Decide
  // por onde a empresa liga e com qual credencial, então é do administrador (a tela Telefonia fica em Integrações).
  "calls.lines.manage": "admin",
  // Web Push: cada pessoa liga/desliga os avisos no PRÓPRIO navegador.
  "push.subscribe": "viewer",
  // Marcar/desmarcar tarefa da lista do dia como feita (produto §F): é trabalho
  // do dia a dia; viewer só lê.
  "tasks.write": "member",
  // Campanhas (produto §A): rascunho, lista e pausar = quem opera. Iniciar,
  // retomar e liberar segurados disparam WhatsApp em massa, mas o ritmo, a
  // janela, o teto diário e os freios da campanha seguram o volume — decisão
  // do dono (27/09): admin E member iniciam. Viewer continua só lendo.
  "campaigns.write": "member",
  "campaigns.start": "member",
  "captacao.run": "member",
  "captacao.import": "member",
  // Consulta PAGA de dado de pessoa (busca por nome, IE/CPF): custa dinheiro e mexe com dado
  // pessoal. É do administrador por padrão (levantamento cnae-ie-cpf §6, Fase B).
  "captacao.fonte_paga": "admin",
  // IA com permissão de escrita (tools que criam/unificam contato etc.).
  "ai.write": "member",
  // Token da extensão (relay) e conexão de rede social: agem pela conta do time.
  "relay.tokens": "admin",
  "social.connect": "admin",
  // Escopo por dono (F3d): redistribuir contatos/negócios/números entre as
  // pessoas é do administrador. Compartilhar usa a ação de escrita do registro.
  "records.transfer": "admin",
  // Gerência de membros / convites
  "team.invite": "admin",
  "team.revokeInvite": "admin",
  "team.manageMembers": "admin",
  // Configurações do time
  "settings.write": "admin",
  "settings.goals": "admin",
  "settings.businessHours": "admin",
  // Integrações / canais
  "integrations.manage": "admin",
  // Base de conhecimento da empresa (o que a IA consulta para falar com os contatos): é o administrador quem
  // decide o que entra, porque vira texto que sai no nome da empresa.
  "conhecimento.write": "admin",
  // Metodologias de abordagem da IA (como o agente conduz a conversa): também decisão do administrador.
  "metodologias.write": "admin",
  // Billing / excluir time
  "team.billing": "owner",
  "team.delete": "owner",
};

/**
 * True se o ator atual pode executar `action`. Fail-closed: ação desconhecida
 * exige `owner`; sem ator → false.
 */
export function can(action: string): boolean {
  const min = ACTION_MIN_ROLE[action] ?? "owner";
  if (!hasRole(min)) return false;
  // Mesma regra de tela do `requireCan` (F2b).
  const modulo = moduloDaAcao(action);
  const actor = getActor();
  return !modulo || !actor || Boolean(actor.system) || temModulo(actor.role, getCurrentModulos(), modulo);
}

/** Igual a `can`, mas lança `ForbiddenError` quando negado. Devolve o ator. */
export function requireCan(action: string): Actor {
  const min = ACTION_MIN_ROLE[action] ?? "owner";
  const actor = requireRole(min);
  // Telas por pessoa (F2b): sem a tela da ação, nega — mesmo que o papel
  // permita. O sistema (motor/webhook) não tem tela e passa.
  const modulo = moduloDaAcao(action);
  if (modulo && !actor.system && !temModulo(actor.role, getCurrentModulos(), modulo)) throw new ForbiddenError();
  return actor;
}
