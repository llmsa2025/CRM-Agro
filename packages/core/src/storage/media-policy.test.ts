import { describe, it, expect } from "vitest";
import { assertMediaAllowed, isMediaMimeAllowed, MediaNotAllowed, MAX_MEDIA_BYTES } from "./media-policy";

/** Política de mídia do upload (S10) — sem banco. */
describe("política de mídia", () => {
  it("aceita imagem, áudio (com parâmetros), mp4, pdf e Office", () => {
    for (const mime of [
      "image/jpeg",
      "image/png",
      "audio/ogg; codecs=opus",
      "audio/webm;codecs=opus",
      "video/mp4",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/msword",
    ]) {
      expect(isMediaMimeAllowed(mime), mime).toBe(true);
    }
  });

  it("recusa svg, html, executável, sem tipo e octet-stream", () => {
    for (const mime of ["image/svg+xml", "text/html", "application/x-msdownload", "", "application/octet-stream"]) {
      expect(isMediaMimeAllowed(mime), mime || "(vazio)").toBe(false);
    }
  });

  it("recusa acima de 25 MB e arquivo vazio", () => {
    expect(() => assertMediaAllowed("image/png", MAX_MEDIA_BYTES + 1)).toThrow(MediaNotAllowed);
    expect(() => assertMediaAllowed("image/png", 0)).toThrow(MediaNotAllowed);
    expect(() => assertMediaAllowed("image/png", MAX_MEDIA_BYTES)).not.toThrow();
  });
});
