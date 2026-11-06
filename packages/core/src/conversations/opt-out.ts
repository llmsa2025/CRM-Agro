import { db, type TenantPrismaClient } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";
import { assertOwned } from "../tenancy/assert-owned";

/**
 * Opt-out automático (plano N12, produto §A.5).
 *
 * Antes, "pare", "sair" ou "não quero mais receber" na resposta não mudava
 * nada: quem pediu para sair continuava entrando em fluxo e em campanha —
 * risco de denúncia (ban do número) e de LGPD. Agora a mensagem recebida passa
 * pela REGRA abaixo e, se for um pedido de saída DEFINITIVO:
 *  - `Contact.relacionamentoStatus = opt_out` (a lista de campanha já pula);
 *  - tag `Pediu para sair` (a lista de texto do contato, a mesma do "Tem
 *    Histórico" — NÃO a tag nomeada, que é única por contato e trocaria a
 *    lista dele, e que dispararia fluxos `tag_added`);
 *  - inscrições em curso encerradas (mesmo `where`/`data` do "parar tudo" do
 *    item 1.5, `encerrarInscricoesDoFluxo`, só que por contato);
 *  - destinatário de campanha que recebeu a mensagem há até 30 dias →
 *    `opted_out` (conta no freio de saídas); os que ainda iam receber →
 *    `skipped` "pediu para sair";
 *  - uma nota no histórico, só na 1ª vez.
 *
 * A regra é CONSERVADORA de propósito: marcar opt-out por engano perde o
 * contato para sempre. Na dúvida ela não marca, e a mensagem segue o caminho
 * normal (fluxos, IA de classificação com confirmação humana, vendedor).
 *
 * Como a regra decide (texto normalizado: minúsculas, sem acento, sem
 * pontuação nem emoji):
 *  1. NEGAÇÃO do pedido ("não quero sair da lista", "não precisa me remover")
 *     → não é opt-out.
 *  2. Pedido de LISTA/descadastro ("me tira dessa lista", "remove meu
 *     número", "descadastrar", "sair da lista", "unsubscribe") → opt-out,
 *     sempre.
 *  3. ADIAMENTO ou condição ("não quero agora", "me chama semana que vem",
 *     "no momento", "depois das 18h") → NÃO é opt-out definitivo (é
 *     "pediu depois", assunto da classificação).
 *  4. Pedido explícito de parar ("pare de me mandar", "não me mande mais",
 *     "não quero mais receber") → opt-out.
 *  5. COMANDO curto: a mensagem inteira é o comando, no máximo com cortesia
 *     ("Pare", "SAIR 🙏", "Me remova, obrigado", "stop").
 *  6. Começa com o comando (pare/parar/parem/stop — a regex do plano sem os
 *     ambíguos) e não é pergunta ("Pare com isso") → opt-out.
 *
 * Ficam FORA de propósito (vão para a classificação da IA, que só SUGERE a
 * saída, com confirmação humana — campaigns/classificacao.ts): "não quero",
 * "não quero mais", "cancelar" sozinhos (respondem a uma oferta ou a um
 * "responda CONFIRMAR ou CANCELAR" do template), "não tenho interesse" e
 * "não, obrigado" (recusa não é pedido para nunca mais ser contatado),
 * "não quero perder essa", "cancelar a visita", "para quem é?", "sair para
 * almoçar", "remover o item 2", "não quero receber o boleto por e-mail".
 *
 * Configurável: `REGRAS_OPT_OUT` (passada a `classificarOptOut`) e a env
 * `OPT_OUT_COMANDOS_EXTRA` (comandos curtos a mais, separados por vírgula).
 */

export const TAG_PEDIU_PARA_SAIR = "Pediu para sair";
export const MOTIVO_PEDIU_PARA_SAIR = "pediu para sair";
/** Resposta até N dias depois do envio da campanha conta como resposta a ela. */
export const JANELA_ATRIBUICAO_CAMPANHA_DIAS = 30;

export type RegrasOptOut = {
  /** Mensagem inteira = comando (depois de tirar a cortesia). */
  comandos: string[];
  /** Palavras de cortesia/preenchimento ignoradas em volta do comando. */
  cortesia: string[];
  /** Pedido de lista/descadastro: opt-out mesmo com adiamento. */
  pedidosDeLista: RegExp[];
  /** Pedido explícito de parar (qualquer ponto da mensagem). */
  pedidosExplicitos: RegExp[];
  /** Início de mensagem que é comando (a regex do plano, sem os ambíguos). */
  inicios: RegExp;
  /** Adiamento/condição: tira o caráter definitivo. */
  adiamento: RegExp[];
  /** Negação do próprio pedido. */
  negacao: RegExp;
};

export const REGRAS_OPT_OUT: RegrasOptOut = {
  comandos: [
    "pare",
    "parar",
    "para",
    "parem",
    "sair",
    "quero sair",
    "remover",
    "remova",
    "me remova",
    "me remove",
    "me tira",
    "me tire",
    "me exclua",
    "me exclui",
    "stop",
    "descadastrar",
  ],
  cortesia: [
    "obrigado",
    "obrigada",
    "obg",
    "obgd",
    "grato",
    "grata",
    "valeu",
    "vlw",
    "por favor",
    "porfavor",
    "pfv",
    "pf",
    "por gentileza",
    "ok",
    "tchau",
    "att",
    "abs",
    "abraco",
    "ja",
    "isso",
  ],
  pedidosDeLista: [
    // "me tira dessa lista", "pode me remover da sua lista", "exclui meu número
    // do cadastro" — o objeto é a PESSOA (me/meu número), não um item da
    // lista ("tira o adubo da lista" não casa).
    /\b(tira|tire|tirem|tirar|remove|remova|removam|remover|exclui|exclua|excluam|excluir|retira|retire|retirar|apaga|apague|apagar)( (o )?meu (numero|contato|telefone|nome|whatsapp|zap))? (da|dessa|desta|de|do|da sua|dessa sua|de sua|desta sua) (lista|listas|contatos|cadastro)\b/,
    /\b(tira|tire|tirem|tirar|remove|remova|removam|remover|exclui|exclua|excluam|excluir|apaga|apague|apagar) (o )?meu (numero|contato|telefone|whatsapp|zap)\b/,
    /\bdescadastr\w*/,
    /\bsair (da|dessa|desta)( sua)? lista\b/,
    /\bunsubscribe\b/,
    /\bcancel\w*( a| o| minha| meu)? (inscricao|assinatura|cadastro)\b/,
  ],
  pedidosExplicitos: [
    /\b(pare|para|parem|parar|pode parar) de (me )?(mandar|enviar|chamar|ligar|encher|incomodar|perturbar)\b/,
    /\bnao (me )?(mande|mandem|manda|envie|enviem|envia|chame|chamem|procure|procurem|ligue|liguem|incomode|incomodem|perturbe|perturbem) mais\b/,
    // "receber" só com objeto de mensagem: "não quero receber o boleto por e-mail" não é saída.
    /\bnao quero (mais )?receber( (mais|essas?|estas?|suas?|nenhuma|isso|nada|propagandas?|mensage\w*|promoc\w*|ofertas?)\b|$)/,
    /\bnao quero (mais )?ser (contatado|contatada|chamado|chamada|incomodado|incomodada)\b/,
    /\bnao quero mais (mensage\w*|contato)\b/,
    /\bchega de (mensage\w*|mandar|enviar)\b/,
  ],
  // Sem "sair"/"remover" aqui: "sair para almoçar", "remover o item 2" — esses
  // só valem como comando inteiro ou com a lista ("sair da lista").
  inicios: /^(pare|parem|parar|stop)\b/,
  adiamento: [
    /\b(no|neste|nesse) momento\b/,
    /\bpor (enquanto|ora|agora)\b/,
    /\b(amanha|depois|em breve)\b/,
    /\bmais (tarde|pra frente|para frente|adiante)\b/,
    /\b(semana|mes|ano) que vem\b/,
    /\bproxim[oa] (semana|mes|ano|safra)\b/,
    /\b(outra|outro) (hora|dia|vez|momento)\b/,
    /\bdaqui a\b/,
    /\bme (chama|chame|liga|ligue|procura|procure|manda|mande) (em|na|no|daqui|semana|mes)\b/,
    // "agora"/"hoje" só são adiamento colados a uma recusa ("não quero
    // agora", "hoje não dá"); em "pare de mandar agora!" são ênfase.
    /\bnao (quero|posso|da|tenho interesse|tenho tempo)( \w+){0,2} (agora|hoje)\b/,
    /\bhoje nao (da|posso|quero)\b/,
  ],
  negacao: /\bnao (quero|queria|pretendo|vou|preciso|precisa|precisam|e pra|e para|e pro)( me)? (sair|tirar|remover|excluir|cancelar|descadastrar|parar)\b/,
};

/** Minúsculas, sem acento, sem pontuação nem emoji, espaços simples. */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function comandosExtraDoAmbiente(): string[] {
  return (process.env.OPT_OUT_COMANDOS_EXTRA ?? "")
    .split(",")
    .map((c) => normalizarTexto(c))
    .filter(Boolean);
}

/** Tira a cortesia das pontas ("pare por favor obrigado" → "pare"). */
function semCortesia(t: string, cortesia: string[]): string {
  let s = ` ${t} `;
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const c of cortesia) {
      const antes = s;
      s = s.replace(new RegExp(`^ ${c} `), " ").replace(new RegExp(` ${c} $`), " ");
      if (s !== antes) mudou = true;
    }
  }
  return s.trim();
}

export type DecisaoOptOut = {
  /** Pedido de saída DEFINITIVO: aplica o opt-out. */
  optOut: boolean;
  /** Recusa com adiamento ("não quero agora") — insumo da classificação. */
  adiamento: boolean;
  /** Qual regra decidiu (log e nota no histórico). */
  regra: "negacao" | "lista" | "explicito" | "comando" | "inicio" | null;
};

const NADA: DecisaoOptOut = { optOut: false, adiamento: false, regra: null };

/** A regra de opt-out sobre o texto de UMA mensagem recebida. Pura. */
export function classificarOptOut(texto: string | null | undefined, regras: RegrasOptOut = REGRAS_OPT_OUT): DecisaoOptOut {
  if (!texto) return NADA;
  const t = normalizarTexto(texto);
  if (!t) return NADA;
  if (regras.negacao.test(t)) return { optOut: false, adiamento: false, regra: "negacao" };
  if (regras.pedidosDeLista.some((r) => r.test(t))) return { optOut: true, adiamento: false, regra: "lista" };
  const adiamento = regras.adiamento.some((r) => r.test(t));
  if (adiamento) return { optOut: false, adiamento: true, regra: null };
  if (regras.pedidosExplicitos.some((r) => r.test(t))) return { optOut: true, adiamento: false, regra: "explicito" };
  const comandos = new Set([...regras.comandos, ...comandosExtraDoAmbiente()]);
  if (comandos.has(semCortesia(t, regras.cortesia))) return { optOut: true, adiamento: false, regra: "comando" };
  // Pergunta ("sair como?", "remover o quê?") não é ordem: fica para a IA/vendedor.
  if (regras.inicios.test(t) && !texto.includes("?")) return { optOut: true, adiamento: false, regra: "inicio" };
  return NADA;
}

// ---------------------------------------------------------------------------
// Aplicação
// ---------------------------------------------------------------------------

export type ResultadoOptOut = {
  /** Foi agora que o contato virou opt-out (false = já era). */
  novo: boolean;
  inscricoesEncerradas: number;
  /** Destinatário de campanha recente marcado `opted_out` (0 ou 1). */
  campanhaSaiu: number;
  /** Destinatários que ainda iam receber, marcados `skipped`. */
  campanhasPuladas: number;
};

/** Transação do client do time (a do `receiveInbound` ou a do `aplicarOptOut`). */
type TxDoTime = Parameters<Parameters<TenantPrismaClient["$transaction"]>[0]>[0];

type OpcoesDoOptOut = {
  origem: "regra" | "manual";
  texto?: string | null;
  regra?: DecisaoOptOut["regra"];
  messageId?: string | null;
  agora?: Date;
};

/**
 * Os efeitos do opt-out DENTRO de uma transação do time. Idempotente: cada
 * passo só pega o que ainda não está no estado final.
 */
async function efeitosDoOptOut(tx: TxDoTime, contactId: string, opts: OpcoesDoOptOut): Promise<ResultadoOptOut> {
  const agora = opts.agora ?? new Date();
  const desde = new Date(agora.getTime() - JANELA_ATRIBUICAO_CAMPANHA_DIAS * 86_400_000);
  // Transição (compare-and-set): só um "pare" vira opt-out; os seguintes acham feito.
  const { count: virou } = await tx.contact.updateMany({
    where: { id: contactId, relacionamentoStatus: { not: "opt_out" } },
    data: { relacionamentoStatus: "opt_out" },
  });
  // Tag sem duplicar. `Contact.tags` nasce NULL, e o filtro `has` do Prisma
  // não casa com NULL — então: trava a linha (UPDATE) e lê as tags já sob a
  // trava; outro "pare" simultâneo espera o commit e acha a tag lá.
  const { tags } = await tx.contact.update({
    where: { id: contactId },
    data: { relacionamentoStatus: "opt_out" },
    select: { tags: true },
  });
  if (!tags.includes(TAG_PEDIU_PARA_SAIR)) {
    await tx.contact.update({ where: { id: contactId }, data: { tags: { set: [...tags, TAG_PEDIU_PARA_SAIR] } } });
  }
  // Inscrições em curso: mesmo where/data do "parar tudo" (item 1.5). Job que
  // ainda está na fila acha `done` e sai; o passo em execução fecha sem
  // avançar (CAS do concluirPasso, item 1.9).
  const { count: encerradas } = await tx.enrollment.updateMany({
    where: { contactId, status: { in: ["active", "waiting"] } },
    data: { status: "done", nextRunAt: null, waitingFor: null, waitingUntil: null },
  });
  // Campanha: a mensagem que ele recebeu por último (até 30 dias) é a que
  // provocou a saída — conta no freio de saídas dela.
  const ultima = await tx.campaignRecipient.findFirst({
    where: { contactId, status: { in: ["sent", "delivered", "read", "replied"] }, sentAt: { gte: desde } },
    orderBy: { sentAt: "desc" },
    select: { id: true },
  });
  const { count: campanhaSaiu } = ultima
    ? await tx.campaignRecipient.updateMany({
        where: { id: ultima.id, status: { in: ["sent", "delivered", "read", "replied"] } },
        data: { status: "opted_out", motivo: MOTIVO_PEDIU_PARA_SAIR, classificacao: "saiu", repliedAt: agora },
      })
    : { count: 0 };
  // Quem ainda ia receber não recebe mais. `sending` (o worker está enviando
  // agora) fica com o worker: ele confere o opt-out no claim (contrato A.3).
  const { count: campanhasPuladas } = await tx.campaignRecipient.updateMany({
    where: { contactId, status: { in: ["queued", "held"] } },
    data: { status: "skipped", motivo: MOTIVO_PEDIU_PARA_SAIR },
  });
  if (virou === 1) {
    const trecho = opts.texto ? `"${opts.texto.trim().slice(0, 200)}"` : null;
    await tx.activity.create({
      data: {
        contactId,
        tipo: "note",
        conteudo: [
          "Pediu para sair",
          trecho,
          opts.origem === "regra" ? "opt-out automático" : "marcado pelo vendedor",
          "inscrições encerradas; não entra mais em fluxos nem campanhas",
        ]
          .filter(Boolean)
          .join(" · "),
        meta: {
          optOut: true,
          origem: opts.origem,
          regra: opts.regra ?? null,
          messageId: opts.messageId ?? null,
          inscricoesEncerradas: encerradas,
        },
      } as never,
    });
  }
  return { novo: virou === 1, inscricoesEncerradas: encerradas, campanhaSaiu, campanhasPuladas };
}

/**
 * Aplica o opt-out ao contato. IDEMPOTENTE: rodar de novo (mensagem
 * reentregue, segundo "pare", retry) não duplica tag, nota nem contagem — cada
 * passo só pega o que ainda não está no estado final. Numa transação só.
 *
 * `origem`: "regra" (mensagem recebida, contexto do sistema), "manual" (o
 * vendedor marcou, ou confirmou a sugestão da IA).
 */
export async function aplicarOptOut(contactId: string, opts: OpcoesDoOptOut): Promise<ResultadoOptOut> {
  requireCan("contacts.write");
  const prisma = db();
  // O id vem do inbound (servidor) ou da tela: nunca mexe em contato de outro time.
  await assertOwned("contact", contactId);
  const agora = opts.agora ?? new Date();
  const r = await prisma.$transaction((tx) => efeitosDoOptOut(tx, contactId, { ...opts, agora }));
  if (r.novo || r.inscricoesEncerradas || r.campanhaSaiu || r.campanhasPuladas) {
    logger.info({ contactId, origem: opts.origem, regra: opts.regra ?? null, ...r }, "[opt-out] contato pediu para sair");
  }
  return r;
}

/** Marca o opt-out pela tela (vendedor, ou confirmação da sugestão da IA). */
export async function marcarOptOut(contactId: string): Promise<ResultadoOptOut> {
  requireCan("contacts.write");
  return aplicarOptOut(contactId, { origem: "manual" });
}

/**
 * Ponto de entrada do `receiveInbound`: roda DENTRO da mesma transação que
 * grava a mensagem recebida (e só para mensagem de ENTRADA de um contato).
 * Devolve `true` quando a mensagem é um pedido de saída: o chamador então NÃO
 * acorda o "respondeu?" nem inscreve em `message_received` (nem registra
 * resposta de campanha) — responder a quem disse "pare" é o que gera denúncia.
 *
 * Por que na mesma transação (auditoria do #112): antes o opt-out rodava
 * DEPOIS de gravar a mensagem. Se o worker caísse entre os dois, o retry da
 * fila caía no dedup da mensagem e o opt-out nunca era aplicado. Agora a
 * mensagem e o opt-out entram juntos ou não entram — e, se a transação falha,
 * o job relança e o BullMQ refaz os dois.
 *
 * O `contactId` vem do próprio inbound (identificador achado no time da conta),
 * e o `tx` é do client do time: não há como tocar contato de outro time.
 */
export async function optOutNaTransacao(
  tx: TxDoTime,
  input: { contactId: string; texto: string | null | undefined; messageId?: string | null },
): Promise<boolean> {
  const decisao = classificarOptOut(input.texto);
  if (!decisao.optOut) return false;
  requireCan("contacts.write");
  const r = await efeitosDoOptOut(tx, input.contactId, {
    origem: "regra",
    texto: input.texto,
    regra: decisao.regra,
    messageId: input.messageId ?? null,
  });
  logger.info({ contactId: input.contactId, origem: "regra", regra: decisao.regra, ...r }, "[opt-out] contato pediu para sair");
  return true;
}
