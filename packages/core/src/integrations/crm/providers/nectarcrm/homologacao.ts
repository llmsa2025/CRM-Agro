/**
 * Roteiro de HOMOLOGAÇÃO do Nectar (plano §3.0). Ficha N5.
 *
 * Roda, pela API, os itens da homologação que dá para medir e devolve um
 * relatório SEM token, SEM corpo de resposta e SEM dado de cliente. Quem roda
 * de verdade é o dono, com o token da CONTA DE TESTE do Nectar (o script
 * `packages/core/scripts/nectar-homologacao.ts` tem a dupla trava). Aqui só há
 * a lógica, testada contra o Nectar falso.
 *
 * O que este arquivo garante:
 * - todo registro criado leva o prefixo `CRMAGRO TESTE HOMOLOGACAO <AAAAMMDD-HHMM>`
 *   e e-mail `homologacao+<n>@example.com` (o domínio `example.com` não recebe e-mail);
 * - o único telefone usado é o que o dono passou (`telefone`); sem ele, os casos
 *   de telefone ficam `nao_testado` e os contatos nascem sem telefone;
 * - no máximo 1 chamada por `pausaMs` (padrão 1 s) e no máximo 500 chamadas; um
 *   401 aborta a rodada;
 * - o `observado` de cada caso guarda só: status HTTP, nomes de chaves, contagens,
 *   verdadeiro ou falso, trechos de erro de até 200 caracteres com os dígitos
 *   trocados por `#` e o `sha256` (com o tamanho) das notas lidas de volta;
 * - NADA é apagado no Nectar (o CRM Agro nunca apaga; não há DELETE aqui).
 *
 * Regra da pasta `providers/nectarcrm/`: só importa o conector, o cliente,
 * `zod` e `node:crypto` (mais os arquivos irmãos de `crm/`).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { ErroCrm } from "../../errors";
import type { FormatoTelefone } from "../../contract";
import { criarClienteNectar, segmento, transportePadrao, type ClienteNectar, type PedidoNectar, type RespostaNectar, type TransporteNectar } from "./client";
import { telefoneNoFormato, variantesDoTelefone } from "./telefone";

export type ResultadoCaso = {
  id: string;
  grupo: string;
  descricao: string;
  /** ok = a API se comportou como o plano espera; falhou = erro onde se esperava sucesso; observar = achado que decide algo; nao_testado = faltou pré-requisito. */
  resultado: "ok" | "falhou" | "observar" | "nao_testado";
  observado: Record<string, unknown>;
};

export type ArquivoDeTeste = { nome: string; tipo: string; blob: Blob };

/** Só a conta de teste: variável de homologação exata, o token e (opcional) o telefone do dono em E.164. */
export function permitidoRodarHomologacao(
  env: Record<string, string | undefined>,
): { ok: true; token: string; telefone: string | null } | { ok: false; motivo: string } {
  if (env.NECTAR_HOMOLOGACAO !== "conta-de-teste") {
    return { ok: false, motivo: "defina NECTAR_HOMOLOGACAO=conta-de-teste (o roteiro só roda na CONTA DE TESTE do Nectar, nunca na de um cliente)" };
  }
  const token = env.NECTAR_HOMOLOGACAO_TOKEN?.trim();
  if (!token) return { ok: false, motivo: "falta NECTAR_HOMOLOGACAO_TOKEN (o token da conta de teste, gerado por um administrador)" };
  const telefone = env.NECTAR_HOMOLOGACAO_TELEFONE?.trim() || null;
  if (telefone && !/^\+\d{8,15}$/.test(telefone)) {
    return { ok: false, motivo: "NECTAR_HOMOLOGACAO_TELEFONE precisa estar em E.164 (+55 e o número, sem espaço nem pontuação)" };
  }
  return { ok: true, token, telefone };
}

/** As conferências que só a tela do Nectar mostra (o dono faz depois de rodar o script). */
export const CHECKLIST_VISUAL: readonly string[] = [
  "Em quais históricos a nota com dois vínculos (contato e oportunidade) aparece: só no da oportunidade, só no do contato ou nos dois.",
  "Quais áudios tocam na tela do Nectar e quais só baixam (ogg do WhatsApp, mp3, m4a, wav).",
  "Se o anexo aparece na aba Anexos da oportunidade e no Nectar Drive, e se desconta do armazenamento da conta.",
  "Se a nota criada pela API avisou o responsável do contato.",
  "Se os dias sem interação do contato mudaram depois da nota.",
  "Se uma tarefa de ligação criada já concluída entra nas estatísticas de ligação do Nectar.",
  "Se alguma automação do Nectar (WhatsApp, e-mail marketing, RD Station, fluxo de cadência) disparou mensagem para os contatos criados. Não deveria, com as automações desligadas.",
];

const TETO_PADRAO = 500;
const PAUSA_PADRAO_MS = 1000;
const ACENTOS = "áéíóúâêôãõçÁÉÍÓÚÂÊÔÃÕÇ";

/** A rodada bateu no teto de chamadas. */
class HomologacaoTeto extends Error {
  constructor() {
    super("HomologacaoTeto: teto de chamadas");
    this.name = "HomologacaoTeto";
  }
}
/** O Nectar recusou o token (401): não adianta continuar. */
class HomologacaoAbortada extends Error {
  constructor() {
    super("HomologacaoAbortada: o Nectar recusou o token");
    this.name = "HomologacaoAbortada";
  }
}

/** Trecho de texto do Nectar para o relatório: sem e-mail, sem dígitos (viram `#`), no máximo 200 caracteres. */
export function trechoSeguro(texto: string): string {
  return texto
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<e-mail>")
    .replace(/\d/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/** Só os nomes das chaves (ordenados) de um objeto, ou do primeiro item de uma lista. */
function chavesDe(json: unknown): string[] {
  const alvo = Array.isArray(json) ? json[0] : json;
  return alvo && typeof alvo === "object" ? Object.keys(alvo as object).sort() : [];
}

/** A lista de itens de uma resposta: a própria lista, ou uma chave conhecida de página. */
function listaDe(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const k of ["content", "data", "items", "lista", "resultado"]) {
      const v = (json as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return null;
}

/** O id de um registro (como texto), ou null. */
function idDe(json: unknown): string | null {
  const id = (json as { id?: unknown } | null)?.id;
  return typeof id === "number" || typeof id === "string" ? String(id) : null;
}

const obj = (json: unknown): Record<string, unknown> => (json && typeof json === "object" ? (json as Record<string, unknown>) : {});

type Resp = { ok: boolean; status: number; json: unknown; trecho: string | null };

type Estado = {
  funilVendas?: { id: string; nome: string; etapas: number[]; b2b: boolean };
  funilB2b?: { id: string; nome: string; etapas: number[]; b2b: boolean };
  funilPre?: { id: string; nome: string; etapas: number[] };
  outroFunilPre?: { id: string };
  temLeadboard?: boolean;
  usuarioId?: string;
  outroUsuarioId?: string;
  filaId?: string;
  contatoA?: string;
  contatoB?: string;
  empresa?: string;
  opId?: string;
  qualId?: string;
  notaId?: string;
  codigoA?: string;
  emailA?: string;
  rotaUsuarios?: "/usuarios/" | "/usuario/";
};

type Ctx = {
  prefixo: string;
  /** Resumo do payload do token (lido no início, sem chamada). */
  jwt: Record<string, unknown>;
  telefone: string | null;
  arquivos: ArquivoDeTeste[];
  estado: Estado;
  chamadas: number;
  vistos429: number;
  cabecalhosDeLimite: Set<string>;
  req(metodo: "GET" | "POST" | "PUT", caminho: string, opts?: { query?: Record<string, string | number | (string | number)[]>; corpo?: unknown; multipart?: FormData; cabecalho?: Record<string, string> }): Promise<Resp>;
  email(n: number): string;
};

type Saida = { resultado: ResultadoCaso["resultado"]; observado: Record<string, unknown> };
type Definicao = { id: string; grupo: string; descricao: string; exec: (c: Ctx) => Promise<Saida> };

const nao = (motivo: string): Saida => ({ resultado: "nao_testado", observado: { motivo } });
/** Motivo de pular os casos de pré-venda: sem Leadboard, ou sem saber se tem. */
const semLeadboard = (c: Ctx) => (c.estado.temLeadboard === undefined ? "não deu para saber se a conta tem o Leadboard" : "a conta não tem o Leadboard");
const saida = (resultado: ResultadoCaso["resultado"], observado: Record<string, unknown>): Saida => ({ resultado, observado });
/** ok quando a chamada deu 2xx; falhou quando não deu. */
const okSe = (r: Resp, observado: Record<string, unknown>): Saida =>
  saida(r.ok ? "ok" : "falhou", { status: r.status, ...(r.trecho ? { erro: r.trecho } : {}), ...observado });

/** Um trecho de texto para a nota (com acentos), do tamanho pedido. */
function textoDeTamanho(n: number): string {
  const base = `Transcrição de teste com acentos ${ACENTOS} e quebra.\n`;
  return base.repeat(Math.ceil(n / base.length)).slice(0, n);
}

const CATALOGO: Definicao[] = [
  // ─── Conta e catálogos ────────────────────────────────────────────────────
  {
    id: "conta.funis-vendas",
    grupo: "conta",
    descricao: "GET /pipeline/?type=0 (funis de vendas): prova o token e mostra o formato",
    exec: async (c) => {
      const r = await c.req("GET", "/pipeline/", { query: { type: 0, page: -1 } });
      const lista = listaDe(r.json) ?? [];
      const funis = lista.map(obj);
      const uteis = funis.filter((f) => f.ativo !== false && f.produtoObrigatorio !== true);
      const escolhido = uteis[0];
      const b2b = uteis.find((f) => f.modeloVenda === 0 || f.modeloVenda === undefined);
      const info = (f: Record<string, unknown> | undefined) =>
        f && idDe(f) ? { id: idDe(f)!, nome: String(f.nome ?? ""), etapas: (Array.isArray(f.sequencias) ? f.sequencias : []).map((e) => Number(obj(e).sequencia)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b), b2b: f.modeloVenda === 0 } : undefined;
      c.estado.funilVendas = info(escolhido);
      c.estado.funilB2b = info(b2b);
      return okSe(r, { total: lista.length, chavesDoFunil: chavesDe(lista), semProdutoObrigatorio: uteis.length, temFunilB2b: Boolean(b2b) });
    },
  },
  {
    id: "conta.jwt",
    grupo: "conta",
    descricao: "Chaves do payload do token (se é JWT, usuarioMasterId e exp)",
    exec: async (c) => saida("observar", c.jwt),
  },
  {
    id: "conta.funis-pre-venda",
    grupo: "conta",
    descricao: "GET /pipeline/?type=1 (funis de pré-venda): decide se a conta tem o Leadboard",
    exec: async (c) => {
      const r = await c.req("GET", "/pipeline/", { query: { type: 1, page: -1 } });
      const lista = (listaDe(r.json) ?? []).map(obj);
      // Lista vazia, 403 e 404 dizem "sem Leadboard"; erro de rede ou 5xx não dizem nada (fica indefinido).
      c.estado.temLeadboard = r.ok ? lista.length > 0 : r.status === 403 || r.status === 404 ? false : undefined;
      const util = lista.find((f) => f.ativo !== false);
      if (util && idDe(util)) {
        c.estado.funilPre = {
          id: idDe(util)!,
          nome: String(util.nome ?? ""),
          etapas: (Array.isArray(util.sequencias) ? util.sequencias : []).map((e) => Number(obj(e).sequencia)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b),
        };
        const outro = lista.find((f) => f.ativo !== false && idDe(f) !== idDe(util));
        if (outro && idDe(outro)) c.estado.outroFunilPre = { id: idDe(outro)! };
      }
      // O que volta numa conta SEM Leadboard (lista vazia, 403 ou 404) é o que esconde a opção pré-venda.
      return saida("observar", { status: r.status, total: lista.length, temLeadboard: c.estado.temLeadboard ?? null, ...(r.trecho ? { erro: r.trecho } : {}) });
    },
  },
  {
    id: "conta.pipelines-plural",
    grupo: "conta",
    descricao: "GET /pipelines (rota citada no índice do Apiary)",
    exec: async (c) => {
      const r = await c.req("GET", "/pipelines", { query: { page: -1 } });
      return saida("observar", { status: r.status, total: listaDe(r.json)?.length ?? null, ...(r.trecho ? { erro: r.trecho } : {}) });
    },
  },
  {
    id: "conta.usuarios-rota",
    grupo: "conta",
    descricao: "Rota da lista de usuários: /usuarios/ ou /usuario/",
    exec: async (c) => {
      const plural = await c.req("GET", "/usuarios/", { query: { page: -1 } });
      const singular = await c.req("GET", "/usuario/", { query: { page: -1 } });
      c.estado.rotaUsuarios = plural.ok ? "/usuarios/" : singular.ok ? "/usuario/" : undefined;
      return saida(plural.ok || singular.ok ? "observar" : "falhou", {
        statusPlural: plural.status,
        statusSingular: singular.status,
        totalPlural: listaDe(plural.json)?.length ?? null,
        totalSingular: listaDe(singular.json)?.length ?? null,
      });
    },
  },
  {
    id: "conta.usuarios-attribute",
    grupo: "conta",
    descricao: "O `attribute=` limita os campos? A resposta SEM ele traz sipPassword? (só se traz, nunca o valor)",
    exec: async (c) => {
      const rota = c.estado.rotaUsuarios;
      if (!rota) return nao("a rota da lista de usuários não respondeu");
      const sem = await c.req("GET", rota, { query: { page: -1 } });
      const com = await c.req("GET", rota, { query: { page: -1, attribute: ["id", "nome", "email", "login", "ativo", "virtual", "isSuporte"] } });
      const itens = (listaDe(sem.json) ?? []).map(obj);
      const chavesSem = chavesDe(sem.json);
      const chavesCom = chavesDe(com.json);
      const inativos = itens.filter((u) => u.ativo === false).length;
      const ativo = itens.find((u) => u.ativo !== false && idDe(u));
      c.estado.usuarioId = ativo ? (idDe(ativo) ?? undefined) : undefined;
      const outro = itens.find((u) => u.ativo !== false && idDe(u) && idDe(u) !== c.estado.usuarioId);
      c.estado.outroUsuarioId = outro ? (idDe(outro) ?? undefined) : undefined;
      return saida("observar", {
        statusSem: sem.status,
        statusCom: com.status,
        chavesSemAttribute: chavesSem,
        chavesComAttribute: chavesCom,
        attributeLimita: chavesCom.length > 0 && chavesCom.length < chavesSem.length,
        // Só se aparece, nunca o valor.
        sipPasswordSemAttribute: chavesSem.includes("sipPassword"),
        listaIpsSemAttribute: chavesSem.includes("listaIps"),
        inativosNaLista: inativos,
        totalUsuarios: itens.length,
      });
    },
  },
  {
    id: "conta.filas",
    grupo: "conta",
    descricao: "GET /queues/",
    exec: async (c) => {
      const r = await c.req("GET", "/queues/");
      const lista = (listaDe(r.json) ?? []).map(obj);
      c.estado.filaId = lista[0] ? (idDe(lista[0]) ?? undefined) : undefined;
      return okSe(r, { total: lista.length, chaves: chavesDe(lista) });
    },
  },
  {
    id: "conta.etiquetas",
    grupo: "conta",
    descricao: "GET /lista/?page=-1 (etiquetas)",
    exec: async (c) => {
      const r = await c.req("GET", "/lista/", { query: { page: -1 } });
      const lista = (listaDe(r.json) ?? []).map(obj);
      return okSe(r, {
        total: lista.length,
        chaves: chavesDe(lista),
        temOptOutCrmAgro: lista.some((l) => String(l.nome ?? "").trim().toLowerCase() === "opt-out (crm agro)"),
      });
    },
  },
  {
    id: "conta.campos-personalizados",
    grupo: "conta",
    descricao: "GET /campoPersonalizado/?page=-1, /customField/fields/1 e /2",
    exec: async (c) => {
      const campos = await c.req("GET", "/campoPersonalizado/", { query: { page: -1 } });
      const c1 = await c.req("GET", "/customField/fields/1");
      const c2 = await c.req("GET", "/customField/fields/2");
      const lista = (listaDe(campos.json) ?? []).map(obj);
      return saida(campos.ok ? "ok" : "falhou", {
        statusCampos: campos.status,
        total: lista.length,
        obrigatorios: lista.filter((f) => f.obrigatorio === true || f.obrigatorio === "true").length,
        statusContatos: c1.status,
        statusOportunidades: c2.status,
        totalContatos: listaDe(c1.json)?.length ?? null,
        totalOportunidades: listaDe(c2.json)?.length ?? null,
      });
    },
  },
  {
    id: "conta.display-length",
    grupo: "conta",
    descricao: "Máximo real de displayLength em /contatos/ (50, 100 e 200)",
    exec: async (c) => {
      const porTamanho: Record<string, number | null> = {};
      let algumOk = false;
      for (const n of [50, 100, 200]) {
        const r = await c.req("GET", "/contatos/", { query: { displayLength: n } });
        algumOk ||= r.ok;
        porTamanho[String(n)] = r.ok ? (listaDe(r.json)?.length ?? null) : -r.status;
      }
      return saida(algumOk ? "observar" : "falhou", { voltaram: porTamanho, nota: "número negativo = status HTTP do erro" });
    },
  },

  // ─── Contato ──────────────────────────────────────────────────────────────
  {
    id: "contato.criar",
    grupo: "contato",
    descricao: "Criar os contatos de teste A (telefone no formato (DD) 9XXXX-XXXX) e B (telefone em E.164)",
    exec: async (c) => {
      const codigoA = `${c.prefixo.replace(/\s+/g, "-").toLowerCase()}-a`;
      c.estado.codigoA = codigoA;
      c.estado.emailA = c.email(1);
      const corpoA: Record<string, unknown> = { nome: `${c.prefixo} A`, constante: 3, ativo: true, codigo: codigoA, emails: [c.estado.emailA] };
      const corpoB: Record<string, unknown> = { nome: `${c.prefixo} B`, constante: 3, ativo: true, emails: [c.email(3)] };
      if (c.telefone) {
        corpoA.telefones = [telefoneNoFormato(c.telefone, "parenteses_hifen")];
        corpoB.telefones = [c.telefone];
      }
      const a = await c.req("POST", "/contatos/", { corpo: corpoA });
      const b = await c.req("POST", "/contatos/", { corpo: corpoB });
      c.estado.contatoA = idDe(a.json) ?? undefined;
      c.estado.contatoB = idDe(b.json) ?? undefined;
      return saida(a.ok && b.ok && c.estado.contatoA && c.estado.contatoB ? "ok" : "falhou", {
        statusA: a.status,
        statusB: b.status,
        chavesDaResposta: chavesDe(a.json),
        comTelefone: Boolean(c.telefone),
        ...(a.trecho ? { erroA: a.trecho } : {}),
        ...(b.trecho ? { erroB: b.trecho } : {}),
      });
    },
  },
  {
    id: "contato.codigo",
    grupo: "contato",
    descricao: "O `codigo` é gravável e se acha por GET /contatos/?nome=<codigo>&exato=true",
    exec: async (c) => {
      if (!c.estado.contatoA || !c.estado.codigoA) return nao("o contato A não foi criado");
      const lido = await c.req("GET", `/contatos/${segmento(c.estado.contatoA)}`);
      const busca = await c.req("GET", "/contatos/", { query: { nome: c.estado.codigoA, exato: "true" } });
      const achados = (listaDe(busca.json) ?? []).map(obj);
      return saida(busca.ok && achados.some((x) => idDe(x) === c.estado.contatoA) ? "ok" : "observar", {
        codigoGravado: obj(lido.json).codigo === c.estado.codigoA,
        statusBusca: busca.status,
        achouPeloCodigo: achados.some((x) => idDe(x) === c.estado.contatoA),
        totalNaBusca: achados.length,
      });
    },
  },
  {
    id: "contato.telefone-variantes",
    grupo: "contato",
    descricao: "Busca por telefone: quais das 7 variantes acham o contato A (exata ou por trecho)",
    exec: async (c) => {
      if (!c.telefone) return nao("sem NECTAR_HOMOLOGACAO_TELEFONE");
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const achou: Record<string, boolean> = {};
      const formatos: FormatoTelefone[] = ["e164", "55", "ddd", "parenteses_hifen", "parenteses", "sem_nono", "sem_nono_parenteses_hifen"];
      const variantes = variantesDoTelefone(c.telefone);
      let algum = false;
      for (let i = 0; i < variantes.length; i++) {
        const r = await c.req("GET", `/contatos/telefone/${segmento(variantes[i]!)}`);
        const ids = (listaDe(r.json) ?? (r.ok ? [r.json] : [])).map(idDe);
        achou[formatos[i] ?? `variante${i}`] = ids.includes(c.estado.contatoA);
        algum ||= achou[formatos[i] ?? `variante${i}`] === true;
      }
      // Trecho: os 8 últimos dígitos, sem formatação (se achar, a busca é por trecho).
      const oito = c.telefone.replace(/\D/g, "").slice(-8);
      const trecho = await c.req("GET", `/contatos/telefone/${segmento(oito)}`);
      const idsTrecho = (listaDe(trecho.json) ?? (trecho.ok ? [trecho.json] : [])).map(idDe);
      return saida("observar", { achouPorVariante: achou, algumaAchou: algum, achouPorTrecho8Digitos: idsTrecho.includes(c.estado.contatoA) });
    },
  },
  {
    id: "contato.mais-codificado",
    grupo: "contato",
    descricao: "O `+` do E.164 codificado (%2B) e não codificado na busca por telefone",
    exec: async (c) => {
      if (!c.telefone) return nao("sem NECTAR_HOMOLOGACAO_TELEFONE");
      if (!c.estado.contatoB) return nao("o contato B não foi criado");
      const cod = await c.req("GET", `/contatos/telefone/${segmento(c.telefone)}`);
      const cru = await c.req("GET", `/contatos/telefone/${c.telefone}`);
      const acha = (r: Resp) => (listaDe(r.json) ?? (r.ok ? [r.json] : [])).map(idDe).includes(c.estado.contatoB!);
      return saida("observar", { statusCodificado: cod.status, achouCodificado: acha(cod), statusSemCodificar: cru.status, achouSemCodificar: acha(cru) });
    },
  },
  {
    id: "contato.put-listas",
    grupo: "contato",
    descricao: "PUT com emails, telefones e listas: acrescenta ou substitui? (lê de volta)",
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const id = segmento(c.estado.contatoA);
      const tam = (j: unknown, chave: string) => (Array.isArray(obj(j)[chave]) ? (obj(j)[chave] as unknown[]).length : 0);
      const antes = await c.req("GET", `/contatos/${id}`);
      const putE = await c.req("PUT", `/contatos/${id}`, { corpo: { emails: [c.email(2)] } });
      const depoisE = await c.req("GET", `/contatos/${id}`);
      const observado: Record<string, unknown> = {
        emailsAntes: tam(antes.json, "emails"),
        statusPutEmails: putE.status,
        emailsDepois: tam(depoisE.json, "emails"),
        emailsSubstituiu: putE.ok && tam(depoisE.json, "emails") === 1,
        emailsAcrescentou: putE.ok && tam(depoisE.json, "emails") > tam(antes.json, "emails"),
      };
      if (c.telefone) {
        const putT = await c.req("PUT", `/contatos/${id}`, { corpo: { telefones: [c.telefone] } });
        const depoisT = await c.req("GET", `/contatos/${id}`);
        observado.telefonesAntes = tam(depoisE.json, "telefones");
        observado.statusPutTelefones = putT.status;
        observado.telefonesDepois = tam(depoisT.json, "telefones");
        observado.telefonesSubstituiu = putT.ok && tam(depoisT.json, "telefones") === 1 && tam(depoisE.json, "telefones") > 1;
      }
      const putL = await c.req("PUT", `/contatos/${id}`, { corpo: { listas: [{ nome: c.prefixo }] } });
      const depoisL = await c.req("GET", `/contatos/${id}`);
      observado.statusPutListas = putL.status;
      observado.listasDepois = tam(depoisL.json, "listas");
      return saida(putE.ok ? "observar" : "falhou", observado);
    },
  },
  {
    id: "contato.put-sem-chave",
    grupo: "contato",
    descricao: "PUT sem uma chave preserva o valor?",
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const id = segmento(c.estado.contatoA);
      const put = await c.req("PUT", `/contatos/${id}`, { corpo: { origem: "CRMAGRO TESTE" } });
      const depois = await c.req("GET", `/contatos/${id}`);
      const d = obj(depois.json);
      return saida(put.ok ? "observar" : "falhou", {
        statusPut: put.status,
        nomePreservado: typeof d.nome === "string" && d.nome.startsWith("CRMAGRO TESTE HOMOLOGACAO"),
        emailsPreservados: Array.isArray(d.emails) && d.emails.length > 0,
        codigoPreservado: d.codigo === c.estado.codigoA,
      });
    },
  },
  {
    id: "contato.codigo-ja-preenchido",
    grupo: "contato",
    descricao: "PUT de `codigo` num contato que já tem código: muda ou fica?",
    exec: async (c) => {
      if (!c.estado.contatoA || !c.estado.codigoA) return nao("o contato A não foi criado");
      const id = segmento(c.estado.contatoA);
      const put = await c.req("PUT", `/contatos/${id}`, { corpo: { codigo: `${c.estado.codigoA}-outro` } });
      const depois = await c.req("GET", `/contatos/${id}`);
      const mudou = obj(depois.json).codigo !== c.estado.codigoA;
      // Restaura o código original, para os casos seguintes.
      if (mudou) await c.req("PUT", `/contatos/${id}`, { corpo: { codigo: c.estado.codigoA } });
      return saida("observar", { statusPut: put.status, codigoMudou: mudou });
    },
  },
  {
    id: "contato.busca-email-constante",
    grupo: "contato",
    descricao: "A busca por e-mail devolve a `constante` do contato?",
    exec: async (c) => {
      if (!c.estado.emailA) return nao("o contato A não foi criado");
      const r = await c.req("GET", `/contatos/email/${segmento(c.estado.emailA)}`);
      const item = obj(listaDe(r.json)?.[0] ?? r.json);
      return saida(r.ok ? "observar" : "falhou", { status: r.status, achou: r.ok, devolveConstante: "constante" in item, chaves: chavesDe(r.json), ...(r.trecho ? { erro: r.trecho } : {}) });
    },
  },

  // ─── Empresa ──────────────────────────────────────────────────────────────
  {
    id: "empresa.cnpj",
    grupo: "empresa",
    descricao: "Contato-empresa com CNPJ formatado e só com dígitos; GET /contatos/cnpj/{...} nos dois formatos",
    exec: async (c) => {
      const cnpjs = [{ formatado: "11.222.333/0001-81", digitos: "11222333000181", nome: "Empresa 1" }, { formatado: "11.444.777/0001-61", digitos: "11444777000161", nome: "Empresa 2" }];
      const criar = async (e: (typeof cnpjs)[number], usar: string, n: number) =>
        c.req("POST", "/contatos/", { corpo: { nome: `${c.prefixo} ${e.nome}`, constante: 3, ativo: true, empresa: true, cnpj: usar, razaoSocial: `${c.prefixo} ${e.nome} LTDA`, emails: [c.email(10 + n)] } });
      const um = await criar(cnpjs[0]!, cnpjs[0]!.formatado, 1);
      const dois = await criar(cnpjs[1]!, cnpjs[1]!.digitos, 2);
      c.estado.empresa = idDe(um.json) ?? undefined;
      const acha = async (cnpj: string, id: string | null) => {
        const r = await c.req("GET", `/contatos/cnpj/${segmento(cnpj)}`);
        return (listaDe(r.json) ?? (r.ok ? [r.json] : [])).map(idDe).includes(id);
      };
      const idUm = idDe(um.json);
      const idDois = idDe(dois.json);
      return saida(um.ok && dois.ok ? "observar" : "falhou", {
        statusCriarFormatado: um.status,
        statusCriarDigitos: dois.status,
        formatadoAchaPorFormatado: await acha(cnpjs[0]!.formatado, idUm),
        formatadoAchaPorDigitos: await acha(cnpjs[0]!.digitos, idUm),
        digitosAchaPorFormatado: await acha(cnpjs[1]!.formatado, idDois),
        digitosAchaPorDigitos: await acha(cnpjs[1]!.digitos, idDois),
      });
    },
  },

  // ─── Oportunidade ─────────────────────────────────────────────────────────
  {
    id: "oportunidade.criar-formas-do-funil",
    grupo: "oportunidade",
    descricao: "Criar com funilVenda {id}, com funilDeVenda {id} e com pipeline (nome), cada um com etapa; lê de volta onde caiu",
    exec: async (c) => {
      const f = c.estado.funilVendas;
      if (!c.estado.contatoA || !f || f.etapas.length === 0) return nao("falta o contato A ou um funil de vendas sem produto obrigatório");
      const formas: [string, Record<string, unknown>][] = [
        ["funilVenda", { funilVenda: { id: f.id } }],
        ["funilDeVenda", { funilDeVenda: { id: f.id } }],
        ["pipeline", { pipeline: f.nome }],
      ];
      const observado: Record<string, unknown> = {};
      let algum = false;
      for (const [nome, extra] of formas) {
        const r = await c.req("POST", "/oportunidades/", { corpo: { nome: `${c.prefixo} card ${nome}`, cliente: { id: c.estado.contatoA }, etapa: f.etapas[0], ...extra } });
        algum ||= r.ok;
        if (r.ok && nome === "funilVenda") c.estado.opId = idDe(r.json) ?? undefined;
        observado[nome] = { status: r.status, criou: r.ok, ...(r.trecho ? { erro: r.trecho } : {}) };
      }
      const lista = await c.req("GET", `/oportunidades/contatoId/${segmento(c.estado.contatoA)}`);
      const itens = (listaDe(lista.json) ?? []).map(obj);
      observado.lidasDoContato = itens.length;
      observado.chavesDaOportunidade = chavesDe(itens);
      observado.caiuNoFunilEscolhido = itens.filter((o) => idDe(obj(o.funilVenda)) === f.id || idDe(obj(o.pipeline)) === f.id).length;
      return saida(algum ? "observar" : "falhou", observado);
    },
  },
  {
    id: "oportunidade.b2b",
    grupo: "oportunidade",
    descricao: "Funil B2B: `cliente` = empresa e `contato` = pessoa; em qual contato a oportunidade aparece",
    exec: async (c) => {
      const f = c.estado.funilB2b;
      if (!c.estado.contatoA || !c.estado.empresa || !f || f.etapas.length === 0) return nao("falta o contato A, a empresa ou um funil B2B sem produto obrigatório");
      const r = await c.req("POST", "/oportunidades/", { corpo: { nome: `${c.prefixo} card b2b`, cliente: { id: c.estado.empresa }, contato: { id: c.estado.contatoA }, funilVenda: { id: f.id }, etapa: f.etapas[0] } });
      const daPessoa = await c.req("GET", `/oportunidades/contatoId/${segmento(c.estado.contatoA)}`);
      const daEmpresa = await c.req("GET", `/oportunidades/contatoId/${segmento(c.estado.empresa)}`);
      const nova = idDe(r.json);
      const tem = (x: Resp) => (listaDe(x.json) ?? []).map(idDe).includes(nova);
      return saida(r.ok ? "observar" : "falhou", { status: r.status, apareceNaPessoa: tem(daPessoa), apareceNaEmpresa: tem(daEmpresa), ...(r.trecho ? { erro: r.trecho } : {}) });
    },
  },
  {
    id: "oportunidade.listar-por-contato",
    grupo: "oportunidade",
    descricao: "O que GET /oportunidades/contatoId/{id} traz (funil, status)",
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const r = await c.req("GET", `/oportunidades/contatoId/${segmento(c.estado.contatoA)}`);
      const itens = (listaDe(r.json) ?? []).map(obj);
      return okSe(r, { total: itens.length, chaves: chavesDe(itens), temFunil: itens.some((o) => "funilVenda" in o || "pipeline" in o), temStatus: itens.some((o) => "status" in o) });
    },
  },
  {
    id: "oportunidade.put",
    grupo: "oportunidade",
    descricao: "PUT de nome, valorAvulso e responsavel; PUT com etapa e com status",
    exec: async (c) => {
      const f = c.estado.funilVendas;
      if (!c.estado.opId) return nao("nenhuma oportunidade foi criada");
      const id = segmento(c.estado.opId);
      const observado: Record<string, unknown> = {};
      const nome = await c.req("PUT", `/oportunidades/${id}`, { corpo: { nome: `${c.prefixo} card renomeado`, valorAvulso: 1234.5 } });
      const lido = await c.req("GET", `/oportunidades/contatoId/${segmento(c.estado.contatoA!)}`);
      const item = (listaDe(lido.json) ?? []).map(obj).find((o) => idDe(o) === c.estado.opId);
      observado.putNomeEValor = { status: nome.status, nomeMudou: typeof item?.nome === "string" && item.nome.endsWith("renomeado"), valorMudou: item?.valorAvulso === 1234.5 };
      if (c.estado.usuarioId) {
        const resp = await c.req("PUT", `/oportunidades/${id}`, { corpo: { responsavel: { id: c.estado.usuarioId } } });
        observado.putResponsavel = { status: resp.status };
      }
      const etapa2 = f?.etapas[1];
      if (etapa2 !== undefined) {
        const e = await c.req("PUT", `/oportunidades/${id}`, { corpo: { etapa: etapa2 } });
        observado.putEtapa = { status: e.status, ...(e.trecho ? { erro: e.trecho } : {}) };
      }
      const st = await c.req("PUT", `/oportunidades/${id}`, { corpo: { status: 1 } });
      observado.putStatus = { status: st.status, ...(st.trecho ? { erro: st.trecho } : {}) };
      return saida(nome.ok ? "observar" : "falhou", observado);
    },
  },
  {
    id: "oportunidade.fila",
    grupo: "oportunidade",
    descricao: "queue {id} como responsável na criação da oportunidade",
    exec: async (c) => {
      const f = c.estado.funilVendas;
      if (!c.estado.contatoB || !c.estado.filaId || !f || f.etapas.length === 0) return nao("falta o contato B, uma fila ou um funil de vendas");
      const r = await c.req("POST", "/oportunidades/", { corpo: { nome: `${c.prefixo} card fila`, cliente: { id: c.estado.contatoB }, funilVenda: { id: f.id }, etapa: f.etapas[0], queue: { id: c.estado.filaId } } });
      return saida(r.ok ? "observar" : "falhou", { status: r.status, ...(r.trecho ? { erro: r.trecho } : {}) });
    },
  },
  {
    id: "oportunidade.contato-bloqueado",
    grupo: "oportunidade",
    descricao: "Contato com `blocked`: dá para marcar pela API? Recusa a oportunidade nova?",
    exec: async (c) => {
      const f = c.estado.funilVendas;
      if (!c.estado.contatoB || !f || f.etapas.length === 0) return nao("falta o contato B ou um funil de vendas");
      const id = segmento(c.estado.contatoB);
      const marcar = await c.req("PUT", `/contatos/${id}`, { corpo: { blocked: true } });
      const lido = await c.req("GET", `/contatos/${id}`);
      const bloqueado = obj(lido.json).blocked === true;
      let observado: Record<string, unknown> = { statusMarcar: marcar.status, ficouBloqueado: bloqueado };
      if (bloqueado) {
        const r = await c.req("POST", "/oportunidades/", { corpo: { nome: `${c.prefixo} card bloqueado`, cliente: { id: c.estado.contatoB }, funilVenda: { id: f.id }, etapa: f.etapas[0] } });
        observado = { ...observado, statusOportunidade: r.status, recusou: !r.ok, ...(r.trecho ? { erro: r.trecho } : {}) };
        // Desfaz a marca (o CRM Agro não apaga nada; aqui só restaura o contato de teste).
        await c.req("PUT", `/contatos/${id}`, { corpo: { blocked: false } });
      }
      return saida("observar", observado);
    },
  },

  // ─── Qualificação (Leadboard) ─────────────────────────────────────────────
  {
    id: "qualificacao.listar",
    grupo: "qualificacao",
    descricao: "GET /qualificacoes/ (o que volta, com ou sem Leadboard)",
    exec: async (c) => {
      const r = await c.req("GET", "/qualificacoes/", { query: { page: -1 } });
      return saida("observar", { status: r.status, total: listaDe(r.json)?.length ?? null, temLeadboard: c.estado.temLeadboard ?? null, ...(r.trecho ? { erro: r.trecho } : {}) });
    },
  },
  {
    id: "qualificacao.criar-formas-do-funil",
    grupo: "qualificacao",
    descricao: "POST /qualificacoes/ com funilVenda {id}, com pipeline (nome) e sem funil (onde cai)",
    exec: async (c) => {
      const f = c.estado.funilPre;
      if (!c.estado.temLeadboard || !f) return nao(semLeadboard(c));
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const etapa = f.etapas[0] ?? 1;
      const formas: [string, Record<string, unknown>][] = [["funilVenda", { funilVenda: { id: f.id } }], ["pipeline", { pipeline: f.nome }], ["semFunil", {}]];
      const observado: Record<string, unknown> = {};
      let algum = false;
      for (const [nome, extra] of formas) {
        const r = await c.req("POST", "/qualificacoes/", { corpo: { nome: `${c.prefixo} qualificação ${nome}`, cliente: { id: c.estado.contatoA }, etapa, status: 1, ...extra } });
        algum ||= r.ok;
        if (r.ok && nome === "funilVenda") c.estado.qualId = idDe(r.json) ?? undefined;
        observado[nome] = { status: r.status, criou: r.ok, ...(r.trecho ? { erro: r.trecho } : {}) };
      }
      return saida(algum ? "observar" : "falhou", observado);
    },
  },
  {
    id: "qualificacao.cliente-empresa",
    grupo: "qualificacao",
    descricao: "`cliente` = empresa em vez da pessoa",
    exec: async (c) => {
      const f = c.estado.funilPre;
      if (!c.estado.temLeadboard || !f) return nao(semLeadboard(c));
      if (!c.estado.empresa) return nao("a empresa não foi criada");
      const r = await c.req("POST", "/qualificacoes/", { corpo: { nome: `${c.prefixo} qualificação empresa`, cliente: { id: c.estado.empresa }, funilVenda: { id: f.id }, etapa: f.etapas[0] ?? 1, status: 1 } });
      return saida("observar", { status: r.status, criou: r.ok, ...(r.trecho ? { erro: r.trecho } : {}) });
    },
  },
  {
    id: "qualificacao.constantes",
    grupo: "qualificacao",
    descricao: "Contato Cliente (0), Prospect (1) e Descartado (5): a API recusa? Qual erro?",
    exec: async (c) => {
      const f = c.estado.funilPre;
      if (!c.estado.temLeadboard || !f) return nao(semLeadboard(c));
      const observado: Record<string, unknown> = {};
      for (const constante of [0, 1, 5]) {
        const pessoa = await c.req("POST", "/contatos/", { corpo: { nome: `${c.prefixo} constante ${constante}`, constante, ativo: true, emails: [c.email(20 + constante)] } });
        const id = idDe(pessoa.json);
        if (!id) {
          observado[`constante${constante}`] = { status: pessoa.status, criouContato: false };
          continue;
        }
        const r = await c.req("POST", "/qualificacoes/", { corpo: { nome: `${c.prefixo} qualificação c${constante}`, cliente: { id }, funilVenda: { id: f.id }, etapa: f.etapas[0] ?? 1, status: 1 } });
        observado[`constante${constante}`] = { status: r.status, aceitou: r.ok, ...(r.trecho ? { erro: r.trecho } : {}) };
      }
      return saida("observar", observado);
    },
  },
  {
    id: "qualificacao.segunda",
    grupo: "qualificacao",
    descricao: "Segunda qualificação no mesmo funil e em outro funil (uma por contato ou por funil?)",
    exec: async (c) => {
      const f = c.estado.funilPre;
      if (!c.estado.temLeadboard || !f || !c.estado.contatoB) return nao(`${semLeadboard(c)}, ou falta o contato B`);
      const nova = (funil: string, rotulo: string) => c.req("POST", "/qualificacoes/", { corpo: { nome: `${c.prefixo} qualificação ${rotulo}`, cliente: { id: c.estado.contatoB }, funilVenda: { id: funil }, etapa: f.etapas[0] ?? 1, status: 1 } });
      const primeira = await nova(f.id, "primeira");
      const mesmoFunil = await nova(f.id, "mesmo funil");
      const observado: Record<string, unknown> = {
        primeira: { status: primeira.status, criou: primeira.ok },
        segundaNoMesmoFunil: { status: mesmoFunil.status, criou: mesmoFunil.ok, ...(mesmoFunil.trecho ? { erro: mesmoFunil.trecho } : {}) },
      };
      if (c.estado.outroFunilPre) {
        const outro = await nova(c.estado.outroFunilPre.id, "outro funil");
        observado.segundaEmOutroFunil = { status: outro.status, criou: outro.ok, ...(outro.trecho ? { erro: outro.trecho } : {}) };
      } else {
        observado.segundaEmOutroFunil = { motivo: "a conta só tem um funil de pré-venda" };
      }
      return saida("observar", observado);
    },
  },
  {
    id: "qualificacao.listar-por-contato",
    grupo: "qualificacao",
    descricao: "GET /qualificacoes/contatoId/{id} e os status que voltam",
    exec: async (c) => {
      if (!c.estado.temLeadboard) return nao(semLeadboard(c));
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const r = await c.req("GET", `/qualificacoes/contatoId/${segmento(c.estado.contatoA)}`);
      const itens = (listaDe(r.json) ?? []).map(obj);
      return saida(r.ok ? "observar" : "falhou", { status: r.status, total: itens.length, chaves: chavesDe(itens), statusVistos: [...new Set(itens.map((q) => String(q.status ?? "?")))].sort() });
    },
  },
  {
    id: "qualificacao.put",
    grupo: "qualificacao",
    descricao: "PUT /qualificacoes/{id} com etapa e com status (base do futuro \"mover card\")",
    exec: async (c) => {
      const f = c.estado.funilPre;
      if (!c.estado.qualId || !f) return nao("nenhuma qualificação foi criada");
      const id = segmento(c.estado.qualId);
      const observado: Record<string, unknown> = {};
      if (f.etapas[1] !== undefined) {
        const e = await c.req("PUT", `/qualificacoes/${id}`, { corpo: { etapa: f.etapas[1] } });
        observado.putEtapa = { status: e.status, ...(e.trecho ? { erro: e.trecho } : {}) };
      }
      const s = await c.req("PUT", `/qualificacoes/${id}`, { corpo: { status: 1 } });
      observado.putStatus = { status: s.status, ...(s.trecho ? { erro: s.trecho } : {}) };
      return saida("observar", observado);
    },
  },

  // ─── Notas ────────────────────────────────────────────────────────────────
  {
    id: "notas.campos-minimos",
    grupo: "notas",
    descricao: "Campos mínimos aceitos: só descricao + contato; e com titulo",
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const minima = await c.req("POST", "/publicacao/", { corpo: { descricao: `${c.prefixo} nota mínima`, contato: { id: c.estado.contatoA } } });
      const comTitulo = await c.req("POST", "/publicacao/", { corpo: { titulo: `${c.prefixo} nota com titulo`, descricao: `${c.prefixo} nota com titulo`, contato: { id: c.estado.contatoA } } });
      const comAssunto = await c.req("POST", "/publicacao/", { corpo: { assunto: `${c.prefixo} nota com assunto`, descricao: `${c.prefixo} nota com assunto`, contato: { id: c.estado.contatoA } } });
      c.estado.notaId = idDe(minima.json) ?? idDe(comAssunto.json) ?? undefined;
      return saida(minima.ok || comAssunto.ok ? "observar" : "falhou", {
        soDescricaoEContato: { status: minima.status, criou: minima.ok, ...(minima.trecho ? { erro: minima.trecho } : {}) },
        comTitulo: { status: comTitulo.status, criou: comTitulo.ok },
        comAssunto: { status: comAssunto.status, criou: comAssunto.ok },
      });
    },
  },
  {
    id: "notas.dois-vinculos",
    grupo: "notas",
    descricao: "Nota com oportunidade + contato",
    exec: async (c) => {
      if (!c.estado.contatoA || !c.estado.opId) return nao("falta o contato A ou uma oportunidade");
      const r = await c.req("POST", "/publicacao/", { corpo: { assunto: `${c.prefixo} nota com dois vínculos`, descricao: `${c.prefixo} nota com dois vínculos`, contato: { id: c.estado.contatoA }, oportunidade: { id: c.estado.opId } } });
      return okSe(r, { chavesDaResposta: chavesDe(r.json) });
    },
  },
  {
    id: "notas.formato-html",
    grupo: "notas",
    descricao: "\\n e <br>, e as tags HTML que ficam ou somem (lê de volta)",
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const enviado = "linha1\nlinha2<br>linha3 <b>negrito</b> <i>italico</i> <a href=\"https://example.com\">link</a> <script>x()</script> &amp; fim";
      const r = await c.req("POST", "/publicacao/", { corpo: { assunto: `${c.prefixo} formato`, descricao: enviado, contato: { id: c.estado.contatoA } } });
      const id = idDe(r.json);
      if (!r.ok || !id) return okSe(r, {});
      const lido = String(obj((await c.req("GET", `/publicacao/${segmento(id)}`)).json).descricao ?? "");
      return saida("observar", {
        status: r.status,
        quebraDeLinhaPreservada: lido.includes("linha1\nlinha2"),
        brPreservado: lido.includes("<br>"),
        negritoPreservado: lido.includes("<b>"),
        italicoPreservado: lido.includes("<i>"),
        linkPreservado: lido.includes("<a "),
        scriptPreservado: lido.includes("<script"),
        entidadePreservada: lido.includes("&amp;"),
        sha256Enviado: sha256(enviado),
        sha256Lido: sha256(lido),
        tamanhoEnviado: enviado.length,
        tamanhoLido: lido.length,
      });
    },
  },
  ...[10_000, 50_000, 100_000].map<Definicao>((n) => ({
    id: `notas.tamanho-${n / 1000}k`,
    grupo: "notas",
    descricao: `Nota de ${n / 1000} mil caracteres com acentos: lê de volta e compara sha256 e tamanho`,
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const texto = textoDeTamanho(n);
      const r = await c.req("POST", "/publicacao/", { corpo: { assunto: `${c.prefixo} tamanho ${n}`, descricao: texto, contato: { id: c.estado.contatoA } } });
      const id = idDe(r.json);
      if (!r.ok || !id) return okSe(r, { tamanhoEnviado: texto.length });
      const lido = String(obj((await c.req("GET", `/publicacao/${segmento(id)}`)).json).descricao ?? "");
      // Um corte pode ser silencioso: o POST volta 200 e o texto grava cortado.
      return saida(lido === texto ? "ok" : "observar", {
        status: r.status,
        tamanhoEnviado: texto.length,
        tamanhoLido: lido.length,
        sha256Enviado: sha256(texto),
        sha256Lido: sha256(lido),
        igual: lido === texto,
        cortado: lido.length < texto.length,
      });
    },
  })),
  {
    id: "notas.autor-e-data",
    grupo: "notas",
    descricao: "`autor` e `dataCriacao` enviados são respeitados?",
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const alvo = c.estado.outroUsuarioId ?? c.estado.usuarioId;
      const dataPassada = "2020-01-15T10:00:00-03:00";
      const r = await c.req("POST", "/publicacao/", {
        corpo: { assunto: `${c.prefixo} autor e data`, descricao: `${c.prefixo} autor e data`, contato: { id: c.estado.contatoA }, dataCriacao: dataPassada, ...(alvo ? { autor: { id: alvo } } : {}) },
      });
      const id = idDe(r.json);
      if (!r.ok || !id) return okSe(r, {});
      const lida = obj((await c.req("GET", `/publicacao/${segmento(id)}`)).json);
      return saida("observar", {
        status: r.status,
        autorInformado: Boolean(alvo),
        autorRespeitado: alvo ? idDe(lida.autor) === alvo : null,
        dataRespeitada: typeof lida.dataCriacao === "string" && lida.dataCriacao.startsWith("2020-01-15"),
      });
    },
  },
  {
    id: "notas.comentario",
    grupo: "notas",
    descricao: "POST /publicacao/{id}/comentario e GET /publicacao/{id}/comentarios",
    exec: async (c) => {
      if (!c.estado.notaId) return nao("nenhuma nota foi criada");
      const id = segmento(c.estado.notaId);
      const r = await c.req("POST", `/publicacao/${id}/comentario`, { corpo: { descricao: `${c.prefixo} comentário` } });
      const lista = await c.req("GET", `/publicacao/${id}/comentarios`);
      return saida(r.ok ? "ok" : "falhou", { status: r.status, statusLista: lista.status, comentarios: listaDe(lista.json)?.length ?? null, ...(r.trecho ? { erro: r.trecho } : {}) });
    },
  },
  {
    id: "notas.ordem-da-lista",
    grupo: "notas",
    descricao: "Ordem do GET /publicacao/: cria 5 notas em sequência e lista (a mais nova vem primeiro? tem dataCriacao? tamanho da página?)",
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const criados: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const r = await c.req("POST", "/publicacao/", { corpo: { assunto: `${c.prefixo} ordem ${i}`, descricao: `${c.prefixo} ordem ${i}`, contato: { id: c.estado.contatoA } } });
        const id = idDe(r.json);
        if (r.ok && id) criados.push(id);
      }
      const p1 = await c.req("GET", "/publicacao/", { query: { page: 1 } });
      const p2 = await c.req("GET", "/publicacao/", { query: { page: 2 } });
      const itens = (listaDe(p1.json) ?? []).map(obj);
      const ids = itens.map(idDe);
      const datas = itens.map((n) => (typeof n.dataCriacao === "string" ? Date.parse(n.dataCriacao) : Number.NaN));
      const desc = datas.length > 1 && datas.every((d, i) => i === 0 || (!Number.isNaN(d) && !Number.isNaN(datas[i - 1]!) && d <= datas[i - 1]!));
      const posicoes = criados.map((id) => ids.indexOf(id));
      return saida(p1.ok ? "observar" : "falhou", {
        statusPagina1: p1.status,
        tamanhoDaPagina: itens.length,
        statusPagina2: p2.status,
        tamanhoDaPagina2: listaDe(p2.json)?.length ?? null,
        todasTemDataCriacao: itens.length > 0 && datas.every((d) => !Number.isNaN(d)),
        ordemDecrescentePorData: desc,
        criadasNaPagina1: posicoes.filter((p) => p >= 0).length,
        // A última criada vem primeiro? (posição 0 é a mais nova).
        ultimaCriadaEhAPrimeira: criados.length > 0 && ids[0] === criados[criados.length - 1],
        chavesDaNota: chavesDe(itens),
      });
    },
  },
  {
    id: "notas.x-no-webhook",
    grupo: "notas",
    descricao: "Cabeçalho X-No-Webhook aceito?",
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const r = await c.req("POST", "/publicacao/", { corpo: { assunto: `${c.prefixo} sem webhook`, descricao: `${c.prefixo} sem webhook`, contato: { id: c.estado.contatoA } }, cabecalho: { "X-No-Webhook": "true" } });
      return saida(r.ok ? "observar" : "falhou", { status: r.status, aceito: r.ok, ...(r.trecho ? { erro: r.trecho } : {}) });
    },
  },

  // ─── Arquivos (só com a pasta de arquivos de teste) ───────────────────────
  {
    id: "arquivos.tipos",
    grupo: "arquivos",
    descricao: "incluirComAnexos com cada tipo de arquivo (pdf, jpg, png, ogg, mp3, m4a, wav, mp4)",
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      if (c.arquivos.length === 0) return nao("sem arquivos de teste na pasta");
      const observado: Record<string, unknown> = {};
      let algum = false;
      for (const a of c.arquivos) {
        const r = await enviarAnexos(c, [a], `tipo ${a.nome}`);
        algum ||= r.ok;
        observado[a.nome] = { status: r.status, aceito: r.ok, anexosNaResposta: contarAnexos(r.json), ...(r.trecho ? { erro: r.trecho } : {}) };
      }
      return saida(algum ? "observar" : "falhou", observado);
    },
  },
  {
    id: "arquivos.tamanhos",
    grupo: "arquivos",
    descricao: "Arquivos de 5, 20 e 25 MB (aceitos) e de 50 e 80 MB (espera-se erro)",
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const base = c.arquivos.find((a) => a.nome.toLowerCase().endsWith(".pdf")) ?? c.arquivos[0];
      if (!base) return nao("sem arquivos de teste na pasta");
      const observado: Record<string, unknown> = {};
      for (const mb of [5, 20, 25, 50, 80]) {
        const grande = blobDeTamanho(base.blob, mb * 1024 * 1024);
        const r = await enviarAnexos(c, [{ nome: `teste-${mb}mb${extensao(base.nome)}`, tipo: base.tipo, blob: grande }], `tamanho ${mb} MB`);
        observado[`${mb}MB`] = { status: r.status, aceito: r.ok, ...(r.trecho ? { erro: r.trecho } : {}) };
      }
      return saida("observar", observado);
    },
  },
  {
    id: "arquivos.varios",
    grupo: "arquivos",
    descricao: "Vários arquivos numa chamada",
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      if (c.arquivos.length < 2) return nao("precisa de pelo menos 2 arquivos de teste na pasta");
      const r = await enviarAnexos(c, c.arquivos.slice(0, 5), `vários ${Math.min(5, c.arquivos.length)}`);
      return saida(r.ok ? "observar" : "falhou", { status: r.status, enviados: Math.min(5, c.arquivos.length), anexosNaResposta: contarAnexos(r.json), ...(r.trecho ? { erro: r.trecho } : {}) });
    },
  },
  {
    id: "arquivos.extensao-proibida",
    grupo: "arquivos",
    descricao: "Uma nota com 1 arquivo de extensão proibida (.exe de 1 KB) e 1 PDF permitido: o que volta?",
    exec: async (c) => {
      if (!c.estado.contatoA) return nao("o contato A não foi criado");
      const pdf = c.arquivos.find((a) => a.nome.toLowerCase().endsWith(".pdf"));
      if (!pdf) return nao("sem teste.pdf na pasta");
      const exe: ArquivoDeTeste = { nome: "teste.exe", tipo: "application/octet-stream", blob: new Blob([new Uint8Array(1024)]) };
      const r = await enviarAnexos(c, [exe, pdf], "extensão proibida");
      return saida("observar", { status: r.status, aceito: r.ok, anexosNaResposta: contarAnexos(r.json), ...(r.trecho ? { erro: r.trecho } : {}) });
    },
  },

  // ─── Limites ──────────────────────────────────────────────────────────────
  {
    id: "limites.cabecalhos",
    grupo: "limites",
    descricao: "429 visto na rodada? Nomes dos cabeçalhos de limite, se vieram",
    exec: async (c) =>
      saida("observar", {
        respostas429: c.vistos429,
        cabecalhosDeLimiteVistos: [...c.cabecalhosDeLimite].sort(),
        chamadasAteAqui: c.chamadas,
        nota: "sem teste de carga de propósito: a conta de teste também tem cota. A resposta de cota esgotada vem do suporte (pergunta 18).",
      }),
  },
];

/** Cabeçalhos que costumam trazer o limite de chamadas. Só o NOME vai para o relatório. */
const CABECALHOS_DE_LIMITE = [
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-rate-limit-limit",
  "x-rate-limit-remaining",
  "x-rate-limit-reset",
];

const extensao = (nome: string) => (nome.includes(".") ? nome.slice(nome.lastIndexOf(".")) : "");

/** Um Blob do tamanho pedido, repetindo o de origem (sem copiar tudo para a memória de uma vez). */
function blobDeTamanho(origem: Blob, bytes: number): Blob {
  if (origem.size === 0) return new Blob([new Uint8Array(bytes)]);
  const partes: Blob[] = [];
  let total = 0;
  while (total + origem.size <= bytes) {
    partes.push(origem);
    total += origem.size;
  }
  if (total < bytes) partes.push(origem.slice(0, bytes - total));
  return new Blob(partes);
}

function contarAnexos(json: unknown): number | null {
  const a = obj(json).anexos;
  if (Array.isArray(a)) return a.length;
  return a && typeof a === "object" ? 1 : null;
}

/** POST /publicacao/incluirComAnexos: o campo `publicacao` (texto JSON) e os `anexos` (arquivos). */
async function enviarAnexos(c: Ctx, arquivos: ArquivoDeTeste[], rotulo: string): Promise<Resp> {
  const form = new FormData();
  form.append("publicacao", JSON.stringify({ assunto: `${c.prefixo} anexo ${rotulo}`, descricao: `${c.prefixo} anexo ${rotulo}`, contato: { id: c.estado.contatoA } }));
  for (const a of arquivos) form.append("anexos", a.blob, a.nome);
  return c.req("POST", "/publicacao/incluirComAnexos", { multipart: form });
}

/** Payload do JWT (base64url), ou null se o token não for um JWT. Nunca devolve valores além do `exp`. */
function resumoDoJwt(token: string): Record<string, unknown> {
  const partes = token.split(".");
  if (partes.length !== 3) return { ehJwt: false };
  try {
    const payload = JSON.parse(Buffer.from(partes[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const exp = typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
    return {
      ehJwt: true,
      chavesDoPayload: Object.keys(payload).sort(),
      temUsuarioMasterId: "usuarioMasterId" in payload,
      temExp: exp !== null,
      expiraEm: exp && !Number.isNaN(exp.getTime()) ? exp.toISOString() : null,
    };
  } catch {
    return { ehJwt: false, motivo: "o payload não é JSON" };
  }
}

/** Tira do relatório qualquer coisa que não pode sair: o token, o telefone em qualquer formato e e-mail que não seja de @example.com. */
function limpar(observado: Record<string, unknown>, segredos: string[]): Record<string, unknown> {
  let texto = JSON.stringify(observado);
  for (const s of segredos) if (s.length >= 6) texto = texto.split(s).join("<removido>");
  texto = texto.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (e) => (e.toLowerCase().endsWith("@example.com") ? e : "<e-mail>"));
  return JSON.parse(texto) as Record<string, unknown>;
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** AAAAMMDD-HHMM em UTC. */
function carimbo(d: Date): string {
  const iso = d.toISOString(); // 2026-09-30T14:05:00.000Z
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
}

export async function rodarHomologacao(opts: {
  token: string;
  telefone: string | null;
  transporte?: TransporteNectar;
  pausaMs?: number;
  arquivos?: ArquivoDeTeste[];
  agora?: () => Date;
  tetoChamadas?: number;
}): Promise<{ casos: ResultadoCaso[]; chamadas: number; checklistVisual: string[] }> {
  const agora = opts.agora ?? (() => new Date());
  const pausaMs = opts.pausaMs ?? PAUSA_PADRAO_MS;
  const teto = opts.tetoChamadas ?? TETO_PADRAO;
  const prefixo = `CRMAGRO TESTE HOMOLOGACAO ${carimbo(agora())}`;
  const base: TransporteNectar | undefined = opts.transporte;

  let ultima: { status: number; texto: string } | null = null;
  let cabecalhoExtra: Record<string, string> | null = null;
  // O cliente converte qualquer erro do transporte em erro de rede: o teto é marcado aqui e relançado no `req`.
  let tetoAtingido = false;
  const ctx: Ctx = {
    prefixo,
    jwt: resumoDoJwt(opts.token),
    telefone: opts.telefone,
    arquivos: opts.arquivos ?? [],
    estado: {},
    chamadas: 0,
    vistos429: 0,
    cabecalhosDeLimite: new Set(),
    email: (n) => `homologacao+${n}@example.com`,
    req: async (metodo, caminho, o = {}) => {
      cabecalhoExtra = o.cabecalho ?? null;
      try {
        let dados: unknown;
        if (metodo === "GET") dados = await cliente.get(caminho, z.unknown(), o.query);
        else if (metodo === "PUT") dados = await cliente.put(caminho, o.corpo ?? {}, z.unknown());
        else if (o.multipart) dados = await cliente.postMultipart(caminho, o.multipart, z.unknown());
        else dados = await cliente.post(caminho, o.corpo ?? {}, z.unknown());
        return { ok: true, status: ultima?.status ?? 200, json: dados, trecho: null };
      } catch (e) {
        if (tetoAtingido || e instanceof HomologacaoTeto) throw new HomologacaoTeto();
        if (e instanceof ErroCrm) {
          if (e.status === 401) throw new HomologacaoAbortada();
          // O corpo do erro só entra no relatório como trecho seguro (sem dígitos nem e-mail).
          return { ok: false, status: e.status ?? 0, json: null, trecho: trechoSeguro(ultima?.texto || e.message) };
        }
        throw e;
      } finally {
        cabecalhoExtra = null;
      }
    },
  };

  /** Transporte com a pausa, o teto, o cabeçalho extra e a captura do que o relatório precisa (sem guardar corpo). */
  const contado: TransporteNectar = async (p: PedidoNectar): Promise<RespostaNectar> => {
    if (ctx.chamadas >= teto) {
      tetoAtingido = true;
      throw new HomologacaoTeto();
    }
    if (ctx.chamadas > 0 && pausaMs > 0) await dormir(pausaMs);
    ctx.chamadas += 1;
    const pedido = cabecalhoExtra ? { ...p, cabecalhos: { ...p.cabecalhos, ...cabecalhoExtra } } : p;
    ultima = null;
    const r = await (base ?? transportePadrao)(pedido);
    ultima = { status: r.status, texto: r.texto };
    if (r.status === 429) ctx.vistos429 += 1;
    for (const nome of CABECALHOS_DE_LIMITE) if (r.cabecalho(nome) !== null) ctx.cabecalhosDeLimite.add(nome);
    return r;
  };
  const cliente: ClienteNectar = criarClienteNectar({ token: opts.token, transporte: contado });

  const segredos = [opts.token, ...(opts.telefone ? [opts.telefone, opts.telefone.replace(/\D/g, ""), ...variantesDoTelefone(opts.telefone)] : [])];
  const casos: ResultadoCaso[] = [];
  let parada: string | null = null;

  // O primeiro caso chama a API (prova o token); por isso um 401 marca o primeiro caso como "falhou".
  for (const def of CATALOGO) {
    const cabecalho = { id: def.id, grupo: def.grupo, descricao: def.descricao };
    if (parada) {
      casos.push({ ...cabecalho, resultado: "nao_testado", observado: { motivo: parada } });
      continue;
    }
    try {
      const r = await def.exec(ctx);
      casos.push({ ...cabecalho, resultado: r.resultado, observado: limpar(r.observado, segredos) });
    } catch (e) {
      if (e instanceof HomologacaoAbortada) {
        casos.push({ ...cabecalho, resultado: "falhou", observado: { status: 401, motivo: "o Nectar recusou o token" } });
        parada = "abortado: o Nectar recusou o token (401)";
      } else if (e instanceof HomologacaoTeto) {
        casos.push({ ...cabecalho, resultado: "nao_testado", observado: { motivo: `teto de ${teto} chamadas` } });
        parada = `não rodou: teto de ${teto} chamadas atingido`;
      } else {
        casos.push({ ...cabecalho, resultado: "falhou", observado: { erro: trechoSeguro(e instanceof Error ? e.message : String(e)) } });
      }
    }
  }
  return { casos, chamadas: ctx.chamadas, checklistVisual: [...CHECKLIST_VISUAL] };
}
