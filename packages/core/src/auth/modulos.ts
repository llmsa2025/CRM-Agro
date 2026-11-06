/**
 * Telas por pessoa (plano-equipe-permissoes F2b). Cada módulo é um item do menu.
 * O administrador escolhe as telas de cada membro/só leitura; vazio = todas.
 * Master e administradores veem todas sempre.
 *
 * Vale em TRÊS lugares, sempre os três: menu (item some), rota (middleware →
 * /sem-acesso) e ação (`requireCan` → ForbiddenError). Assim a API não depende
 * do menu.
 */
export const MODULOS = [
  "painel",
  "atividades",
  "conversas",
  "ligacoes",
  "agenda",
  "contatos",
  "campanhas",
  "captacao",
  "funis",
  "fluxos",
  "mapa",
  "integracoes",
  "configuracoes",
] as const;
export type Modulo = (typeof MODULOS)[number];

/** Sempre liberados: o Painel é a página inicial (sem ele não há para onde ir). */
export const MODULOS_FIXOS: readonly Modulo[] = ["painel"];

export const ehModulo = (x: string): x is Modulo => (MODULOS as readonly string[]).includes(x);

/**
 * Tela de cada ação do RBAC. Ação sem tela (ex.: `push.subscribe`, `ai.write`)
 * vale em qualquer tela. Acrescentou ação nova no `authz.ts`? Mapeie aqui.
 */
const ACAO_MODULO: Record<string, Modulo> = {
  "contacts.write": "contatos",
  "contacts.import": "contatos",
  "contacts.delete": "contatos",
  "contacts.export": "contatos",
  "contacts.merge": "contatos",
  "tags.write": "contatos",
  "flows.write": "fluxos",
  "flows.activate": "fluxos",
  "funnels.write": "funis",
  "deals.write": "funis",
  "messages.send": "conversas",
  "conversations.delete": "conversas",
  "agenda.write": "agenda",
  "calls.write": "ligacoes",
  "calls.lines.manage": "integracoes",
  "tasks.write": "painel",
  "campaigns.write": "campanhas",
  "campaigns.start": "campanhas",
  "captacao.run": "captacao",
  "captacao.import": "captacao",
  "captacao.fonte_paga": "captacao",
  "relay.tokens": "integracoes",
  "social.connect": "integracoes",
  "integrations.manage": "integracoes",
  "conhecimento.write": "integracoes",
  "metodologias.write": "integracoes",
  "team.invite": "configuracoes",
  "team.revokeInvite": "configuracoes",
  "team.manageMembers": "configuracoes",
  "settings.write": "configuracoes",
  "settings.goals": "configuracoes",
  "settings.businessHours": "configuracoes",
};

export function moduloDaAcao(acao: string): Modulo | null {
  return ACAO_MODULO[acao] ?? null;
}

/** A pessoa tem a tela? Master/admin e lista vazia = todas; o Painel sempre. */
export function temModulo(role: string | null | undefined, modulos: readonly string[] | null | undefined, modulo: string): boolean {
  if (role === "owner" || role === "admin") return true;
  if (!modulos || modulos.length === 0) return true;
  return (MODULOS_FIXOS as readonly string[]).includes(modulo) || modulos.includes(modulo);
}

/** Normaliza a lista escolhida na tela: só módulos conhecidos, sem repetidos, Painel incluso. */
export function normalizarModulos(lista: readonly string[]): Modulo[] {
  const set = new Set(lista.filter(ehModulo));
  if (set.size === 0) return [];
  for (const f of MODULOS_FIXOS) set.add(f);
  // Todas marcadas = vazio (acompanha as telas novas que vierem).
  if (MODULOS.every((m) => set.has(m))) return [];
  return MODULOS.filter((m) => set.has(m));
}

// ---------------------------------------------------------------------------
// "Ver tudo" POR TELA (F3, pedido do dono de 28/09). Nas telas com registros
// que têm dono, o administrador escolhe, por pessoa e por tela, se ela vê "só
// os meus" ou "de todos" (ex.: Contatos de todos, Conversas só as dela).
// Master e administrador veem tudo sempre. Painel e Mapa não entram na lista:
// seguem Contatos (os contatos e as atividades) e Funis (os negócios).
// ---------------------------------------------------------------------------

/** Telas cujos registros têm dono — as que o "ver tudo" por tela controla. */
export const MODULOS_COM_DONO = ["contatos", "funis", "conversas", "ligacoes", "agenda", "campanhas", "fluxos", "captacao"] as const;
export type ModuloComDono = (typeof MODULOS_COM_DONO)[number];

export const ehModuloComDono = (x: unknown): x is ModuloComDono => typeof x === "string" && (MODULOS_COM_DONO as readonly string[]).includes(x);

/** Normaliza a escolha da tela: só telas com dono, sem repetidas, na ordem do menu. */
export function normalizarVerTudoEm(lista: readonly unknown[]): ModuloComDono[] {
  const set = new Set(lista.filter(ehModuloComDono));
  return MODULOS_COM_DONO.filter((m) => set.has(m));
}

/**
 * "Ver tudo" que veio de um token/job: a lista nova (`verTudoEm`) ou, em token
 * e job emitidos antes da troca, o booleano antigo (`verTudo: true` = todas as
 * telas, o mesmo que a migration converteu). Qualquer outra coisa = nenhuma.
 */
export function verTudoEmDoLegado(verTudoEm: unknown, verTudoAntigo?: unknown): ModuloComDono[] {
  if (Array.isArray(verTudoEm)) return normalizarVerTudoEm(verTudoEm);
  return verTudoAntigo === true ? [...MODULOS_COM_DONO] : [];
}

/** A pessoa vê os registros de TODOS nesta tela? Master e administrador: sempre. */
export function veTudoNaTela(role: unknown, verTudoEm: readonly string[] | null | undefined, modulo: ModuloComDono): boolean {
  if (role === "owner" || role === "admin") return true;
  return Boolean(verTudoEm?.includes(modulo));
}

// "Editar" POR TELA (pedido do dono, 28/09): três opções por tela — "Só os
// meus", "Ver de todos" (lê os registros dos colegas, não altera) e "Ver e
// editar de todos". `editarTudoEm` fica sempre DENTRO de `verTudoEm`.

/** Normaliza a lista de edição: só telas com dono e só as que a pessoa também VÊ de todos. */
export function normalizarEditarTudoEm(editar: readonly unknown[], ver: readonly unknown[]): ModuloComDono[] {
  const veTodas = new Set(normalizarVerTudoEm(ver));
  return normalizarVerTudoEm(editar).filter((m) => veTodas.has(m));
}

/**
 * "Editar tudo" que veio de um token/job: a lista nova, ou — em token/job de
 * antes da troca, sem a lista — a própria lista de "ver" (até aqui "ver tudo"
 * também deixava alterar; a migration fez o mesmo no banco).
 */
export function editarTudoEmDoLegado(editarTudoEm: unknown, verTudoEm: readonly string[]): ModuloComDono[] {
  return Array.isArray(editarTudoEm) ? normalizarEditarTudoEm(editarTudoEm, verTudoEm) : normalizarVerTudoEm(verTudoEm);
}

/** A pessoa ALTERA os registros de TODOS nesta tela? Master e administrador: sempre. */
export function editaTudoNaTela(role: unknown, editarTudoEm: readonly string[] | null | undefined, modulo: ModuloComDono): boolean {
  if (role === "owner" || role === "admin") return true;
  return Boolean(editarTudoEm?.includes(modulo));
}

/**
 * De qual "ver tudo" depende cada tela do menu no TEMPO REAL (as salas do
 * socket são por tela): Integrações mostra os números (canais = Conversas);
 * Painel e Mapa seguem Contatos. Tela sem registros com dono → null.
 */
export function moduloDeEscopoDaTela(tela: string): ModuloComDono | null {
  if (ehModuloComDono(tela)) return tela;
  if (tela === "integracoes") return "conversas";
  if (tela === "painel" || tela === "mapa") return "contatos";
  return null;
}
