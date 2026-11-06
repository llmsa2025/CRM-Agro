/**
 * Regras puras do player de áudio das Conversas (sem DOM: o componente está em
 * `components/audio-player.tsx` e chama estas funções). Ficam aqui para poder
 * testar no vitest, que roda sem jsdom.
 */

/** "1:05", "0:07" e, de 1 h em diante, "1:02:03". Valor inválido vira "0:00". */
export function fmtDur(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const r = total % 60;
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A duração já é um número de verdade? (o navegador dá NaN antes dos metadados e Infinity em stream sem Range) */
export function duracaoConhecida(d: number): boolean {
  return Number.isFinite(d) && d > 0;
}

/** Rótulo do tempo total: "--:--" enquanto a duração não é conhecida (em vez de "0:00", que parece áudio vazio). */
export function rotuloDuracao(d: number): string {
  return duracaoConhecida(d) ? fmtDur(d) : "--:--";
}

/** Percentual (0–100) da barra de progresso; 0 se a duração é desconhecida. */
export function percentual(atual: number, total: number): number {
  if (!duracaoConhecida(total) || !Number.isFinite(atual) || atual <= 0) return 0;
  return Math.min(100, (atual / total) * 100);
}

/**
 * Por que o áudio não toca — vira a frase mostrada no lugar da barra.
 * - rede: caiu a conexão no meio do download;
 * - decodificacao: o arquivo veio corrompido/incompleto;
 * - formato: o navegador não reproduz o formato (Safari e o OGG/Opus do WhatsApp);
 * - origem: o navegador aceita o formato, mas a URL não respondeu (link vencido,
 *   objeto apagado, Storage fora do ar — o Chrome não separa isso de "formato");
 * - generica: qualquer outra recusa.
 */
export type FalhaAudio = "rede" | "decodificacao" | "formato" | "origem" | "generica";

/**
 * `MediaError.code` → falha. `null` = não é falha do usuário (código 1: a carga
 * foi abortada por nós mesmos — troca de src, desmontar). Código 4
 * (SRC_NOT_SUPPORTED) é o que o navegador devolve para formato não suportado E
 * para resposta HTTP de erro (403/404): `formatoOk` (do `canPlayType`) desempata.
 */
export function falhaDoMediaError(codigo: number | null | undefined, formatoOk: boolean): FalhaAudio | null {
  switch (codigo) {
    case 1:
      return null;
    case 2:
      return "rede";
    case 3:
      return "decodificacao";
    case 4:
      return formatoOk ? "origem" : "formato";
    default:
      return "generica";
  }
}

/**
 * Falha do `audio.play()` (a promessa rejeitada). `AbortError` = o play foi
 * interrompido por um pause()/nova carga: não é erro. `NotSupportedError` = sem
 * fonte reproduzível (mesma coisa do código 4).
 */
export function falhaDoPlay(
  nome: string,
  codigoMedia: number | null | undefined,
  formatoOk: boolean,
): FalhaAudio | null {
  if (nome === "AbortError") return null;
  if (nome === "NotSupportedError") return falhaDoMediaError(4, formatoOk);
  if (codigoMedia) return falhaDoMediaError(codigoMedia, formatoOk);
  return "generica";
}

/** Frase (PT-BR) mostrada no lugar da barra quando o áudio falha. */
export function mensagemDaFalha(f: FalhaAudio): string {
  switch (f) {
    case "rede":
      return "A conexão caiu ao carregar o áudio.";
    case "decodificacao":
      return "O arquivo de áudio está corrompido ou incompleto.";
    case "formato":
      return "Este navegador não reproduz o formato do áudio (o WhatsApp usa OGG/Opus).";
    case "origem":
      return "Não foi possível carregar o áudio. O link pode ter vencido ou o arquivo estar inválido.";
    default:
      return "Não foi possível tocar este áudio.";
  }
}

/**
 * O navegador declara que toca este tipo? Usa o `canPlayType` do próprio
 * `<audio>`. Sem tipo informado (mensagem antiga) assume que sim: só serve para
 * escolher a frase de erro, nunca para bloquear a reprodução (um "não" errado
 * esconderia um áudio que tocaria).
 */
export function formatoTocavel(mime: string | null | undefined, canPlayType: (tipo: string) => string): boolean {
  const tipo = (mime ?? "").trim();
  if (!tipo) return true;
  if (canPlayType(tipo) !== "") return true;
  // "audio/ogg; codecs=opus" → tenta também "audio/ogg" (alguns navegadores só conhecem o contêiner).
  const base = tipo.split(";")[0]!.trim();
  return base !== tipo && base !== "" && canPlayType(base) !== "";
}

/**
 * A URL assinada da mídia muda a cada renovação (validade de 1 h; a lista de
 * mensagens é recarregada por evento e por polling). Trocar o `src` de um
 * `<audio>` recarrega o arquivo e ZERA a reprodução — o áudio que estava
 * tocando parava sozinho. Regra: só adota a URL nova quando isso não custa nada
 * (áudio parado no início) ou quando a URL atual falhou (provavelmente venceu).
 */
export function deveAdotarNovaUrl(input: {
  atual: string;
  nova: string;
  tocando: boolean;
  /** posição atual em segundos */
  posicao: number;
  comFalha: boolean;
}): boolean {
  if (!input.nova || input.nova === input.atual) return false;
  if (input.comFalha) return true;
  return !input.tocando && input.posicao <= 0;
}

/** Velocidades do botão (como no WhatsApp): normal, 1,5x e 2x. */
export const VELOCIDADES = [1, 1.5, 2] as const;
export type VelocidadeAudio = (typeof VELOCIDADES)[number];

/** Chave no localStorage: a escolha vale para todos os áudios. */
export const CHAVE_VELOCIDADE_AUDIO = "crmagro:audio:velocidade";

/** Próxima velocidade ao clicar no botão: 1x → 1,5x → 2x → 1x. Valor estranho volta ao normal. */
export function proximaVelocidade(atual: number): VelocidadeAudio {
  const i = VELOCIDADES.findIndex((v) => v === atual);
  return VELOCIDADES[(i + 1) % VELOCIDADES.length] ?? 1;
}

/** Valor lido do localStorage → velocidade. Qualquer coisa fora da lista vira 1x. */
export function velocidadeSalva(valor: unknown): VelocidadeAudio {
  const n = typeof valor === "string" ? Number(valor.replace(",", ".")) : valor;
  return VELOCIDADES.find((v) => v === n) ?? 1;
}

/** Rótulo do botão em português: "1x", "1,5x", "2x". */
export function rotuloVelocidade(v: number): string {
  return `${String(v).replace(".", ",")}x`;
}
