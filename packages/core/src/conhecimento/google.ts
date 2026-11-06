/**
 * Documento do Google (Docs, Planilhas, Apresentações ou arquivo do Drive) pelo LINK de compartilhamento.
 *
 * Sem login e sem permissão nova na conta do Google: funciona quando o arquivo está como "Qualquer pessoa
 * com o link pode ver". É o que cobre o caso comum (manual, tabela de preços, apresentação) sem pedir acesso
 * ao Drive inteiro. Arquivo privado ganha um aviso que diz como compartilhar. Ler o Drive pela conta
 * conectada fica para depois, se fizer falta.
 *
 * Segurança (SSRF): o endereço que buscamos é MONTADO aqui a partir do id extraído do link, nunca o link
 * que a pessoa colou. Só https, só hosts do Google, redirecionamento conferido a cada salto.
 */
import { ArquivoNaoLido, CARACTERES_MAX_DOC, TAMANHO_MAX_ARQUIVO, conferirTextoExtraido, lerArquivo, type FonteDoArquivo } from "./leitor";

export type LinkDoGoogle = { tipo: "doc" | "planilha" | "apresentacao" | "arquivo"; id: string };

const ID = /^[A-Za-z0-9_-]{10,200}$/;

/** Reconhece o link e tira o tipo e o id. `null` = não é um link do Google que a gente leia. */
export function lerLinkDoGoogle(entrada: string): LinkDoGoogle | null {
  let u: URL;
  try {
    u = new URL(entrada.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "docs.google.com") {
    const m = u.pathname.match(/^\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([^/]+)/);
    if (!m || !ID.test(m[2]!)) return null;
    const tipo = m[1] === "document" ? "doc" : m[1] === "spreadsheets" ? "planilha" : "apresentacao";
    return { tipo, id: m[2]! };
  }
  if (host === "drive.google.com") {
    const m = u.pathname.match(/^\/file\/(?:u\/\d+\/)?d\/([^/]+)/);
    const id = m?.[1] ?? u.searchParams.get("id") ?? "";
    return ID.test(id) ? { tipo: "arquivo", id } : null;
  }
  return null;
}

function enderecoDeExportacao(l: LinkDoGoogle): string {
  switch (l.tipo) {
    case "doc":
      return `https://docs.google.com/document/d/${l.id}/export?format=txt`;
    case "planilha":
      return `https://docs.google.com/spreadsheets/d/${l.id}/export?format=xlsx`;
    case "apresentacao":
      return `https://docs.google.com/presentation/d/${l.id}/export?format=txt`;
    case "arquivo":
      return `https://drive.google.com/uc?export=download&id=${l.id}`;
  }
}

const hostPermitido = (h: string) => h === "google.com" || h.endsWith(".google.com") || h.endsWith(".googleusercontent.com");

const COMO_COMPARTILHAR =
  'Esse arquivo não está aberto por link. No Google, clique em Compartilhar, em "Acesso geral" escolha "Qualquer pessoa com o link" e copie o link de novo.';

type Busca = (url: string, init?: RequestInit) => Promise<Response>;

/** Baixa seguindo os redirecionamentos, conferindo o destino a cada salto. */
async function baixar(url: string, buscar: Busca): Promise<{ bytes: Uint8Array; tipo: string; nome: string | null }> {
  let atual = url;
  for (let salto = 0; salto < 6; salto++) {
    const u = new URL(atual);
    if (u.protocol !== "https:" || !hostPermitido(u.hostname.toLowerCase())) throw new ArquivoNaoLido(COMO_COMPARTILHAR);
    let res: Response;
    try {
      res = await buscar(atual, { redirect: "manual", signal: AbortSignal.timeout(25_000), headers: { "user-agent": "Mozilla/5.0 (CRM Agro)" } });
    } catch {
      throw new ArquivoNaoLido("Não consegui falar com o Google agora. Tente de novo em instantes.");
    }
    if (res.status >= 300 && res.status < 400) {
      const destino = res.headers.get("location");
      if (!destino) throw new ArquivoNaoLido(COMO_COMPARTILHAR);
      atual = new URL(destino, atual).toString();
      // Mandou para a tela de login: o arquivo é privado.
      if (new URL(atual).hostname.toLowerCase() === "accounts.google.com") throw new ArquivoNaoLido(COMO_COMPARTILHAR);
      continue;
    }
    if (res.status === 404) throw new ArquivoNaoLido("Não achei esse arquivo no Google. Confira o link.");
    if (res.status === 401 || res.status === 403) throw new ArquivoNaoLido(COMO_COMPARTILHAR);
    if (!res.ok) throw new ArquivoNaoLido("O Google não entregou o arquivo. Tente de novo em instantes.");
    const tamanho = Number(res.headers.get("content-length") ?? 0);
    if (tamanho > TAMANHO_MAX_ARQUIVO) throw new ArquivoNaoLido(`O arquivo tem mais de ${TAMANHO_MAX_ARQUIVO / 1024 / 1024} MB. Envie uma versão menor.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > TAMANHO_MAX_ARQUIVO) throw new ArquivoNaoLido(`O arquivo tem mais de ${TAMANHO_MAX_ARQUIVO / 1024 / 1024} MB. Envie uma versão menor.`);
    const tipo = (res.headers.get("content-type") ?? "").toLowerCase();
    const disp = res.headers.get("content-disposition") ?? "";
    const nome = decodeURIComponent(disp.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? disp.match(/filename="?([^";]+)"?/i)?.[1] ?? "") || null;
    return { bytes, tipo, nome };
  }
  throw new ArquivoNaoLido("O Google redirecionou demais. Confira o link.");
}

const SEM_ARQUIVO_DE_TIPO = "Esse arquivo do Drive não é um tipo que eu leia. Use PDF, Word (.docx), Excel (.xlsx) ou texto.";

/** O arquivo do Drive não diz a extensão no link: vem do nome do arquivo ou do tipo de conteúdo. */
function nomeComExtensao(nome: string | null, tipo: string): string {
  if (nome && /\.[a-z0-9]{2,5}$/i.test(nome)) return nome;
  if (tipo.includes("pdf")) return "arquivo.pdf";
  if (tipo.includes("wordprocessingml")) return "arquivo.docx";
  if (tipo.includes("spreadsheetml")) return "arquivo.xlsx";
  if (tipo.startsWith("text/plain") || tipo.includes("csv") || tipo.includes("markdown")) return "arquivo.txt";
  throw new ArquivoNaoLido(SEM_ARQUIVO_DE_TIPO);
}

export type ResultadoDoLink = { fonte: FonteDoArquivo; texto: string; nomeArquivo: string | null };

/** Busca o conteúdo do link e devolve o texto. `buscar` existe para o teste (a rede do teste é falsa). */
export async function lerDocumentoDoGoogle(link: LinkDoGoogle, buscar: Busca = (u, i) => fetch(u, i)): Promise<ResultadoDoLink> {
  const { bytes, tipo, nome } = await baixar(enderecoDeExportacao(link), buscar);

  // Documento e apresentação saem como texto puro; planilha sai como .xlsx.
  if (link.tipo === "doc" || link.tipo === "apresentacao") {
    if (tipo.includes("text/html")) throw new ArquivoNaoLido(COMO_COMPARTILHAR);
    const texto = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
    return { fonte: "texto", texto: conferirTextoExtraido(texto, link.tipo === "doc" ? "documento" : "apresentação"), nomeArquivo: null };
  }
  if (tipo.includes("text/html")) throw new ArquivoNaoLido(COMO_COMPARTILHAR);
  const nomeFinal = link.tipo === "planilha" ? "planilha.xlsx" : nomeComExtensao(nome, tipo);
  const { fonte, texto } = await lerArquivo(nomeFinal, bytes);
  return { fonte, texto, nomeArquivo: link.tipo === "arquivo" ? nomeFinal : null };
}

export { CARACTERES_MAX_DOC };
