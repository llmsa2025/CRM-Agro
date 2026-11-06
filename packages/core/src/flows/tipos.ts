/**
 * Tipo do fluxo (`Flow.tipo`): cada tipo só aceita os seus passos e gatilhos.
 *
 * - **prospeccao**: fala com contatos (mensagem, e-mail, DM, agente, ligação) e é inscrito por eles. É o que
 *   todo fluxo era até aqui.
 * - **marketing**: publica postagens nas redes sociais (passo "Postagem") e NÃO fala com contato. Roda por
 *   gatilho manual ou agendado, nunca por evento de contato.
 *
 * O tipo é escolhido na criação e não muda depois: trocar o tipo de um fluxo com passos mudaria o que ele faz
 * com as pessoas. A regra vale no serviço (`createFlow`, `updateFlow`, `activateFlow`), que é quem bloqueia, e
 * no editor, que só mostra o que o tipo aceita.
 *
 * Sem importar valor do Prisma nem do banco: o editor (cliente) usa este arquivo para filtrar a paleta.
 */

export const FLOW_TIPOS = ["prospeccao", "marketing", "enriquecimento"] as const;
export type FlowTipoDoFluxo = (typeof FLOW_TIPOS)[number];

export const NOME_DO_TIPO: Record<FlowTipoDoFluxo, string> = {
  prospeccao: "Prospecção",
  marketing: "Marketing",
  enriquecimento: "Enriquecimento",
};

export const DESCRICAO_DO_TIPO: Record<FlowTipoDoFluxo, string> = {
  prospeccao: "Fala com contatos: mensagem, e-mail, DM, agente e ligação.",
  marketing: "Publica postagens nas redes sociais. Não fala com contato.",
  enriquecimento: "Capta dados, enriquece e atualiza cadastros e histórico, e pode seguir para o funil ou para a conversa. Aceita todos os passos.",
};

/**
 * Tipos que dá para criar hoje. O marketing entra quando o passo "Postagem" existir (sem ele, um fluxo de
 * marketing não tem o que fazer).
 */
export const TIPOS_DISPONIVEIS: readonly FlowTipoDoFluxo[] = ["prospeccao", "enriquecimento"];

/** Passos que só existem em fluxo de marketing. */
const NOS_SO_DO_MARKETING: readonly string[] = ["social_post"];
/** Passos que servem aos dois tipos (não dependem de um contato). */
const NOS_DOS_DOIS: readonly string[] = ["wait", "http_request", "end"];

const NOS_DO_MARKETING = new Set<string>([...NOS_SO_DO_MARKETING, ...NOS_DOS_DOIS]);
/** Passos que falam com o contato (mensagem, e-mail, DM, agente, "digitando"): respeitam janela, cota e opt-out. */
export const NOS_QUE_FALAM_COM_O_CONTATO: ReadonlySet<string> = new Set(["send_message", "send_email", "send_social", "ai_agent", "typing"]);

/**
 * O passo pode entrar num fluxo deste tipo? Prospecção e Enriquecimento aceitam todos os passos, menos o que é só do
 * marketing (Postagem). Marketing é bem específico: só os passos que não dependem de um contato.
 */
export function noServeAoTipo(tipo: FlowTipoDoFluxo, noTipo: string): boolean {
  if (tipo === "marketing") return NOS_DO_MARKETING.has(noTipo);
  return !NOS_SO_DO_MARKETING.includes(noTipo);
}

/** Gatilhos que cada tipo aceita. Marketing não é inscrito por evento de contato. */
const GATILHOS_DO_MARKETING: readonly string[] = ["manual", "schedule"];

export function gatilhoServeAoTipo(tipo: FlowTipoDoFluxo, triggerType: string): boolean {
  return tipo === "marketing" ? GATILHOS_DO_MARKETING.includes(triggerType) : true;
}

export function gatilhosDoTipo<T extends string>(tipo: FlowTipoDoFluxo, todos: readonly T[]): T[] {
  return todos.filter((g) => gatilhoServeAoTipo(tipo, g));
}

const ROTULO_DO_NO: Record<string, string> = {
  send_message: "Enviar mensagem",
  send_email: "Enviar e-mail",
  send_social: "Enviar DM",
  switch_flow: "Trocar de fluxo",
  wait: "Esperar",
  typing: "Digitando",
  condition: "Condição",
  ab_split: "Teste A/B",
  update_stage: "Mover etapa",
  create_deal: "Criar card",
  add_tag: "Adicionar tag",
  notify_user: "Notificar",
  http_request: "HTTP",
  ai_agent: "Agente IA",
  manual_call: "Ligação manual",
  sync_name: "Atualizar nome",
  save_history: "Registrar conversa no histórico",
  enrich_data: "Enriquecer dados (antigo)",
  enrich_company: "Enriquecer empresa",
  enrich_person: "Enriquecer pessoa",
  social_post: "Postagem",
  end: "Fim",
};

const ROTULO_DO_GATILHO: Record<string, string> = {
  contact_created: "Contato criado",
  stage_changed: "Mudança de etapa",
  tag_added: "Tag adicionada",
  message_received: "Mensagem recebida",
  manual: "Manual",
  schedule: "Agendado",
  webhook: "Webhook",
  contacts_selected: "Contatos selecionados",
};

/**
 * Confere o fluxo contra o tipo. Devolve as frases dos problemas (vazio = está de acordo). Cada frase diz o
 * que não pode e em que tipo de fluxo pode.
 */
export function problemasDoTipo(input: { tipo: FlowTipoDoFluxo; triggerType: string; nodeTipos: readonly string[] }): string[] {
  const { tipo, triggerType, nodeTipos } = input;
  const problemas: string[] = [];
  const nome = NOME_DO_TIPO[tipo];
  if (!gatilhoServeAoTipo(tipo, triggerType)) {
    problemas.push(`O gatilho "${ROTULO_DO_GATILHO[triggerType] ?? triggerType}" é de fluxo de prospecção. Fluxo de ${nome} começa por Manual ou Agendado.`);
  }
  const vistos = new Set<string>();
  for (const n of nodeTipos) {
    if (vistos.has(n) || noServeAoTipo(tipo, n)) continue;
    vistos.add(n);
    const doMarketing = NOS_SO_DO_MARKETING.includes(n);
    problemas.push(
      doMarketing
        ? `O passo "${ROTULO_DO_NO[n] ?? n}" só roda em fluxo de Marketing. Este fluxo é de ${nome}.`
        : `O passo "${ROTULO_DO_NO[n] ?? n}" só roda em fluxo de Prospecção. Este fluxo é de ${nome}.`,
    );
  }
  return problemas;
}

/** O que falta para o tipo poder ir ao ar (fluxo de marketing sem Postagem não faz nada). */
export function faltaParaAtivar(input: { tipo: FlowTipoDoFluxo; nodeTipos: readonly string[] }): string | null {
  if (input.tipo === "marketing" && !input.nodeTipos.includes("social_post")) {
    return 'Um fluxo de Marketing precisa de pelo menos um passo "Postagem" para ser ativado.';
  }
  return null;
}
