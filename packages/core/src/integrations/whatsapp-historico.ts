import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { env, modoHistoricoWhatsApp } from "@crmagro/config";
import { basePrisma, comCamposCifrados } from "@crmagro/db";
import { numeroDe, ondeConversaPorNumero, ondeIdentificadorExato, valorDe } from "../contacts/identificadores-cifra";
import { ehJidLid, fetchWhatsAppHistoryPage, phoneVariants, type InboundMessage } from "@crmagro/channels";
import { redisEstado } from "../shared/redis-cache";
import { logger } from "../logger/index";
import { previewDaMensagem } from "../conversations/ultima-mensagem";
import { ehLid, nomeDePessoaValido, PREFIXO_ROTULO_LID_ANTIGO } from "../conversations/nome";
import { gravarParesLid, lerParesLid } from "../conversations/lid-mapa";
import { gravarNoMetaDaConta, type ContaWhatsAppJob } from "./meta-da-conta";
import { sincronizarNomesWhatsApp } from "./whatsapp-nomes";

export const WHATSAPP_HISTORY_QUEUE = "whatsapp-history";
export type WhatsAppHistoryJob = ContaWhatsAppJob;
const estadoSchema = z.object({
  status: z.enum(["pending", "running", "completed", "error"]),
  pagina: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  processadas: z.number().int().nonnegative(),
  importadas: z.number().int().nonnegative(),
  ignoradas: z.number().int().nonnegative(),
  ate: z.string().datetime(),
  atualizadoEm: z.string().datetime(),
});
export type WhatsAppHistoryStatus = z.infer<typeof estadoSchema>;

export function lerEstadoHistorico(meta: unknown): WhatsAppHistoryStatus | null {
  const p = estadoSchema.safeParse((meta as { whatsappHistory?: unknown } | null)?.whatsappHistory);
  return p.success ? p.data : null;
}

let fila: Queue<WhatsAppHistoryJob> | undefined;
function queue() {
  return fila ??= new Queue<WhatsAppHistoryJob>(WHATSAPP_HISTORY_QUEUE, { connection: redisEstado() });
}

/**
 * Chave de segurança da importação AUTOMÁTICA (`WA_HISTORICO_MODO`). Só o modo
 * "completo" liga; sem a variável fica desligada — importar o histórico inteiro
 * puxa também as conversas pessoais do dono (28/09: 17.920 mensagens). Lê o env
 * a cada chamada (barato) para os testes poderem alternar o modo.
 */
export function importacaoHistoricoLigada(): boolean {
  return modoHistoricoWhatsApp(env.WA_HISTORICO_MODO) === "completo";
}

export async function agendarHistoricoWhatsApp(job: WhatsAppHistoryJob): Promise<void> {
  // Desligado: nada entra na fila (vale para o QR e para a varredura do worker).
  if (!importacaoHistoricoLigada()) return;
  await queue().add("sincronizar", job, {
    jobId: `wa-history-${job.accountId}`,
    attempts: 5,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/**
 * Rede de segurança: agenda contas novas, retoma páginas interrompidas e
 * confere o total de históricos concluídos. O celular entrega o histórico em
 * blocos, às vezes DEPOIS de confirmar o QR; a primeira página vazia não pode
 * encerrar a sincronização para sempre. JobId impede concorrência por conta.
 */
export async function agendarHistoricosWhatsApp(): Promise<void> {
  if (!importacaoHistoricoLigada()) return; // nem consulta o banco
  const contas = await basePrisma.channelAccount.findMany({
    where: { provider: "evolution", canal: "whatsapp", status: "connected", externalId: { not: null } },
    select: { id: true, teamId: true, externalId: true },
  });
  for (const c of contas) {
    await agendarHistoricoWhatsApp({ accountId: c.id, teamId: c.teamId, instance: c.externalId! });
  }
}

async function salvarEstado(job: WhatsAppHistoryJob, estado: WhatsAppHistoryStatus): Promise<void> {
  // Atualização atômica só desta chave: não sobrescreve outros metadados da
  // conta. Todos os identificadores do job são conferidos, inclusive o time.
  await gravarNoMetaDaConta(job, "whatsappHistory", estado);
}

/**
 * Nome do perfil da OUTRA pessoa num lote do histórico: só de mensagem
 * RECEBIDA (na enviada o pushName é o do próprio dono) e só nome de verdade —
 * no histórico a Evolution põe o número (ou o id do `@lid`) quando não sabe.
 */
function nomeDoPerfilNoLote(messages: InboundMessage[]): string | null {
  for (const m of messages) {
    if (m.fromMe) continue;
    const nome = nomeDePessoaValido(m.name);
    if (nome) return nome;
  }
  return null;
}

/**
 * Importação histórica, separada do receiveInbound: NÃO publica mensagem nova,
 * incrementa não-lidas, altera opt-out, cria atividades nem aciona automações.
 * Os registros de mídia são preservados; arquivos antigos ficam no celular.
 * Uma página é atômica; o índice de providerMessageId torna retries seguros.
 */
export async function importarPaginaHistorico(job: WhatsAppHistoryJob, messages: InboundMessage[]): Promise<number> {
  const validasBase = [...new Map(messages
    .filter((m) => m.instance === job.instance && m.providerMessageId && m.timestamp && (m.text !== null || m.media))
    .map((m) => [m.providerMessageId!, m])).values()];
  if (!validasBase.length) return 0;
  // Mensagem do pacote de histórico só tem o @lid (sem telefone). Se o CRM Agro já sabe
  // de quem é (par visto nesta página ou guardado antes), ela entra na conversa do
  // NÚMERO em vez de criar a conversa "sem número" da mesma pessoa. Fora da
  // transação da página e sem nunca lançar: falha do mapa não pode travar a importação.
  const validas = await resolverLidsDaPagina(job.teamId, validasBase);
  return basePrisma.$transaction(async (tx) => {
    const conta = await tx.channelAccount.findFirst({
      where: { id: job.accountId, teamId: job.teamId, externalId: job.instance, provider: "evolution", canal: "whatsapp" },
      select: { id: true },
    });
    if (!conta) return 0;
    const existentes = await tx.message.findMany({
      where: { teamId: job.teamId, providerMessageId: { in: validas.map((m) => m.providerMessageId!) } },
      select: { id: true, providerMessageId: true, conversation: { select: { channelAccountId: true } } },
    });
    const porId = new Map(existentes.map((m) => [m.providerMessageId, m]));
    // Nunca desloca uma mensagem de OUTRA conta ativa. Uma mensagem da mesma
    // instância que ficou órfã após desconectar pode voltar à caixa reconectada.
    const elegiveis = validas.filter((m) => {
      const c = porId.get(m.providerMessageId!)?.conversation.channelAccountId;
      return !c || c === job.accountId;
    });
    if (!elegiveis.length) return 0;
    const identifiers = await tx.channelIdentifier.findMany({
      where: { teamId: job.teamId, ...ondeIdentificadorExato(job.teamId, "whatsapp", elegiveis.flatMap((m) => ehLid(m.from) ? [] : phoneVariants(m.from))) },
      select: { valor: true, valorCifrado: true, contactId: true },
    });
    const contatos = new Map(identifiers.flatMap((i) => { const v = valorDe(i); return v ? [[v, i.contactId] as const] : []; }));
    const grupos = new Map<string, { contactId: string | null; number: string; messages: InboundMessage[] }>();
    for (const m of elegiveis) {
      const contactId = ehLid(m.from) ? null : phoneVariants(m.from).map((n) => contatos.get(n)).find(Boolean) ?? null;
      const chave = contactId ?? m.from;
      const grupo = grupos.get(chave) ?? { contactId, number: m.from, messages: [] };
      grupo.messages.push(m);
      grupos.set(chave, grupo);
    }
    const gruposOrdenados = [...grupos.values()].map((g) => ({
      ...g, messages: g.messages.sort((a, b) => b.timestamp! - a.timestamp!),
    }));
    await tx.conversation.createMany({
      // `tx` é do basePrisma (sem a extensão da cifra dos contatos): preenche cifrado e índice aqui.
      data: gruposOrdenados.map((g) => comCamposCifrados("conversation", job.teamId, {
        teamId: job.teamId, channelAccountId: job.accountId, canal: "whatsapp" as const,
        contactId: g.contactId, externalNumber: g.contactId ? null : g.number,
        // Sem nome, fica null: a tela mostra a agenda, o número ou "sem número"
        // (conversations/nome.ts) — rótulo de tela não vira nome de pessoa.
        externalName: nomeDoPerfilNoLote(g.messages),
      })),
      skipDuplicates: true,
    });
    const conversas = await tx.conversation.findMany({
      where: {
        teamId: job.teamId, channelAccountId: job.accountId,
        OR: gruposOrdenados.map((g) => g.contactId ? { contactId: g.contactId } : { contactId: null, ...ondeConversaPorNumero(job.teamId, [g.number]) }),
      },
      select: { id: true, contactId: true, externalNumber: true, externalNumberCifrado: true },
    });
    const porConversa = new Map(conversas.map((c) => [c.contactId ?? numeroDe(c, "externalNumber", "conversation")!, c.id]));
    const novas: Prisma.MessageCreateManyInput[] = [];
    let recuperadas = 0;
    for (const g of gruposOrdenados) {
      const conversationId = porConversa.get(g.contactId ?? g.number)!;
      // Histórico só PREENCHE o pushName que falta (o do webhook é mais novo);
      // o rótulo antigo das conversas `@lid` conta como "sem nome".
      const nome = nomeDoPerfilNoLote(g.messages);
      if (nome) await tx.conversation.updateMany({
        where: { id: conversationId, teamId: job.teamId, OR: [{ externalName: null }, { externalName: { startsWith: PREFIXO_ROTULO_LID_ANTIGO } }] },
        data: { externalName: nome },
      });
      const orfas = g.messages.map((m) => porId.get(m.providerMessageId!)).filter((m) => m?.conversation.channelAccountId === null);
      if (orfas.length) {
        const r = await tx.message.updateMany({
          where: { teamId: job.teamId, id: { in: orfas.map((m) => m!.id) }, conversation: { channelAccountId: null } },
          data: { conversationId },
        });
        recuperadas += r.count;
      }
      for (const m of g.messages) {
        if (porId.has(m.providerMessageId!)) continue;
        novas.push({
          teamId: job.teamId, conversationId, providerMessageId: m.providerMessageId,
          direcao: m.fromMe ? "out" : "in", tipo: m.media?.kind ?? "text",
          conteudo: textoHistorico(m), mediaMime: m.media?.mime,
          status: m.fromMe ? "sent" : "delivered", createdAt: new Date(m.timestamp! * 1000),
          meta: { whatsappHistory: true },
        });
      }
      const ultima = g.messages[0]!;
      const quando = new Date(ultima.timestamp! * 1000);
      await tx.conversation.updateMany({
        where: { id: conversationId, teamId: job.teamId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: quando } }] },
        data: {
          lastMessageAt: quando,
          lastMessagePreview: previewDaMensagem(textoHistorico(ultima), ultima.media?.kind ?? "text"),
          lastMessageDirecao: ultima.fromMe ? "out" : "in",
        },
      });
    }
    const criadas = novas.length ? await tx.message.createMany({ data: novas, skipDuplicates: true }) : { count: 0 };
    return criadas.count + recuperadas;
  }, { timeout: 30_000 });
}

/**
 * Pares @lid ↔ telefone da página: a mensagem AO VIVO já gravada na Evolution traz
 * `remoteJid` = @lid e o telefone em `remoteJidAlt` (o `from` vem como telefone e
 * o `remoteJid` original fica no `InboundMessage`). Guarda esses pares (origem
 * "historico") e troca o `from` das mensagens só-@lid pelo telefone do par, seja
 * ele desta página ou de uma anterior/webhook (tabela `WhatsAppLid`). O que não
 * tem par segue como conversa "sem número", como antes.
 *
 * Só ajusta ONDE a mensagem entra: NÃO junta conversas que já existem (isso é a
 * unificação, que a pessoa revisa: a documentação interna).
 */
async function resolverLidsDaPagina(teamId: string, mensagens: InboundMessage[]): Promise<InboundMessage[]> {
  try {
    const daPagina = new Map<string, string>();
    for (const m of mensagens) {
      if (ehJidLid(m.remoteJid) && !ehLid(m.from)) daPagina.set(m.remoteJid, m.from);
    }
    if (daPagina.size) {
      await gravarParesLid(basePrisma, teamId, [...daPagina].map(([lid, telefone]) => ({ lid, telefone })), "historico");
    }
    const soLid = mensagens.filter((m) => ehLid(m.from));
    if (!soLid.length) return mensagens;
    const guardados = await lerParesLid(basePrisma, teamId, soLid.map((m) => m.from).filter((l) => !daPagina.has(l)));
    return mensagens.map((m) => {
      if (!ehLid(m.from)) return m;
      const telefone = daPagina.get(m.from) ?? guardados.get(m.from)?.telefone;
      return telefone ? { ...m, from: telefone } : m;
    });
  } catch (e) {
    // Sem o mapa (ex.: migration ainda não aplicada), a importação segue como antes.
    logger.warn({ teamId, err: e instanceof Error ? e.message : String(e) }, "[wa-history] não deu para resolver os @lid da página (segue como conversa sem número)");
    return mensagens;
  }
}

function textoHistorico(m: InboundMessage): string {
  if (!m.media) return m.text ?? "";
  const nomes = { image: "Imagem", audio: "Áudio", doc: "Arquivo" };
  const aviso = `[${nomes[m.media.kind]} do histórico: consulte o arquivo no celular]`;
  return m.text ? `${m.text}\n${aviso}` : aviso;
}

/**
 * Job do histórico de UMA conta (fila `whatsapp-history`, agendado a cada minuto
 * pela varredura do worker): importa o histórico e, na mesma passada, cuida dos
 * nomes das conversas (limpeza do nome do dono + agenda do celular). Os nomes
 * rodam mesmo se o histórico falhar — são independentes — e só no intervalo
 * deles (6 h), ou na hora quando uma passagem do histórico acabou de concluir.
 */
export async function processarHistoricoWhatsApp(job: WhatsAppHistoryJob, parar: () => boolean = () => false): Promise<void> {
  // Cinto e suspensório: jobs que já estavam na fila do Redis (agendados antes
  // de a chave existir ou com ela ligada) também não importam nada quando o
  // modo está desligado. A sincronização de nomes, que roda no mesmo job, para junto.
  if (!importacaoHistoricoLigada()) return;
  let concluiu = false;
  try {
    concluiu = await sincronizarHistorico(job, parar);
  } finally {
    if (!parar()) {
      await sincronizarNomesWhatsApp(job, { forcar: concluiu }).catch((e) => {
        logger.warn({ accountId: job.accountId, err: e instanceof Error ? e.message : String(e) }, "[wa-nomes] falha ao sincronizar nomes (tenta de novo na próxima rodada)");
      });
    }
  }
}

/** Importa/retoma o histórico. Devolve true quando uma passagem CONCLUIU agora. */
async function sincronizarHistorico(job: WhatsAppHistoryJob, parar: () => boolean): Promise<boolean> {
  const conta = await basePrisma.channelAccount.findFirst({
    where: { id: job.accountId, teamId: job.teamId, externalId: job.instance, provider: "evolution", canal: "whatsapp", status: "connected" },
    select: { meta: true },
  });
  if (!conta) return false; // conta desconectada/excluída enquanto o job esperava
  let estado: WhatsAppHistoryStatus = lerEstadoHistorico(conta.meta) ?? {
    status: "pending", pagina: 1, total: 0, processadas: 0, importadas: 0, ignoradas: 0,
    ate: new Date().toISOString(), atualizadoEm: new Date().toISOString(),
  };
  const buscar = (page: number, tamanho?: number) => fetchWhatsAppHistoryPage({
    apiUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY, instance: job.instance, page, until: estado.ate,
    ...(tamanho ? { tamanho } : {}),
  });
  if (estado.status === "completed") {
    // Já concluído: a varredura passa a cada minuto só para ver se o celular
    // entregou MAIS histórico antigo. Confere o total com página de 1 item
    // (antes baixava 250 mensagens por minuto, por conta, para sempre). Falha
    // aqui não rebaixa o estado para "erro": a importação continua concluída.
    const conferencia = await buscar(1, 1);
    if (conferencia.total === estado.total) return false;
  }
  try {
    const primeira = await buscar(1);
    // Mudou o conjunto enquanto paginávamos: começa outra passagem. IDs no
    // banco deduplicam e evitam perder itens deslocados pela paginação offset.
    if (estado.status === "completed" || estado.total !== primeira.total) {
      estado = { ...estado, pagina: 1, processadas: 0, ignoradas: 0 };
    }
    estado = { ...estado, status: "running", total: primeira.total };
    await salvarEstado(job, estado);
    for (let pagina = estado.pagina; pagina <= Math.max(1, primeira.pages); pagina++) {
      if (parar()) return false; // shutdown: o próximo worker retoma do checkpoint
      const existe = await basePrisma.channelAccount.count({
        where: { id: job.accountId, teamId: job.teamId, externalId: job.instance, status: "connected" },
      });
      if (!existe) return false;
      const p = pagina === 1 ? primeira : await buscar(pagina);
      const importadas = await importarPaginaHistorico(job, p.messages);
      estado = {
        ...estado, pagina: pagina + 1, processadas: estado.processadas + p.records,
        importadas: estado.importadas + importadas, ignoradas: estado.ignoradas + p.records - p.messages.length,
        atualizadoEm: new Date().toISOString(),
      };
      await salvarEstado(job, estado);
    }
    // Contagem real, inclusive após crash entre o commit da página e o
    // checkpoint. Reprocessar a página não pode subcontar o histórico.
    const disponiveis = await basePrisma.message.count({
      where: { teamId: job.teamId, conversation: { channelAccountId: job.accountId }, createdAt: { lte: new Date(estado.ate) } },
    });
    estado = { ...estado, importadas: disponiveis, status: "completed", atualizadoEm: new Date().toISOString() };
    await salvarEstado(job, estado);
    logger.info({ accountId: job.accountId, importadas: estado.importadas, ignoradas: estado.ignoradas }, "[wa-history] histórico sincronizado");
    return true;
  } catch (e) {
    await salvarEstado(job, { ...estado, status: "error", atualizadoEm: new Date().toISOString() });
    throw e;
  }
}
