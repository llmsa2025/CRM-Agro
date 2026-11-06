import type { Prisma } from "@prisma/client";
import { db, decryptCredentials, encryptCredentials, runAsSystem } from "@crmagro/db";
import { emailDoMime } from "@crmagro/channels";
import { logger } from "../logger/index";
import { rateLimit } from "../rate-limit/service";
import { processIncomingEmail } from "./leitura-imap";

/**
 * Processa um e-mail que chegou pelo encaminhamento do Gmail (Gmail → Cloudflare →
 * CRM Agro). O worker decide sozinho entre três caminhos:
 * - confirmação do Google → guarda só o link de confirmar (cifrado), nunca o abre;
 * - e-mail de um contato (ou resposta a e-mail nosso) → vira mensagem na conversa
 *   da caixa, pela mesma regra do IMAP (`processIncomingEmail`), sem duplicar;
 * - qualquer outro → descartado sem gravar nada do conteúdo (LGPD).
 * E-mail que não veio da caixa do vendedor é recusado e só contado.
 *
 * Não loga remetente, assunto nem texto: só ids.
 */

export type EmailEncaminhadoJob = {
  encaminhamentoId: string;
  teamId: string;
  /** Remetente do ENVELOPE (`MAIL FROM`), não o `From:` do cabeçalho. */
  envelopeDe: string;
  /** O e-mail cru (MIME) em base64. */
  rawB64: string;
  /** Ms unix de quando o e-mail chegou ao Worker do Cloudflare. */
  chegadaEm: number;
};

export type ResultadoEncaminhado =
  | "gravado"
  | "ignorado"
  | "confirmacao_google"
  | "envelope_recusado"
  | "sem_caixa"
  | "excesso"
  | "invalido";

/** Quem manda o e-mail de confirmação do encaminhamento (igualdade exata, nunca por sufixo). */
export const REMETENTE_CONFIRMACAO_GMAIL = "forwarding-noreply@google.com";

/** E-mails encaminhados aceitos por hora, por encaminhamento. */
export const TETO_POR_HORA = 300;

const HOSTS_DE_CONFIRMACAO = new Set(["mail-settings.google.com", "mail.google.com"]);
const CAMINHO_DE_CONFIRMACAO = /^\/mail(\/u\/\d+)?\/vf-/;

/**
 * O link de CONFIRMAR o encaminhamento (`vf-`) dentro do e-mail do Google, ou `null`.
 * Só vale `https` e host EXATO do Google (nada de `mail-settings.google.com.evil.io`),
 * e só o caminho `vf-`: o `uf-` cancela o pedido e nunca é aceito.
 */
export function linkDeConfirmacaoDoGmail(texto: string | null, html: string | null): string | null {
  const junto = `${texto ?? ""}\n${html ?? ""}`.replace(/&amp;/g, "&");
  for (const candidato of junto.match(/https:\/\/[^\s"'<>)]+/g) ?? []) {
    try {
      const url = new URL(candidato);
      if (url.protocol === "https:" && HOSTS_DE_CONFIRMACAO.has(url.hostname) && CAMINHO_DE_CONFIRMACAO.test(url.pathname)) {
        return candidato;
      }
    } catch {
      // candidato que não é URL: segue para o próximo
    }
  }
  return null;
}

/** `googlemail.com` é o mesmo domínio que `gmail.com`. */
const dominioCanonico = (dominio: string) => (dominio === "googlemail.com" ? "gmail.com" : dominio);

function separarEndereco(endereco: string): { local: string; dominio: string } | null {
  const i = endereco.lastIndexOf("@");
  if (i <= 0 || i === endereco.length - 1) return null;
  return { local: endereco.slice(0, i), dominio: dominioCanonico(endereco.slice(i + 1)) };
}

/** O domínio é de um servidor do próprio Google (`google.com` ou `qualquer.google.com`)? Nunca por sufixo solto. */
function dominioDeServidorDoGoogle(dominio: string): boolean {
  return dominio === "google.com" || dominio.endsWith(".google.com");
}

/**
 * O envelope do e-mail encaminhado vem do Gmail dessa caixa? Dois formatos valem:
 * - o que o Gmail usa na prática (visto em produção em 01/10/2026): o remetente do envelope é de um
 *   servidor do Google, `<10 caracteres>@mail-dl2-x0f.google.com`, sem `+caf_=`. Um endereço comum
 *   `@gmail.com` (alguém escrevendo direto para o endereço) NÃO passa por aqui;
 * - `<local>+caf_=<destino>@<domínio da caixa>` (o formato que a pesquisa indicava, gmail-sem-casa §6.5).
 *   O Gmail ignora pontos no começo do endereço (`a.na` = `ana`) e `googlemail.com` = `gmail.com`.
 *   Igualdade simples NÃO vale (o envio direto por BCC fica para a fase 2a).
 *
 * A defesa principal é o token de 128 bits do endereço; o envelope é um segundo filtro. Se o formato do
 * Google mudar, os e-mails aparecem como "recusados" na tela e o log diz por quê
 * (`resumoDoEnvelopeRecusado`).
 */
export function envelopeDaCaixa(envelopeDe: string, enderecosDaCaixa: string[]): boolean {
  const envelope = separarEndereco(envelopeDe.trim().toLowerCase());
  if (!envelope) return false;
  if (dominioDeServidorDoGoogle(envelope.dominio)) return true;
  for (const endereco of enderecosDaCaixa) {
    const caixa = separarEndereco(endereco.trim().toLowerCase());
    if (!caixa || envelope.dominio !== caixa.dominio) continue;
    const semPontos = caixa.dominio === "gmail.com";
    const localEnvelope = semPontos ? envelope.local.replace(/\./g, "") : envelope.local;
    const localCaixa = semPontos ? caixa.local.replace(/\./g, "") : caixa.local;
    if (localCaixa && localEnvelope.startsWith(`${localCaixa}+caf_=`)) return true;
  }
  return false;
}

/**
 * Por que o envelope foi recusado, SEM nenhum endereço (só domínio, tamanho e sim/não), para o log.
 * Serve para corrigir a regra se o formato do Google for outro: mostra se o domínio bate com o da
 * caixa, se veio o `+caf_=` e se o começo do endereço é o da caixa. O remetente nunca vai para o log.
 */
export function resumoDoEnvelopeRecusado(envelopeDe: string, enderecosDaCaixa: string[]) {
  const envelope = separarEndereco(envelopeDe.trim().toLowerCase());
  const caixas = enderecosDaCaixa.map((e) => separarEndereco(e.trim().toLowerCase())).filter((c) => c !== null);
  if (!envelope) return { envelopeValido: false, caixaDominios: caixas.map((c) => c.dominio) };
  const daCaixa = caixas.filter((c) => c.dominio === envelope.dominio);
  const semPontos = envelope.dominio === "gmail.com";
  const normal = (local: string) => (semPontos ? local.replace(/\./g, "") : local);
  const antesDoCaf = envelope.local.split("+caf_=")[0] ?? "";
  return {
    envelopeValido: true,
    envelopeDominio: envelope.dominio,
    temCaf: envelope.local.includes("+caf_="),
    localDoEnvelopeTamanho: antesDoCaf.length,
    caixaDominios: caixas.map((c) => c.dominio),
    mesmoDominioDaCaixa: daCaixa.length > 0,
    localIgualAoDaCaixa: daCaixa.some((c) => normal(c.local) === normal(antesDoCaf)),
    localDaCaixaTamanho: daCaixa.map((c) => c.local.length),
  };
}

/** Os endereços da caixa (`user` e `from` das credenciais), em minúsculas e sem o "Nome <…>". */
function enderecosDaCaixa(credentials: unknown): string[] {
  let cfg: { user?: unknown; from?: unknown } | null = null;
  try {
    cfg = decryptCredentials(credentials) as { user?: unknown; from?: unknown } | null;
  } catch {
    return [];
  }
  const achados = new Set<string>();
  for (const valor of [cfg?.user, cfg?.from]) {
    if (typeof valor !== "string") continue;
    const entreAngulos = /<([^<>\s]+@[^<>\s]+)>/.exec(valor)?.[1];
    const endereco = (entreAngulos ?? valor).trim().toLowerCase();
    if (endereco.includes("@")) achados.add(endereco);
  }
  return [...achados];
}

export async function processarEmailEncaminhado(job: EmailEncaminhadoJob): Promise<ResultadoEncaminhado> {
  const raw = Buffer.from(job.rawB64, "base64");
  if (raw.length === 0) return "invalido";

  return runAsSystem(job.teamId, async (): Promise<ResultadoEncaminhado> => {
    const prisma = db();
    // Duas consultas, SEM `include`: a extensão de tenancy não filtra `include`.
    const enc = await prisma.emailEncaminhamento.findFirst({
      where: { id: job.encaminhamentoId },
      select: { id: true, channelAccountId: true, confirmadoEm: true },
    });
    if (!enc) return "sem_caixa";
    const caixa = await prisma.channelAccount.findFirst({
      where: { id: enc.channelAccountId, canal: "email" },
      select: { id: true, credentials: true },
    });
    if (!caixa) return "sem_caixa";

    try {
      const limite = await rateLimit(`email-entrada:${enc.id}`, TETO_POR_HORA, 3_600_000);
      if (!limite.allowed) {
        logger.warn({ encaminhamentoId: enc.id }, "[email-entrada] teto por hora estourado, e-mail descartado");
        return "excesso";
      }
    } catch (err) {
      // O limite é uma proteção; se ele mesmo falhar, o e-mail segue (a rota já limitou a entrada).
      logger.warn({ encaminhamentoId: enc.id, err: err instanceof Error ? err.message : String(err) }, "[email-entrada] limite indisponível");
    }

    const agora = new Date();
    const chegada = new Date(Math.min(job.chegadaEm || agora.getTime(), agora.getTime()));
    const { email, html } = await emailDoMime(raw, { recebidoEm: chegada });

    // Confirmação do Google: só guarda o link. Nunca abre o link nem cria mensagem, e não
    // conta como "e-mail recebido" (nem `ultimoRecebidoEm` nem `confirmadoEm` mudam).
    if (email.from === REMETENTE_CONFIRMACAO_GMAIL) {
      const link = linkDeConfirmacaoDoGmail(email.text, html);
      await prisma.emailEncaminhamento.update({
        where: { id: enc.id },
        data: {
          confirmacaoEm: agora,
          ...(link ? { confirmacaoLink: encryptCredentials({ link }) as unknown as Prisma.InputJsonValue } : {}),
        },
      });
      return "confirmacao_google";
    }

    const enderecos = enderecosDaCaixa(caixa.credentials);
    if (!envelopeDaCaixa(job.envelopeDe, enderecos)) {
      // Recusado não mexe em `ultimoRecebidoEm`: senão o lixo esconderia o "sem e-mail recente".
      await prisma.emailEncaminhamento.update({
        where: { id: enc.id },
        data: { recusados: { increment: 1 }, ultimoRecusadoEm: agora },
      });
      logger.warn(
        { encaminhamentoId: enc.id, envelope: resumoDoEnvelopeRecusado(job.envelopeDe, enderecos) },
        "[email-entrada] envelope não é da caixa, descartado",
      );
      return "envelope_recusado";
    }

    // Envelope aprovado: só a data (nada do conteúdo) e, no 1º, a confirmação.
    await prisma.emailEncaminhamento.update({
      where: { id: enc.id },
      data: { ultimoRecebidoEm: agora, ...(enc.confirmadoEm ? {} : { confirmadoEm: agora }) },
    });

    return (await processIncomingEmail(caixa.id, email)) ? "gravado" : "ignorado";
  });
}
