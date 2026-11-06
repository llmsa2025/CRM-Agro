/**
 * Regras puras da tela "Receber sem senha" (ficha E5). Sem "use client" e sem
 * importar valor do `@crmagro/core`: o diálogo (cliente) e o teste usam isto direto.
 */

const HOSTS_DO_GOOGLE = new Set(["mail-settings.google.com", "mail.google.com"]);
const CAMINHO_DE_CONFIRMACAO = /^\/mail(\/u\/\d+)?\/vf-/;

/**
 * O link de confirmar o encaminhamento só aparece na tela se for mesmo do Google:
 * `https`, host EXATO do Google e caminho `vf-` (o `uf-` cancela o pedido). Espelha
 * `linkDeConfirmacaoDoGmail` do core (E3): o core já filtra ao guardar, e aqui se
 * confere de novo antes de pôr o link num `<a>`.
 */
export function linkDeConfirmacaoExibivel(link: string | null): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.protocol === "https:" && HOSTS_DO_GOOGLE.has(url.hostname) && CAMINHO_DE_CONFIRMACAO.test(url.pathname)) {
      return link;
    }
  } catch {
    // não é URL
  }
  return null;
}

/** O estado do recebimento de uma caixa: o do core, ou `sem_endereco` quando o endereço ainda não foi gerado. */
export type EstadoDoRecebimento = "sem_endereco" | "aguardando_confirmacao" | "confirmar" | "funcionando" | "sem_email_recente";

/**
 * A tela de encaminhamento do Gmail. Com o e-mail da caixa, o Google abre na conta certa mesmo com várias
 * contas abertas no navegador (`authuser`); sem ele, na primeira conta aberta (`u/0`).
 */
export function urlDoEncaminhamentoDoGmail(conta: string | null): string {
  const tela = "tab=rm&ogbl#settings/fwdandpop";
  if (conta && /^[^\s@/?#&]+@[^\s@/?#&]+\.[^\s@/?#&]+$/.test(conta)) {
    return `https://mail.google.com/mail/?authuser=${encodeURIComponent(conta)}&${tela}`;
  }
  return `https://mail.google.com/mail/u/0/?${tela}`;
}

/** Os quatro passos do assistente "Receber e-mails sem senha". O endereço já vem gerado no primeiro. */
export type PassoDoAssistente = 1 | 2 | 3 | 4;
export const PASSOS_DO_ASSISTENTE_TOTAL = 4;
export const TITULOS_DOS_PASSOS: readonly string[] = ["Adicionar no Gmail", "Confirmar o pedido", "Ligar o encaminhamento", "Pronto"];

type BaseDoPasso = { endereco: string | null; estado: EstadoDoRecebimento } | null;

/** Em que passo o assistente abre, pelo que o servidor já sabe (quem fecha e volta não recomeça do zero). */
export function passoInicialDoAssistente(dto: BaseDoPasso): PassoDoAssistente {
  if (!dto?.endereco) return 1;
  if (dto.estado === "funcionando" || dto.estado === "sem_email_recente") return 4;
  if (dto.estado === "confirmar") return 2;
  return 1;
}

/**
 * Quando o servidor avança sozinho, o assistente acompanha, e nunca volta: o pedido do Google chegou
 * (sai do passo de adicionar para o de confirmar) ou o primeiro e-mail chegou (vai ao fim).
 */
export function passoAposAtualizacao(atual: PassoDoAssistente, dto: BaseDoPasso): PassoDoAssistente {
  if (!dto?.endereco) return atual;
  if (dto.estado === "funcionando") return 4;
  if (dto.estado === "confirmar" && atual <= 1) return 2;
  return atual;
}

/**
 * O que a linha da caixa do Gmail sem senha diz sobre o recebimento das respostas. `ok`: funcionando,
 * sem nada a fazer (a pessoa nem precisa abrir o assistente). `attention`: falta algo, e o `assistente`
 * diz que vale oferecer o botão que abre o passo a passo. `null` = nada a dizer (o estado não veio).
 */
export type LinhaDoRecebimento = { tone: "ok" | "attention"; texto: string; assistente: boolean };

export function linhaDoRecebimento(estado: EstadoDoRecebimento | undefined): LinhaDoRecebimento | null {
  if (estado === "funcionando") return { tone: "ok", texto: "Funcionando. Recebe e envia e-mails.", assistente: false };
  const aviso = avisoDoRecebimento(estado);
  return aviso ? { tone: "attention", texto: aviso, assistente: true } : null;
}

/**
 * O que a linha da caixa do Gmail sem senha diz enquanto o recebimento das respostas não está
 * funcionando. `null` = nada a dizer (funcionando, ou o estado não veio).
 */
export function avisoDoRecebimento(estado: EstadoDoRecebimento | undefined): string | null {
  switch (estado) {
    case "sem_endereco":
      return "Envia pelo Gmail. Falta ligar o recebimento das respostas.";
    case "aguardando_confirmacao":
      return "Falta adicionar o endereço de encaminhamento no Gmail.";
    case "confirmar":
      return "Falta terminar o encaminhamento no Gmail.";
    case "sem_email_recente":
      return "Nenhum e-mail chegou há mais de 3 dias. Confira se o encaminhamento continua ligado.";
    default:
      return null;
  }
}

/** Ainda falta o primeiro e-mail chegar (o Google ainda não confirmou ou o encaminhamento ainda não ligou). */
export function recebimentoEmAndamento(estados: Iterable<EstadoDoRecebimento>): boolean {
  for (const e of estados) if (e === "aguardando_confirmacao" || e === "confirmar") return true;
  return false;
}

/**
 * Qual caixa abre o passo a passo do recebimento sozinha: a que acabou de ser conectada pelo Gmail
 * (a volta do Google com `?google=gmail-conectado`). É a caixa `gmail_api` da própria pessoa; sem
 * saber quem é, só vale se houver uma única. `null` = não abre nenhuma.
 */
export function caixaParaAbrirRecebimento(
  google: string | null,
  contas: { id: string; canal: string; provider: string; ownerId: string | null }[],
  userId: string | null,
): string | null {
  if (google !== "gmail-conectado") return null;
  const gmail = contas.filter((c) => c.canal === "email" && c.provider === "gmail_api");
  // Sabendo quem é a pessoa, só a caixa DELA (o administrador também vê as dos outros, e não abre a de ninguém).
  if (userId) return gmail.find((c) => c.ownerId === userId)?.id ?? null;
  return gmail.length === 1 ? gmail[0]!.id : null;
}

/** Quanto tempo o diálogo continua perguntando se o Google já confirmou (depois, a pessoa reabre). */
const LIMITE_DO_POLLING_MS = 10 * 60_000;

/** Só pergunta de novo enquanto falta a confirmação e faz menos de 10 minutos que o diálogo abriu. */
export function deveContinuarPerguntando(estado: string, desdeMs: number, agoraMs: number): boolean {
  return (estado === "aguardando_confirmacao" || estado === "confirmar") && agoraMs - desdeMs < LIMITE_DO_POLLING_MS;
}

/** Dias inteiros desde o último e-mail recebido, ou `null` se nunca chegou (ou a data não vale). */
export function diasSemEmail(ultimoRecebidoEm: string | null, agoraMs: number): number | null {
  if (!ultimoRecebidoEm) return null;
  const desde = Date.parse(ultimoRecebidoEm);
  if (Number.isNaN(desde)) return null;
  return Math.max(0, Math.floor((agoraMs - desde) / 86_400_000));
}

/**
 * Mensagem de tela para o erro de uma action. NUNCA a mensagem crua do core: ela traz o
 * id da caixa. Só o nome do erro decide o texto.
 */
export function mensagemDoErroDeEncaminhamento(nome: string): string {
  if (nome === "OwnedNotFound" || nome === "ForbiddenError") {
    return "Só o dono da caixa ou um administrador pode ligar o recebimento sem senha.";
  }
  if (nome === "EntradaDeEmailDesligada") return "O recebimento sem senha não está ligado neste servidor.";
  return "Não deu para concluir agora. Tente de novo em instantes.";
}
