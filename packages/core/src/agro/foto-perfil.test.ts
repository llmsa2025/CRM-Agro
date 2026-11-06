import { afterEach, describe, it, expect, vi } from "vitest";
import { baixarFotoDePerfil, tipoDaImagem, urlDeFotoPermitida } from "@crmagro/channels";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

afterEach(() => vi.unstubAllGlobals());

describe("urlDeFotoPermitida (o endereço vem de um serviço externo)", () => {
  it("aceita https do CDN do WhatsApp e da Meta", () => {
    expect(urlDeFotoPermitida("https://pps.whatsapp.net/v/t61/foto.jpg?ccb=11")?.hostname).toBe("pps.whatsapp.net");
    expect(urlDeFotoPermitida("https://scontent.xx.fbcdn.net/a.jpg")).not.toBeNull();
  });

  it("recusa http, outros hosts, rede interna, porta, usuário e lixo", () => {
    for (const u of [
      "http://pps.whatsapp.net/foto.jpg",
      "https://evil.com/foto.jpg",
      "https://whatsapp.net.evil.com/foto.jpg",
      "https://evilwhatsapp.net/foto.jpg",
      "https://127.0.0.1/foto.jpg",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/foto.jpg",
      "https://pps.whatsapp.net:8443/foto.jpg",
      "https://user:senha@pps.whatsapp.net/foto.jpg",
      "file:///etc/passwd",
      "isto não é url",
    ]) {
      expect(urlDeFotoPermitida(u), u).toBeNull();
    }
  });
});

describe("tipoDaImagem (pelo começo do arquivo, não pelo cabeçalho)", () => {
  it("reconhece JPEG, PNG e WebP; o resto não é imagem", () => {
    expect(tipoDaImagem(JPEG)).toBe("image/jpeg");
    expect(tipoDaImagem(PNG)).toBe("image/png");
    expect(tipoDaImagem(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]))).toBe("image/webp");
    expect(tipoDaImagem(Buffer.from("<html>"))).toBeNull();
    expect(tipoDaImagem(Buffer.alloc(0))).toBeNull();
  });
});

describe("baixarFotoDePerfil", () => {
  const resposta = (corpo: Buffer, init: ResponseInit = {}) => new Response(new Uint8Array(corpo), { status: 200, ...init });

  it("baixa a foto, sem seguir redirecionamento", async () => {
    const fetchFalso = vi.fn().mockResolvedValue(resposta(JPEG));
    vi.stubGlobal("fetch", fetchFalso);

    const r = await baixarFotoDePerfil("https://pps.whatsapp.net/foto.jpg");

    expect(r?.tipo).toBe("image/jpeg");
    expect(r?.bytes.equals(JPEG)).toBe(true);
    expect(fetchFalso.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("não chama a rede para endereço fora da lista", async () => {
    const fetchFalso = vi.fn();
    vi.stubGlobal("fetch", fetchFalso);
    expect(await baixarFotoDePerfil("https://evil.com/foto.jpg")).toBeNull();
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("devolve null quando o CDN recusa, a resposta não é imagem ou passa de 2 MB", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(Buffer.from("x"), { status: 403 })));
    expect(await baixarFotoDePerfil("https://pps.whatsapp.net/a.jpg")).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(Buffer.from("<html>nao sou imagem</html>"))));
    expect(await baixarFotoDePerfil("https://pps.whatsapp.net/a.jpg")).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]))));
    expect(await baixarFotoDePerfil("https://pps.whatsapp.net/a.jpg")).toBeNull();
  });
});
