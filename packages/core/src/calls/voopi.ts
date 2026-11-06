import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, getCurrentTeamId, tenantData } from "@crmagro/db";
import { VoopiProvider, normalizePhone, phoneVariants, type VoopiConfig } from "@crmagro/channels";
import { requireCan } from "../auth/authz";
import { assertOwned } from "../tenancy/assert-owned";
import { logger } from "../logger/index";
import { createCall } from "./service";
import { redisEstado } from "../shared/redis-cache";
import { assinaturaDaLigacaoVoopi } from "./voopi-webhook-auth";
import { escopoLigacao } from "./escopo";
import {
  CallNotFound,
  CallValidationError,
  ContatoPediuParaSair,
  ContatoSemTelefoneValido,
  VoopiFalhou,
  VoopiNaoConfigurada,
} from "./errors";

/**
 * Ligar pela Voopi (tronco SIP / click-to-call) — o caminho de ponta a ponta.
 *
 * Antes existia o `VoopiProvider` (makeCall/hangup), o webhook e a transcrição,
 * mas NADA chamava o `makeCall`: nenhuma Call ganhava `providerCallId` e o
 * webhook nunca achava a ligação. Agora:
 *  1. o admin cadastra a conta SIP do time (`salvarVoopi`) — fica em
 *     `Integration` tipo `voopi`, com `credentials` CIFRADO pela extensão do
 *     Prisma (mesma cifra das outras integrações);
 *  2. "ligar pela Voopi" (`ligarPelaVoopi`) cria a Call (ou usa a que o
 *     discador já criou), chama o `makeCall` com a credencial DO TIME e grava
 *     o `providerCallId`. O `callbackUrl` leva o id da nossa Call (`ref`) e a
 *     assinatura dela (`sig`) — nunca o segredo global: o evento assinado só
 *     mexe naquela ligação, e se a Voopi avisar antes de gravarmos o id, o
 *     webhook acha a ligação mesmo assim;
 *  3. o webhook (`applyVoopiWebhookEvent`) atualiza status, duração, gravação
 *     e o resultado (produto §D); a transcrição roda no worker.
 * Sem Voopi pronta → `VoopiNaoConfigurada` ANTES de criar qualquer coisa: a
 * tela cai no discador manual.
 */

export const VOOPI_SIP_HOST_PADRAO = "sip.voopi.com.br";

/**
 * O host da conta tem de ser da Voopi: a API de click-to-call é derivada dele
 * (`sip.` → `api.`) e o servidor faz POST nela — host livre seria SSRF.
 */
function hostDaVoopi(host: string): boolean {
  const h = host.toLowerCase();
  return h === "voopi.com.br" || h.endsWith(".voopi.com.br");
}

/** Cadastro da conta SIP (borda da tela de Integrações). */
export const salvarVoopiSchema = z.object({
  sipHost: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+$/, "host inválido")
    .refine(hostDaVoopi, "o host tem de ser da Voopi (…voopi.com.br)")
    .default(VOOPI_SIP_HOST_PADRAO),
  sipPort: z.string().trim().regex(/^\d{2,5}$/, "porta inválida").default("5060"),
  sipUser: z.string().trim().min(1, "usuário SIP obrigatório").max(100),
  /** Opcional ao editar: vazio mantém a senha salva. */
  sipPassword: z.string().min(1).max(200).optional(),
});
export type SalvarVoopiInput = z.input<typeof salvarVoopiSchema>;

/** O que fica cifrado em `Integration.credentials`. */
const credencialSalvaSchema = z.object({
  sipHost: z.string().min(1).refine(hostDaVoopi),
  sipPort: z.string().min(1),
  sipUser: z.string().min(1),
  sipPassword: z.string().min(1),
});
type CredencialVoopi = z.infer<typeof credencialSalvaSchema>;

/** Estado da Voopi para a tela (nunca a senha). */
export type VoopiStatusDTO = {
  /** Conta SIP cadastrada. */
  configurada: boolean;
  /** Dá para ligar agora (conta + servidor prontos). */
  pronta: boolean;
  /** O que falta para ficar pronta (texto para a tela). */
  falta: string[];
  sipHost: string | null;
  sipPort: string | null;
  sipUser: string | null;
  senhaSalva: boolean;
  atualizadoEm: string | null;
};

/**
 * O que falta NO SERVIDOR: o endereço público (a Voopi avisa o fim da
 * ligação nele) e, em produção, o token do webhook (sem ele a rota recusa
 * tudo). Lido na hora (process.env), como a rota do webhook.
 */
function faltaNoServidor(): string[] {
  const falta: string[] = [];
  if (!process.env.APP_PUBLIC_URL) falta.push("APP_PUBLIC_URL no servidor");
  if (process.env.NODE_ENV === "production" && !process.env.VOOPI_WEBHOOK_TOKEN) falta.push("VOOPI_WEBHOOK_TOKEN no servidor");
  return falta;
}

/**
 * `callbackUrl` de UMA ligação: o id da nossa Call (`ref`) e a assinatura dela
 * (`sig`). NUNCA o segredo global — a URL vai para a conta Voopi do time (ver
 * `voopi-webhook-auth.ts`). Sem segredo (só em dev) vai sem assinatura.
 */
function urlDoWebhook(callId: string): string {
  const base = (process.env.APP_PUBLIC_URL ?? "").replace(/\/$/, "");
  const u = new URL(`${base}/api/webhooks/voopi`);
  u.searchParams.set("ref", callId);
  const segredo = process.env.VOOPI_WEBHOOK_TOKEN;
  if (segredo) u.searchParams.set("sig", assinaturaDaLigacaoVoopi(callId, segredo));
  return u.toString();
}

async function linhaDaVoopi() {
  return db().integration.findFirst({
    where: { tipo: "voopi" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, credentials: true, status: true, updatedAt: true },
  });
}

/** Credencial do time pronta para ligar — ou `VoopiNaoConfigurada` com o motivo. */
async function credencialDaVoopi(): Promise<CredencialVoopi> {
  const row = await linhaDaVoopi();
  const cred = credencialSalvaSchema.safeParse(row?.credentials);
  if (!row || !cred.success) throw new VoopiNaoConfigurada("cadastre a conta da Voopi em Integrações");
  if (row.status !== "connected") throw new VoopiNaoConfigurada("a integração da Voopi está desligada");
  const falta = faltaNoServidor();
  if (falta.length) throw new VoopiNaoConfigurada(`falta ${falta.join(" e ")}`);
  return cred.data;
}

function provedor(cred: CredencialVoopi, callId: string): VoopiProvider {
  const config: VoopiConfig = { ...cred, webhookUrl: urlDoWebhook(callId) };
  return new VoopiProvider(config);
}

/** Resumo do erro da API para a tela, sem a resposta crua da Voopi. */
function resumoDoErro(e: unknown): string {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "sem resposta a tempo";
  const status = e instanceof Error ? /\((\d{3})\)/.exec(e.message)?.[1] : undefined;
  return status ? `HTTP ${status}` : "erro de comunicação";
}

// ─── Cadastro (admin) ───────────────────────────────────────────────────────

/**
 * Estado da integração (sem a senha). A tela de Integrações (admin) usa tudo;
 * para os outros papéis, a action devolve só `{ pronta, falta }`.
 */
export async function statusVoopi(): Promise<VoopiStatusDTO> {
  const row = await linhaDaVoopi();
  const cred = credencialSalvaSchema.safeParse(row?.credentials);
  const falta = [...(cred.success ? [] : ["a conta da Voopi (Integrações)"]), ...faltaNoServidor()];
  return {
    configurada: cred.success,
    pronta: cred.success && row?.status === "connected" && falta.length === 0,
    falta,
    sipHost: cred.success ? cred.data.sipHost : null,
    sipPort: cred.success ? cred.data.sipPort : null,
    sipUser: cred.success ? cred.data.sipUser : null,
    senhaSalva: cred.success,
    atualizadoEm: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/**
 * Cadastra/atualiza a conta SIP da Voopi do time. NÃO testa ligando (nunca
 * originamos ligação de teste): a 1ª ligação de verdade é o teste. Senha vazia
 * ao editar mantém a salva.
 */
export async function salvarVoopi(input: SalvarVoopiInput): Promise<VoopiStatusDTO> {
  requireCan("integrations.manage");
  const dados = salvarVoopiSchema.parse(input);
  const prisma = db();
  const existente = await linhaDaVoopi();
  const anterior = credencialSalvaSchema.safeParse(existente?.credentials);
  const sipPassword = dados.sipPassword ?? (anterior.success ? anterior.data.sipPassword : undefined);
  if (!sipPassword) throw new CallValidationError("senha da conta SIP da Voopi obrigatória");
  // A extensão do Prisma cifra `credentials` na escrita (e decifra na leitura).
  const credentials = { sipHost: dados.sipHost, sipPort: dados.sipPort, sipUser: dados.sipUser, sipPassword } satisfies CredencialVoopi;
  if (existente) {
    await prisma.integration.update({ where: { id: existente.id }, data: { credentials, status: "connected" } });
  } else {
    await prisma.integration.create({
      data: tenantData<Prisma.IntegrationUncheckedCreateInput>({ tipo: "voopi", credentials, status: "connected" }),
    });
  }
  return statusVoopi();
}

/** Remove a conta da Voopi do time (as ligações passam a ser só manuais). */
export async function removerVoopi(): Promise<void> {
  requireCan("integrations.manage");
  await db().integration.deleteMany({ where: { tipo: "voopi" } });
}

// ─── Ligar / desligar ───────────────────────────────────────────────────────

/** "Ligar pela Voopi": um contato (número dele) OU a ligação que o discador criou. */
export const ligarPelaVoopiSchema = z
  .object({
    contactId: z.string().uuid().optional(),
    callId: z.string().uuid().optional(),
    /** Qual número do contato (qualquer formato); sem ele, o válido principal. */
    phoneNumber: z.string().trim().min(1).optional(),
    /** O contato pediu para sair (opt-out) e o vendedor confirmou que liga assim mesmo. */
    confirmarOptOut: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.contactId) !== Boolean(v.callId), "informe contactId ou callId (um dos dois)");
export type LigarPelaVoopiInput = z.infer<typeof ligarPelaVoopiSchema>;

export type LigacaoVoopi = { callId: string; providerCallId: string; contactId: string; phoneNumber: string };

/**
 * O número para ligar: um dos números DO CONTATO (a Voopi é paga pelo time e
 * a ligação fica no histórico dele) e nunca um marcado como errado (§D). Sem
 * `pedido`, o válido principal.
 */
async function numeroDoContato(contactId: string, pedido?: string | null): Promise<string> {
  const idents = await db().channelIdentifier.findMany({
    where: { contactId, canal: "whatsapp" },
    orderBy: [{ invalido: "asc" }, { isPrimary: "desc" }, { createdAt: "asc" }],
    select: { valor: true, invalido: true },
  });
  if (pedido) {
    const variantes = phoneVariants(normalizePhone(pedido));
    const achado = idents.find((i) => variantes.includes(i.valor));
    if (!achado) throw new CallValidationError("o número não é deste contato");
    if (achado.invalido) throw new ContatoSemTelefoneValido(contactId, "o número foi marcado como errado");
    return achado.valor;
  }
  const valido = idents.find((i) => !i.invalido);
  if (!valido) throw new ContatoSemTelefoneValido(contactId);
  return valido.valor;
}

/** Trava de "ligando agora" por contato (clique duplo, reenvio, retry de rede). */
const TRAVA_LIGAR_MS = 30_000;
/** Ligação da Voopi em curso para o contato há menos que isto → não liga de novo. */
const EM_CURSO_MS = 2 * 60_000;
const JA_LIGANDO = "já há uma ligação saindo para este contato";

/**
 * Reserva a ligação para o contato: trava curta no Redis (SET NX) e, por
 * cima, nenhuma ligação da Voopi em curso para ele nos últimos 2 min. Redis
 * fora → segue só com a conferência no banco. Devolve a chave da trava.
 */
async function reservarContato(contactId: string, agora: Date): Promise<string | null> {
  const chave = `voopi:ligar:${getCurrentTeamId()}:${contactId}`;
  let travada: string | null = chave;
  try {
    const ok = await redisEstado().set(chave, "1", "PX", TRAVA_LIGAR_MS, "NX");
    if (ok !== "OK") throw new CallValidationError(JA_LIGANDO);
  } catch (e) {
    if (e instanceof CallValidationError) throw e;
    logger.warn({ contactId, err: e instanceof Error ? e.message : String(e) }, "[voopi] trava indisponível — só a conferência no banco");
    travada = null;
  }
  const emCurso = await db().call.count({
    where: {
      contactId,
      provider: "voopi",
      status: { in: ["ringing", "answered"] },
      createdAt: { gte: new Date(agora.getTime() - EM_CURSO_MS) },
    },
  });
  if (emCurso > 0) {
    await soltarContato(travada);
    throw new CallValidationError(JA_LIGANDO);
  }
  return travada;
}

async function soltarContato(chave: string | null): Promise<void> {
  if (!chave) return;
  await redisEstado()
    .del(chave)
    .catch(() => {});
}

/** Quem pediu para sair (opt-out) só recebe ligação com confirmação do vendedor. */
async function conferirOptOut(contactId: string, confirmado: boolean | undefined): Promise<void> {
  if (confirmado) return;
  const c = await db().contact.findUnique({ where: { id: contactId }, select: { relacionamentoStatus: true } });
  if (c?.relacionamentoStatus === "opt_out") throw new ContatoPediuParaSair(contactId);
}

/**
 * Origina a ligação pela Voopi com a credencial do time. A Call nasce (ou é
 * reservada) como `ringing` ANTES da chamada à API e vira `failed` se a Voopi
 * recusar. Dois cliques não originam duas ligações: no discador, a reserva da
 * Call (compare-and-set); pelo contato, a trava por contato.
 */
export async function ligarPelaVoopi(input: LigarPelaVoopiInput): Promise<LigacaoVoopi> {
  requireCan("calls.write");
  const prisma = db();
  const dados = ligarPelaVoopiSchema.parse(input);
  // Sem Voopi pronta: erro nomeado antes de criar qualquer coisa.
  const cred = await credencialDaVoopi();

  let call: { id: string; contactId: string; phoneNumber: string };
  let trava: string | null = null;
  if (dados.callId) {
    // Ligação que o discador criou (getNextDialerSlot): a Voopi origina ela.
    await assertOwned("call", dados.callId);
    const c = await prisma.call.findUnique({
      where: { id: dados.callId },
      select: { id: true, contactId: true, phoneNumber: true, status: true, direction: true, providerCallId: true },
    });
    if (!c) throw new CallNotFound(dados.callId);
    if (c.direction !== "outbound" || c.status !== "scheduled" || c.providerCallId) {
      throw new CallValidationError(`a ligação ${c.id} já foi iniciada`);
    }
    await conferirOptOut(c.contactId, dados.confirmarOptOut);
    await numeroDoContato(c.contactId, c.phoneNumber);
    // Reserva (compare-and-set): o segundo clique não acha mais `scheduled`.
    const { count } = await prisma.call.updateMany({
      where: { id: c.id, status: "scheduled", providerCallId: null },
      data: { provider: "voopi", status: "ringing" },
    });
    if (count !== 1) throw new CallValidationError(`a ligação ${c.id} já foi iniciada`);
    call = c;
  } else {
    const contactId = dados.contactId!;
    await assertOwned("contact", contactId);
    await conferirOptOut(contactId, dados.confirmarOptOut);
    const numero = await numeroDoContato(contactId, dados.phoneNumber);
    trava = await reservarContato(contactId, new Date());
    try {
      const c = await createCall({ contactId, phoneNumber: numero, direction: "outbound", provider: "voopi" });
      await prisma.call.update({ where: { id: c.id }, data: { status: "ringing" } });
      call = c;
    } catch (e) {
      await soltarContato(trava);
      throw e;
    }
  }

  let providerCallId: string;
  try {
    ({ providerCallId } = await provedor(cred, call.id).makeCall({ to: call.phoneNumber }));
  } catch (e) {
    logger.warn({ callId: call.id, err: e instanceof Error ? e.message : String(e) }, "[voopi] falha ao originar a ligação");
    await prisma.call.updateMany({
      where: { id: call.id, providerCallId: null },
      data: { status: "failed", notes: "A Voopi não originou a ligação." },
    });
    // Não saiu: o vendedor pode tentar de novo na hora.
    await soltarContato(trava);
    throw new VoopiFalhou("ligar", resumoDoErro(e));
  }
  // O webhook pode ter chegado antes (pelo `ref`) e já gravado o id.
  await prisma.call.updateMany({ where: { id: call.id, providerCallId: null }, data: { providerCallId } });
  logger.info({ callId: call.id, providerCallId }, "[voopi] ligação originada");
  return { callId: call.id, providerCallId, contactId: call.contactId, phoneNumber: call.phoneNumber };
}

/** Desliga uma ligação da Voopi em curso (o fim chega pelo webhook). */
export async function desligarPelaVoopi(callId: string): Promise<void> {
  requireCan("calls.write");
  // F3: só desliga a ligação de quem ligou (master/admin/"ver tudo": qualquer uma).
  const call = await db().call.findFirst({ where: { AND: [{ id: callId }, escopoLigacao({ escrita: true })] }, select: { id: true, provider: true, providerCallId: true } });
  if (!call) throw new CallNotFound(callId);
  if (call.provider !== "voopi" || !call.providerCallId) throw new CallValidationError("a ligação não está na Voopi");
  const cred = await credencialDaVoopi();
  try {
    await provedor(cred, call.id).hangup(call.providerCallId);
  } catch (e) {
    logger.warn({ callId, err: e instanceof Error ? e.message : String(e) }, "[voopi] falha ao desligar");
    throw new VoopiFalhou("desligar", resumoDoErro(e));
  }
}
