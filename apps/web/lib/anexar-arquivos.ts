/**
 * Regras puras de "anexar arquivo" nas Conversas (sem DOM: o vitest do web roda
 * sem jsdom). Servem ao clipe, ao arrastar e soltar e ao colar da área de
 * transferência, para os três caminhos validarem e escolherem o tipo do mesmo
 * jeito. O servidor continua sendo a autoridade (`assertMediaAllowed` em
 * `packages/core/src/storage/media-policy.ts`); aqui é só o aviso rápido, antes
 * de subir o arquivo.
 */

/** Teto de um anexo. Espelho de `MAX_MEDIA_BYTES` do core (o teste confere os dois). */
export const MAX_ANEXO_BYTES = 25 * 1024 * 1024;

/** Filtro do seletor de arquivos do clipe (o arrastar e soltar não passa por ele). */
export const ANEXO_ACCEPT = "image/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt";

/** Quantos arquivos entram por vez. O clipe sempre aceitou um só. */
export const MAX_ANEXOS_POR_VEZ = 1;

export type TipoAnexo = "image" | "audio" | "doc";

/** Mesma escolha que o servidor faz (`mediaTypeFromMime`): imagem, áudio ou documento. */
export function tipoDoAnexo(mime: string): TipoAnexo {
  const m = mime.trim().toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  return "doc";
}

/** Tipo base, sem parâmetros: "audio/ogg; codecs=opus" vira "audio/ogg". */
function tipoBase(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** Tipos exatos aceitos além de `image/*` e `audio/*`. Espelho do core. */
const MIME_EXATOS: ReadonlySet<string> = new Set([
  "video/mp4",
  "application/pdf",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

/** O servidor aceita este tipo? (SVG fica de fora de propósito: pode levar script.) */
export function tipoAceito(mime: string): boolean {
  const b = tipoBase(mime);
  if (!b) return false;
  if (b.startsWith("image/")) return b !== "image/svg+xml";
  if (b.startsWith("audio/")) return true;
  return MIME_EXATOS.has(b);
}

/**
 * O arraste carrega arquivos? Só `dataTransfer.types` contendo "Files" conta:
 * arrastar texto selecionado ou um link (types "text/plain", "text/uri-list")
 * NÃO é arquivo e não pode ser interceptado (senão quebra soltar texto no campo
 * e a seleção de texto). Aceita array e `DOMStringList` (navegador antigo).
 */
export function arrasteTemArquivos(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types).includes("Files");
}

/** Eventos que mexem no contador de arraste (ver `contadorDeArraste`). */
export type EventoArraste = "entrou" | "saiu" | "soltou" | "reiniciar";

/**
 * Contador do arraste. `dragenter`/`dragleave` disparam também ao passar por
 * cada elemento filho; contar entradas e saídas evita a sobreposição piscar
 * (some só quando o contador volta a zero). Nunca fica negativo.
 */
export function contadorDeArraste(atual: number, evento: EventoArraste): number {
  if (evento === "entrou") return atual + 1;
  if (evento === "saiu") return Math.max(0, atual - 1);
  return 0;
}

/** O que a validação precisa saber de um arquivo (um `File` serve). */
export type ArquivoInfo = { name: string; type: string; size: number };

export type ResultadoAnexos<T extends ArquivoInfo> = { ok: true; arquivo: T } | { ok: false; erro: string };

const TIPOS_ACEITOS_TEXTO = "Envie imagem, áudio, PDF ou documento do Office.";

/** Nome curto para mensagem: arquivo de nome enorme não pode estourar o aviso. */
function nomeCurto(nome: string): string {
  const n = nome.trim() || "arquivo";
  return n.length > 40 ? `${n.slice(0, 37)}...` : n;
}

/**
 * Confere a lista de arquivos contra os limites do clipe: um por vez, não vazio,
 * até 25 MB e de um tipo que o servidor aceita. Devolve o arquivo a enviar ou a
 * frase pronta para a pessoa (curta, em português). Lista vazia = `erro` vazio
 * (nada a fazer, sem aviso).
 */
export function validarAnexos<T extends ArquivoInfo>(arquivos: readonly T[]): ResultadoAnexos<T> {
  if (arquivos.length === 0) return { ok: false, erro: "" };
  if (arquivos.length > MAX_ANEXOS_POR_VEZ) {
    return { ok: false, erro: `Anexe um arquivo por vez. Vieram ${arquivos.length}.` };
  }
  const arquivo = arquivos[0]!;
  const nome = nomeCurto(arquivo.name);
  if (!arquivo.size || arquivo.size <= 0) return { ok: false, erro: `“${nome}” está vazio.` };
  if (arquivo.size > MAX_ANEXO_BYTES) return { ok: false, erro: `“${nome}” passa de 25 MB.` };
  if (!tipoAceito(arquivo.type)) {
    return { ok: false, erro: `Não dá para enviar “${nome}”. ${TIPOS_ACEITOS_TEXTO}` };
  }
  return { ok: true, arquivo };
}

/**
 * Arquivos de um Ctrl+V. Só conta quando a área de transferência traz arquivo e
 * NENHUM texto: print de tela e imagem copiada chegam só como imagem, mas copiar
 * células do Excel ou trecho do Word traz texto E uma imagem do trecho, e ali o
 * que se quer colar é o texto (segue o comportamento normal do campo).
 */
export function arquivosColados<T>(arquivos: readonly T[], textoPlano: string): T[] {
  if (arquivos.length === 0) return [];
  if (textoPlano.trim() !== "") return [];
  return [...arquivos];
}
