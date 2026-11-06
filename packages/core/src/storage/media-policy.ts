/**
 * Política de mídia enviada pelo usuário (anexo de negócio, mídia na conversa).
 * Auditoria S10: o upload acontecia ANTES da sessão e aceitava qualquer tipo.
 * Agora a action confere posse → confere esta política → só então sobe.
 *
 * Fora da lista de propósito: `image/svg+xml` (pode carregar script), HTML,
 * executáveis e o genérico `application/octet-stream` (arquivo sem tipo).
 */

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB

/** Tipos exatos aceitos além dos prefixos `image/` e `audio/`. */
const MIME_EXATOS: ReadonlySet<string> = new Set([
  "video/mp4",
  "application/pdf",
  "text/csv",
  // Office
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // LibreOffice
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

const IMAGENS_BLOQUEADAS: ReadonlySet<string> = new Set(["image/svg+xml"]);

export class MediaNotAllowed extends Error {
  constructor(readonly motivo: "tipo" | "tamanho" | "vazio", detalhe: string) {
    super(
      motivo === "tamanho"
        ? `MediaNotAllowed: arquivo maior que 25 MB (${detalhe}).`
        : motivo === "vazio"
          ? "MediaNotAllowed: arquivo vazio."
          : `MediaNotAllowed: tipo de arquivo não aceito (${detalhe}).`,
    );
    this.name = "MediaNotAllowed";
  }
}

/** Tipo base, sem parâmetros: "audio/ogg; codecs=opus" → "audio/ogg". */
export function baseMime(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

export function isMediaMimeAllowed(mime: string): boolean {
  const b = baseMime(mime);
  if (!b) return false;
  if (b.startsWith("image/")) return !IMAGENS_BLOQUEADAS.has(b);
  if (b.startsWith("audio/")) return true;
  return MIME_EXATOS.has(b);
}

/** Lança `MediaNotAllowed` se o arquivo não pode subir. */
export function assertMediaAllowed(mime: string, size: number): void {
  if (!size || size <= 0) throw new MediaNotAllowed("vazio", "");
  if (size > MAX_MEDIA_BYTES) throw new MediaNotAllowed("tamanho", `${size} bytes`);
  if (!isMediaMimeAllowed(mime)) throw new MediaNotAllowed("tipo", baseMime(mime) || "sem tipo");
}
