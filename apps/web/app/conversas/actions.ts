"use server";

import { acaoDaTela } from "@/lib/tenant";
import { mensagemDaRegra, mensagemParaTela } from "@/lib/erros";
import { revalidatePath } from "next/cache";
import {
  assertMediaAllowed,
  assertOwned,
  createChannelAccountSchema,
  criarContaDeCanal,
  excluirContaDeCanal,
  deleteConversation,
  list as listContacts,
  countUnreadConversations,
  listConversations,
  listarTodasAsConversas,
  listConversationsInputSchema,
  listMessages,
  listMessagesInputSchema,
  markRead,
  primaryTelefone,
  primaryEmail,
  listSignatures,
  registerContactForConversation,
  cadastrarContatoDaConversa,
  setRelacionamentoStatus,
  sugerirUnificacaoLid,
  unificarConversaSemNumero,
  sendEmail,
  sendMessage,
  sendMediaMessage,
  sendMessageSchema,
  sendTyping,
  storageEnabled,
  uploadMedia,
  setInteresse,
  startConversationWithContact,
  startConversationWithNumber,
  replyEmailInConversation,
  marcarOptOut,
  createDeal,
  encaminharMensagens,
  listarDestinosDeEncaminhamento,
} from "@crmagro/core";
import type { Interesse } from "@prisma/client";
import type { CompanyInput, PersonInput, Papel } from "@crmagro/core";
import type {
  ConversationListItem,
  ConversationPage,
  CreateChannelAccountInput,
  DestinoDeEncaminhamento,
  ResultadoEncaminhamento,
  ListConversationsInput,
  ListMessagesInput,
  MessageDTO,
  MessagePage,
  SignatureDTO,
  SugestaoUnificacao,
} from "@crmagro/core";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "conversas". */
const runAsUserAction = acaoDaTela("conversas");
/**
 * Ações de Contatos/Funis que aparecem na conversa ("Pediu para sair",
 * "Adicionar ao funil"): valem onde o botão aparece — quem tem Conversas pode,
 * mesmo sem as telas Contatos/Funis (exceção do dono, 28/09). Só estas duas.
 */
const naConversa = acaoDaTela("conversas", { tambem: ["contatos", "funis"] });
export type SendState = {
  ok?: boolean;
  error?: string;
  message?: MessageDTO;
  /** Mídia: o envio anterior do MESMO arquivo ainda não foi confirmado — a tela pede confirmação. */
  reenvioPendente?: boolean;
};

// --- ChannelAccount (Conectar conta — /integracoes) -------------------------

export type AccountState = { ok?: boolean; error?: string; id?: string };

export async function createChannelAccountAction(
  input: CreateChannelAccountInput,
): Promise<AccountState> {
  const parsed = createChannelAccountSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  // WhatsApp só pelo QR do onboarding; nada de URL/instância vindas do cliente
  // (auditoria do #53 — SSRF cego e instância de outro time). RBAC no core.
  try {
    const account = await runAsUserAction(async () => criarContaDeCanal(parsed.data));
    revalidatePath("/conversas");
    revalidatePath("/integracoes");
    return { ok: true, id: account.id };
  } catch (e) {
    return { error: mensagemParaTela(e, { semPrefixo: true }) };
  }
}

export async function deleteChannelAccountAction(id: string): Promise<AccountState> {
  try {
    // Admin (RBAC no core). Conta Evolution: apaga também a instância na Evolution.
    await runAsUserAction(async () => excluirContaDeCanal(id));
    revalidatePath("/conversas");
    revalidatePath("/integracoes");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e, { semPrefixo: true }) };
  }
}

/**
 * LEGADO (tela atual, sem rolagem infinita): TODAS as conversas da conta, como
 * antes do item 2.2 (auditoria do #76 — com o teto de 500, a conversa de um
 * contato antigo sumia da lista). A tela nova usa `listConversationsPageAction`.
 */
export async function listConversationsAction(channelAccountId: string): Promise<ConversationListItem[]> {
  return runAsUserAction(async () => listarTodasAsConversas(channelAccountId));
}

/** Lista do inbox paginada (item 2.2): `cursor` = `nextCursor` da página anterior. */
export async function listConversationsPageAction(
  channelAccountId: string,
  input: ListConversationsInput = {},
): Promise<ConversationPage> {
  const filtros = listConversationsInputSchema.parse(input);
  return runAsUserAction(async () => listConversations(channelAccountId, filtros));
}

/** LEGADO: as 200 mensagens mais NOVAS, em ordem cronológica (DP-02). */
export async function listMessagesAction(conversationId: string): Promise<MessageDTO[]> {
  return runAsUserAction(async () => (await listMessages(conversationId, { take: 200 })).items);
}

/** Thread paginada: 50 mais novas; `antesDe` = `cursorAnteriores` ("carregar anteriores"). */
export async function listMessagesPageAction(conversationId: string, input: ListMessagesInput = {}): Promise<MessagePage> {
  const filtros = listMessagesInputSchema.parse(input);
  return runAsUserAction(async () => listMessages(conversationId, filtros));
}

/** Badge do menu: conversas com mensagem não lida (cache de 30 s por time). */
export async function countUnreadConversationsAction(): Promise<number> {
  return runAsUserAction(async () => countUnreadConversations());
}

/** Responde por E-MAIL numa conversa de e-mail (com assunto "Re:" + tracking). */
export async function sendEmailReplyAction(
  conversationId: string,
  body: string,
  subject?: string,
  signatureId?: string,
): Promise<SendState> {
  if (!body.trim()) return { error: "mensagem vazia" };
  try {
    await runAsUserAction(async () => replyEmailInConversation(conversationId, body.trim(), subject?.trim(), signatureId));
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function registerContactAction(input: {
  conversationId: string;
  nome: string;
  telefone?: string;
}): Promise<{ ok?: boolean; error?: string; contactId?: string; conversationId?: string }> {
  const nome = input.nome?.trim();
  if (!nome) return { error: "nome obrigatório" };
  try {
    // `conversationId` pode ser OUTRO: se o contato já tinha conversa nesta
    // conta, esta foi mesclada nela (item 0.8) — a tela deve abrir a devolvida.
    const { contactId, conversationId } = await runAsUserAction(async () =>
      registerContactForConversation(input.conversationId, nome, input.telefone),
    );
    revalidatePath("/conversas");
    return { ok: true, contactId, conversationId };
  } catch (e) {
    // Número de um contato de outro responsável: diz com quem está (regra do dono, 28/09).
    return { error: mensagemParaTela(e) };
  }
}

/**
 * Cadastro COMPLETO pelo canal: os mesmos campos da tela "Novo contato" (pessoa e empresa), num pop-up.
 * `jaExistia`: o número já era de um contato, a conversa foi ligada a ele e o que foi digitado não foi aplicado.
 */
export async function cadastrarContatoDaConversaAction(input: {
  conversationId: string;
  person: PersonInput;
  company?: CompanyInput | null;
  papel?: Papel;
  responsavelId?: string | null;
  relacionamentoStatus?: "novo" | "ja_conversou" | "cliente";
}): Promise<{ ok?: boolean; error?: string; contactId?: string; conversationId?: string; jaExistia?: boolean; nome?: string; existenteId?: string }> {
  if (!input.person?.nome?.trim()) return { error: "Informe o nome da pessoa." };
  try {
    const { conversationId, ...dados } = input;
    // `conversationId` devolvido pode ser OUTRO: se o contato já tinha conversa nesta conta, esta foi mesclada nela.
    const r = await runAsUserAction(async () => cadastrarContatoDaConversa(conversationId, dados));
    revalidatePath("/conversas");
    revalidatePath("/contatos");
    return { ok: true, ...r };
  } catch (e) {
    // Número ou e-mail de um contato que já existe, ou de outro responsável: diz com quem está (regra do dono, 28/09).
    const existenteId = e instanceof Error && "contactId" in e ? ((e as { contactId?: string | null }).contactId ?? undefined) : undefined;
    return { error: mensagemParaTela(e, { semPrefixo: true }), ...(existenteId ? { existenteId } : {}) };
  }
}

/** Marca o status do contato direto da conversa (Nunca contatado, Contatado, Cliente). */
export async function setStatusDoContatoAction(
  contactId: string,
  status: "novo" | "ja_conversou" | "cliente",
): Promise<{ ok?: boolean; error?: string }> {
  try {
    await runAsUserAction(async () => setRelacionamentoStatus(contactId, status));
    revalidatePath("/conversas");
    revalidatePath("/contatos");
    revalidatePath(`/contatos/${contactId}`);
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e, { semPrefixo: true }) };
  }
}

/**
 * O que o CRM Agro sabe sobre uma conversa "sem número" (@lid): o telefone, o
 * contato dono dele e se já existe outra conversa do número. SÓ leitura.
 */
export async function sugerirUnificacaoAction(
  conversationId: string,
): Promise<{ ok: true; sugestao: SugestaoUnificacao } | { ok: false; error: string }> {
  try {
    const sugestao = await runAsUserAction(async () => sugerirUnificacaoLid(conversationId));
    return { ok: true, sugestao };
  } catch (e) {
    return { ok: false, error: mensagemDaRegra(e) ?? "Não foi possível consultar esta conversa agora." };
  }
}

/**
 * "Unificar com o contato": junta a conversa sem número com a do contato (ou
 * com o número que o CRM Agro descobriu). Devolve a conversa que ficou, para a
 * tela abri-la. RBAC e escopo no core (`unificarConversaSemNumero`).
 */
export async function unificarConversaAction(input: {
  conversationId: string;
  contactId?: string;
  usarNumeroEncontrado?: boolean;
}): Promise<{ ok?: boolean; error?: string; conversationId?: string }> {
  try {
    const alvo = input.contactId
      ? { contactId: input.contactId }
      : input.usarNumeroEncontrado
        ? { usarNumeroEncontrado: true as const }
        : null;
    if (!alvo) return { error: "Escolha um contato para unificar." };
    const r = await runAsUserAction(async () => unificarConversaSemNumero(input.conversationId, alvo));
    revalidatePath("/conversas");
    return { ok: true, conversationId: r.conversationId ?? input.conversationId };
  } catch (e) {
    // Erros de regra têm texto pensado para a pessoa; o resto vira mensagem genérica.
    const nome = e instanceof Error ? e.name : "";
    if (nome === "ForbiddenError" || nome === "EdicaoNaoPermitida") return { error: "Você não tem permissão para unificar esta conversa." };
    if (nome === "OwnedNotFound" && (e as { model?: string }).model === "contact") {
      return { error: "Você não tem acesso ao contato dono deste número. Peça ao administrador." };
    }
    if (nome === "OwnedNotFound" || (e instanceof Error && e.message === "ConversationNotFound")) {
      return { error: "Não encontrei esta conversa. Ela pode já ter sido unificada; atualize a lista." };
    }
    return { error: mensagemDaRegra(e) ?? "Não foi possível unificar agora. Tente de novo." };
  }
}

export type ContactPickerItem = { id: string; nome: string; telefone: string | null };

/** Lista contatos (com telefone) pro seletor de "nova conversa". */
export async function listContactsForPickerAction(search?: string): Promise<ContactPickerItem[]> {
  return runAsUserAction(async () => {
    const { items } = await listContacts({ search, limit: 30 });
    return items.map((c) => ({ id: c.id, nome: c.nome, telefone: primaryTelefone(c.identifiers) }));
  });
}

/**
 * Assinaturas da caixa aberta no inbox (por caixa, 28/09) — para escolher ao
 * escrever/responder; a padrão da caixa vem marcada. Confere a tela
 * "conversas" (antes usava a action de Integrações, que barrava quem só tem
 * Conversas).
 */
export async function listAssinaturasDaCaixaAction(channelAccountId: string): Promise<SignatureDTO[]> {
  if (!channelAccountId) return [];
  return runAsUserAction(async () => listSignatures({ channelAccountId }));
}

export type EmailContactItem = { id: string; nome: string; email: string };

/** Lista contatos QUE TÊM e-mail (para o "Para" ao escrever um e-mail novo). */
export async function listEmailContactsAction(search?: string): Promise<EmailContactItem[]> {
  return runAsUserAction(async () => {
    const { items } = await listContacts({ search, limit: 30 });
    return items
      .map((c) => ({ id: c.id, nome: c.nome, email: primaryEmail(c.identifiers) }))
      .filter((c): c is EmailContactItem => Boolean(c.email));
  });
}

/** Envia um e-mail NOVO para um contato (Escrever) numa conta de e-mail. */
export async function sendNewEmailAction(input: {
  contactId: string;
  subject: string;
  body: string;
  channelAccountId: string;
  signatureId?: string;
}): Promise<SendState> {
  if (!input.body.trim()) return { error: "mensagem vazia" };
  try {
    await runAsUserAction(async () =>
      sendEmail(input.contactId, {
        subject: input.subject.trim() || "(sem assunto)",
        body: input.body.trim(),
        channelAccountId: input.channelAccountId,
        ...(input.signatureId ? { signatureId: input.signatureId } : {}),
      }),
    );
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function startConversationAction(input: {
  channelAccountId: string;
  contactId?: string;
  nome?: string;
  numero?: string;
}): Promise<{ ok?: boolean; error?: string; conversationId?: string }> {
  try {
    if (input.contactId) {
      const { conversationId } = await runAsUserAction(async () =>
        startConversationWithContact(input.channelAccountId, input.contactId!),
      );
      revalidatePath("/conversas");
      return { ok: true, conversationId };
    }
    if (input.nome && input.numero) {
      const { conversationId } = await runAsUserAction(async () =>
        startConversationWithNumber(input.channelAccountId, input.nome!, input.numero!),
      );
      revalidatePath("/conversas");
      return { ok: true, conversationId };
    }
    return { error: "informe um contato ou nome + número" };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function deleteConversationAction(
  conversationId: string,
): Promise<{ ok?: boolean; error?: string }> {
  try {
    await runAsUserAction(async () => deleteConversation(conversationId));
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
  return { ok: true };
}

export async function markReadAction(conversationId: string): Promise<void> {
  await runAsUserAction(async () => markRead(conversationId));
  revalidatePath("/conversas");
}

export async function sendMessageAction(
  conversationId: string,
  text: string,
): Promise<SendState> {
  const parsed = sendMessageSchema.safeParse({ conversationId, text });
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  try {
    const message = await runAsUserAction(async () => sendMessage(parsed.data.conversationId, parsed.data.text));
    revalidatePath("/conversas");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof Error && e.name === "CanalSemEnvioDireto") return { error: e.message };
    return { error: mensagemParaTela(e) };
  }
}

function extFromName(name: string, mime: string): string {
  const fromName = name.includes(".") ? name.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  if (fromName && fromName.length <= 5) return fromName;
  const fromMime = mime.split("/")[1]?.split(";")[0]?.replace(/[^a-z0-9]/gi, "");
  return (fromMime || "bin").toLowerCase().slice(0, 5);
}

/**
 * Envia mídia (imagem/áudio/documento) numa conversa. Recebe FormData
 * (conversationId, file, caption?). Sobe pro Supabase Storage e delega ao
 * serviço, que persiste a Message e tenta o envio ao WhatsApp (best-effort).
 *
 * Ordem importa (S10): sessão → posse da conversa → tipo/tamanho → upload.
 * Antes o upload vinha ANTES da sessão (arquivo anônimo com a service-role).
 */
export async function sendMediaAction(formData: FormData): Promise<SendState> {
  const conversationId = String(formData.get("conversationId") ?? "");
  const caption = String(formData.get("caption") ?? "");
  const file = formData.get("file");
  // Reenvio confirmado pela pessoa ("Enviar mesmo assim") depois do aviso.
  const confirmarReenvio = formData.get("confirmarReenvio") === "1";

  if (!conversationId) return { error: "conversationId obrigatório" };
  if (!(file instanceof File) || file.size === 0) return { error: "arquivo vazio" };
  if (!storageEnabled()) return { error: "armazenamento de mídia não configurado no servidor" };

  try {
    const message = await runAsUserAction(async () => {
      await assertOwned("conversation", conversationId);
      const mime = file.type || "application/octet-stream";
      assertMediaAllowed(mime, file.size);
      const path = `${conversationId}/${crypto.randomUUID()}.${extFromName(file.name, mime)}`;
      const buf = Buffer.from(await file.arrayBuffer());
      // Sobe pro Storage (exibição/persistência) e envia o base64 direto (mais rápido).
      // O Buffer já é um Uint8Array: sem a cópia extra de até 25 MB (INT-14).
      await uploadMedia(path, buf, mime);
      return sendMediaMessage(conversationId, {
        mediaPath: path,
        mediaMime: mime,
        base64: buf.toString("base64"),
        caption,
        confirmarReenvio,
      });
    });
    revalidatePath("/conversas");
    return { ok: true, message };
  } catch (e) {
    // O mesmo arquivo foi enviado há pouco e o envio não foi confirmado: pode
    // já ter chegado. Não é erro — a tela pergunta antes de duplicar.
    if (e instanceof Error && e.name === "EnvioAindaNaoConfirmado") {
      return { reenvioPendente: true, error: mensagemParaTela(e, { semPrefixo: true }) };
    }
    if (e instanceof Error && e.name === "CanalSemEnvioDireto") return { error: e.message };
    return { error: mensagemParaTela(e) };
  }
}

/** Sinaliza "digitando" ao contato da conversa (best-effort; UI não bloqueia). */
export async function sendTypingAction(conversationId: string, durationMs = 4000): Promise<void> {
  try {
    await runAsUserAction(async () => sendTyping(conversationId, durationMs));
  } catch {
    // presença é best-effort — silencioso.
  }
}

/** Define o interesse do contato direto da conversa (qualificação rápida). */
export async function setInteresseAction(
  contactId: string,
  interesse: Interesse,
): Promise<{ ok?: boolean; error?: string }> {
  try {
    await runAsUserAction(async () => setInteresse(contactId, interesse));
    revalidatePath("/conversas");
    revalidatePath(`/contatos/${contactId}`);
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** "Pediu para sair" pelo menu da conversa (exceção: vale sem a tela Contatos). */
export async function marcarOptOutNaConversaAction(contactId: string): Promise<{ ok?: boolean; error?: string; summary?: string }> {
  try {
    const r = await naConversa(async () => marcarOptOut(contactId));
    revalidatePath("/conversas");
    return { ok: true, summary: r.novo ? "Contato marcado: pediu para sair." : "O contato já tinha pedido para sair." };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** "Adicionar ao funil" pelo menu da conversa (exceção: vale sem a tela Funis). */
export async function addToFunnelNaConversaAction(input: {
  contactId: string;
  funnelId: string;
  stageId: string;
  valor?: number;
}): Promise<{ ok?: boolean; error?: string }> {
  if (!input.contactId || !input.funnelId || !input.stageId) return { error: "escolha funil e etapa" };
  try {
    await naConversa(async () =>
      createDeal({ funnelId: input.funnelId, stageId: input.stageId, contactId: input.contactId, valor: input.valor ?? 0 }),
    );
    revalidatePath("/conversas");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

// --- Compartilhar (encaminhar) mensagem --------------------------------------

/** Frase para a pessoa: só as regras do encaminhamento e a falta de permissão têm texto próprio. */
function erroDoEncaminhar(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "EncaminhamentoInvalido") return e.message;
    if (e.name === "ForbiddenError") return "Você não tem permissão para enviar mensagens.";
  }
  return "Não foi possível encaminhar. Tente de novo.";
}

/**
 * Conversas de destino do "Compartilhar": só do mesmo canal da conversa aberta,
 * das contas que a pessoa pode usar, com busca por nome ou número.
 */
export async function listarDestinosEncaminharAction(
  conversationId: string,
  busca?: string,
): Promise<{ items?: DestinoDeEncaminhamento[]; error?: string }> {
  try {
    const items = await runAsUserAction(async () => listarDestinosDeEncaminhamento(conversationId, busca));
    return { items };
  } catch (e) {
    return { error: erroDoEncaminhar(e) };
  }
}

export type EncaminharState = { ok?: boolean; error?: string; resultado?: ResultadoEncaminhamento };

/**
 * Encaminha mensagens para outras conversas do MESMO canal. Toda a regra (canal,
 * time, permissão, cota, "já conversou?") é do servidor: os ids vêm da tela, mas
 * nada aqui confia neles. Falha de um destino não derruba os outros: vem no `resultado`.
 */
export async function encaminharMensagensAction(input: { messageIds: string[]; destinoIds: string[] }): Promise<EncaminharState> {
  try {
    const resultado = await runAsUserAction(async () => encaminharMensagens(input));
    revalidatePath("/conversas");
    return { ok: true, resultado };
  } catch (e) {
    return { error: erroDoEncaminhar(e) };
  }
}
