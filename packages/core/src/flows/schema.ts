import { z } from "zod";
import { FLOW_TIPOS } from "./tipos";

/**
 * Schemas zod do motor de fluxos — uma fonte de verdade (AGENTS.md).
 *
 * O grafo é serializado como uma lista de nós. Cada nó tem `tipo`, `config`
 * (variando por tipo) e, exceto `condition`, um `nextNodeId`. Nó `condition`
 * usa `branches` (ramificações com condição + destino).
 *
 * O `flowSnapshot` guardado no Enrollment é um array de `SnapshotNode` — a
 * versão do grafo no momento da entrada do contato. Isso desacopla a execução
 * de edições posteriores no fluxo.
 */

export const triggerTypeSchema = z.enum([
  "contact_created",
  "stage_changed",
  "tag_added",
  "message_received",
  "manual",
  /**
   * @deprecated Não há job repetível que dispare este gatilho — um fluxo
   * "Agendado" nunca roda. Mantido só porque existe no enum do banco; o editor
   * deve escondê-lo até o agendador existir (MF-14).
   */
  "schedule",
  // Gatilho Webhook (recebimento HTTP). Faltava aqui (MF-14): o editor salvava
  // "webhook" e o zod da action recusava.
  "webhook",
  // Contatos selecionados: não dispara sozinho. Roda nos contatos que a pessoa seleciona em Contatos ("Rodar fluxo").
  // Diferente do Manual, que serve ao "Testar" e à troca de fluxo (`contatos-selecionados.ts`).
  "contacts_selected",
]);
export type TriggerType = z.infer<typeof triggerTypeSchema>;

// ---------------------------------------------------------------------------
// Config de cada tipo de nó
// ---------------------------------------------------------------------------

export const sendMessageConfigSchema = z.object({
  channelAccountId: z.string().optional(), // omitido = fallback pra 1ª conta WA conectada do time
  text: z.string().min(1, "texto obrigatório").max(4096),
  skipIfHistory: z.boolean().optional(), // toggle "não enviar se já houver conversa fora da plataforma"
  // O que fazer quando HÁ histórico de conversa fora da plataforma (revendas):
  //  - "skip" (padrão): não envia e segue o fluxo silenciosamente.
  //  - "hold": não envia, marca a tag "Tem Histórico" e SEGURA o contato para
  //    revisão manual (o vendedor decide retomar) — decisão do usuário p/ revenda.
  onHistory: z.enum(["skip", "hold"]).optional(),
});
export type SendMessageConfig = z.infer<typeof sendMessageConfigSchema>;

export const sendEmailConfigSchema = z.object({
  channelAccountId: z.string().optional(), // omitido = 1ª conta de e-mail conectada
  subject: z.string().min(1, "assunto obrigatório").max(300),
  body: z.string().min(1, "corpo obrigatório").max(20000),
  signatureId: z.string().optional(), // assinatura a anexar (omitido = nenhuma)
  // Sem e-mail no contato: pular o passo (segue o fluxo) em vez de falhar.
  skipIfNoEmail: z.boolean().optional(),
});
export type SendEmailConfig = z.infer<typeof sendEmailConfigSchema>;

export const sendSocialConfigSchema = z.object({
  canal: z.enum(["instagram", "linkedin"]),
  channelAccountId: z.string().optional(), // omitido = 1ª conta social conectada do canal
  template: z.string().min(1, "mensagem obrigatória").max(4000),
  // Comportamento quando o contato NÃO tem o @/URL do canal:
  //  - "skip": pula o passo e segue o fluxo (default);
  //  - "hold": SEGURA o contato no passo (não avança) até você resolver e dar o
  //    OK manual — útil quando não quer avançar sem ter enviado.
  onNoHandle: z.enum(["skip", "hold"]).optional().default("skip"),
  // ANTI-BAN por IA: quando ligado, um passo de IA reescreve o `template` (já com
  // as variáveis resolvidas) numa versão PERSONALIZADA e VARIADA por contato,
  // antes de enviar. Duas mensagens iguais em massa é o maior sinal de spam/ban;
  // variar o texto (mantendo a intenção) reduz esse risco. Se a IA estiver
  // desligada/sem chave ou falhar, envia o template original (fail-open).
  aiPersonalize: z.boolean().optional().default(false),
  // Orientação opcional pra IA (tom, objetivo, o que evitar). Sem isso, ela só
  // reescreve variando naturalmente sem mudar a intenção nem inventar dados.
  aiInstrucao: z.string().trim().max(1000).optional(),
});
export type SendSocialConfig = z.infer<typeof sendSocialConfigSchema>;

export const switchFlowConfigSchema = z.object({
  flowId: z.string().min(1, "escolha o fluxo de destino"),
});
export type SwitchFlowConfig = z.infer<typeof switchFlowConfigSchema>;

export const waitConfigSchema = z
  .object({
    duration: z.number().int().positive(),
    // "sec" existe para cadências curtas (ex.: pausa entre duas mensagens
    // seguidas, para não chegarem coladas no WhatsApp).
    unit: z.enum(["sec", "min", "hour", "day"]),
    // Modo "intercalar" (controle de ritmo): quando presente e > duration, a espera é um
    // valor ALEATÓRIO em [duration, durationMax] na mesma unidade. Assim os
    // envios não saem num intervalo fixo, que é padrão fácil de detectar.
    durationMax: z.number().int().positive().optional(),
  })
  .refine((c) => c.durationMax == null || c.durationMax >= c.duration, {
    message: "durationMax deve ser >= duration",
    path: ["durationMax"],
  });
export type WaitConfig = z.infer<typeof waitConfigSchema>;

export const typingConfigSchema = z
  .object({
    channelAccountId: z.string().optional(),
    duration: z.number().int().positive(),
    unit: z.enum(["sec", "min"]), // "digitando" por horas não faz sentido
    // Mesma ideia controle de ritmo do wait: se presente e > duration, o "digitando" dura
    // um tempo ALEATÓRIO em [duration, durationMax] (parece mais humano).
    durationMax: z.number().int().positive().optional(),
  })
  .refine((c) => c.durationMax == null || c.durationMax >= c.duration, {
    message: "durationMax deve ser >= duration",
    path: ["durationMax"],
  });
export type TypingConfig = z.infer<typeof typingConfigSchema>;

export const conditionDefSchema = z.discriminatedUnion("type", [
  // "respondeu?" = há Activity inbound desde o último send_message do enrollment.
  //
  // `janelaMin` é a JANELA DE ESPERA em minutos: por quanto tempo o motor
  // continua verificando antes de desistir e cair no "senão". Sem ela a
  // condição é medida no instante em que o fluxo chega nela — o que, logo
  // depois de um envio, é sempre "não respondeu" (ninguém responde em 1s).
  // `canal` (opcional) restringe a "respondeu?" a UM canal (o contato respondeu
  // no WhatsApp? no e-mail? no Instagram? no LinkedIn?). Sem `canal`, casa com
  // qualquer resposta recebida (comportamento anterior, preservado).
  z.object({
    type: z.literal("responded"),
    janelaMin: z.number().int().positive().optional(),
    canal: z.enum(["whatsapp", "email", "instagram", "linkedin"]).optional(),
  }),
  z.object({ type: z.literal("tag_present"), tag: z.string().min(1) }),
  z.object({ type: z.literal("stage_is"), stageId: z.string().min(1) }),
  // "tem nome?" — o contato tem um nome REAL no cadastro (não vazio e não um
  // placeholder tipo o próprio número). Base do atendimento personalizado:
  // ramo "sim" usa {primeiro_nome}; ramo "não" manda a mensagem genérica.
  z.object({ type: z.literal("has_name") }),
  // "tem nome no WhatsApp?" — o WhatsApp do contato tem um nome de verdade: o que o dono salvou na agenda do
  // aparelho ou o nome do perfil (só aparece depois de o contato interagir), sem emoji, símbolo ou caractere solto.
  // É o mesmo critério do passo "Atualizar nome": sim = há nome para atualizar o cadastro; não = mensagem genérica.
  z.object({ type: z.literal("whatsapp_name") }),
  // "tem WhatsApp?" — serve para escolher o canal: sim = mensagem no WhatsApp; senão = e-mail ou ligação.
  // `modo` ausente (ou "cadastro") = só olha o cadastro: o contato tem um número de WhatsApp que não foi marcado como
  // errado, sem consultar a Evolution. "verificar" = pergunta ao WhatsApp se o número tem conta, sem enviar mensagem
  // (usa a cota de consultas da conta; ver `conferir-whatsapp.ts`).
  // O modo é OPCIONAL e sem `default` de propósito: o padrão não é gravado, para o fluxo que já existe manter o mesmo
  // grafo (e o mesmo hash da `FlowVersion`).
  z.object({ type: z.literal("has_whatsapp"), modo: z.enum(["cadastro", "verificar"]).optional() }),
  // "tem e-mail?" — o contato tem um e-mail que o passo "Enviar e-mail" usaria: existe e não está marcado inválido
  // por bounce. Só olha o cadastro.
  z.object({ type: z.literal("has_email") }),
  // "já tenho histórico no canal?" — detecta contato já abordado ANTES da
  // plataforma. WhatsApp = checagem REAL na Evolution (conversa existente).
  // E-mail/Instagram = histórico na plataforma (Activity/Conversa do canal).
  z.object({ type: z.literal("channel_history"), canal: z.enum(["whatsapp", "email", "instagram"]) }),
  // "já respondeu?" — o contato já mandou ALGUMA resposta (Activity de entrada),
  // independente do último envio. Útil antes de qualquer disparo no fluxo.
  z.object({ type: z.literal("has_reply") }),
  // "o que ele respondeu?" — olha a(s) resposta(s) recebida(s) desde o último envio (sem envio, as últimas). Sem
  // resposta nenhuma, nenhum destes casa (cai no "senão"). Use depois de um "respondeu?".
  // `reply_class`: sem interesse, tenho interesse ou outro (por palavras, ver `classificar-resposta.ts`).
  z.object({ type: z.literal("reply_class"), classe: z.enum(["sem_interesse", "interesse", "outro"]) }),
  // `reply_text`: a resposta tem a palavra que você escreveu (várias, separadas por vírgula): em qualquer parte
  // (`contem`) ou a resposta inteira é a palavra (`exato`).
  z.object({ type: z.literal("reply_text"), texto: z.string().trim().min(1).max(200), modo: z.enum(["contem", "exato"]).default("contem") }),
]);
export type ConditionDef = z.infer<typeof conditionDefSchema>;

export const conditionBranchesSchema = z.object({
  branches: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      condition: conditionDefSchema,
      nextNodeId: z.string(),
      // Outros destinos da MESMA saída: começam ao mesmo tempo que `nextNodeId`, cada um como um ramo (inscrição filha).
      maisDestinos: z.array(z.string()).max(10).optional(),
    }),
  ),
  default: z.string().nullable(), // destino quando nenhum branch casa (null = termina)
  defaultMais: z.array(z.string()).max(10).optional(), // outros destinos do "senão"
});
export type ConditionBranches = z.infer<typeof conditionBranchesSchema>;

/**
 * Ramos do nó `ab_split` (teste A/B): variantes ponderadas. O contato cai numa
 * variante por SORTEIO — mas o sorteio é DETERMINÍSTICO por (enrollmentId,
 * nodeId), então re-execuções/retries pegam sempre a mesma (senão quebraria a
 * idempotência do motor). `weight` é o peso relativo (não precisa somar 100).
 */
export const abSplitBranchesSchema = z.object({
  variants: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      weight: z.number().int().min(0),
      nextNodeId: z.string(),
    }),
  ),
});
export type AbSplitBranches = z.infer<typeof abSplitBranchesSchema>;

export const updateStageConfigSchema = z.object({
  funnelId: z.string().min(1),
  stageId: z.string().min(1),
});
export type UpdateStageConfig = z.infer<typeof updateStageConfigSchema>;

export const addTagConfigSchema = z.object({ tag: z.string().min(1) });
export type AddTagConfig = z.infer<typeof addTagConfigSchema>;

/**
 * Config do nó `ai_agent`. Dois modos (`modo`; ausente = "mensagem", o que os fluxos antigos já eram):
 *
 * - **mensagem**: GERAÇÃO de UMA mensagem personalizada pela IA. O nó monta o CONTEXTO do contato (dados
 *   canônicos), pede à IA a mensagem, com guardrails fortes (só fatos reais,
 *   proíbe inventar, mantém intenção/idioma/tom, tamanho controlado, varia p/ controle de ritmo) e ENVIA pelo canal
 *   (hoje WhatsApp) seguindo a regra de ouro (o core chama o serviço de canal, nunca um provider direto).
 *   FAIL-OPEN: IA desligada/sem chave/erro → cai no `fallbackText` (template seguro, sem placeholder vazado).
 *
 * - **conversa**: o agente CONVERSA com o contato. Abre a conversa seguindo a `orientacao`, espera a
 *   resposta (por evento, como a condição "respondeu?"), lê o histórico e responde, de novo e de novo, até:
 *   a IA passar para uma pessoa, o contato parar de responder (`silencioHoras`), as `maxRespostas`
 *   mensagens do agente acabarem, uma pessoa responder na conversa, ou o contato pedir para parar (opt-out).
 *   Aí o fluxo segue para o próximo passo. Sem texto de segurança no meio da conversa: se a IA falha, tenta
 *   de novo e, esgotadas as tentativas, passa para uma pessoa.
 *
 * Provedor plugável (anthropic/glm); omitido = o primeiro conectado do time.
 */
export const aiAgentConfigSchema = z.object({
  modo: z.enum(["mensagem", "conversa"]).optional(),
  // O que a mensagem deve alcançar (ex.: "apresentar a consultoria e propor uma
  // conversa de 15 min"). É a espinha da geração — a IA não inventa objetivo. (modo mensagem)
  objetivo: z.string().trim().max(2000).optional(),
  // Orientação da conversa (modo conversa): quem é o agente, o que quer alcançar, o que pode e não pode
  // dizer, quando passar para uma pessoa.
  orientacao: z.string().trim().max(4000).optional(),
  // Tom desejado (ex.: "cordial e direto", "consultivo"). Default: cordial e humano.
  tom: z.string().trim().max(200).optional(),
  // Canal de envio. Hoje só WhatsApp está implementado no nó.
  canal: z.enum(["whatsapp"]).default("whatsapp"),
  // Tamanho-alvo em caracteres (guardrail anti-parágrafo). Default resolvido no executor.
  maxChars: z.number().int().min(80).max(2000).optional(),
  // Template de SEGURANÇA (fail-open) usado quando a IA está desligada/falha. (modo mensagem)
  // Aceita as variáveis do renderTemplate ({saudacao}, {primeiro_nome}, …).
  fallbackText: z.string().trim().max(4096).optional(),
  // Quantas mensagens o agente manda no total, contando a de abertura (modo conversa). Padrão 6.
  maxRespostas: z.number().int().min(1).max(30).optional(),
  // Quantas horas esperar o contato responder antes de encerrar a conversa (modo conversa). Padrão 24.
  silencioHoras: z.number().int().min(1).max(168).optional(),
  // Avisa o dono do contato quando o agente passa a conversa para uma pessoa (modo conversa). Padrão: sim.
  avisarVendedor: z.boolean().optional(),
  // Metodologia de abordagem (Integrações → IA → Metodologias). Ausente = a padrão da empresa para o agente;
  // "nenhuma" = sem metodologia; um id = aquela. É lida na hora de rodar (não fica congelada no fluxo).
  metodologiaId: z.string().trim().max(64).optional(),
  // Não enviar se já houver conversa fora da plataforma (mesma semântica do send_message).
  skipIfHistory: z.boolean().optional(),
  onHistory: z.enum(["skip", "hold"]).optional(),
  // Provedor/modelo/temperatura (opcionais). Provedor omitido = 1º conectado.
  provider: z.enum(["anthropic", "glm"]).optional(),
  model: z.string().trim().optional(),
  temperature: z.number().min(0).max(2).optional(),
  channelAccountId: z.string().optional(), // conta de canal (omitido = 1ª WA conectada)
});
export type AiAgentConfig = z.infer<typeof aiAgentConfigSchema>;

export const notifyUserConfigSchema = z.object({
  userId: z.string().optional(), // omitido = notifica o ownerId do contato
  message: z.string().min(1),
});
export type NotifyUserConfig = z.infer<typeof notifyUserConfigSchema>;

export const httpRequestConfigSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type HttpRequestConfig = z.infer<typeof httpRequestConfigSchema>;

/**
 * Nó `manual_call` (ligação manual): TRAVA o passo. Cria uma ligação PENDENTE no
 * histórico do contato e segura o enrollment (waiting, sem reagendamento) até o
 * vendedor marcar "feito" (com data/hora/resumo/observação). Só então o fluxo
 * avança. `roteiro` é uma orientação opcional do que falar na ligação.
 */
export const manualCallConfigSchema = z.object({
  roteiro: z.string().trim().max(2000).optional(),
});
export type ManualCallConfig = z.infer<typeof manualCallConfigSchema>;

/**
 * Nó `sync_name` (atualizar nome pelo WhatsApp): lê o pushName que o contato
 * expôs ao interagir (só vem DEPOIS de ele responder) e, se o cadastro não tiver
 * nome real, preenche. Com `overwrite`, sobrescreve o nome atual mesmo que já
 * exista. É o que viabiliza o atendimento automatizado personalizado.
 */
export const syncNameConfigSchema = z.object({
  overwrite: z.boolean().optional(),
});
export type SyncNameConfig = z.infer<typeof syncNameConfigSchema>;

/**
 * Nó `save_history` (registrar conversa no histórico): pega a conversa do contato no WhatsApp (todas as
 * mensagens, tenha ele respondido ou não) e registra no histórico do contato. Só roda para contato com número
 * de WhatsApp cadastrado; sem ele o passo fica segurado ("sem cadastro") até alguém cadastrar e retomar.
 */
export const saveHistoryConfigSchema = z.object({
  channelAccountId: z.string().optional(), // conta de WhatsApp (omitido = 1ª conectada)
});
export type SaveHistoryConfig = z.infer<typeof saveHistoryConfigSchema>;

/**
 * Nó `enrich_data` (enriquecer dados): consulta o CNPJ das empresas do contato (CNPJá, depois BrasilAPI) e preenche
 * só o que está vazio (IE, e-mail, telefone, endereço, cidade, UF, CNAE). Sem CNPJ não tem o que consultar: o
 * passo pula com o motivo. IE sem CNPJ e CPF ainda não têm fonte pública; ficam na lista de pendências.
 */
export const enrichDataConfigSchema = z.object({}).passthrough();
export type EnrichDataConfig = z.infer<typeof enrichDataConfigSchema>;

/**
 * Nó `enrich_company` (enriquecer empresa): consulta o CNPJ de cada empresa do contato e preenche só o que está VAZIO
 * (e-mail, telefone, IE, endereço, cidade, UF, CNAE, natureza jurídica), com a fonte e a data de cada campo. Só dado de
 * confiança alta ou média; nunca troca valor existente, nunca guarda o e-mail do contador, não lê o site.
 */
export const enrichCompanyConfigSchema = z.object({}).passthrough();
export type EnrichCompanyConfig = z.infer<typeof enrichCompanyConfigSchema>;

/**
 * Nó `enrich_person` (enriquecer pessoa): com o CPF guardado no contato e o nome, acha na fonte gratuita as empresas
 * em que ele é sócio ou dono e as vincula. Só confiança alta (nome e CPF conferem); `incluirConfiancaMedia` liga também
 * as de nome parecido. Nunca consulta fonte paga (IE de produtor fica para quem enriquece à mão, com o custo à vista).
 */
export const enrichPersonConfigSchema = z.object({ incluirConfiancaMedia: z.boolean().optional() }).passthrough();
export type EnrichPersonConfig = z.infer<typeof enrichPersonConfigSchema>;

// ---------------------------------------------------------------------------
// Nó do snapshot / input do builder — discriminated union por `tipo`
// ---------------------------------------------------------------------------

const baseNodeFields = { id: z.string() } as const;

export const snapshotNodeSchema = z.discriminatedUnion("tipo", [
  z.object({
    ...baseNodeFields,
    tipo: z.literal("send_message"),
    config: sendMessageConfigSchema,
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("send_email"),
    config: sendEmailConfigSchema,
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("send_social"),
    config: sendSocialConfigSchema,
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("switch_flow"),
    config: switchFlowConfigSchema,
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("wait"),
    config: waitConfigSchema,
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("typing"),
    config: typingConfigSchema,
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("condition"),
    config: z.unknown().optional(),
    branches: conditionBranchesSchema,
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("ab_split"),
    config: z.unknown().optional(),
    branches: abSplitBranchesSchema,
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("update_stage"),
    config: updateStageConfigSchema,
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("create_deal"),
    config: updateStageConfigSchema, // mesma config: funnelId + stageId
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("add_tag"),
    config: addTagConfigSchema,
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("notify_user"),
    config: notifyUserConfigSchema,
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("http_request"),
    config: httpRequestConfigSchema,
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("ai_agent"),
    config: aiAgentConfigSchema.optional(),
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("manual_call"),
    config: manualCallConfigSchema.optional(),
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("sync_name"),
    config: syncNameConfigSchema.optional(),
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("save_history"),
    config: saveHistoryConfigSchema.optional(),
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("enrich_data"),
    config: enrichDataConfigSchema.optional(),
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("enrich_company"),
    config: enrichCompanyConfigSchema.optional(),
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("enrich_person"),
    config: enrichPersonConfigSchema.optional(),
    nextNodeId: z.string().nullable(),
  }),
  z.object({
    ...baseNodeFields,
    tipo: z.literal("end"),
    config: z.unknown().optional(),
    nextNodeId: z.string().nullable(), // sempre null — nó terminal
  }),
]);
export type SnapshotNode = z.infer<typeof snapshotNodeSchema>;

export const flowSnapshotSchema = z.array(snapshotNodeSchema);

// ---------------------------------------------------------------------------
// CRUD de Flow
// ---------------------------------------------------------------------------

/** Posição de cada nó no canvas (mapa nodeId → {x,y}), persistida no FlowNode. */
export const nodePositionsSchema = z.record(
  z.string(),
  z.object({ x: z.number(), y: z.number() }),
);
export type NodePositions = z.infer<typeof nodePositionsSchema>;

export const flowCreateSchema = z.object({
  nome: z.string().trim().min(1, "nome obrigatório"),
  // Tipo do fluxo (prospecção ou marketing). Ausente = prospecção. Não muda depois de criado (`tipos.ts`).
  tipo: z.enum(FLOW_TIPOS).optional(),
  triggerType: triggerTypeSchema,
  triggerConfig: z.record(z.string(), z.unknown()).optional(),
  nodes: z.array(snapshotNodeSchema).default([]),
  positions: nodePositionsSchema.optional(),
});
export type FlowCreate = z.infer<typeof flowCreateSchema>;

export const flowUpdateSchema = flowCreateSchema.partial().extend({
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
});
export type FlowUpdate = z.infer<typeof flowUpdateSchema>;
