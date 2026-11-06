import { env } from "@crmagro/config";
import { basePrisma, db, getCurrentTeamId, runAsSystem } from "@crmagro/db";
import {
  defaultEvolutionProvider,
  getChannelProvider,
  hasWhatsAppHistory,
  normalizePhone,
  phoneVariants,
  baixarMidiaEvolution,
  MAX_MIDIA_RECEBIDA_BYTES,
  type ChannelAccountRef,
  type InboundMessage,
  type MediaType,
} from "@crmagro/channels";
import { emitConversationEvent, emitMessageStatus } from "./events";
import { safeEnrollByTrigger } from "../flows/triggers";
import { checkAndMaybePauseAccount } from "../channels-limit/service";
import { signedMediaUrls, uploadMedia, storageEnabled } from "../storage/service";
import type {
  ConversationListItem,
  ConversationPage,
  ListConversationsInput,
  ListMessagesInput,
  MessageDTO,
  MessagePage,
} from "./schema";
import { codificarCursor, decodificarCursor, type ChaveCursor } from "../shared/cursor-keyset";
import { assertOwned, OwnedNotFound } from "../tenancy/assert-owned";
import { donoPadrao } from "../tenancy/escopo";
import { quemAge, recusarSeDeOutro, responsavelObrigatorio } from "../contacts/responsavel";
import { escopoCanal, escopoConversa } from "./escopo";
import { isUniqueViolation } from "../contacts/errors";
import { createContactWithCompany, type CompanyInput, type PersonInput, type Papel } from "../companies/service";
import { vincularConversaAoContato } from "./vinculo";
import { descobrirEUnificarLid } from "./unificar-lid";
import { gravarParesLid } from "./lid-mapa";
import {
  buscaExataDeContatos,
  numeroDe,
  ondeBuscaDeConversaPorNumero,
  ondeBuscaDeIdentificador,
  ondeConversaPorNumero,
  ondeIdentificadorExato,
  valorDe,
} from "../contacts/identificadores-cifra";
import { invalidarNaoLidas, previewDaMensagem, touchConversation } from "./ultima-mensagem";
import { ehLid, nomeCompleto, nomeDaConversa, nomeDePessoaValido, nomeSugeridoDaConversa } from "./nome";
import { acordarQuemEsperaResposta } from "../flows/aguardando";
import { optOutNaTransacao } from "./opt-out";
import {
  ENVIO_NAO_CONFIRMADO,
  EnvioAindaNaoConfirmado,
  JANELA_CONFIRMACAO_MS,
  ORIGEM_ECO,
  envioPodeTerSaido,
  impressaoDoArquivo,
  statusExibido,
} from "./envio-incerto";
import { statusAposRecibo } from "./recibo-status";
import { aplicarEstadoDaConexao, publicarQrAtualizado } from "../integrations/whatsapp-conexao";
import type { InboundJob } from "./inbound-queue";
import { Prisma } from "@prisma/client";
import type { Canal } from "@prisma/client";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";

/** Campos do Message que compõem o DTO (inclui mídia). */
const MESSAGE_DTO_SELECT = {
  id: true,
  direcao: true,
  tipo: true,
  conteudo: true,
  mediaPath: true,
  mediaMime: true,
  status: true,
  createdAt: true,
  meta: true,
} as const;

type MessageRow = {
  id: string;
  direcao: string;
  tipo: string;
  conteudo: string | null;
  mediaPath: string | null;
  mediaMime: string | null;
  status: string;
  createdAt: Date;
  meta?: unknown;
};

/** Converte uma linha de Message em DTO, com a URL da mídia já assinada. */
function toMessageDTO(m: MessageRow, mediaUrl: string | null): MessageDTO {
  const meta = (m.meta ?? null) as { subject?: string; from?: string; to?: string } | null;
  return {
    id: m.id,
    direcao: m.direcao,
    tipo: m.tipo,
    conteudo: m.conteudo,
    mediaUrl,
    mediaMime: m.mediaMime,
    // `failed` de envio incerto (ainda na janela) aparece como "não confirmado".
    status: statusExibido(m.status, m.meta, m.createdAt),
    createdAt: m.createdAt.toISOString(),
    subject: meta?.subject ?? null,
    emailFrom: meta?.from ?? null,
    emailTo: meta?.to ?? null,
  };
}

/** Várias linhas → DTOs, com as mídias assinadas num request só (DP-02). */
async function toMessageDTOs(rows: MessageRow[]): Promise<MessageDTO[]> {
  const urls = await signedMediaUrls(rows.map((m) => m.mediaPath).filter((p): p is string => !!p));
  return rows.map((m) => toMessageDTO(m, m.mediaPath ? (urls.get(m.mediaPath) ?? null) : null));
}

/** Uma linha → DTO (envio: a mídia recém-enviada é assinada na hora). */
async function toMessageDTOUnico(m: MessageRow): Promise<MessageDTO> {
  return (await toMessageDTOs([m]))[0]!;
}

/** image/* → image, audio/* → audio, o resto → doc. */
function mediaTypeFromMime(mime: string): MediaType {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "doc";
}

/**
 * Serviços de conversa. Ligam contato <-> conversa <-> conta conectada (ChannelAccount).
 *
 * - listConversations / listMessages / sendMessage: rodam DENTRO de runWithTeam
 *   (caller define o time). Operam por conversationId/channelAccountId.
 * - receiveInbound: self-contained — resolve/cria o contato pelo identifier de
 *   whatsapp (cross-team via basePrisma), resolve a conta pelo `instance` do
 *   payload, abre o contexto do time e grava Message (in) + Activity. Chamado
 *   pelo webhook, que não tem contexto de tenancy prévio.
 *
 * Identifiers: o número WhatsApp vive em ChannelIdentifier (canal=whatsapp). A
 * ChannelAccount é a identidade de envio/recepção do time (cada número WhatsApp
 * conectado). Providers vêm do factory (getChannelProvider), não de `new ...`.
 */

/** Resolves or cria a conversa de um contato numa conta/canal. Roda em runWithTeam. */
async function getOrCreateConversation(params: {
  contactId: string | null;
  externalNumber: string | null;
  externalName: string | null;
  channelAccountId: string | null;
}) {
  const prisma = db();
  const { contactId, externalNumber, externalName, channelAccountId } = params;
  // O canal segue a conta conectada (não é sempre whatsapp): abrir conversa numa
  // conta de e-mail cria conversa de e-mail, não uma whatsapp órfã na aba errada.
  let canal: Canal = "whatsapp";
  if (channelAccountId) {
    // F3: e a conta tem de ser de quem age (ou quem vê tudo; o sistema vê tudo).
    const acc = await prisma.channelAccount.findFirst({
      where: { AND: [{ id: channelAccountId }, escopoCanal({ escrita: true })] },
      select: { canal: true },
    });
    // S1: conta de outro time (ou inexistente) não vira FK da conversa — antes
    // caía no default "whatsapp" e a conversa do meu time passava a enviar pelo
    // número do outro time (o `include` da conta não é filtrado por time).
    if (!acc) throw new OwnedNotFound("channelAccount", [channelAccountId]);
    canal = acc.canal;
  }
  // Conversa registrada casa por contactId; conversa de número não-cadastrado
  // casa por externalNumber (contactId null).
  // O número é comparado pelo texto ou pelo índice cego, conforme CONTATOS_CIFRA (identificadores-cifra.ts).
  const where: Prisma.ConversationWhereInput = contactId
    ? { contactId, canal, channelAccountId: channelAccountId ?? null }
    : {
        contactId: null,
        ...(externalNumber ? ondeConversaPorNumero(getCurrentTeamId() ?? "", [externalNumber]) : { externalNumber }),
        canal,
        channelAccountId: channelAccountId ?? null,
      };
  const existing = await prisma.conversation.findFirst({ where });
  if (existing) {
    // Mantém o pushName mais recente na conversa mesmo quando já há contato — é
    // daqui que o nó `sync_name` do fluxo puxa o nome exposto na interação.
    // Quem chama só passa pushName de mensagem RECEBIDA (ver receiveInbound).
    if (externalName && existing.externalName !== externalName) {
      await prisma.conversation.update({ where: { id: existing.id }, data: { externalName } as never });
      return { ...existing, externalName };
    }
    return existing;
  }
  try {
    return await prisma.conversation.create({
      data: { contactId, externalNumber, externalName, canal, channelAccountId, status: "open" } as never,
    });
  } catch (e) {
    // INT-02: duas mensagens do mesmo contato ao mesmo tempo passavam juntas
    // pelo findFirst e nasciam DUAS conversas. O índice único parcial
    // (conta+contato / conta+número) barra a segunda: fica a que ganhou.
    if (!isUniqueViolation(e)) throw e;
    const vencedora = await prisma.conversation.findFirst({ where });
    if (!vencedora) throw e;
    return vencedora;
  }
}

/** Página padrão do inbox (item 2.2). */
export const CONVERSAS_POR_PAGINA = 50;
/** Teto interno: a action legada (tela atual, sem rolagem infinita) pede mais. */
const CONVERSAS_TETO = 500;
export const MENSAGENS_POR_PAGINA = 50;

/**
 * Keyset da lista: ordem `lastMessageAt DESC NULLS FIRST, id DESC` (a mesma do
 * índice `[channelAccountId, lastMessageAt]` lido de trás para frente; conversa
 * recém-aberta, ainda sem mensagem, fica no topo como antes). "Depois do cursor"
 * = o que vem abaixo da última linha entregue.
 */
function conversasDepoisDe(c: ChaveCursor): Prisma.ConversationWhereInput {
  if (c.em === null) {
    return { OR: [{ lastMessageAt: null, id: { lt: c.id } }, { lastMessageAt: { not: null } }] };
  }
  return { OR: [{ lastMessageAt: { lt: c.em } }, { lastMessageAt: c.em, id: { lt: c.id } }] };
}

/**
 * Ramos da busca por número. Em `off`/`dupla` é "contém" nos dígitos, como sempre. Em `indice`/`ligada`
 * (CONTATOS_CIFRA) o texto de telefone e e-mail não é mais pesquisável por trecho: acha número ou e-mail
 * COMPLETO (em qualquer formato) pelo índice cego, e o número sem DDD pelo sufixo de 8 dígitos.
 */
function numerosDaBusca(busca: string, digitos: string): Prisma.ConversationWhereInput[] {
  if (!buscaExataDeContatos()) {
    return digitos.length >= 4
      ? [{ externalNumber: { contains: digitos } }, { contact: { identifiers: { some: { valor: { contains: digitos } } } } }]
      : [];
  }
  const teamId = getCurrentTeamId() ?? "";
  const ramos: Prisma.ConversationWhereInput[] = [];
  const doNumero = ondeBuscaDeConversaPorNumero(teamId, busca);
  if (doNumero) ramos.push(doNumero);
  const deIdentificador = ondeBuscaDeIdentificador(teamId, busca);
  if (deIdentificador) ramos.push({ contact: { identifiers: { some: deIdentificador } } });
  return ramos;
}

/** Busca no servidor: com página de 50, filtrar só o que veio na tela não acha o resto. */
export function buscaDeConversa(busca: string): Prisma.ConversationWhereInput {
  const contem = { contains: busca, mode: "insensitive" as const };
  const digitos = busca.replace(/\D/g, "");
  // Nome e sobrenome são colunas separadas, mas a lista mostra os dois juntos: "Danilo Silva" tem que achar.
  // Cada palavra casa com nome OU sobrenome (como na lista de contatos).
  const palavras = busca.split(/\s+/).filter(Boolean);
  const porNomeCompleto: Prisma.ConversationWhereInput[] =
    palavras.length > 1
      ? [
          {
            AND: palavras.map((p) => ({
              contact: {
                OR: [
                  { nome: { contains: p, mode: "insensitive" as const } },
                  { sobrenome: { contains: p, mode: "insensitive" as const } },
                ],
              },
            })),
          },
        ]
      : [];
  return {
    OR: [
      { contact: { nome: contem } },
      { contact: { sobrenome: contem } },
      ...porNomeCompleto,
      { contact: { empresa: contem } },
      { externalName: contem },
      { nomeAgenda: contem },
      { lastMessagePreview: contem },
      ...numerosDaBusca(busca, digitos),
    ],
  };
}

/**
 * Lista conversas de uma conta conectada, paginada por cursor (item 2.2,
 * DP-01). Lê a prévia da própria Conversation (`lastMessage*`, gravada em
 * `touchConversation`) — sem `include` de mensagens. Roda em runWithTeam.
 */
export async function listConversations(
  channelAccountId: string,
  opts: ListConversationsInput = {},
): Promise<ConversationPage> {
  const prisma = db();
  const take = Math.min(Math.max(opts.take ?? CONVERSAS_POR_PAGINA, 1), CONVERSAS_TETO);
  const filtros: Prisma.ConversationWhereInput[] = [];
  if (opts.cursor) filtros.push(conversasDepoisDe(decodificarCursor(opts.cursor)));
  const busca = opts.busca?.trim();
  if (busca) filtros.push(buscaDeConversa(busca));
  const convs = await prisma.conversation.findMany({
    where: {
      channelAccountId,
      ...(opts.naoLidas ? { unreadCount: { gt: 0 } } : {}),
      // F3: só a conta de quem conectou (master/admin/"ver tudo" veem todas).
      AND: [...filtros, escopoConversa()],
    },
    select: {
      id: true,
      canal: true,
      status: true,
      unreadCount: true,
      lastMessageAt: true,
      lastMessagePreview: true,
      lastMessageDirecao: true,
      lastMessageSubject: true,
      externalNumber: true,
      externalNumberCifrado: true,
      externalName: true,
      nomeAgenda: true,
      contact: {
        select: {
          id: true,
          nome: true,
          sobrenome: true,
          interesse: true,
          empresa: true,
          cidade: true,
          estado: true,
          relacionamentoStatus: true,
          identifiers: { where: { canal: { in: ["whatsapp", "email"] } }, select: { canal: true, valor: true, valorCifrado: true, isPrimary: true } },
        },
      },
    },
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "first" } }, { id: "desc" }],
    take: take + 1, // a linha a mais só diz se há próxima página
  });
  const temMais = convs.length > take;
  const pagina = temMais ? convs.slice(0, take) : convs;
  const ultima = pagina[pagina.length - 1];
  const items = pagina.map((c): ConversationListItem => {
    const idents = c.contact?.identifiers ?? [];
    const waIdents = idents.filter((i) => i.canal === "whatsapp");
    const emailIdents = idents.filter((i) => i.canal === "email");
    // Telefone e e-mail legíveis (CONTATOS_CIFRA: com a cifra em indice/ligada, vêm do valor cifrado).
    const externalNumber = numeroDe(c, "externalNumber", "conversation");
    const principalWa = waIdents.find((i) => i.isPrimary) ?? waIdents[0];
    const principalEmail = emailIdents.find((i) => i.isPrimary) ?? emailIdents[0];
    const numero = (principalWa ? valorDe(principalWa) : null)
      ?? (ehLid(externalNumber) ? null : externalNumber) ?? null;
    const contactEmail = principalEmail ? valorDe(principalEmail) : null;
    return {
      id: c.id,
      canal: c.canal,
      status: c.status,
      unreadCount: c.unreadCount,
      lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
      contact: c.contact
        ? {
            id: c.contact.id,
            nome: c.contact.nome,
            sobrenome: c.contact.sobrenome,
            interesse: c.contact.interesse,
            empresa: c.contact.empresa,
            cidade: c.contact.cidade,
            estado: c.contact.estado,
            relacionamentoStatus: c.contact.relacionamentoStatus,
          }
        : null,
      // Nome exibido (pedido do dono): contato cadastrado > agenda do celular >
      // pushName (só de mensagem recebida) > número. Regras em ./nome.ts.
      displayName: nomeDaConversa({
        contatoNome: nomeCompleto(c.contact?.nome, c.contact?.sobrenome),
        nomeAgenda: c.nomeAgenda,
        externalName: c.externalName,
        externalNumber,
      }),
      nomeSugerido: nomeSugeridoDaConversa({ nomeAgenda: c.nomeAgenda, externalName: c.externalName }),
      numero,
      contactEmail,
      externalNumber,
      lastMessage:
        c.lastMessageDirecao && c.lastMessageAt
          ? {
              // No e-mail a prévia é o assunto (mais útil que o corpo cru).
              conteudo: c.canal === "email" ? (c.lastMessageSubject ?? c.lastMessagePreview) : c.lastMessagePreview,
              direcao: c.lastMessageDirecao,
              createdAt: c.lastMessageAt.toISOString(),
            }
          : null,
    };
  });
  return {
    items,
    nextCursor: temMais && ultima ? codificarCursor({ em: ultima.lastMessageAt, id: ultima.id }) : null,
  };
}

/**
 * TODAS as conversas da conta, página a página pelo cursor (auditoria do #76):
 * a tela ATUAL filtra e acha a conversa selecionada no cliente e não tem
 * rolagem infinita — com o teto de 500, a conversa de um contato antigo sumia.
 * Teto de segurança de 50 páginas. A tela nova usa `listConversations` direto.
 */
export async function listarTodasAsConversas(
  channelAccountId: string,
  opts: { porPagina?: number; paginasMax?: number } = {},
): Promise<ConversationListItem[]> {
  const todas: ConversationListItem[] = [];
  let cursor: string | undefined;
  const paginasMax = opts.paginasMax ?? 50;
  for (let i = 0; i < paginasMax; i++) {
    const pagina = await listConversations(channelAccountId, { take: opts.porPagina ?? CONVERSAS_TETO, ...(cursor ? { cursor } : {}) });
    todas.push(...pagina.items);
    if (!pagina.nextCursor) return todas;
    cursor = pagina.nextCursor;
  }
  // Parou no teto com página sobrando: a lista da tela está INCOMPLETA (as
  // conversas mais antigas não aparecem). Aviso para saber quando migrar a
  // tela para a rolagem por cursor (auditoria do #87).
  logger.warn({ channelAccountId, paginas: paginasMax, conversas: todas.length }, "[inbox] lista completa parou no teto de páginas — conversas antigas de fora");
  return todas;
}

/**
 * Mensagens de uma conversa, as MAIS NOVAS primeiro no banco e devolvidas em
 * ordem cronológica (DP-02: antes vinham as 200 mais ANTIGAS e a mensagem nova
 * nunca aparecia numa conversa longa). `antesDe` = "carregar anteriores".
 * Roda em runWithTeam.
 */
export async function listMessages(conversationId: string, opts: ListMessagesInput = {}): Promise<MessagePage> {
  const prisma = db();
  const take = Math.min(Math.max(opts.take ?? MENSAGENS_POR_PAGINA, 1), 200);
  const antes = opts.antesDe ? decodificarCursor(opts.antesDe) : null;
  const msgs = await prisma.message.findMany({
    where: {
      conversationId,
      conversation: escopoConversa(), // F3: conversa de número alheio não abre
      ...(antes?.em
        ? { OR: [{ createdAt: { lt: antes.em } }, { createdAt: antes.em, id: { lt: antes.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: MESSAGE_DTO_SELECT,
  });
  const temMais = msgs.length > take;
  const pagina = (temMais ? msgs.slice(0, take) : msgs).reverse();
  const maisAntiga = pagina[0];
  return {
    items: await toMessageDTOs(pagina as MessageRow[]),
    cursorAnteriores: temMais && maisAntiga ? codificarCursor({ em: maisAntiga.createdAt, id: maisAntiga.id }) : null,
  };
}

/**
 * Resolve o número WhatsApp (E.164) de um contato via ChannelIdentifier.
 * Prioriza o VÁLIDO (número dado como errado numa ligação fica por último —
 * produto §D), depois o primário, depois o mais antigo: a mesma ordem da lista
 * da campanha, para o envio sair no número que a lista escolheu. Só com número
 * inválido, devolve o inválido (comportamento de antes).
 * Exportado (usado pelo executor de fluxos).
 */
export async function getWhatsAppNumber(contactId: string): Promise<string | null> {
  const prisma = db();
  const picked = await prisma.channelIdentifier.findFirst({
    where: { contactId, canal: "whatsapp" },
    orderBy: [{ invalido: "asc" }, { isPrimary: "desc" }, { createdAt: "asc" }],
    select: { valor: true, valorCifrado: true },
  });
  return picked ? valorDe(picked) : null;
}

/**
 * Hora REAL da mensagem (INT-16). Antes gravava a hora da ingestão — depois de
 * uma queda, respostas antigas entravam como novas e a ordem da conversa
 * embaralhava.
 *
 * - `timestamp`: o `messageTimestamp` do WhatsApp, em SEGUNDOS (o parser já
 *   converte ms e Long). Sem ele → hora em que o webhook chegou.
 * - `recebidoEm`: quando o webhook chegou (ms, gravado no job da fila — estável
 *   entre as tentativas). A mensagem aconteceu em algum ponto do segundo
 *   `[timestamp, timestamp + 999 ms]` e ANTES de chegar: a melhor estimativa é
 *   a chegada, presa dentro desse segundo. Assim, no tráfego ao vivo, duas
 *   mensagens do mesmo segundo ficam na ordem em que chegaram, e a resposta
 *   automática que chega logo depois da nossa mensagem (hora em ms) não
 *   aparece ANTES dela por causa do arredondamento para o segundo.
 * - Nunca depois de `agora`: relógio do aparelho adiantado não joga a mensagem
 *   (nem o `lastMessageAt`) para o futuro.
 */
export function dataDaMensagem(
  timestamp: number | null | undefined,
  agora = new Date(),
  recebidoEm?: number | null,
): Date {
  const limite = agora.getTime();
  const chegada = recebidoEm && Number.isFinite(recebidoEm) ? Math.min(recebidoEm, limite) : limite;
  if (!timestamp || !Number.isFinite(timestamp)) return new Date(chegada);
  const inicio = Math.floor(timestamp) * 1000;
  const estimada = Math.min(Math.max(chegada, inicio), inicio + 999);
  return new Date(Math.min(estimada, limite));
}

/**
 * Mensagem recebida VELHA demais para acionar automação. Depois de uma queda, a fila reentrega (ou o reprocesso
 * periódico traz de volta) mensagens de horas ou dias atrás: elas têm de ENTRAR na conversa, mas não podem acordar
 * quem espera resposta, inscrever em fluxo "mensagem recebida" nem disparar o fluxo pós-resposta da campanha, senão o
 * contato recebe uma resposta automática fora de hora. Mesma régua do envio vencido (FLOW_STALE_HOURS, padrão 6 h).
 */
export function mensagemVelhaParaGatilho(quando: Date, agora = new Date()): boolean {
  const horas = Number(process.env.FLOW_STALE_HOURS ?? 6);
  const limiteMs = (Number.isFinite(horas) && horas > 0 ? horas : 6) * 3_600_000;
  return agora.getTime() - quando.getTime() > limiteMs;
}

/** Zera o contador de não-lidas (ao abrir a thread). Roda em runWithTeam. */
export async function markRead(conversationId: string): Promise<void> {
  const prisma = db();
  const teamId = getCurrentTeamId();
  // updateMany + count: uma ida ao banco e erro nomeado para id alheio.
  // Escrita: quem só VÊ a conversa do colega ("Ver de todos") abre a thread,
  // mas não zera o contador dele (nada muda, sem erro na tela).
  const { count } = await prisma.conversation.updateMany({
    where: { AND: [{ id: conversationId }, escopoConversa({ escrita: true })] },
    data: { unreadCount: 0 },
  });
  if (count === 0) {
    if (await prisma.conversation.count({ where: { AND: [{ id: conversationId }, escopoConversa()] } })) return;
    throw new OwnedNotFound("conversation", [conversationId]);
  }
  await invalidarNaoLidas(teamId); // badge do menu
}

/**
 * Sinaliza "digitando" para o contato de uma conversa (best-effort).
 *
 * Usada pelo nó `typing` do motor e pelo inbox manual. Resolve o mesmo provider
 * do `sendMessage`; se o provider não expõe presença, ou a chamada falha, apenas
 * retorna — presença nunca deve impedir nada. Roda dentro de runWithTeam.
 */
export async function sendTyping(conversationId: string, durationMs: number): Promise<void> {
  requireCan("messages.send");
  const prisma = db();
  const conv = await prisma.conversation.findFirst({
    where: { AND: [{ id: conversationId }, escopoConversa({ escrita: true })] },
    include: { contact: true, channelAccount: true },
  });
  if (!conv || conv.canal !== "whatsapp") return; // presença só existe no WhatsApp
  const to = conv.contactId ? await getWhatsAppNumber(conv.contactId) : numeroDe(conv, "externalNumber", "conversation");
  if (!to || ehLid(to)) return;
  const channel = await resolveChannelForConversation(conv);
  if (!channel?.sendPresence) return;
  await channel.sendPresence({ to, presence: "composing", durationMs });
}

/**
 * Aplica um recibo de status (entrega/leitura/erro) numa mensagem enviada.
 *
 * Self-contained como o `receiveInbound`: o webhook não tem contexto de tenancy,
 * então resolvemos a mensagem cross-team pelo `providerMessageId` e abrimos
 * `runWithTeam` com o time dela.
 *
 * Nunca REGRIDE o status: um recibo de entrega atrasado não pode sobrescrever
 * "lido". A ordem de chegada não é garantida. A regra completa (inclusive sair
 * de `failed` quando o recibo prova que a mensagem chegou) é `statusAposRecibo`.
 */
export async function applyStatusUpdate(update: {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed" | null;
  errorCode: string | null;
  /** Instância da Evolution que mandou o recibo (webhook autenticado por ela). */
  instance: string | null;
}): Promise<void> {
  if (!update.status && !update.errorCode) return;

  // Auditoria de isolamento S-14: o recibo só mexe em mensagem da CONTA da
  // instância que o mandou (mesmo time; a conversa é dessa conta ou é legada,
  // sem conta). Antes valia o `providerMessageId` em qualquer time.
  if (!update.instance) return;
  const conta = await basePrisma.channelAccount.findUnique({
    where: { provider_externalId: { provider: "evolution", externalId: update.instance } },
    select: { id: true, teamId: true },
  });
  if (!conta) return;

  const msg = await basePrisma.message.findFirst({
    where: {
      providerMessageId: update.providerMessageId,
      direcao: "out",
      teamId: conta.teamId,
      conversation: { OR: [{ channelAccountId: conta.id }, { channelAccountId: null }] },
    },
    select: {
      id: true,
      teamId: true,
      status: true,
      errorCode: true,
      statusAt: true,
      conversation: { select: { id: true, channelAccountId: true } },
    },
  });
  if (!msg) return; // recibo de mensagem que não é nossa (ou anterior ao tracking)

  // Status a gravar (null = o recibo não muda o status). Antes, `failed` valia
  // mais que `read` na ordem e NUNCA saía dali: um ✓✓ que chegasse depois do
  // erro era ignorado e a mensagem entregue ficava vermelha para sempre.
  const novoStatus = statusAposRecibo(msg, update);
  const ehFalha = novoStatus === "failed" || Boolean(update.errorCode);

  await runAsSystem(msg.teamId, async () => {
    await db().message.update({
      where: { id: msg.id },
      data: {
        ...(novoStatus ? { status: novoStatus } : {}),
        ...(update.errorCode ? { errorCode: update.errorCode } : {}),
        statusAt: new Date(),
      },
    });

    // Atualiza o tique na tela ao vivo (✓ → ✓✓ → ✓✓ azul), sem recarregar.
    const efetivo = update.errorCode ? "failed" : novoStatus;
    if (efetivo) {
      emitMessageStatus({
        channelAccountId: msg.conversation?.channelAccountId ?? "",
        conversationId: msg.conversation?.id ?? "",
        messageId: msg.id,
        status: efetivo,
      });
    }

    // Monitor de saúde (Fase B controle de ritmo): um ack de erro pode indicar que o
    // número está sendo limitado. Reavalia a taxa de erro recente da conta e a
    // pausa automaticamente se passar do limiar — o motor então adia os envios.
    const accId = msg.conversation?.channelAccountId;
    if (ehFalha && accId) {
      await checkAndMaybePauseAccount(accId).catch(() => {});
    }

    // Funil da campanha (entregue → lida, ou recusada), pelo mesmo id do WhatsApp (A.2).
    if (efetivo) {
      const { aplicarReciboDeCampanha } = await import("../campaigns/resposta");
      await aplicarReciboDeCampanha(update.providerMessageId, efetivo);
    }
  });
}

/**
 * Resolve o provider de uma conversa.
 *
 * Preferência: a ChannelAccount vinculada. Quando a conversa não tem conta
 * (rows legadas, pré-multicanal), NÃO cai direto no `defaultEvolutionProvider`:
 * ele usa `env.EVOLUTION_INSTANCE`, que sai de sincronia com a instância real
 * assim que o WhatsApp é reconectado (o nome novo vai pras credentials da
 * ChannelAccount, não pro .env) — e o envio quebra com 404. Buscamos a primeira
 * conta conectada do time; só então o env, como último recurso.
 */
async function resolveChannelForConversation(conv: {
  teamId: string;
  canal: string;
  channelAccount: { teamId: string; provider: string; credentials: unknown } | null;
}) {
  // Defesa em profundidade (S1): o `include` da conta não passa pelo filtro de
  // tenancy. Conversa antiga ligada a conta de outro time não envia por ela.
  if (conv.channelAccount && conv.channelAccount.teamId !== conv.teamId) {
    throw new OwnedNotFound("channelAccount", ["(conta da conversa)"]);
  }
  if (conv.channelAccount) {
    const ch = getChannelProvider({
      canal: conv.canal,
      provider: conv.channelAccount.provider,
      credentials: conv.channelAccount.credentials,
    } satisfies ChannelAccountRef);
    if (ch) return ch;
  }
  const conta = await db().channelAccount.findFirst({
    where: { canal: "whatsapp", status: "connected" },
    orderBy: { createdAt: "asc" },
  });
  if (conta) {
    const ch = getChannelProvider({
      canal: "whatsapp",
      provider: conta.provider,
      credentials: conta.credentials,
    } satisfies ChannelAccountRef);
    if (ch) return ch;
  }
  return defaultEvolutionProvider();
}

/**
 * Ganchos do envio (item 1.2): o motor grava a fase do passo EXATAMENTE em
 * volta da chamada ao canal — antes = nada saiu; depois = saiu.
 */
export type GanchosDeEnvio = {
  antesDeEnviar?: () => Promise<void>;
  depoisDeEnviar?: (providerMessageId: string) => Promise<void>;
};

export class HistoricoSemTelefone extends Error {
  constructor() {
    super("Esta conversa do histórico não contém o telefone. Cadastre o número do contato para responder.");
    this.name = "HistoricoSemTelefone";
  }
}

/**
 * Conversa de outro canal (Instagram, LinkedIn, e-mail) não envia por aqui. Antes, `sendMessage` pegava o
 * telefone do contato e o primeiro WhatsApp conectado: quem respondia na aba do Instagram mandava um WhatsApp
 * para o celular do contato. Agora recusa, e o envio de cada canal ganha o próprio caminho.
 */
export class CanalSemEnvioDireto extends Error {
  constructor(canal: string) {
    const nome = canal === "instagram" ? "Instagram" : canal === "linkedin" ? "LinkedIn" : canal === "email" ? "e-mail" : canal;
    super(`O envio por ${nome} ainda não sai pelo CRM Agro. Responda pelo aplicativo do ${nome} por enquanto.`);
    this.name = "CanalSemEnvioDireto";
  }
}

/** Só conversa de WhatsApp envia pelo canal de WhatsApp. */
function exigirConversaDeWhatsApp(conv: { canal: string }): void {
  if (conv.canal !== "whatsapp") throw new CanalSemEnvioDireto(conv.canal);
}

/** Envia mensagem WhatsApp numa conversa. Roda dentro de runWithTeam. */
export async function sendMessage(conversationId: string, text: string, ganchos: GanchosDeEnvio = {}): Promise<MessageDTO> {
  requireCan("messages.send");
  const prisma = db();
  const conv = await prisma.conversation.findFirst({
    where: { AND: [{ id: conversationId }, escopoConversa()] },
    include: { contact: true, channelAccount: true },
  });
  if (!conv) throw new Error("ConversationNotFound");
  // Escrita: com "Ver de todos" em Conversas, lê a conversa do número do colega
  // mas não envia por ele — recusado ANTES de resolver o provedor.
  await assertOwned("conversation", conversationId);
  exigirConversaDeWhatsApp(conv);

  const to = conv.contactId ? await getWhatsAppNumber(conv.contactId) : numeroDe(conv, "externalNumber", "conversation");
  if (!to) throw new Error("ContactSemWhatsApp");
  if (ehLid(to)) throw new HistoricoSemTelefone();

  const channel = await resolveChannelForConversation(conv);
  if (!channel) throw new Error("ChannelNotImplemented");

  await ganchos.antesDeEnviar?.();
  const { providerMessageId } = await channel.send({ to, content: { text } });
  await ganchos.depoisDeEnviar?.(providerMessageId);

  let msg;
  try {
    msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direcao: "out",
        tipo: "text",
        conteudo: text,
        providerMessageId,
        status: "sent",
      } as never,
      select: MESSAGE_DTO_SELECT,
    });
  } catch (e) {
    // O eco `fromMe` da própria Evolution pode chegar (fila inbound, item 0.8)
    // e gravar a mensagem ANTES daqui: o índice único (teamId,
    // providerMessageId) barra a duplicata. A mensagem saiu — usa a já gravada.
    if (!isUniqueViolation(e) || !providerMessageId) throw e;
    const ja = await prisma.message.findFirst({ where: { providerMessageId }, select: MESSAGE_DTO_SELECT });
    if (!ja) throw e;
    msg = ja;
  }
  if (conv.contactId) {
    await prisma.activity.create({
      data: { contactId: conv.contactId, tipo: "whatsapp", direcao: "out", conteudo: text } as never,
    });
  }
  await touchConversation(conv.id, { preview: previewDaMensagem(text), direcao: "out" });

  emitConversationEvent({
    type: "message:sent",
    channelAccountId: conv.channelAccountId ?? "",
    conversationId: conv.id,
    message: {
      id: msg.id,
      direcao: msg.direcao,
      conteudo: msg.conteudo,
      createdAt: msg.createdAt.toISOString(),
    },
  });

  return toMessageDTOUnico(msg as MessageRow);
}

/**
 * Envia uma mídia (imagem/áudio/documento) numa conversa. O upload pro Storage
 * já foi feito pela action (path recebido aqui). O envio ao WhatsApp é
 * BEST-EFFORT: se o provider não expõe `sendMedia`, ou a chamada falha (ex.:
 * nenhum número conectado), a mensagem ainda é PERSISTIDA e exibida na
 * plataforma — só não sai pro WhatsApp. Devolve o DTO já com a URL assinada.
 *
 * Falha com desfecho INCERTO (prazo estourou, Evolution respondeu 5xx/"Timed
 * Out": a mídia pode ter saído mesmo assim) não é "falha definitiva": a linha
 * leva a marca `meta.envio = "nao_confirmado"` e o eco/recibo do WhatsApp a
 * promove (ver ./envio-incerto.ts). Reenviar o MESMO arquivo enquanto isso pede
 * confirmação (`confirmarReenvio`), para não duplicar no celular do destinatário.
 */
export async function sendMediaMessage(
  conversationId: string,
  input: { mediaPath: string; mediaMime: string; base64: string; caption?: string; confirmarReenvio?: boolean },
): Promise<MessageDTO> {
  requireCan("messages.send");
  const prisma = db();
  const conv = await prisma.conversation.findFirst({
    where: { AND: [{ id: conversationId }, escopoConversa()] },
    include: { contact: true, channelAccount: true },
  });
  if (!conv) throw new Error("ConversationNotFound");
  // Escrita: com "Ver de todos" em Conversas, lê a conversa do número do colega
  // mas não envia por ele — recusado ANTES de resolver o provedor.
  await assertOwned("conversation", conversationId);
  exigirConversaDeWhatsApp(conv);

  const tipo = mediaTypeFromMime(input.mediaMime);
  if (!conv.contactId && ehLid(conv.externalNumber)) throw new HistoricoSemTelefone();
  const caption = input.caption?.trim() || null;
  const impressao = impressaoDoArquivo(input.base64);

  // Idempotência: o envio anterior DESTE arquivo ainda não foi confirmado (pode
  // ter chegado). Reenviar sem aviso duplicaria no celular do destinatário.
  if (!input.confirmarReenvio) {
    const anterior = await prisma.message.findFirst({
      where: {
        conversationId: conv.id,
        direcao: "out",
        tipo,
        status: "failed",
        providerMessageId: null,
        createdAt: { gte: new Date(Date.now() - JANELA_CONFIRMACAO_MS) },
        AND: [{ meta: { path: ["envio"], equals: ENVIO_NAO_CONFIRMADO } }, { meta: { path: ["sha256"], equals: impressao } }],
      },
      select: { id: true },
    });
    if (anterior) throw new EnvioAindaNaoConfirmado();
  }

  // Tenta enviar ao WhatsApp (best-effort). Falha não impede persistir.
  const iniciouEm = new Date();
  let providerMessageId = "";
  let status: "sent" | "failed" = "sent";
  let incerto = false;
  try {
    const to = conv.contactId ? await getWhatsAppNumber(conv.contactId) : numeroDe(conv, "externalNumber", "conversation");
    const channel = to ? await resolveChannelForConversation(conv) : null;
    if (to && channel?.sendMedia) {
      // base64 direto — sem a Evolution buscar URL externa.
      const r = await channel.sendMedia({
        to,
        base64: input.base64,
        type: tipo,
        mime: input.mediaMime,
        caption: caption ?? undefined,
      });
      providerMessageId = r.providerMessageId;
    } else {
      status = "failed"; // sem número/canal/suporte — fica só na plataforma
    }
  } catch (e) {
    status = "failed";
    incerto = envioPodeTerSaido(e);
    logger.warn(
      { conversationId: conv.id, incerto, err: e instanceof Error ? e.message : String(e) },
      "[conversas] sendMedia falhou (mensagem persistida mesmo assim)",
    );
  }

  // O eco `fromMe` da própria Evolution pode ter chegado ANTES de gravarmos
  // (a resposta HTTP demorou): a linha do eco já é esta mensagem. Reaproveita
  // em vez de duplicar — e a mensagem sai como enviada, não como erro.
  const eco = incerto
    ? await prisma.message.findFirst({
        where: {
          conversationId: conv.id,
          direcao: "out",
          tipo,
          providerMessageId: { not: null },
          createdAt: { gte: new Date(iniciouEm.getTime() - 5_000) },
          meta: { path: ["origem"], equals: ORIGEM_ECO },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      })
    : null;
  if (eco) {
    const linha = await reaproveitarLinhaDoEco(eco.id, input, caption);
    return toMessageDTOUnico(linha as MessageRow);
  }

  let msg;
  try {
    msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direcao: "out",
        tipo,
        conteudo: caption,
        mediaPath: input.mediaPath,
        mediaMime: input.mediaMime,
        providerMessageId: providerMessageId || undefined,
        status,
        // Só o envio de desfecho incerto leva a marca (e a impressão do arquivo,
        // que reconhece o reenvio do mesmo arquivo).
        ...(incerto ? { meta: { envio: ENVIO_NAO_CONFIRMADO, sha256: impressao } } : {}),
      } as never,
      select: MESSAGE_DTO_SELECT,
    });
  } catch (e) {
    // Idem ao sendMessage: o eco gravou a mensagem antes de nós e o índice
    // único (teamId, providerMessageId) barrou a duplicata. A mensagem SAIU —
    // não pode virar "Falha ao enviar mídia" na tela.
    if (!isUniqueViolation(e) || !providerMessageId) throw e;
    const ja = await prisma.message.findFirst({ where: { providerMessageId }, select: { id: true } });
    if (!ja) throw e;
    const linha = await reaproveitarLinhaDoEco(ja.id, input, caption);
    return toMessageDTOUnico(linha as MessageRow);
  }
  if (conv.contactId) {
    await prisma.activity.create({
      data: {
        contactId: conv.contactId,
        tipo: "whatsapp",
        direcao: "out",
        conteudo: caption ?? `[${tipo}]`,
        mediaPath: input.mediaPath,
        mediaMime: input.mediaMime,
      } as never,
    });
  }
  await touchConversation(conv.id, { preview: previewDaMensagem(caption, tipo), direcao: "out" });

  emitConversationEvent({
    type: "message:sent",
    channelAccountId: conv.channelAccountId ?? "",
    conversationId: conv.id,
    message: {
      id: msg.id,
      direcao: msg.direcao,
      conteudo: msg.conteudo ?? `[${tipo}]`,
      createdAt: msg.createdAt.toISOString(),
    },
  });

  return toMessageDTOUnico(msg as MessageRow);
}

/**
 * A linha gravada pelo eco `fromMe` é a MESMA mensagem que acabamos de enviar:
 * completa com a mídia/legenda originais (o eco pode ter vindo sem o arquivo) e
 * tira a marca de eco (a linha já foi reivindicada). Não recria Activity nem
 * prévia — o caminho do eco já fez.
 */
async function reaproveitarLinhaDoEco(
  id: string,
  input: { mediaPath: string; mediaMime: string },
  caption: string | null,
) {
  const prisma = db();
  const atual = await prisma.message.findUniqueOrThrow({ where: { id }, select: { mediaPath: true, conteudo: true } });
  return prisma.message.update({
    where: { id },
    data: {
      ...(atual.mediaPath ? {} : { mediaPath: input.mediaPath, mediaMime: input.mediaMime }),
      ...(!atual.conteudo && caption ? { conteudo: caption } : {}),
      meta: Prisma.DbNull,
    } as never,
    select: MESSAGE_DTO_SELECT,
  });
}

/**
 * O eco `fromMe` de uma mídia chegou: se existe uma mídia NOSSA de envio
 * incerto na mesma conversa (falha por prazo/5xx, sem id do WhatsApp), o eco é
 * ela — adota o id do WhatsApp e promove para enviada. Assim os recibos
 * seguintes (✓✓) a encontram, e ela não fica duplicada nem vermelha.
 * Devolve o id da linha adotada, ou null se não há candidata.
 */
async function adotarEcoDeEnvioNaoConfirmado(p: {
  conversationId: string;
  tipo: "image" | "audio" | "doc";
  providerMessageId: string;
}): Promise<string | null> {
  const prisma = db();
  const candidatas = await prisma.message.findMany({
    where: {
      conversationId: p.conversationId,
      direcao: "out",
      tipo: p.tipo,
      status: "failed",
      providerMessageId: null,
      errorCode: null,
      createdAt: { gte: new Date(Date.now() - JANELA_CONFIRMACAO_MS) },
      meta: { path: ["envio"], equals: ENVIO_NAO_CONFIRMADO },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
    take: 5,
  });
  for (const c of candidatas) {
    try {
      // Reivindica com condição: duas entregas do mesmo eco não adotam a mesma linha.
      const r = await prisma.message.updateMany({
        where: { id: c.id, providerMessageId: null, status: "failed" },
        data: { providerMessageId: p.providerMessageId, status: "sent", statusAt: new Date(), meta: Prisma.DbNull } as never,
      });
      if (r.count === 1) return c.id;
    } catch (e) {
      if (isUniqueViolation(e)) return null; // outra entrega do mesmo eco já gravou esse id
      throw e;
    }
  }
  return null;
}

/**
 * Resolve a ChannelAccount de whatsapp que RECEBEU o inbound, pelo `instance` do
 * payload da Evolution. A CONTA é a autoridade de tenant no inbound (cada time
 * conecta o próprio número) — o teamId vem dela, não do contato.
 * Cross-team (basePrisma) — o webhook não tem contexto de tenancy prévio.
 *
 * Fail-closed (auditoria de isolamento S-03): SÓ a instância exata
 * (`provider` + `externalId`) resolve a conta. Instância sem conta, conta
 * desconectada ou payload sem instância → null (mensagem descartada, com log em
 * `receiveInbound`). NUNCA "a única conta conectada do sistema": o onboarding
 * cria a instância na Evolution (com o webhook) ANTES de gravar a conta, e
 * nessa janela as mensagens do número novo do time B caíam no inbox do time A.
 * Nada se perde: o que chegou antes do "confirmar" fica na Evolution e entra
 * pela importação do histórico (`integrations/whatsapp-historico.ts`).
 */
export async function resolveInboundAccount(
  instance: string | null,
): Promise<{ id: string; teamId: string } | null> {
  if (!instance) return null;
  // O(1) pelo índice único (provider, externalId) — antes carregava TODAS as
  // contas de todos os times a cada mensagem e procurava em JS (DP-04), e duas
  // contas com a mesma instância faziam o inbound cair no time errado (S4).
  const conta = await basePrisma.channelAccount.findUnique({
    where: { provider_externalId: { provider: "evolution", externalId: instance } },
    select: { id: true, teamId: true, canal: true, status: true },
  });
  if (conta && conta.canal === "whatsapp" && conta.status === "connected") {
    return { id: conta.id, teamId: conta.teamId };
  }
  return null; // sem conta, ou desconectada: não cai em outra conta
}

/** Inicia (ou reabre) a conversa de um contato já cadastrado numa conta. */
export async function startConversationWithContact(
  channelAccountId: string,
  contactId: string,
): Promise<{ conversationId: string }> {
  requireCan("messages.send");
  // S1: contato vem do cliente. A conta é conferida em getOrCreateConversation.
  await assertOwned("contact", contactId);
  const conv = await getOrCreateConversation({
    contactId,
    externalNumber: null,
    externalName: null,
    channelAccountId,
  });
  return { conversationId: conv.id };
}

/**
 * Inicia conversa com um número novo: cadastra o contato (nome + telefone) — ou
 * reaproveita se o número já existir — e abre a conversa. No cadastro, consulta
 * o histórico do WhatsApp: se já houve conversa, nasce `ja_conversou` (pro fluxo
 * de primeiro contato pular); senão, `novo`.
 */
export async function startConversationWithNumber(
  channelAccountId: string,
  nome: string,
  numberRaw: string,
): Promise<{ conversationId: string; contactId: string }> {
  requireCan("messages.send");
  const prisma = db();
  const dono = donoPadrao(); // F3: contato novo é de quem cadastrou
  const number = normalizePhone(numberRaw);
  if (!number) throw new Error("TelefoneInvalido");
  // S1: confere a conta ANTES de cadastrar o contato (senão sobrava contato
  // órfão quando a conta era de outro time).
  await assertOwned("channelAccount", channelAccountId);

  let contactId: string;
  const existing = await prisma.channelIdentifier.findFirst({
    where: { canal: "whatsapp", valor: number },
  });
  if (existing) {
    // Número de um contato de OUTRO responsável (regra do dono, 28/09): não
    // abre conversa "no contato do colega" nem cadastra a pessoa de novo.
    await recusarSeDeOutro(existing.contactId, await quemAge());
    contactId = existing.contactId;
  } else {
    const account = await prisma.channelAccount.findUnique({ where: { id: channelAccountId } });
    const instance = (account?.credentials as { instance?: string } | null)?.instance;
    const jaConversou = instance
      ? await hasWhatsAppHistory({
          apiUrl: env.EVOLUTION_API_URL,
          apiKey: env.EVOLUTION_API_KEY,
          instance,
          number,
        })
      : false;
    const contact = await prisma.contact.create({
      data: {
        nome: nome.trim(),
        relacionamentoStatus: jaConversou ? "ja_conversou" : "novo",
        origem: "conversa_manual",
        ownerId: await responsavelObrigatorio(dono),
      } as never,
    });
    contactId = contact.id;
    await prisma.channelIdentifier.create({
      data: { contactId, canal: "whatsapp", valor: number, isPrimary: true } as never,
    });
  }
  const conv = await getOrCreateConversation({
    contactId,
    externalNumber: null,
    externalName: null,
    channelAccountId,
  });
  return { conversationId: conv.id, contactId };
}

/** Exclui uma conversa (mensagens caem por cascade). Roda dentro de runWithTeam. */
export async function deleteConversation(conversationId: string): Promise<void> {
  requireCan("conversations.delete");
  const prisma = db();
  const teamId = getCurrentTeamId();
  await assertOwned("conversation", conversationId); // F3: só a do meu número
  await prisma.conversation.delete({ where: { id: conversationId } });
  await invalidarNaoLidas(teamId); // podia ter não-lidas
}

/**
 * Cadastra o contato de uma conversa de número não-registrado: cria o Contact
 * (nome + telefone) e vincula a conversa a ele. Se o número já tiver contato,
 * reaproveita. Idempotente-ish. Roda em runWithTeam. Retorna o contactId.
 */
export async function registerContactForConversation(
  conversationId: string,
  nome: string,
  telefone?: string,
): Promise<{ contactId: string; conversationId: string }> {
  requireCan("messages.send");
  const prisma = db();
  const dono = donoPadrao(); // F3: contato novo é de quem cadastrou
  const conv = await prisma.conversation.findFirst({ where: { AND: [{ id: conversationId }, escopoConversa()] } });
  if (!conv) throw new Error("ConversationNotFound");
  await assertOwned("conversation", conversationId); // escrita: cadastrar contato pela conversa do colega pede "Ver e editar"
  const numero = normalizePhone(telefone ?? "") ?? (ehLid(conv.externalNumber) ? null : conv.externalNumber) ?? null;
  if (ehLid(conv.externalNumber) && !numero) throw new HistoricoSemTelefone();

  let contactId: string;
  const existing = numero
    ? await prisma.channelIdentifier.findFirst({ where: { canal: "whatsapp", valor: numero } })
    : null;
  if (existing) {
    // Idem: o número já é de um contato de outro responsável — recusa.
    await recusarSeDeOutro(existing.contactId, await quemAge());
    contactId = existing.contactId;
  } else {
    const contact = await prisma.contact.create({
      data: { nome: nome.trim(), relacionamentoStatus: "ja_conversou", origem: conv.canal, ownerId: await responsavelObrigatorio(dono) } as never,
    });
    contactId = contact.id;
    if (numero) {
      await prisma.channelIdentifier.create({
        data: { contactId, canal: "whatsapp", valor: numero, isPrimary: true } as never,
      });
    }
  }
  // Se o contato já tem conversa nesta conta, esta é MESCLADA nela (índice
  // único conta+contato) — o front deve abrir a conversa devolvida.
  const ficou = await vincularConversaAoContato(conversationId, contactId);
  if (ficou === conversationId) {
    await prisma.conversation.updateMany({ where: { id: ficou }, data: { externalName: null } });
  }
  // Conversa "sem número" (@lid) que a pessoa acabou de ligar a um telefone: guarda
  // o par (origem "manual") para o importador do histórico e as mensagens novas
  // não separarem a mesma pessoa de novo. Nunca derruba o cadastro.
  const teamId = getCurrentTeamId();
  if (teamId && numero && ehLid(conv.externalNumber)) {
    await gravarParesLid(basePrisma, teamId, [{ lid: conv.externalNumber!, telefone: numero }], "manual").catch((e) =>
      logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[wa-lid] não gravou o par ao cadastrar o contato"),
    );
  }
  return { contactId, conversationId: ficou };
}

/** O que o cadastro completo pelo canal devolve (a tela mostra o aviso quando o número já era de um contato). */
export type ContatoCadastradoDaConversa = {
  contactId: string;
  /** A conversa que ficou (pode ser outra, se a do contato nesta conta já existia e esta foi mesclada). */
  conversationId: string;
  /** O número já pertencia a um contato: a conversa foi ligada a ele e o que foi digitado NÃO foi aplicado. */
  jaExistia: boolean;
  nome: string;
};

/**
 * Cadastro COMPLETO do contato a partir de uma conversa (pessoa + empresa, os mesmos campos da tela "Novo
 * contato"). Cria o contato com o telefone da conversa (ou o digitado), liga a conversa a ele e o marca como
 * "contatado" (ou o status escolhido, como Cliente). Se o número já é de um contato, só liga a conversa a ele.
 * Roda em runWithTeam.
 */
export async function cadastrarContatoDaConversa(
  conversationId: string,
  input: {
    person: PersonInput;
    company?: CompanyInput | null;
    papel?: Papel;
    responsavelId?: string | null;
    /** Padrão: contatado (já existe uma conversa). */
    relacionamentoStatus?: "novo" | "ja_conversou" | "cliente";
  },
): Promise<ContatoCadastradoDaConversa> {
  requireCan("messages.send");
  const prisma = db();
  const conv = await prisma.conversation.findFirst({ where: { AND: [{ id: conversationId }, escopoConversa()] } });
  if (!conv) throw new Error("ConversationNotFound");
  await assertOwned("conversation", conversationId); // escrita: cadastrar pela conversa do colega pede "Ver e editar"
  const doCanal = ehLid(conv.externalNumber) ? null : conv.externalNumber;
  const numero = normalizePhone(input.person.telefone ?? "") ?? doCanal ?? null;
  if (ehLid(conv.externalNumber) && !numero) throw new HistoricoSemTelefone();

  let contactId: string;
  let jaExistia = false;
  const existing = numero ? await prisma.channelIdentifier.findFirst({ where: { canal: "whatsapp", valor: numero } }) : null;
  if (existing) {
    // O número já é de um contato de outro responsável: recusa. Do mesmo responsável: liga a conversa a ele.
    await recusarSeDeOutro(existing.contactId, await quemAge());
    contactId = existing.contactId;
    jaExistia = true;
  } else {
    ({ contactId } = await createContactWithCompany({
      person: { ...input.person, telefone: numero ?? input.person.telefone ?? null, origem: input.person.origem ?? conv.canal },
      company: input.company,
      papel: input.papel,
      responsavelId: input.responsavelId,
    }));
    await prisma.contact.update({ where: { id: contactId }, data: { relacionamentoStatus: input.relacionamentoStatus ?? "ja_conversou" } });
  }

  // O cadastro já tenta ligar a conversa pelo número (reconciliação). Aqui garante o vínculo nos outros casos
  // (número digitado diferente, conversa "sem número") e acha a conversa que ficou se houve mescla.
  let ficou = conversationId;
  const atual = await prisma.conversation.findFirst({ where: { id: conversationId }, select: { id: true, contactId: true } });
  if (!atual) {
    const doContato = await prisma.conversation.findFirst({ where: { contactId, channelAccountId: conv.channelAccountId }, select: { id: true } });
    if (doContato) ficou = doContato.id;
  } else if (atual.contactId !== contactId) {
    ficou = await vincularConversaAoContato(conversationId, contactId);
  }
  if (ficou === conversationId) await prisma.conversation.updateMany({ where: { id: ficou }, data: { externalName: null } });

  const teamId = getCurrentTeamId();
  if (teamId && numero && ehLid(conv.externalNumber)) {
    await gravarParesLid(basePrisma, teamId, [{ lid: conv.externalNumber!, telefone: numero }], "manual").catch((e) =>
      logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[wa-lid] não gravou o par ao cadastrar o contato"),
    );
  }
  const c = await prisma.contact.findFirst({ where: { id: contactId }, select: { nome: true, sobrenome: true } });
  return { contactId, conversationId: ficou, jaExistia, nome: nomeCompleto(c?.nome, c?.sobrenome) };
}

const tamanhoEmMb = (bytes: number | null) =>
  bytes ? ` (${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB)` : "";

/** Aviso gravado no lugar da mídia acima do teto (INT-14). */
export function avisoArquivoGrande(bytes: number | null): string {
  return `[arquivo grande${tamanhoEmMb(bytes)}: veja no celular]`;
}

/** Aviso da mídia cujo download estourou o prazo (arquivo pesado ou Evolution lenta). */
export function avisoArquivoDemorou(bytes: number | null): string {
  return `[arquivo${tamanhoEmMb(bytes)} não baixado, demorou demais: veja no celular]`;
}

/**
 * Processa mensagem recebida (webhook). Self-contained: resolve o contato pelo
 * identifier de whatsapp (cria contato + identifier se não existir), resolve a
 * conta pelo instance, abre o contexto do time e grava Message (in) + Activity.
 * Idempotente por providerMessageId. No primeiro inbound, marca o contato como
 * ja_conversou. Emite evento pro barramento SSE.
 */
export async function receiveInbound(
  msg: InboundMessage,
  opts: { recebidoEm?: number | null } = {},
): Promise<void> {
  // fromMe = mensagem ENVIADA pela conta (pela plataforma OU direto pelo celular/
  // WhatsApp Web). Não descartamos mais: gravamos como SAÍDA para o histórico do
  // contato ficar completo. O dedup por providerMessageId (abaixo) evita duplicar
  // o eco do que a própria plataforma acabou de enviar.
  const direcao: "in" | "out" = msg.fromMe ? "out" : "in";
  if (msg.text === null && !msg.media) return; // sem texto e sem mídia — ignora

  // AUTORIDADE de tenant no inbound = a CONTA (instance) que recebeu, não o
  // contato. Resolver pelo contato vazaria mensagens entre times (número que
  // colide entre contas, ou número desconhecido caindo num time arbitrário).
  const account = await resolveInboundAccount(msg.instance);
  if (!account) {
    logger.warn(
      { motivo: "sem_conta", instance: msg.instance ?? null },
      "[inbound] instância sem ChannelAccount conectada — mensagem descartada (fail-closed)",
    );
    return;
  }
  const teamId = account.teamId;
  const channelAccountId = account.id;

  // Contato: procurado DENTRO do time da conta (não global). Casa com e sem o
  // nono dígito: o WhatsApp entrega números antigos sem o 9 e o cadastro pode ter
  // com (ou vice-versa). Sem isso a conversa nasce solta e some do radar do motor.
  const ident = await basePrisma.channelIdentifier.findFirst({
    where: { teamId, ...ondeIdentificadorExato(teamId, "whatsapp", phoneVariants(msg.from)) },
    include: { contact: true },
  });
  // NÃO cria contato no inbound: número não-cadastrado vira conversa com
  // externalNumber/externalName. Vira Contact só num ato explícito (criar card,
  // cadastrar contato, etc.).
  const contactId = ident?.contact.id ?? null;

  const quando = dataDaMensagem(msg.timestamp, new Date(), opts.recebidoEm);

  await runAsSystem(teamId, async () => {
    // Idempotência (caminho rápido): já gravamos esse providerMessageId. A
    // garantia de verdade é o índice ÚNICO (teamId, providerMessageId) — ver o
    // catch P2002 abaixo — porque duas entregas podem passar juntas por aqui.
    if (msg.providerMessageId) {
      const dup = await db().message.findFirst({
        where: { providerMessageId: msg.providerMessageId },
        select: { id: true },
      });
      if (dup) return;
    }
    const conv = await getOrCreateConversation({
      contactId,
      externalNumber: contactId ? null : msg.from,
      // Guarda o pushName SEMPRE (mesmo com contato) — o nó `sync_name` lê daqui
      // para preencher o nome do cadastro quando o contato responde. NUNCA de
      // mensagem ENVIADA (fromMe): ali o pushName é o do próprio dono da conta,
      // e todas as conversas puxadas pelo celular ficavam com o nome dele.
      // Número/"Você" no lugar do nome também não conta (ver ./nome.ts).
      externalName: msg.fromMe ? null : nomeDePessoaValido(msg.name),
      channelAccountId,
    });

    // Eco `fromMe` de uma mídia cujo envio pelo CRM Agro ficou "não confirmado"
    // (prazo estourou/5xx, mas a Evolution entregou): o eco É essa mensagem.
    // Adota o id do WhatsApp na linha que já existe (promove a "enviada") em vez
    // de gravar uma segunda — antes de baixar a mídia, que já temos.
    if (direcao === "out" && msg.media && msg.providerMessageId) {
      const adotada = await adotarEcoDeEnvioNaoConfirmado({
        conversationId: conv.id,
        tipo: msg.media.kind,
        providerMessageId: msg.providerMessageId,
      });
      if (adotada) {
        emitMessageStatus({
          channelAccountId: channelAccountId ?? "",
          conversationId: conv.id,
          messageId: adotada,
          status: "sent",
        });
        return;
      }
    }

    // Mídia recebida: baixa na Evolution e sobe pro Storage — aqui no WORKER
    // (fila inbound), nunca no web. Best-effort: se o download/upload falha,
    // grava como mídia SEM arquivo (a UI mostra "[áudio]"/"[imagem]" e não
    // perde o registro da mensagem). Acima do teto (INT-14) nem baixa: a
    // mensagem leva o aviso "veja no celular".
    let tipo: "text" | "image" | "audio" | "doc" = "text";
    let mediaPath: string | undefined;
    let mediaMime: string | undefined;
    let texto = msg.text;
    if (msg.media) {
      tipo = msg.media.kind;
      mediaMime = msg.media.mime;
      const tamanho = msg.media.size ?? null;
      const grande = tamanho !== null && tamanho > MAX_MIDIA_RECEBIDA_BYTES;
      const baixada =
        grande || !msg.providerMessageId || !storageEnabled()
          ? null
          : await baixarMidiaEvolution({
              providerMessageId: msg.providerMessageId,
              from: msg.from,
              instance: msg.instance,
              remoteJid: msg.remoteJid,
              fromMe: msg.fromMe,
            });
      const motivo = grande ? "grande" : baixada && !baixada.ok ? baixada.motivo : null;
      if (motivo === "grande" || motivo === "tempo") {
        // Estourou o teto ou o prazo: o arquivo não vem, mas o vendedor sabe
        // onde ver (antes, o prazo estourado caía em "falha", sem aviso).
        const aviso = motivo === "grande" ? avisoArquivoGrande(tamanho) : avisoArquivoDemorou(tamanho);
        texto = texto ? `${texto}\n${aviso}` : aviso;
        logger.info({ tipo, tamanho, motivo, conversationId: conv.id }, "[inbound] mídia não baixada");
      } else if (baixada?.ok) {
        try {
          const ext = (baixada.mime.split("/")[1] || "bin").split(";")[0];
          const path = `${conv.id}/${direcao}-${crypto.randomUUID()}.${ext}`;
          // O Buffer já é um Uint8Array: sobe sem cópia.
          await uploadMedia(path, baixada.bytes, baixada.mime);
          mediaPath = path;
          mediaMime = baixada.mime;
        } catch (e) {
          logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[inbound] falha ao salvar mídia recebida");
        }
      }
    }
    // Activity guarda o texto inteiro; a prévia da conversa é cortada (200).
    const preview = texto || (msg.media ? `[${tipo}]` : "");

    // Message + Activity + status do contato numa TRANSAÇÃO: ou entra tudo, ou
    // nada (e o retry da fila refaz). Duas entregas da mesma mensagem: a
    // segunda bate no índice único e sai sem duplicar nada (INT-02).
    const prisma = db();
    let created: { id: string; direcao: string; createdAt: Date };
    // Pedido de saída (opt-out, N12): decidido e aplicado NA MESMA transação
    // da mensagem (auditoria do #112) — se o worker cair depois, o retry cai no
    // dedup, mas o opt-out já entrou junto. Regra e efeitos em ./opt-out.ts.
    let pediuParaSair = false;
    try {
      created = await prisma.$transaction(async (tx) => {
        const m = await tx.message.create({
          data: {
            conversationId: conv.id,
            direcao,
            tipo,
            conteudo: texto ?? "",
            mediaPath,
            mediaMime,
            providerMessageId: msg.providerMessageId ?? undefined,
            // saída (enviada por nós) nasce "sent"; entrada, "delivered".
            status: direcao === "out" ? "sent" : "delivered",
            // Saída gravada pelo eco/celular: a marca deixa o envio de mídia do
            // CRM Agro (que demorou a responder) reconhecer esta linha como a sua.
            ...(direcao === "out" ? { meta: { origem: ORIGEM_ECO } } : {}),
            createdAt: quando,
          } as never,
          select: { id: true, direcao: true, createdAt: true },
        });
        // Activity + relacionamentoStatus só quando há Contact registrado.
        if (contactId) {
          await tx.activity.create({
            data: {
              contactId,
              tipo: "whatsapp",
              direcao,
              conteudo: preview,
              mediaPath,
              mediaMime,
              createdAt: quando,
            } as never,
          });
          // Só o INBOUND (o contato respondeu) muda "novo" → "ja_conversou".
          if (direcao === "in") {
            await tx.contact.updateMany({
              where: { id: contactId, relacionamentoStatus: "novo" },
              data: { relacionamentoStatus: "ja_conversou" },
            });
            pediuParaSair = await optOutNaTransacao(tx, { contactId, texto: msg.text, messageId: m.id });
          }
        }
        return m;
      });
    } catch (e) {
      if (isUniqueViolation(e)) return; // outra entrega da mesma mensagem já gravou
      throw e;
    }
    // Prévia + lastMessageAt na mesma escrita. Só mensagem recebida conta como
    // não-lida; a nossa própria saída (eco fromMe) não.
    await touchConversation(conv.id, {
      preview: previewDaMensagem(texto, tipo),
      direcao,
      quando,
      naoLidas: direcao === "in" ? 1 : 0,
    });

    emitConversationEvent({
      // saída enviada de fora da plataforma = "message:sent" (o cliente não a
      // trata como não-lida); entrada = "message:received".
      type: direcao === "out" ? "message:sent" : "message:received",
      channelAccountId: channelAccountId ?? "",
      conversationId: conv.id,
      message: {
        id: created.id,
        direcao: created.direcao,
        conteudo: preview,
        createdAt: created.createdAt.toISOString(),
      },
    });

    // Gatilho do motor de fluxos: mensagem recebida dispara fluxos do tipo
    // message_received (não-fatal — falha do motor não quebra o inbound).
    // Só dispara no INBOUND — a nossa própria saída não é "mensagem recebida".
    if (contactId && direcao === "in") {
      // Quem pediu para sair (opt-out já aplicado na transação acima) não é
      // acordado no "respondeu?" nem inscrito em fluxo — responder a ele é o
      // que gera denúncia.
      if (mensagemVelhaParaGatilho(quando)) {
        logger.info(
          { conversationId: conv.id, idadeHoras: Math.round((Date.now() - quando.getTime()) / 3_600_000) },
          "[inbound] mensagem velha reentregue: gravada, sem acordar espera nem disparar fluxo",
        );
      } else if (!pediuParaSair) {
        // Resposta do lead acorda na hora quem está na condição "respondeu?" (1.1).
        await acordarQuemEsperaResposta(contactId);
        await safeEnrollByTrigger("message_received", { contactId, conversationId: conv.id });
        // Campanha: marca "respondeu" e dispara o fluxo Pós-resposta (A.2).
        // Quem pediu para sair já foi marcado `opted_out` pelo opt-out (A.5).
        const { registrarRespostaDeCampanha } = await import("../campaigns/resposta");
        await registrarRespostaDeCampanha(contactId, { messageId: created.id, texto: msg.text });
      }
    }

    // Conversa antiga "sem número" (@lid) da MESMA pessoa: descobre o par
    // @lid ↔ telefone e junta com esta.
    // Por último e sem lançar: a mensagem já está gravada e o motor já rodou.
    await descobrirEUnificarLid({
      channelAccountId,
      instance: msg.instance,
      telefone: msg.from,
      remoteJid: msg.remoteJid,
    });
  });
}

/**
 * Processa um job da fila `inbound` (worker). Lançar = o BullMQ tenta de novo
 * (20×, espera limitada a 10 min — auditoria do #56): a mensagem não se perde
 * por uma falha passageira. Erro de INFRAESTRUTURA (banco/rede) sai com o
 * prefixo estável `InfraIndisponivel:` — é o que o reprocesso periódico
 * reconhece (o Prisma não põe o código P1001… no texto da mensagem).
 */
export async function processInboundJob(job: InboundJob): Promise<void> {
  try {
    if (job.kind === "message") return await receiveInbound(job.msg, { recebidoEm: job.recebidoEm });
    if (job.kind === "conexao") {
      await aplicarEstadoDaConexao({ instance: job.instance, state: job.state });
      return;
    }
    if (job.kind === "qr") return await publicarQrAtualizado({ instance: job.instance, qrBase64: job.qrBase64 });
    return await applyStatusUpdate(job.update);
  } catch (e) {
    if (erroDeRls(e)) {
      // Erro de RLS não é infra (repetir não resolve) e gastaria as 20 tentativas em silêncio: grita no log
      // já na primeira, para a operação ver na hora e desligar o RLS.
      logger.error({ err: e instanceof Error ? e.message.slice(0, 300) : String(e), job: job.kind }, "[rls] o inbound bateu numa trava de permissão do banco (RLS ou privilégio perdido)");
    }
    if (erroDeInfra(e)) throw new Error(`${PREFIXO_INFRA} ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

/** Prefixo do erro de infraestrutura na fila `inbound` (ver `reprocessarInboundFalhos`). */
export const PREFIXO_INFRA = "InfraIndisponivel:";

// P2024 = esperou demais por uma conexão do pool; P2028 = a transação interativa não começou a tempo (2 s) ou
// estourou o tempo (5 s). Com o RLS ligado cada consulta avulsa segura a conexão por 4 idas ao banco, então os
// dois ficam mais prováveis sob carga: são falha de infra (passageira), não de código nem de dado.
const CODIGOS_PRISMA_INFRA = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2028"]);
const CODIGOS_REDE = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ENOTFOUND"]);

/**
 * Erro de permissão do banco: a trava do RLS (`row-level security`) ou privilégio perdido
 * (`permission denied`, por exemplo depois de um restore sem os GRANT). Só aparece com o app pelo papel
 * `crmagro_app`; repetir o job não resolve.
 */
export function erroDeRls(e: unknown): boolean {
  const err = e as { message?: string; meta?: { message?: string } } | null;
  return /row-level security|permission denied for (table|schema|sequence)/i.test(`${err?.message ?? ""} ${err?.meta?.message ?? ""}`);
}

/** Banco/rede fora (vale repetir quando voltar) × erro de código/dado (não vale). */
export function erroDeInfra(e: unknown): boolean {
  const err = e as { name?: string; code?: string; errorCode?: string; cause?: { code?: string }; message?: string } | null;
  if (!err) return false;
  if (err.name === "PrismaClientInitializationError" || err.name === "PrismaClientRustPanicError") return true;
  if (CODIGOS_PRISMA_INFRA.has(err.code ?? "") || CODIGOS_PRISMA_INFRA.has(err.errorCode ?? "")) return true;
  if (CODIGOS_REDE.has(err.code ?? "") || CODIGOS_REDE.has(err.cause?.code ?? "")) return true;
  return /Can't reach database|timed out|Unable to start a transaction|Server has closed the connection|Error in PostgreSQL connection|Engine is not yet connected|Connection terminated/i.test(err.message ?? "");
}
