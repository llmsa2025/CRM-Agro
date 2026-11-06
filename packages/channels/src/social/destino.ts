import { ChannelSendFailed } from "../errors";

/**
 * Destino de DM social normalizado (item 1.8, INT-09). O `to` do contato vem
 * como a pessoa digitou ("@fulano", "fulano", URL do perfil). Antes o Instagram
 * buscava o texto na caixa "Nova mensagem" e clicava no PRIMEIRO resultado —
 * que nem sempre é o @ exato; agora o envio abre a página do PERFIL certo.
 *
 * Puro (sem Playwright): usado pelo motor (valida antes de gastar cota), pelo
 * provider do navegador e espelhado na extensão.
 */
export type DestinoSocial =
  | { network: "instagram"; username: string; url: string }
  | { network: "linkedin"; id: string; url: string };

// Caminhos do Instagram que não são perfil (post, reels, DM, explorar…).
const IG_RESERVADOS = new Set(["p", "reel", "reels", "explore", "direct", "accounts", "stories", "tv", "about", "legal"]);

export function normalizarDestinoSocial(network: string, to: string): DestinoSocial | null {
  const bruto = (to ?? "").trim();
  if (!bruto) return null;
  if (network === "instagram") {
    let u = bruto;
    const url = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)/i.exec(u);
    if (url) u = url[1]!;
    u = u.replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(u) || IG_RESERVADOS.has(u)) return null;
    return { network: "instagram", username: u, url: `https://www.instagram.com/${u}/` };
  }
  if (network === "linkedin") {
    let id = bruto;
    const url = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#]+)/i.exec(id);
    if (url) id = url[1]!;
    else if (/linkedin\.com\//i.test(id) || id.includes("/")) return null; // empresa, post, /pub/ antigo
    try {
      id = decodeURIComponent(id);
    } catch {
      return null;
    }
    id = id.replace(/^@/, "");
    if (!/^[\p{L}\p{N}_.-]{2,100}$/u.test(id)) return null;
    return { network: "linkedin", id, url: `https://www.linkedin.com/in/${encodeURIComponent(id)}/` };
  }
  return null;
}

/** Destino obrigatório: inválido é erro definitivo (não adianta repetir). */
export function exigirDestinoSocial(network: string, to: string): DestinoSocial {
  const d = normalizarDestinoSocial(network, to);
  if (!d) throw new ChannelSendFailed(`destino ${network} inválido: ${String(to).slice(0, 80)}`, "not_sent", false);
  return d;
}

/** Nome para comparação: sem acento, minúsculo, espaços simples. */
export function normalizarNome(nome: string | null | undefined): string {
  return (nome ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * O cabeçalho da conversa aberta é da pessoa do perfil? (LinkedIn: sem isto, o
 * `.first()` pegava o overlay "Mensagens" e digitava na conversa que estivesse
 * aberta.) Aceita nome contido no outro (título pode vir com sufixo/abreviado).
 */
export function mesmoDestinatario(nomeDoPerfil: string | null | undefined, tituloDaConversa: string | null | undefined): boolean {
  const a = normalizarNome(nomeDoPerfil);
  const b = normalizarNome(tituloDaConversa);
  if (a.length < 2 || b.length < 2) return false;
  return a === b || b.includes(a) || a.includes(b);
}

/**
 * Trecho do texto usado para confirmar que a bolha da mensagem apareceu na
 * conversa depois do envio: a 1ª linha não vazia, até 40 caracteres.
 */
export function trechoParaConferir(texto: string): string {
  const linha = texto.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return linha.slice(0, 40);
}
