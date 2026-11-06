/**
 * Detecção de bloqueio do Google (item 3.2, INT-11). Quando o IP do servidor
 * cai em "tráfego incomum", o Google redireciona para `/sorry/` ou mostra um
 * captcha — e o lote voltava vazio, dado como "concluído", com 0 leads e sem
 * explicação. Agora o scraper para e o job falha com o motivo visível.
 *
 * Puro: recebe a URL e o TEXTO VISÍVEL da página (innerText, não o HTML — o
 * HTML traz scripts com "recaptcha" em página normal).
 */

export type BloqueioGoogle = "sorry" | "trafego_incomum" | "captcha";

const TRAFEGO_INCOMUM =
  /unusual traffic|tr[áa]fego incomum|nossos sistemas detectaram|our systems have detected|sistemas detectaram um tr[áa]fego/i;
const CAPTCHA = /n[ãa]o sou um rob[ôo]|i'?m not a robot|i am not a robot|verifica[çc][ãa]o de seguran[çc]a do google/i;

export function detectarBloqueioGoogle(p: {
  url: string;
  texto?: string | null;
  /** Há um formulário/iframe de captcha no DOM (o worker confere o seletor). */
  temCaptcha?: boolean;
}): BloqueioGoogle | null {
  let caminho = "";
  try {
    caminho = new URL(p.url).pathname;
  } catch {
    caminho = p.url;
  }
  if (/^\/sorry(\/|$)/i.test(caminho)) return "sorry";
  const texto = p.texto ?? "";
  if (TRAFEGO_INCOMUM.test(texto)) return "trafego_incomum";
  if (p.temCaptcha || CAPTCHA.test(texto)) return "captcha";
  return null;
}
