import { createHash } from "node:crypto";
import { env, remetenteDaPlataforma, type RemetentePlataforma } from "@crmagro/config";
import { EmailProvider, type SmtpConfig } from "@crmagro/channels";
import { logger } from "../logger/index";
import { peekRateLimit, rateLimit } from "../rate-limit/service";
import { redisEstado } from "../shared/redis-cache";
import { caixaDoEmail, ehEmailSimples } from "./endereco";
import type { RodapeDeResposta } from "./modelos";

/**
 * Remetente da PLATAFORMA — `CRM Agro <noreply@crmagro.example>` (auditoria S-05).
 *
 * Os e-mails do sistema (redefinir senha, convite de equipe, alerta de saúde)
 * saem daqui, e não da caixa de e-mail de uma pessoa do time: antes, o link de
 * "esqueci a senha" do master saía pela caixa mais antiga do time, e quem era
 * dono dela via o link em "Enviados".
 *
 * SMTP genérico por variável de ambiente (PLATFORM_SMTP_*): Resend, Amazon SES,
 * Brevo ou Postmark mudando só o .env. Usa o mesmo `EmailProvider` (nodemailer)
 * das caixas conectadas. Nunca registra Activity nem mexe no inbox: é aviso de
 * sistema, não conversa com contato.
 *
 * Passo a passo de DNS e credenciais: a documentação interna.
 */

/**
 * `Auto-Submitted` (RFC 3834): e-mail automático. Resposta automática ("estou
 * de férias") e regra de encaminhamento do destinatário não respondem a ele.
 */
const CABECALHOS: Record<string, string> = { "Auto-Submitted": "auto-generated" };

/**
 * Credenciais do remetente da plataforma, lidas do env A CADA CHAMADA (o
 * teste liga e desliga). `null` = desligado OU inválido (`estadoDaPlataforma`
 * diz qual). Validação e porta/TLS: `remetenteDaPlataforma` (@crmagro/config).
 *
 * Porta e TLS: sem PORT, 465 com TLS direto (o padrão do Resend); SECURE=false
 * sem PORT = 587 com STARTTLS OBRIGATÓRIO (`requireTLS`: sem ele, um downgrade
 * no caminho entregaria a chave e os links de reset em claro). Sem SECURE, é
 * TLS direto nas portas 465 e 2465.
 */
export function configDaPlataforma(): SmtpConfig | null {
  const r = remetenteDaPlataforma(env);
  if (r.estado !== "ok") return null;
  return {
    host: r.host,
    port: r.port,
    secure: r.secure,
    ...(r.secure ? {} : { requireTLS: true }),
    user: r.user,
    pass: r.pass,
    from: r.from,
    ...(r.replyTo ? { replyTo: r.replyTo } : {}),
    headers: CABECALHOS,
    // Um destinatário por envio, nunca lista nem grupo (ver `enviarEmailDaPlataforma`).
    destinatarioUnico: true,
  };
}

/** Estado do remetente: desligado, inválido (com os problemas) ou ok. */
export function estadoDaPlataforma(): RemetentePlataforma {
  return remetenteDaPlataforma(env);
}

/**
 * O remetente da plataforma está LIGADO? Qualquer PLATFORM_* no .env conta,
 * mesmo com erro: aí o e-mail de sistema é recusado, e nunca cai na caixa do
 * time (S-05). Só "nenhuma PLATFORM_*" volta ao legado.
 */
export function plataformaConfigurada(): boolean {
  return estadoDaPlataforma().estado !== "desligado";
}

/**
 * Linha do rodapé sobre responder, conforme a via do e-mail de sistema:
 * plataforma sem reply-to = "não responda"; com reply-to = "responda"; sem a
 * plataforma (legado, caixa de uma pessoa do time) = nenhuma das duas.
 */
export function rodapeDeResposta(): RodapeDeResposta {
  const r = estadoDaPlataforma();
  if (r.estado === "desligado") return "omitir";
  return r.estado === "ok" && r.replyTo ? "responda" : "nao-responda";
}

/** Remetente com PLATFORM_* incompleto ou malformado: nada é enviado (e não cai na caixa do time). */
export class RemetenteInvalido extends Error {
  constructor(problemas: string[]) {
    super(`RemetenteInvalido: remetente da plataforma inválido (${problemas.join("; ")}); corrija o .env`);
    this.name = "RemetenteInvalido";
  }
}

/**
 * E-mail mascarado para log: `lu***@gmail.com`. O log nunca guarda o endereço
 * inteiro (LGPD) nem o corpo do e-mail (o link de reset é uma credencial).
 */
export function mascararEmail(email: string): string {
  const [local = "", dominio = ""] = email.trim().split("@");
  if (!local || !dominio) return "***";
  const visivel = local.length > 3 ? local.slice(0, 2) : local.slice(0, 1);
  return `${visivel}***@${dominio.toLowerCase()}`;
}

/**
 * Troca todo endereço de e-mail de um texto pela versão mascarada. A mensagem
 * do nodemailer numa recusa costuma trazer a resposta do servidor com o
 * endereço inteiro ("550 5.1.1 <fulano@empresa.com>: Recipient address
 * rejected"): sem isto, o log gravaria o endereço que `mascararEmail` protege.
 */
export function mascararEmailsNoTexto(texto: string): string {
  return texto.replace(/[^\s<>"'(),;:[\]]+@[^\s<>"'(),;:[\]]+\.[^\s<>"'(),;:[\]]+/g, (m) => mascararEmail(m));
}

/** Mensagem de um erro pronta para o log: sem endereço de e-mail inteiro. */
export function erroParaLog(e: unknown): string {
  return mascararEmailsNoTexto(e instanceof Error ? e.message : String(e));
}

/** O `to` não é UM endereço simples: nada é enviado. */
export class DestinatarioInvalido extends Error {
  constructor() {
    super("DestinatarioInvalido: o e-mail da plataforma vai para UM endereço simples (sem lista, nome ou grupo)");
    this.name = "DestinatarioInvalido";
  }
}

/**
 * Tipo do e-mail de sistema: cada um tem o seu teto no orçamento diário (um
 * tipo não gasta a cota do outro; o reset fica com o que sobrar).
 */
export type TipoDeEmailDaPlataforma = "reset" | "convite" | "alerta" | "teste" | "cadastro";

export type EmailDaPlataforma = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  tipo: TipoDeEmailDaPlataforma;
};

// ─── Orçamento de envio ───────────────────────────────────────────────────────
//
// A cota do provedor (Resend Free: 100/dia, dia UTC) é UMA para a plataforma
// inteira. Sem teto aqui, um time (30 convites/h cada, e qualquer conta Google
// cria um time) ou um anônimo no "esqueci a senha" esgotava a cota, e o reset
// e o alerta paravam para TODOS até a virada do dia. Três travas, no Redis:
// - por DESTINATÁRIO: poucos por hora para a mesma CAIXA (`caixaDoEmail`:
//   `fulano+1@` e `f.ulano@gmail.com` contam como `fulano@gmail.com`);
// - por TIPO, por dia: convite até 45%, cadastro (confirmação de e-mail e o
//   aviso "alguém tentou criar conta com o seu e-mail") até 30% e alerta até
//   1/6 do teto diário;
// - por DIA, a plataforma toda: PLATFORM_EMAIL_LIMITE_DIA (padrão 90).
// Janela fixa alinhada ao dia UTC (a mesma virada do Resend). Redis fora =
// permite (fail-open, como o `rateLimit`). Bater no teto de um tipo ou no do
// dia avisa a operação (Web Push, 1× por dia); `cabeEmailDaPlataforma` deixa a
// porta pública (cadastro) consultar antes de prometer um e-mail.

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
/** E-mails da plataforma para o MESMO endereço por hora (qualquer tipo). */
export const EMAILS_POR_DESTINATARIO_POR_HORA = 6;

/** Teto diário de um tipo, dado o teto diário da plataforma. */
export function tetoDiarioDoTipo(tipo: TipoDeEmailDaPlataforma, limiteDia: number): number {
  if (tipo === "alerta") return Math.max(1, Math.floor(limiteDia / 6));
  if (tipo === "convite") return Math.max(1, Math.floor(limiteDia * 0.45));
  // Cadastro é porta PÚBLICA (sem conta): um robô de cadastros não pode levar a
  // cota do reset e do alerta junto.
  if (tipo === "cadastro") return Math.max(1, Math.floor(limiteDia * 0.3));
  return limiteDia; // reset e teste: o que sobrar do dia
}

/** Passou de um teto do orçamento: nada foi enviado. */
export class LimiteDaPlataforma extends Error {
  constructor(public readonly motivo: "destinatario" | "tipo" | "dia") {
    super(`LimiteDaPlataforma: limite de e-mails da plataforma atingido (${motivo})`);
    this.name = "LimiteDaPlataforma";
  }
}

const CHAVE_DO_DIA = "email-plataforma:dia";
const chaveDoTipo = (tipo: TipoDeEmailDaPlataforma) => `email-plataforma:tipo:${tipo}`;

/** Consome 1 do orçamento (destinatário → tipo → dia) ou lança `LimiteDaPlataforma`. */
async function reservarEnvio(tipo: TipoDeEmailDaPlataforma, to: string, limiteDia: number): Promise<void> {
  const destinatario = createHash("sha256").update(caixaDoEmail(to)).digest("hex").slice(0, 32);
  if (!(await rateLimit(`email-plataforma:para:${destinatario}`, EMAILS_POR_DESTINATARIO_POR_HORA, HORA_MS)).allowed) {
    throw new LimiteDaPlataforma("destinatario");
  }
  const tetoDoTipo = tetoDiarioDoTipo(tipo, limiteDia);
  if (!(await rateLimit(chaveDoTipo(tipo), tetoDoTipo, DIA_MS)).allowed) {
    void avisarTetoAtingido(tipo, "tipo", tetoDoTipo);
    throw new LimiteDaPlataforma("tipo");
  }
  const dia = await rateLimit(CHAVE_DO_DIA, limiteDia, DIA_MS);
  if (!dia.allowed) {
    void avisarTetoAtingido(tipo, "dia", limiteDia);
    throw new LimiteDaPlataforma("dia");
  }
  const usados = limiteDia - dia.remaining;
  if (usados >= Math.ceil(limiteDia * 0.8)) void avisarCotaPerto(usados, limiteDia);
}

/**
 * Ainda cabe UM e-mail deste tipo hoje? Consulta SEM gastar o teto do tipo e
 * o do dia (as mesmas chaves de `reservarEnvio`). É estado GLOBAL: não diz
 * nada sobre um destinatário — a porta pública (cadastro) pode responder
 * "indisponível agora" a todos sem revelar se um e-mail tem conta. Remetente
 * desligado ou inválido = não cabe. `falhaFecha`: Redis fora = não cabe.
 * (Corrida: dois pedidos ao mesmo tempo com 1 vaga passam os dois aqui; um
 * deles esbarra no `reservarEnvio` — o chamador trata a falha do envio.)
 */
export async function cabeEmailDaPlataforma(tipo: TipoDeEmailDaPlataforma, opts: { falhaFecha?: boolean } = {}): Promise<boolean> {
  const estado = estadoDaPlataforma();
  if (estado.estado !== "ok") return false;
  const [doTipo, doDia] = await Promise.all([
    peekRateLimit(chaveDoTipo(tipo), tetoDiarioDoTipo(tipo, estado.limiteDia), DIA_MS, opts),
    peekRateLimit(CHAVE_DO_DIA, estado.limiteDia, DIA_MS, opts),
  ]);
  return doTipo.allowed && doDia.allowed;
}

/**
 * Bateu no teto de um tipo (ou no do dia): avisa a operação UMA vez por dia
 * por teto (log + Web Push do ALERT_TEAM_ID). Sem isto, o cadastro com senha
 * sumia da tela e o reset parava sem ninguém ficar sabendo.
 */
async function avisarTetoAtingido(tipo: TipoDeEmailDaPlataforma, motivo: "tipo" | "dia", teto: number): Promise<void> {
  try {
    const dia = Math.floor(Date.now() / DIA_MS);
    const qual = motivo === "dia" ? "dia" : `tipo:${tipo}`;
    const primeira = await redisEstado().set(`email-plataforma:teto:${qual}:${dia}`, "1", "EX", 26 * 60 * 60, "NX");
    if (!primeira) return;
    logger.warn({ tipo, motivo, teto }, "[email-plataforma] teto de e-mails atingido");
    const efeito =
      motivo === "dia"
        ? "Nenhum e-mail da plataforma sai até as 21h (virada do dia UTC)."
        : tipo === "cadastro"
          ? "A opção \"Registrar com e-mail\" sumiu da tela até as 21h. Se for abuso, CADASTRO_EMPRESA_SENHA=off."
          : `E-mails do tipo "${tipo}" param até as 21h.`;
    const { pushParaOperacao } = await import("../health/alerta");
    await pushParaOperacao(
      motivo === "dia" ? "CRM Agro: teto diário de e-mails atingido" : `CRM Agro: teto de e-mails de ${tipo} atingido`,
      `${teto} e-mails ${motivo === "dia" ? "no dia" : `de ${tipo} no dia`}. ${efeito}`,
    );
  } catch (e) {
    logger.warn({ err: erroParaLog(e) }, "[email-plataforma] aviso de teto não saiu");
  }
}

/** 80% do teto diário: avisa a operação UMA vez por dia (log + Web Push do ALERT_TEAM_ID). */
async function avisarCotaPerto(usados: number, limiteDia: number): Promise<void> {
  try {
    const dia = Math.floor(Date.now() / DIA_MS);
    const primeira = await redisEstado().set(`email-plataforma:aviso80:${dia}`, "1", "EX", 26 * 60 * 60, "NX");
    if (!primeira) return;
    logger.warn({ usados, limiteDia }, "[email-plataforma] 80% do teto diário de e-mails usado");
    // Import tardio: o alerta importa este arquivo (e o push só pesa aqui).
    const { pushParaOperacao } = await import("../health/alerta");
    await pushParaOperacao(
      "CRM Agro: e-mails da plataforma perto do limite",
      `${usados} de ${limiteDia} e-mails de hoje (dia UTC). Passando do teto, reset, convite e alerta param até as 21h.`,
    );
  } catch (e) {
    logger.warn({ err: erroParaLog(e) }, "[email-plataforma] aviso de cota não saiu");
  }
}

/**
 * Envia UM e-mail pelo remetente da plataforma.
 * - `false`: remetente desligado (nenhuma PLATFORM_*; nada foi tentado);
 * - `true`: o servidor SMTP aceitou a mensagem;
 * - remetente inválido: LANÇA `RemetenteInvalido` (nada foi tentado);
 * - destino que não é UM endereço simples: LANÇA `DestinatarioInvalido`;
 * - passou do orçamento (destinatário, tipo ou dia): LANÇA `LimiteDaPlataforma`;
 * - falha de envio: LANÇA o erro do provider (`ChannelSendFailed`) depois de
 *   registrar no log. O chamador decide; ele nunca deve "cair" para a caixa do
 *   time quando a plataforma está ligada (S-05).
 */
export async function enviarEmailDaPlataforma(input: EmailDaPlataforma): Promise<boolean> {
  const estado = estadoDaPlataforma();
  if (estado.estado === "desligado") return false;
  if (estado.estado === "invalido") {
    logger.error({ problemas: estado.problemas, assunto: input.subject }, "[email-plataforma] remetente inválido: e-mail não enviado");
    throw new RemetenteInvalido(estado.problemas);
  }
  const cfg = configDaPlataforma()!;
  // UM endereço simples. Lista ("a@x.com,b@y.com"), nome ou texto livre viraria
  // N e-mails (furando os limites) ou phishing no cabeçalho `To:` com o SPF/DKIM
  // do CRM Agro. O chamador já valida; aqui é a trava final.
  if (!ehEmailSimples(input.to)) throw new DestinatarioInvalido();
  const para = mascararEmail(input.to);
  try {
    await reservarEnvio(input.tipo, input.to, estado.limiteDia);
  } catch (e) {
    logger.warn({ para, tipo: input.tipo, motivo: (e as LimiteDaPlataforma).motivo }, "[email-plataforma] limite de envio: e-mail não enviado");
    throw e;
  }
  try {
    const { providerMessageId } = await new EmailProvider(cfg).send({
      to: input.to,
      content: { subject: input.subject, text: input.text, ...(input.html ? { html: input.html } : {}) },
    });
    logger.info({ para, assunto: input.subject, providerMessageId, smtp: cfg.host }, "[email-plataforma] enviado");
    return true;
  } catch (e) {
    const err = e as { outcome?: string; status?: number };
    logger.error(
      { para, assunto: input.subject, smtp: cfg.host, err: erroParaLog(e), outcome: err?.outcome, status: err?.status },
      "[email-plataforma] falha no envio",
    );
    throw e;
  }
}
