/**
 * Mapper CRM Agro → Nectar (plano §2.3 a §2.7). PURO: sem I/O. Ficha N3.
 *
 * Regra que manda em tudo aqui: o CRM Agro NUNCA apaga nada no Nectar. O `PUT` do
 * Nectar substitui a lista inteira e apaga campo enviado vazio (`null`, `""`,
 * `[]`, `{}`). Por isso:
 * - campo vazio no CRM Agro nunca vai;
 * - listas (e-mails, telefones, etiquetas) só crescem: o mapper recebe o
 *   contato remoto lido antes e devolve a lista COMPLETA (o que já estava lá
 *   mais o novo), ou nada quando não há nada novo;
 * - o `codigo` só vai no POST de um contato criado pelo CRM Agro.
 *
 * Regra da pasta `providers/nectarcrm/`: só importa `zod`, tipos e `node:crypto`.
 */
import type {
  ContatoLocal,
  ContatoRemoto,
  ContatoSaida,
  FormatoTelefone,
  OportunidadeSaida,
  QualificacaoSaida,
  ResponsavelSaida,
} from "../../contract";
import { CrmRequisitoFaltando } from "../../errors";
import { mesmoTelefone, telefoneNoFormato, variantesDoTelefone } from "./telefone";

const LIMITE_TEXTO = 255;
const LIMITE_LINKEDIN = 50;
/** Acima disso a nota é dividida em partes (o limite real da `descricao` é a homologar, plano §2.7). */
export const LIMITE_NOTA = 20_000;

/** Formatador criado UMA vez (criar `Intl.DateTimeFormat` a cada chamada custou 87% da carga de outro app). */
const FORMATADOR_DATA = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const cortar = (texto: string, max: number) => texto.slice(0, max);
const vazio = (v: string | null | undefined) => v == null || v.trim() === "";

/** "nome sobrenome", cortado em 255. */
export function nomeCompleto(nome: string, sobrenome: string | null): string {
  return cortar([nome, sobrenome ?? ""].map((p) => p.trim()).filter(Boolean).join(" "), LIMITE_TEXTO);
}

/** Sem repetir (comparando em minúsculas) e sem vazios; guarda a grafia da primeira ocorrência. */
function unicos(valores: string[], normalizar: (v: string) => string): string[] {
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const bruto of valores) {
    const v = bruto.trim();
    if (!v) continue;
    const chave = normalizar(v);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(v);
  }
  return saida;
}

const minusculo = (v: string) => v.toLowerCase();

/** Contato novo, no formato do Nectar. Campo vazio nunca vai. */
export function contatoParaCriacao(
  local: ContatoLocal,
  opts: {
    constantePadrao: 0 | 1 | 2 | 3 | 5;
    cpfLigado: boolean;
    formatoPreferido: FormatoTelefone;
    enderecoLiberado: boolean;
    responsavel?: ResponsavelSaida;
    empresaAtualId?: string;
  },
): { saida: ContatoSaida; avisos: string[] } {
  const avisos: string[] = [];
  const saida: ContatoSaida = {
    nome: nomeCompleto(local.nome, local.sobrenome),
    // Só quem já é cliente no CRM Agro vira 0. Os demais, inclusive opt-out, vão com a constante padrão da conexão.
    constante: local.relacionamentoStatus === "cliente" ? 0 : opts.constantePadrao,
    ativo: true,
    codigo: local.id, // só na criação
  };

  const emails = unicos(local.emails.map(minusculo), minusculo);
  if (emails.length) saida.emails = emails;

  const telefones = unicos(
    local.telefonesE164.map((t) => telefoneNoFormato(t, opts.formatoPreferido)),
    (v) => v,
  );
  if (telefones.length) saida.telefones = telefones;

  const tags = unicos(local.tagNomes, minusculo);
  if (tags.length) saida.listas = tags.map((nome) => ({ nome }));

  const linkedin = local.linkedin?.trim();
  if (linkedin) {
    if (linkedin.length <= LIMITE_LINKEDIN) saida.linkedin = linkedin;
    else avisos.push("LinkedIn com mais de 50 caracteres: foi só na Ficha do CRM Agro");
  }
  if (opts.cpfLigado && !vazio(local.cpf)) saida.cpf = local.cpf!.trim();
  if (!vazio(local.cargo)) saida.cargo = cortar(local.cargo!.trim(), LIMITE_TEXTO);
  if (!vazio(local.origem)) saida.origem = cortar(local.origem!.trim(), LIMITE_TEXTO);
  // Faturamento zero é "não informado" no CRM Agro: não vai (campo vazio nunca vai).
  if (local.faturamentoAnual != null && Number.isFinite(local.faturamentoAnual) && local.faturamentoAnual > 0) {
    saida.receitaAnual = local.faturamentoAnual;
  }

  if (opts.responsavel?.responsavel) saida.responsavel = opts.responsavel.responsavel;
  if (opts.responsavel?.queue) saida.queue = opts.responsavel.queue;
  if (opts.empresaAtualId) saida.empresaAtual = { id: opts.empresaAtualId };

  // Antes da homologação o endereço vai na Ficha do CRM Agro, não em campo do Nectar (G6-D7).
  if (opts.enderecoLiberado) {
    if (!vazio(local.cidade)) saida.regiaoMunicipio = local.cidade!.trim();
    if (!vazio(local.estado)) saida.regiaoEstado = local.estado!.trim();
  }
  return { saida, avisos };
}

/**
 * O que mandar num `PUT` de contato: só as chaves que mudam, com as listas
 * JÁ UNIDAS ao que o Nectar tem. Devolve `null` quando nada muda.
 * - listas só crescem (e-mail e etiqueta sem diferença de maiúscula; telefone
 *   por variantes);
 * - contato criado pelo CRM Agro: os campos de `manterAtualizados` são
 *   sobrescritos quando o local não está vazio e é diferente;
 * - contato que já existia no Nectar: só PREENCHE o que está vazio lá;
 * - nunca manda `codigo` e nunca troca nome, cargo nem empresa já preenchidos
 *   de um contato que já existia.
 *
 * "responsavel" e "endereco" em `manterAtualizados` ainda não têm efeito aqui:
 * o contato remoto (`ContatoRemoto`) não os traz, então não há como comparar.
 * Entram quando a homologação (N20) confirmar onde o Nectar os devolve. O
 * mesmo vale para o CPF: `cpfLigado` fica na assinatura para o N10a, mas o
 * `ContatoRemoto` não traz o CPF, então não há como saber se está vazio lá.
 */
export function atualizacaoDeContato(
  remoto: ContatoRemoto,
  local: ContatoLocal,
  opts: {
    criadoPeloCrmAgro: boolean;
    manterAtualizados: ("nome" | "cargo" | "responsavel" | "endereco")[];
    cpfLigado: boolean;
    formatoPreferido: FormatoTelefone;
    /** Empresa (contato-empresa) já resolvida; só preenche se a pessoa não tiver empresa lá. */
    empresaAtualId?: string;
  },
): Partial<ContatoSaida> | null {
  const mudanca: Partial<ContatoSaida> = {};

  // E-mails: o que já está lá + o que falta.
  const emailsRemotos = new Set(remoto.emails.map(minusculo));
  const emailsNovos = unicos(local.emails.map(minusculo), minusculo).filter((e) => !emailsRemotos.has(e));
  if (emailsNovos.length) mudanca.emails = [...remoto.emails, ...emailsNovos];

  // Telefones: o local não entra se QUALQUER variante dele já está no Nectar.
  const telefonesNovos = unicos(
    local.telefonesE164
      .filter((t) => !remoto.telefones.some((r) => mesmoTelefone(r, variantesDoTelefone(t))))
      .map((t) => telefoneNoFormato(t, opts.formatoPreferido)),
    (v) => v,
  );
  if (telefonesNovos.length) mudanca.telefones = [...remoto.telefones, ...telefonesNovos];

  // Etiquetas: pelo nome, sem diferença de maiúscula; manda a lista inteira.
  const listasRemotas = new Set(remoto.listas.map(minusculo));
  const listasNovas = unicos(local.tagNomes, minusculo).filter((n) => !listasRemotas.has(n.toLowerCase()));
  if (listasNovas.length) mudanca.listas = [...remoto.listas, ...listasNovas].map((nome) => ({ nome }));

  // Nome e cargo: preenche o vazio; sobrescreve só se o CRM Agro criou o contato e o admin pediu "manter atualizado".
  const nomeLocal = nomeCompleto(local.nome, local.sobrenome);
  if (nomeLocal && (vazio(remoto.nome) || (opts.criadoPeloCrmAgro && opts.manterAtualizados.includes("nome") && nomeLocal !== remoto.nome))) {
    mudanca.nome = nomeLocal;
  }
  const cargoLocal = local.cargo?.trim() ? cortar(local.cargo.trim(), LIMITE_TEXTO) : "";
  if (cargoLocal && (vazio(remoto.cargo) || (opts.criadoPeloCrmAgro && opts.manterAtualizados.includes("cargo") && cargoLocal !== remoto.cargo))) {
    mudanca.cargo = cargoLocal;
  }

  // Empresa: só se a pessoa não tem empresa lá (nunca troca uma já preenchida).
  if (opts.empresaAtualId && remoto.empresaAtualId == null) mudanca.empresaAtual = { id: opts.empresaAtualId };

  return Object.keys(mudanca).length ? mudanca : null;
}

/** "{nome} ({empresa})", ou só "{nome}". Sem travessão (AGENTS.md (texto da interface)). */
export function modeloDoNomeDoCard(nomeContato: string, empresa?: string | null): string {
  const nome = nomeContato.trim();
  const emp = empresa?.trim();
  return emp ? `${nome} (${emp})` : nome;
}

const PREFIXO_OPT_OUT = "[OPT-OUT] ";

function nomeDoCard(nomeCard: string, optOut: boolean): string {
  return cortar((optOut ? PREFIXO_OPT_OUT : "") + nomeCard, LIMITE_TEXTO);
}

function comResponsavel<T extends object>(base: T, responsavel?: ResponsavelSaida): T & ResponsavelSaida {
  const saida: T & ResponsavelSaida = { ...base };
  if (responsavel?.responsavel) saida.responsavel = responsavel.responsavel;
  if (responsavel?.queue) saida.queue = responsavel.queue;
  return saida;
}

/** Oportunidade (vendas). B2B com empresa: `cliente` é a empresa e `contato` é a pessoa; nos outros casos `cliente` é a pessoa. Sem `status`. */
export function oportunidadeParaCriacao(p: {
  nomeCard: string;
  pessoaId: string;
  empresaId?: string;
  funil: { id: string; modeloVenda: "b2b" | "b2c" };
  etapaSequencia: number;
  valor?: number | null;
  responsavel?: ResponsavelSaida;
  optOut: boolean;
}): OportunidadeSaida {
  const b2bComEmpresa = p.funil.modeloVenda === "b2b" && Boolean(p.empresaId);
  const base: OportunidadeSaida = {
    nome: nomeDoCard(p.nomeCard, p.optOut),
    cliente: { id: b2bComEmpresa ? p.empresaId! : p.pessoaId },
    funilVenda: { id: p.funil.id },
    etapa: p.etapaSequencia,
  };
  if (b2bComEmpresa) base.contato = { id: p.pessoaId };
  if (p.valor != null && Number.isFinite(p.valor) && p.valor > 0) base.valorAvulso = p.valor;
  return comResponsavel(base, p.responsavel);
}

/** Qualificação da pré-venda: `cliente` é a pessoa e `status` é 1 (em andamento). */
export function qualificacaoParaCriacao(p: {
  nomeCard: string;
  pessoaId: string;
  funil: { id: string };
  etapaSequencia: number;
  responsavel?: ResponsavelSaida;
  optOut: boolean;
}): QualificacaoSaida {
  return comResponsavel(
    {
      nome: nomeDoCard(p.nomeCard, p.optOut),
      cliente: { id: p.pessoaId },
      funilVenda: { id: p.funil.id },
      etapa: p.etapaSequencia,
      status: 1 as const,
    },
    p.responsavel,
  );
}

/** Escapa o texto do usuário: ele nunca é concatenado como HTML. */
export function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** "29/09/2026 14:05" no fuso de São Paulo. */
function dataHoraSP(d: Date): string {
  const partes = Object.fromEntries(FORMATADOR_DATA.formatToParts(d).map((p) => [p.type, p.value]));
  return `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`;
}

/**
 * Monta a nota do histórico: assunto (255) e a descrição em HTML escapado, já
 * dividida em partes quando passa de 20 mil caracteres. A primeira linha diz
 * quando aconteceu no CRM Agro e quem fez (o Nectar grava a nota com o usuário do
 * token e a hora do envio); a última leva o marcador "[CRM Agro #<marcador>]",
 * que o CRM Agro usa para resolver sozinho uma nota sem resposta (plano §4.5).
 * Em várias partes, cada uma começa com "(parte i de n)" e termina com
 * "[CRM Agro #<marcador>:<i>]".
 */
export function montarNota(p: {
  assunto: string;
  aconteceuEm: Date;
  autorNome: string | null;
  linhas: string[];
  marcador: string;
}): { assunto: string; partes: string[] } {
  const autor = p.autorNome?.trim() ? `por ${p.autorNome.trim()}` : "autor não registrado";
  const primeira = escaparHtml(`Aconteceu no CRM Agro em ${dataHoraSP(p.aconteceuEm)} · ${autor}`);
  const assunto = cortar(p.assunto, LIMITE_TEXTO);
  // Cada linha do usuário pode ter quebras: cada quebra vira uma unidade (<br> entre elas).
  const unidades = p.linhas.flatMap((l) => l.split(/\r?\n/));

  const unica = [primeira, ...unidades.map(escaparHtml), `[CRM Agro #${p.marcador}]`].join("<br>");
  if (unica.length <= LIMITE_NOTA) return { assunto, partes: [unica] };

  // Divide o TEXTO CRU e escapa cada pedaço (nunca corta no meio de "&amp;").
  // Reserva o pior caso do cabeçalho e do rodapé ("(parte 999 de 999)" e ":999").
  const sobra = "(parte 999 de 999)".length + primeira.length + `[CRM Agro #${p.marcador}:999]`.length + 3 * "<br>".length;
  const espaco = Math.max(200, LIMITE_NOTA - sobra);
  const blocos: string[] = []; // HTML já escapado, cada um cabe em `espaco`
  for (const unidade of unidades) {
    let resto = unidade;
    do {
      let ate = 0;
      let tamanho = 0;
      while (ate < resto.length) {
        const passo = escaparHtml(resto[ate]!).length;
        if (tamanho + passo > espaco) break;
        tamanho += passo;
        ate += 1;
      }
      // `ate` nunca fica em 0 (o espaço mínimo é de 200 e o pior caractere escapado tem 6).
      blocos.push(escaparHtml(resto.slice(0, ate)));
      resto = resto.slice(ate);
    } while (resto.length > 0);
  }

  const corpos: string[][] = [[]];
  let usado = 0;
  for (const bloco of blocos) {
    const custo = bloco.length + "<br>".length;
    if (usado + custo > espaco && corpos[corpos.length - 1]!.length > 0) {
      corpos.push([]);
      usado = 0;
    }
    corpos[corpos.length - 1]!.push(bloco);
    usado += custo;
  }
  const n = corpos.length;
  const partes = corpos.map((corpo, i) =>
    [`(parte ${i + 1} de ${n})`, primeira, ...corpo, `[CRM Agro #${p.marcador}:${i + 1}]`].join("<br>"),
  );
  return { assunto, partes };
}

/** Compara ids do Nectar: numérico quando os dois forem números (sem perder precisão), senão como texto. */
function compararIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * O Nectar já tinha o contato repetido: o CRM Agro escolhe sozinho, sem parar o
 * envio (plano §2.4). Critérios, nesta ordem: quantos identificadores casam
 * (e-mail em minúsculas; telefone por variantes), depois quem já tem card no
 * funil de destino, depois o mais antigo (menor id).
 */
export function escolherEntreRepetidos(
  candidatos: { id: string; emails: string[]; telefones: string[]; temCardNoFunil: boolean }[],
  local: { emails: string[]; telefonesE164: string[] },
): { escolhido: string; outros: string[] } {
  if (candidatos.length === 0) throw new CrmRequisitoFaltando("nenhum contato candidato para escolher");
  const emailsLocais = new Set(local.emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const pontuar = (c: { emails: string[]; telefones: string[] }) => {
    const emails = new Set(c.emails.map((e) => e.trim().toLowerCase()));
    let pontos = 0;
    for (const e of emailsLocais) if (emails.has(e)) pontos += 1;
    for (const t of local.telefonesE164) {
      const variantes = variantesDoTelefone(t);
      if (c.telefones.some((r) => mesmoTelefone(r, variantes))) pontos += 1;
    }
    return pontos;
  };
  const ordenados = candidatos
    .map((c) => ({ id: c.id, pontos: pontuar(c), card: c.temCardNoFunil }))
    .sort((a, b) => b.pontos - a.pontos || Number(b.card) - Number(a.card) || compararIds(a.id, b.id));
  return { escolhido: ordenados[0]!.id, outros: ordenados.slice(1).map((c) => c.id) };
}
