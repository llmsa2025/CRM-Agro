import { db, type TenantPrismaClient } from "@crmagro/db";
import { ForbiddenError } from "../auth/authz";
import { escopoCanal, escopoConversa } from "../conversations/escopo";
import { escopoDoContato } from "../contacts/escopo";
import { escopoNegocio } from "../funnels/escopo";
import { escopoFluxo } from "../flows/escopo";
import { escopoLigacao } from "../calls/escopo";
import { escopoCampanha } from "../campaigns/escopo";

/**
 * Prova de posse de id vindo do cliente (auditoria S1 — IDOR por FK).
 *
 * As FKs do schema são de coluna única (`Deal.contactId → Contact.id`, sem o
 * `teamId` junto). A extensão de tenancy filtra o `where` da operação, mas NÃO
 * confere a FK que vai no `data` nem filtra `include`. Então gravar um
 * `contactId` de outro time num Deal/Enrollment/ContactTag do meu time funciona
 * no banco, e dali em diante o `include` devolve o contato alheio.
 *
 * Regra: todo id que chega do cliente e vira FK numa escrita passa por aqui
 * ANTES da escrita. A solução definitiva (FK composta `(id, teamId)`) é da
 * Fase 2; isto fecha o buraco até lá.
 *
 * `db()` já injeta o `teamId` do contexto, então contar o id é suficiente: se
 * não achou, ou não existe ou é de outro time — e para quem chama é o mesmo
 * "não encontrado" (não revela que o id existe em outro lugar).
 */

export type OwnedModel =
  | "contact"
  | "stage"
  | "funnel"
  | "deal"
  | "conversation"
  | "tag"
  | "flow"
  | "channelAccount"
  | "company"
  | "appointment"
  | "call"
  | "enrollment"
  | "campaign"
  | "user"
  | "linhaDeLigacao"
  | "integration"
  | "channelIdentifier";

/**
 * Escopo por dono (F3): para membro/só leitura, "ser do time" não basta — o
 * contato, o negócio, o fluxo, o canal, a conversa e a ligação têm de ser DELE (ou
 * compartilhados). Master, admin, "ver tudo" NA TELA do registro e sistema:
 * escopo vazio. Cada modelo usa o escopo da SUA tela (contato → Contatos,
 * negócio → Funis, número/conversa → Conversas...).
 *
 * `assertOwned` é a guarda de ESCRITA por id (o id vira FK ou o registro vai
 * ser alterado): por padrão confere o escopo de ESCRITA ("Ver e editar de
 * todos" na tela). Quem só usa o id para LER passa `{ leitura: true }`.
 */
type Uso = { escrita: boolean };
const COM_DONO = new Set<OwnedModel>(["contact", "deal", "conversation", "flow", "channelAccount", "call", "campaign", "channelIdentifier"]);

/** Conta quantos dos ids existem NO TIME ATUAL (e no escopo), por model. Tipado sem `any`. */
const CONTAR: Record<OwnedModel, (p: TenantPrismaClient, ids: string[], uso: Uso) => Promise<number>> = {
  contact: (p, ids, uso) => p.contact.count({ where: { AND: [{ id: { in: ids } }, escopoDoContato(uso)] } }),
  stage: (p, ids) => p.stage.count({ where: { id: { in: ids } } }),
  funnel: (p, ids) => p.funnel.count({ where: { id: { in: ids } } }),
  deal: (p, ids, uso) => p.deal.count({ where: { AND: [{ id: { in: ids } }, escopoNegocio(undefined, uso)] } }),
  // Conversa: a do número de quem conectou (F3, decisão do dono).
  conversation: (p, ids, uso) => p.conversation.count({ where: { AND: [{ id: { in: ids } }, escopoConversa(uso)] } }),
  tag: (p, ids) => p.tag.count({ where: { id: { in: ids } } }),
  flow: (p, ids, uso) => p.flow.count({ where: { AND: [{ id: { in: ids } }, escopoFluxo(uso)] } }),
  channelAccount: (p, ids, uso) => p.channelAccount.count({ where: { AND: [{ id: { in: ids } }, escopoCanal(uso)] } }),
  company: (p, ids) => p.company.count({ where: { id: { in: ids } } }),
  appointment: (p, ids) => p.appointment.count({ where: { id: { in: ids } } }),
  call: (p, ids, uso) => p.call.count({ where: { AND: [{ id: { in: ids } }, escopoLigacao(uso)] } }),
  enrollment: (p, ids) => p.enrollment.count({ where: { id: { in: ids } } }),
  // Campanha (F3): as de quem criou + as compartilhadas.
  campaign: (p, ids, uso) => p.campaign.count({ where: { AND: [{ id: { in: ids } }, escopoCampanha(uso)] } }),
  // Responsável do compromisso (Agenda §E): usuário do mesmo time.
  user: (p, ids) => p.user.count({ where: { id: { in: ids } } }),
  // Linha de ligação (F1B-05): do time atual. A regra "membro só usa a própria linha ou a do time" mora em
  // `linhaParaLigar` (calls/nucleo/linhas.ts), não aqui: esta guarda só prova que o id é do time.
  linhaDeLigacao: (p, ids) => p.linhaDeLigacao.count({ where: { id: { in: ids } } }),
  // Conta de provedor, CRM ou IA: do time atual (a tela é de Integrações, restrita a administrador).
  integration: (p, ids) => p.integration.count({ where: { id: { in: ids } } }),
  // Telefone ou e-mail de um contato (F1B-05, usado pelo "ligar para este número" da F1B-11): do time E de um
  // contato que a pessoa alcança, pelo mesmo escopo do contato. O membro não usa o número do contato do colega.
  channelIdentifier: (p, ids, uso) =>
    p.channelIdentifier.count({ where: { AND: [{ id: { in: ids } }, { contact: escopoDoContato(uso) }] } }),
};

/**
 * A pessoa VÊ o registro dos colegas nesta tela ("Ver de todos"), mas não
 * pode alterar. É `ForbiddenError` (as telas e a API já mostram "sem
 * permissão"); só aparece para quem lê o registro — não revela nada novo.
 */
export class EdicaoNaoPermitida extends ForbiddenError {
  constructor() {
    super("Você pode ver, mas não editar os registros dos colegas nesta tela. Peça ao administrador \"Ver e editar de todos\".");
  }
}

/**
 * Registro não encontrado NO TIME ATUAL. Mesma mensagem para "não existe" e
 * "é de outro time" — de propósito, para não servir de oráculo de ids alheios.
 */
export class OwnedNotFound extends Error {
  constructor(
    readonly model: OwnedModel,
    readonly ids: readonly string[],
  ) {
    super(`OwnedNotFound: ${model} ${ids.join(",")} não encontrado neste time.`);
    this.name = "OwnedNotFound";
  }
}

/** Opções das guardas: `leitura` = o id só é usado para LER (escopo de leitura). */
export type OpcoesDePosse = { leitura?: boolean };

/**
 * Faltou algum id no escopo pedido. Na ESCRITA, se todos aparecem no escopo de
 * LEITURA, a pessoa vê mas não edita (`EdicaoNaoPermitida`); senão, "não
 * encontrado" (não revela o que ela não vê).
 */
async function recusar(p: TenantPrismaClient, model: OwnedModel, ids: string[], escrita: boolean): Promise<never> {
  if (escrita && COM_DONO.has(model) && (await CONTAR[model](p, ids, { escrita: false })) === ids.length) throw new EdicaoNaoPermitida();
  throw new OwnedNotFound(model, ids);
}

/** Garante que o registro existe NO TIME ATUAL (e no escopo de escrita, salvo `leitura`). */
export async function assertOwned(model: OwnedModel, id: string, opts: OpcoesDePosse = {}): Promise<void> {
  if (!id) throw new OwnedNotFound(model, [String(id)]);
  const p = db();
  const escrita = !opts.leitura;
  const n = await CONTAR[model](p, [id], { escrita });
  if (n !== 1) await recusar(p, model, [id], escrita);
}

/**
 * Garante que TODOS os ids existem no time atual (ids repetidos contam uma vez).
 * Lista vazia passa. Um único id alheio derruba a chamada inteira: operação em
 * lote não pode "meio funcionar" com ids de outro time (nem de colega que a
 * pessoa só vê).
 */
export async function assertOwnedMany(model: OwnedModel, ids: readonly string[], opts: OpcoesDePosse = {}): Promise<void> {
  const unicos = [...new Set(ids)];
  if (unicos.length === 0) return;
  if (unicos.some((id) => !id)) throw new OwnedNotFound(model, unicos);
  const p = db();
  const escrita = !opts.leitura;
  const n = await CONTAR[model](p, unicos, { escrita });
  if (n !== unicos.length) await recusar(p, model, unicos, escrita);
}

/** Versão para FK opcional: `null`/`undefined` passa; qualquer valor é conferido. */
export async function assertOwnedIfPresent(model: OwnedModel, id: string | null | undefined, opts: OpcoesDePosse = {}): Promise<void> {
  if (id === null || id === undefined) return;
  await assertOwned(model, id, opts);
}
