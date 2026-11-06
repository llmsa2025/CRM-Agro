/**
 * Ponte página <-> extensão CRM Agro Relay (lado da PÁGINA).
 *
 * A tela de Integrações → Canais fala com a extensão por `window.postMessage`:
 *
 *   página  → extensão   crmagro:ext:ping                      { id }
 *   extensão → página    crmagro:ext:pong                      { id, protocolo, versao, configurada }
 *   página  → extensão   crmagro:ext:conectar                  { id, canal, identidade }
 *   extensão → página    crmagro:ext:resultado                 { id, ok, usuario?, conectado?, aviso?, codigo? }
 *
 * Só existe resposta se a extensão (0.3.0 ou mais nova) estiver instalada e o
 * content script tiver rodado nesta página. A extensão NUNCA devolve o cookie:
 * o resultado só diz se conectou, como quem e, se falhou, um `codigo`.
 *
 * O lado da extensão (validação, códigos, allowlist de origens) está em
 * apps/extension/ponte.js; o teste de contrato confere que os dois concordam.
 * Este módulo é puro (sem React): a janela entra por parâmetro, então dá para
 * testar sem DOM.
 */

export const TIPO_PING = "crmagro:ext:ping";
export const TIPO_PONG = "crmagro:ext:pong";
export const TIPO_CONECTAR = "crmagro:ext:conectar";
export const TIPO_RESULTADO = "crmagro:ext:resultado";

export type CanalSocial = "instagram" | "linkedin";
export const CANAIS_SOCIAIS: readonly CanalSocial[] = ["instagram", "linkedin"];

/** Usuário e time da SESSÃO da página: o servidor confere com o dono do token da extensão. */
export interface IdentidadeDaPagina {
  userId: string;
  teamId: string;
}

/** Códigos que a extensão devolve (apps/extension/ponte.js: CODIGOS_ERRO) + os da própria página. */
export const CODIGOS_DA_EXTENSAO = [
  "nao_configurada",
  "sem_sessao",
  "sessao_expirada",
  "token_invalido",
  "sem_permissao",
  "conta_diferente",
  "origem_invalida",
  "crmagro_indisponivel",
  "mensagem_invalida",
  "rede_nao_suportada",
  "erro",
] as const;
/** `sem_resposta`: a página esperou e a extensão não respondeu (não existe do lado da extensão). */
export type CodigoDeErro = (typeof CODIGOS_DA_EXTENSAO)[number] | "sem_resposta";

export interface Pong {
  versao: string;
  protocolo: number;
  /** A extensão tem URL e token do CRM Agro (o download já vem configurado). */
  configurada: boolean;
}

export type ResultadoConexao =
  | { ok: true; usuario: string | null; conectado: boolean }
  | { ok: false; codigo: CodigoDeErro };

/** O que a página precisa da janela (facilita o teste sem DOM). */
export interface JanelaPonte {
  location: { origin: string };
  postMessage(mensagem: unknown, origemAlvo: string): void;
  addEventListener(tipo: "message", ouvinte: (ev: EventoDeMensagem) => void): void;
  removeEventListener(tipo: "message", ouvinte: (ev: EventoDeMensagem) => void): void;
}
export interface EventoDeMensagem {
  source: unknown;
  origin: string;
  data: unknown;
}

/** Formato do id do pedido (a extensão recusa fora disto). */
export const REGEX_ID_DE_PEDIDO = /^[A-Za-z0-9_-]{8,64}$/;

/** Id do pedido (8 a 64 caracteres [A-Za-z0-9_-]), aleatório mesmo em página sem HTTPS. */
export function novoIdDePedido(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(12);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return (Math.random().toString(36).slice(2) + Date.now().toString(36) + "00000000").slice(0, 16);
}

export function montarPing(id: string) {
  return { tipo: TIPO_PING, id };
}

export function montarConectar(id: string, canal: CanalSocial, identidade: IdentidadeDaPagina) {
  return { tipo: TIPO_CONECTAR, id, canal, identidade: { userId: identidade.userId, teamId: identidade.teamId } };
}

function ehObjeto(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

/** Resposta ao ping do MESMO pedido? Devolve o Pong ou null (mensagem alheia/malformada). */
export function interpretarPong(dados: unknown, id: string): Pong | null {
  if (!ehObjeto(dados) || dados.tipo !== TIPO_PONG || dados.id !== id) return null;
  return {
    versao: typeof dados.versao === "string" ? dados.versao : "",
    protocolo: typeof dados.protocolo === "number" ? dados.protocolo : 0,
    configurada: dados.configurada === true,
  };
}

/** Resultado do MESMO pedido? Devolve o resultado tipado ou null (mensagem alheia). */
export function interpretarResultado(dados: unknown, id: string): ResultadoConexao | null {
  if (!ehObjeto(dados) || dados.tipo !== TIPO_RESULTADO || dados.id !== id) return null;
  if (dados.ok === true) {
    return {
      ok: true,
      usuario: typeof dados.usuario === "string" && dados.usuario ? dados.usuario : null,
      conectado: dados.conectado !== false,
    };
  }
  const codigo = typeof dados.codigo === "string" ? dados.codigo : "";
  const conhecido = (CODIGOS_DA_EXTENSAO as readonly string[]).includes(codigo);
  return { ok: false, codigo: conhecido ? (codigo as CodigoDeErro) : "erro" };
}

/**
 * Manda `mensagem` e espera UMA resposta aceita por `aceitar` (que reconhece o
 * `id` do pedido). Só vale mensagem da PRÓPRIA janela e da mesma origem;
 * estourou o tempo, devolve null.
 */
function perguntar<T>(
  win: JanelaPonte,
  mensagem: unknown,
  aceitar: (dados: unknown) => T | null,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    let encerrado = false;
    const encerrar = (valor: T | null) => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(timer);
      win.removeEventListener("message", ouvinte);
      resolve(valor);
    };
    const ouvinte = (ev: EventoDeMensagem) => {
      if (ev.source !== win || ev.origin !== win.location.origin) return;
      const r = aceitar(ev.data);
      if (r !== null) encerrar(r);
    };
    const timer = setTimeout(() => encerrar(null), timeoutMs);
    win.addEventListener("message", ouvinte);
    // targetOrigin = a própria origem (nunca "*"): a mensagem não sai desta origem.
    win.postMessage(mensagem, win.location.origin);
  });
}

/** Tempo que a extensão tem para responder ao ping (ela responde na hora se estiver aí). */
export const TIMEOUT_PING_MS = 1500;
/** Tempo para conectar: lê a sessão, consulta a rede e fala com o CRM Agro (a extensão tem tetos menores). */
export const TIMEOUT_CONECTAR_MS = 45_000;

/** A extensão está instalada (e é uma versão com a ponte) nesta aba? null = não respondeu. */
export function pingarExtensao(win: JanelaPonte, timeoutMs = TIMEOUT_PING_MS): Promise<Pong | null> {
  const id = novoIdDePedido();
  return perguntar(win, montarPing(id), (d) => interpretarPong(d, id), timeoutMs);
}

/** Pede à extensão para ler a sessão do navegador e conectar a conta do usuário logado. */
export async function conectarPelaExtensao(
  win: JanelaPonte,
  canal: CanalSocial,
  identidade: IdentidadeDaPagina,
  timeoutMs = TIMEOUT_CONECTAR_MS,
): Promise<ResultadoConexao> {
  const id = novoIdDePedido();
  const r = await perguntar(win, montarConectar(id, canal, identidade), (d) => interpretarResultado(d, id), timeoutMs);
  return r ?? { ok: false, codigo: "sem_resposta" };
}

export const ROTULO_DA_REDE: Record<CanalSocial, string> = { instagram: "Instagram", linkedin: "LinkedIn" };

export interface MensagemDeResultado {
  /** "ok" conectou com o @; "aviso" conectou sem ler o @; "erro" não conectou. */
  tipo: "ok" | "aviso" | "erro";
  texto: string;
}

/** Texto do resultado para a pessoa (português, sem jargão). */
export function mensagemDoResultado(res: ResultadoConexao, canal: CanalSocial): MensagemDeResultado {
  const rede = ROTULO_DA_REDE[canal];
  if (res.ok) {
    if (res.usuario) return { tipo: "ok", texto: `Conectado como @${res.usuario}` };
    return {
      tipo: "aviso",
      texto: `Conectado, mas não consegui ler o nome do perfil. A conta ficou com o nome ${rede}. Você pode renomear depois.`,
    };
  }
  const erros: Record<CodigoDeErro, string> = {
    sem_sessao: `Você não está logado no ${rede} neste navegador. Entre na sua conta em outra aba e clique em Conectar de novo.`,
    sessao_expirada: `A sessão do ${rede} neste navegador expirou ou pede uma confirmação. Abra o ${rede} em outra aba, resolva o que ele pedir e tente de novo.`,
    nao_configurada:
      "A extensão está instalada, mas ainda não está ligada a este CRM Agro. Baixe a extensão de novo pela tela da extensão.",
    token_invalido:
      "O CRM Agro não aceitou o token da extensão (talvez tenha sido revogado). Baixe a extensão de novo e troque a pasta.",
    sem_permissao: "Seu usuário não tem permissão para conectar redes sociais. Peça a um administrador.",
    conta_diferente:
      "A extensão está ligada a outro usuário do CRM Agro. Baixe a extensão de novo, com o seu usuário logado, e troque a pasta.",
    origem_invalida: "A extensão não reconheceu este endereço do CRM Agro. Atualize a extensão.",
    crmagro_indisponivel: "A extensão não conseguiu falar com o CRM Agro agora. Tente de novo em instantes.",
    sem_resposta: "A extensão não respondeu. Recarregue esta página e tente de novo.",
    mensagem_invalida: "A extensão não entendeu o pedido. Atualize a extensão e tente de novo.",
    rede_nao_suportada: "Esta rede ainda não é suportada.",
    erro: "Não deu para conectar agora. Tente de novo.",
  };
  return { tipo: "erro", texto: erros[res.codigo] };
}
