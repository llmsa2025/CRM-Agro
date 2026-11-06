import { z } from "zod";

/** Input de envio de mensagem (validado na borda — server action / API). */
export const sendMessageSchema = z.object({
  conversationId: z.string().min(1, "conversationId obrigatório"),
  text: z.string().min(1, "texto vazio").max(4096, "texto longo demais"),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/** Input de criação de ChannelAccount (fluxo Conectar conta, em /integracoes).
 *
 * credentials guarda SÓ identificadores não-secretos (ex.: `instance`, `number`
 * para Evolution). `apiKey`/`apiSecret`/`secret`/`token`/`password` são rejeitados
 * aqui — defensiva: mesmo que um dia alguém ilha essa action num form, segredos
 * nunca são persistidos no Json do banco. A apikey admin global da Evolution vem
 * do env em packages/channels/factory.ts, não do DB.
 */
const SECRET_CRED_KEYS = new Set([
  "apiKey",
  "apikey",
  "api_key",
  "apiSecret",
  "api_secret",
  "secret",
  "password",
  "token",
  "bearer",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
]);

export const createChannelAccountSchema = z.object({
  canal: z.enum(["whatsapp", "instagram", "linkedin", "email"]),
  label: z.string().min(1, "nome da conta obrigatório").max(80),
  provider: z.string().min(1),
  credentials: z
    .record(z.string(), z.unknown())
    .refine(
      (c) => !Object.keys(c ?? {}).some((k) => SECRET_CRED_KEYS.has(k)),
      "credentials só podem conter identificadores não-secretos (instance, number). apiKey/secret/token vêm do env, não do banco.",
    ),
});
export type CreateChannelAccountInput = z.infer<typeof createChannelAccountSchema>;

/**
 * Filtros da lista do inbox (item 2.2). `cursor` = `nextCursor` da página
 * anterior (opaco). `naoLidas` = só conversas com mensagem não lida. `busca` =
 * nome/empresa do contato, pushName, número ou texto da última mensagem.
 */
export const listConversationsInputSchema = z.object({
  cursor: z.string().max(200).nullish(),
  naoLidas: z.boolean().optional(),
  busca: z.string().trim().max(100).optional(),
  take: z.number().int().min(1).max(100).optional(),
});
export type ListConversationsInput = z.infer<typeof listConversationsInputSchema>;

/** "Carregar anteriores" da thread: `antesDe` = `cursorAnteriores` da página atual. */
export const listMessagesInputSchema = z.object({
  antesDe: z.string().max(200).nullish(),
  take: z.number().int().min(1).max(100).optional(),
});
export type ListMessagesInput = z.infer<typeof listMessagesInputSchema>;

/** Item de conversa p/ a lista do inbox. */
export type ConversationListItem = {
  id: string;
  canal: string;
  status: string;
  unreadCount: number;
  lastMessageAt: string | null;
  // null = número não-cadastrado. empresa/cidade/estado/relacionamentoStatus:
  // coluna "Sobre" da tela nova (N10).
  contact: {
    id: string;
    nome: string;
    /** Sobrenome (o nome exibido em `displayName` já traz os dois). */
    sobrenome: string | null;
    interesse: string;
    empresa: string | null;
    cidade: string | null;
    estado: string | null;
    relacionamentoStatus: string;
  } | null;
  displayName: string; // contato > agenda do celular > pushName (só recebida) > número
  /** Nome para sugerir no "Cadastrar contato": agenda > pushName; null = não sabemos. */
  nomeSugerido: string | null;
  numero: string | null; // telefone do contato ou externalNumber
  contactEmail: string | null; // e-mail primário do contato (para o "Para" do e-mail)
  externalNumber: string | null;
  lastMessage: { conteudo: string | null; direcao: string; createdAt: string } | null;
};

/** Página da lista do inbox: ordem `lastMessageAt desc, id desc`. */
export type ConversationPage = { items: ConversationListItem[]; nextCursor: string | null };

/** Mensagem normalizada p/ a UI. */
export type MessageDTO = {
  id: string;
  direcao: string;
  tipo: string;
  conteudo: string | null;
  mediaUrl: string | null; // URL assinada (curta duração) quando há mídia
  mediaMime: string | null;
  status: string;
  createdAt: string;
  // E-mail: assunto e remetente/destinatário (para a leitura estilo cliente de e-mail).
  subject?: string | null;
  emailFrom?: string | null;
  emailTo?: string | null;
};

/**
 * Página da thread, em ordem CRONOLÓGICA (a mais nova por último).
 * `cursorAnteriores` ≠ null → há mensagens mais antigas para carregar.
 */
export type MessagePage = { items: MessageDTO[]; cursorAnteriores: string | null };
