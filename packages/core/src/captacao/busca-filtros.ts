import { randomUUID } from "node:crypto";
import { z } from "zod";
import { basePrisma, db, getCurrentTeamId, nomeBuscaLugar, runAsSystem } from "@crmagro/db";
import {
  FILTROS_LOCAIS_PADRAO,
  MINHA_RECEITA_POR_PAGINA,
  aprovaRegistro,
  buscarPaginaMinhaReceita,
  resultadoDoRegistro,
  socioDoRegistro,
  type CnpjResult,
  type FiltrosLocais,
  type PaginaDeBusca,
  type PorteEmpresa,
} from "@crmagro/captation";
import { requireCan } from "../auth/authz";
import { donoPadrao } from "../tenancy/escopo";
import { palavrasDoDominio, exigeEmail, decidirPorEmail } from "./email-filtros";
import { cnpjsJaCadastrados, cnpjsPendentesNaFila } from "./ja-cadastradas";
import { lerStatusCaptura, paradaPedida } from "./status";
import { escopoRascunho } from "./escopo";
import { consultarCnpjDetalhado, draftDoCnpj } from "./cnpj";
import { CapturaFalhou, type Coletor } from "./execucao";
import type { DraftInput } from "./service";
import { enqueueCapture, type CaptureJob } from "./queue";
import { CNPJ_LOTE_MAX } from "./service";
import { OPCOES_DA_BUSCA_ANTIGAS, type ContinuacaoDaBusca, type OpcoesDaBusca } from "./busca-tipos";

/**
 * Busca de empresas POR FILTRO (aba "Por filtros" da captação por CNPJ).
 *
 * Tudo cai na MESMA fila de revisão (`ProspectDraft`, origem `cnpj`): nada vira contato
 * sem o OK da pessoa. A busca roda no worker (leva minutos e a fonte é lenta), com
 * pausa entre páginas e um teto de tempo.
 *
 * Fonte: Minha Receita (gratuita, sem garantia de serviço, filtra por CNAE, UF e
 * município). Porte, capital social, situação, data de abertura e "sem empresário
 * individual/MEI" são nossos (`aprovaRegistro`). Faturamento não existe em fonte
 * pública (a Receita só publica porte e capital social).
 */

export const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI",
  "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
] as const;

export const BUSCA_CNAES_MAX = 10;
export const BUSCA_CIDADES_MAX = 20;
/** Teto de empresas LIDAS na fonte por busca (os filtros locais descartam parte): evita varrer o país por um filtro apertado. */
export const BUSCA_LIDAS_MAX = 5_000;
/** Pausa entre páginas da fonte (fonte voluntária e sem garantia: ritmo baixo). */
export const BUSCA_PAUSA_PAGINA_MS = 1_500;
export const BUSCA_PADRAO_LIMITE = 100;

/** Erro de filtro que a pessoa pode corrigir (a mensagem já vai para a tela). */
export class FiltroInvalido extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FiltroInvalido";
  }
}

/** Não há busca anterior que dê para continuar (acabou, ou o resultado expirou). */
export class BuscaSemContinuacao extends Error {
  constructor() {
    super("Não há mais o que buscar com esses filtros.");
    this.name = "BuscaSemContinuacao";
  }
}

const dataIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "data no formato AAAA-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "data inválida");

/** O que a tela manda. Texto livre onde a pessoa digita (CNAE, cidade); o resto já vem estruturado. */
export const filtrosDaTelaSchema = z.object({
  cnaes: z.array(z.string().max(30)).max(BUSCA_CNAES_MAX).default([]),
  ufs: z.array(z.string().length(2)).max(UFS.length).default([]),
  cidades: z.array(z.string().max(80)).max(BUSCA_CIDADES_MAX).default([]),
  portes: z.array(z.enum(["micro", "pequeno", "demais"])).max(3).default([]),
  capitalMin: z.number().min(0).max(1e13).nullable().default(null),
  capitalMax: z.number().min(0).max(1e13).nullable().default(null),
  abertaDesde: dataIso.nullable().default(null),
  abertaAte: dataIso.nullable().default(null),
  soAtivas: z.boolean().default(true),
  /** Ligado por padrão: empresário individual e MEI são pessoas físicas (LGPD). */
  excluirPessoa: z.boolean().default(true),
  soComTelefone: z.boolean().default(false),
  /** Desligado (padrão): empresa que já é contato do time fica fora ANTES de contar a quantidade pedida. */
  incluirJaCadastradas: z.boolean().default(false),
  /** Desligado (padrão): só o CNAE principal vale. Ligado: o CNAE escolhido também pode estar entre os secundários. */
  cnaeSecundario: z.boolean().default(false),
  /** Ligado (padrão): exclui a empresa que tem e-mail de contabilidade (só vale quando o e-mail é consultado). */
  ignorarEmailContabilidade: z.boolean().default(true),
  soComEmail: z.boolean().default(false),
  /** Caixa "e-mail com a palavra depois do @". Desmarcada, o texto abaixo é ignorado. */
  emailDominioAtivo: z.boolean().default(false),
  emailDominio: z.string().max(200).default(""),
  /** Quantas empresas entram na fila (1 a 500). */
  limite: z.number().int().min(1).max(CNPJ_LOTE_MAX).default(BUSCA_PADRAO_LIMITE),
  completarContato: z.boolean().default(false),
  checarWhatsApp: z.boolean().default(false),
});
export type FiltrosDaTela = z.input<typeof filtrosDaTelaSchema>;

/** "0115-6/00", "0115600" ou "115600" → "0115600". Null se não tiver 7 dígitos úteis. */
export function normalizarCnae(v: string): string | null {
  const d = v.replace(/\D/g, "");
  if (!d || d.length > 7) return null;
  const c = d.padStart(7, "0");
  return /^0\d{6}$|^[1-9]\d{6}$/.test(c) && c !== "0000000" ? c : null;
}

export type FiltrosNormalizados = {
  cnaes: string[];
  ufs: string[];
  cidades: string[];
  locais: FiltrosLocais;
  limite: number;
  completarContato: boolean;
  checarWhatsApp: boolean;
  opcoes: OpcoesDaBusca;
};

/**
 * Valida e limpa o que veio da tela. Pura: sem banco (a cidade vira código IBGE em
 * `resolverMunicipios`). Lança `FiltroInvalido` com a frase pronta para a tela.
 */
export function normalizarFiltros(entrada: FiltrosDaTela): FiltrosNormalizados {
  const p = filtrosDaTelaSchema.safeParse(entrada);
  if (!p.success) throw new FiltroInvalido(p.error.issues[0]?.message ? `Confira os filtros: ${p.error.issues[0].message}.` : "Confira os filtros.");
  const f = p.data;

  const cnaes: string[] = [];
  for (const bruto of f.cnaes) {
    if (!bruto.trim()) continue;
    const c = normalizarCnae(bruto);
    if (!c) throw new FiltroInvalido(`CNAE "${bruto.trim()}" inválido. Use os 7 dígitos, como 0115-6/00.`);
    if (!cnaes.includes(c)) cnaes.push(c);
  }
  const ufs: string[] = [];
  for (const bruto of f.ufs) {
    const u = bruto.trim().toUpperCase();
    if (!(UFS as readonly string[]).includes(u)) throw new FiltroInvalido(`Estado "${bruto}" inválido.`);
    if (!ufs.includes(u)) ufs.push(u);
  }
  const cidades = [...new Set(f.cidades.map((c) => c.trim()).filter(Boolean))];
  if (cidades.length && ufs.length !== 1) throw new FiltroInvalido("Para buscar por cidade, escolha um único estado.");
  if (!cnaes.length && !ufs.length && !cidades.length) {
    throw new FiltroInvalido("Informe ao menos um CNAE, um estado ou uma cidade.");
  }
  if (f.capitalMin !== null && f.capitalMax !== null && f.capitalMin > f.capitalMax) {
    throw new FiltroInvalido("O capital social mínimo é maior que o máximo.");
  }
  if (f.abertaDesde && f.abertaAte && f.abertaDesde > f.abertaAte) {
    throw new FiltroInvalido("A data de abertura inicial é depois da final.");
  }
  // Palavra do domínio: só vale com a caixa marcada E com palavra. Vazia, não filtra nada.
  const emailDominio = f.emailDominioAtivo ? palavrasDoDominio(f.emailDominio) : [];
  const opcoes: OpcoesDaBusca = {
    incluirJaCadastradas: f.incluirJaCadastradas,
    ignorarEmailContabilidade: f.ignorarEmailContabilidade,
    // A palavra do domínio implica "só com e-mail".
    soComEmail: f.soComEmail || emailDominio.length > 0,
    emailDominio,
  };
  return {
    cnaes,
    ufs,
    cidades,
    opcoes,
    locais: {
      ...FILTROS_LOCAIS_PADRAO,
      soAtivas: f.soAtivas,
      excluirPessoa: f.excluirPessoa,
      portes: [...new Set(f.portes)] as PorteEmpresa[],
      capitalMin: f.capitalMin,
      capitalMax: f.capitalMax,
      abertaDesde: f.abertaDesde,
      abertaAte: f.abertaAte,
      soComTelefone: f.soComTelefone,
      // Sem "considerar CNAE secundário", fica só quem tem o CNAE escolhido como PRINCIPAL (a fonte entrega os dois).
      cnaesPrincipais: f.cnaeSecundario ? [] : cnaes,
    },
    limite: f.limite,
    // A fonte da busca não traz e-mail: quem filtra por e-mail precisa consultar o CNPJ de cada empresa.
    completarContato: f.completarContato || exigeEmail(opcoes),
    checarWhatsApp: f.checarWhatsApp,
  };
}

/**
 * Cidade (nome) + estado → código IBGE, pela tabela `Municipio` (dado público, igual
 * para todos os times). Nome que não casa vira `FiltroInvalido` dizendo qual.
 */
export async function resolverMunicipios(cidades: string[], uf: string | null): Promise<{ codigos: number[]; rotulos: string[] }> {
  if (!cidades.length) return { codigos: [], rotulos: [] };
  if (!uf) throw new FiltroInvalido("Para buscar por cidade, escolha um único estado.");
  const achados = await basePrisma.municipio.findMany({
    where: { uf, nomeBusca: { in: cidades.map((c) => nomeBuscaLugar(c)) } },
    select: { codigoIbge: true, nome: true, nomeBusca: true },
  });
  const porNome = new Map(achados.map((m) => [m.nomeBusca, m]));
  const codigos: number[] = [];
  const rotulos: string[] = [];
  for (const c of cidades) {
    const m = porNome.get(nomeBuscaLugar(c));
    if (!m) throw new FiltroInvalido(`Não achei a cidade "${c}" em ${uf}. Confira o nome.`);
    if (!codigos.includes(m.codigoIbge)) {
      codigos.push(m.codigoIbge);
      rotulos.push(`${m.nome}/${uf}`);
    }
  }
  return { codigos, rotulos };
}

/** Cidades de um estado para a caixa de escolha da tela. Dado público; sem time. */
export async function municipiosDaUf(uf: string): Promise<{ codigo: number; nome: string }[]> {
  const u = uf.trim().toUpperCase();
  if (!(UFS as readonly string[]).includes(u)) return [];
  const rows = await basePrisma.municipio.findMany({ where: { uf: u }, select: { codigoIbge: true, nome: true }, orderBy: { nome: "asc" } });
  return rows.map((r) => ({ codigo: r.codigoIbge, nome: r.nome }));
}

type JobFiltro = Extract<CaptureJob, { origem: "cnpj"; modo: "filtro" }>;

/**
 * Pede a busca por filtro: valida, resolve as cidades e põe na fila `capture`. Devolve o
 * `lote` para a tela acompanhar. Não cria Contato: só rascunhos, que a pessoa revisa.
 */
export async function captureCnpjsPorFiltro(entrada: FiltrosDaTela): Promise<{ lote: string }> {
  requireCan("captacao.run");
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("sem time no contexto");
  const f = normalizarFiltros(entrada);
  const cid = await resolverMunicipios(f.cidades, f.ufs[0] ?? null);
  const lote = randomUUID();
  await enqueueCapture({
    origem: "cnpj",
    modo: "filtro",
    teamId,
    lote,
    ownerId: donoPadrao(),
    limite: f.limite,
    filtros: { fonte: { cnaes: f.cnaes, ufs: f.ufs, municipios: cid.codigos }, locais: f.locais, cidades: cid.rotulos, opcoes: f.opcoes },
    completarContato: f.completarContato,
    checarWhatsApp: f.checarWhatsApp,
  });
  return { lote };
}

/**
 * "Buscar mais": continua a busca de um lote anterior DESTA pessoa, de onde ela parou, com os
 * mesmos filtros e o mesmo limite (`limite`, 1 a 500). Os filtros e o cursor vêm do status
 * guardado no servidor, nunca do cliente. Lote de outro time, de outra pessoa ou sem
 * continuação → `BuscaSemContinuacao`.
 */
export async function continuarBuscaPorFiltro(loteAnterior: string, limite: number = BUSCA_PADRAO_LIMITE): Promise<{ lote: string }> {
  requireCan("captacao.run");
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("sem time no contexto");
  if (!/^[0-9a-f-]{36}$/i.test(loteAnterior)) throw new BuscaSemContinuacao();
  const st = await lerStatusCaptura(teamId, loteAnterior);
  const c = st?.continuacao;
  if (!st || !c) throw new BuscaSemContinuacao();
  // Só continua quem pode mexer nesse lote (a fila é por pessoa; master e administrador veem a de todos).
  const meuRascunho = await db().prospectDraft.findFirst({ where: { AND: [{ lote: loteAnterior }, escopoRascunho({ escrita: true })] }, select: { id: true } });
  if (!meuRascunho) throw new BuscaSemContinuacao();
  const dono = donoPadrao();
  const lim = Math.min(Math.max(Math.floor(limite) || BUSCA_PADRAO_LIMITE, 1), CNPJ_LOTE_MAX);
  const lote = randomUUID();
  await enqueueCapture({
    origem: "cnpj",
    modo: "filtro",
    teamId,
    lote,
    ownerId: dono,
    limite: lim,
    filtros: c.filtros,
    cursor: c.cursor,
    saltar: c.saltar,
    lidasAntes: c.lidasNaFonte,
    motivo: c.motivo ?? null,
    // Continua do mesmo jeito (com ou sem consulta do CNPJ de cada empresa).
    completarContato: c.completarContato ?? exigeEmail(c.filtros.opcoes ?? OPCOES_DA_BUSCA_ANTIGAS),
    checarWhatsApp: false,
  });
  return { lote };
}

// ---------------------------------------------------------------------------
// Coletor (roda no worker)
// ---------------------------------------------------------------------------

/** Teto de tempo de uma busca por filtro (o resto vira "parcial: tempo esgotado" com "Buscar mais"). */
export const BUSCA_TETO_MS = Number(process.env.CAPTURE_BUSCA_TETO_MS ?? 20 * 60_000);

/** Junta o que a consulta do CNPJ trouxe (mais completo) com o que a busca já tinha (telefone, por exemplo). */
export function mesclarDetalhe(detalhe: CnpjResult, busca: CnpjResult): CnpjResult {
  const vazio = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  const r: Record<string, unknown> = { ...busca };
  for (const [k, v] of Object.entries(detalhe)) if (!vazio(v)) r[k] = v;
  return r as CnpjResult;
}

export type OpcoesColetaPorFiltro = {
  tetoMs?: number;
  pausaPaginaMs?: number;
  pausaConsultaMs?: number;
  /** Espera base entre as novas tentativas de uma página da fonte que falhou (cresce a cada tentativa). */
  esperaErroMs?: number;
  lidasMax?: number;
  /** Teto de consultas de CNPJ numa busca (cada uma vai à rede, no ritmo das fontes). */
  consultasMax?: number;
  agora?: () => number;
  /** Troca da fonte (teste). */
  buscarPagina?: (f: JobFiltro["filtros"]["fonte"], cursor: string | null) => Promise<PaginaDeBusca>;
  /** Troca da consulta de CNPJ (teste). */
  consultar?: typeof consultarCnpjDetalhado;
  /** Troca da checagem "pediram para parar?" (teste). */
  parar?: () => Promise<boolean>;
};

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Quantas vezes uma página da fonte é tentada antes de a busca parar com o que já veio. */
export const BUSCA_TENTATIVAS_PAGINA = 3;
/** Teto de empresas LIDAS por busca cresce com o pedido (filtro apertado lê mais), até este limite. */
export const BUSCA_LIDAS_TETO_ABSOLUTO = 20_000;
/** Teto de consultas de CNPJ numa busca que precisa do e-mail. */
export const BUSCA_CONSULTAS_MAX = 3_000;
/** Teto de lidas de uma busca que pede `limite` empresas: 40 lidas por empresa pedida, entre 5.000 e 20.000. */
export const lidasMaxDaBusca = (limite: number) => Math.min(BUSCA_LIDAS_TETO_ABSOLUTO, Math.max(BUSCA_LIDAS_MAX, limite * 40));

/**
 * Coletor da busca por filtro. UM clique traz a quantidade pedida: o coletor continua lendo páginas
 * sozinho, em lotes, até juntar `limite` empresas NOVAS que passam em todos os filtros, até a fonte
 * acabar, ou até um limite de segurança (leitura, consultas, tempo) ou o "Parar" da pessoa.
 *
 * Por página: filtros locais da fonte (`aprovaRegistro`), depois (em LOTE, uma consulta só) as que já
 * são cadastro do time (se a opção estiver desligada) e as que já estão na fila de revisão desta
 * pessoa; só então cada candidata é consultada pelo CNPJ (quando há e-mail a conferir), passa pelas regras
 * de e-mail e SÓ ENTÃO conta na quantidade. Grava aos poucos (a tela vê o andamento) e guarda onde parou
 * (`continuacao`) para "Buscar mais".
 */
export function coletarPorFiltro(job: JobFiltro, opts: OpcoesColetaPorFiltro = {}): Coletor {
  const teto = opts.tetoMs ?? BUSCA_TETO_MS;
  const pausaPagina = opts.pausaPaginaMs ?? BUSCA_PAUSA_PAGINA_MS;
  const pausaConsulta = opts.pausaConsultaMs ?? 400;
  const esperaErro = opts.esperaErroMs ?? 4_000;
  const lidasMax = opts.lidasMax ?? lidasMaxDaBusca(job.limite);
  const consultasMax = opts.consultasMax ?? BUSCA_CONSULTAS_MAX;
  const agora = opts.agora ?? Date.now;
  const buscarPagina = opts.buscarPagina ?? ((f, c) => buscarPaginaMinhaReceita(f, c, { limite: MINHA_RECEITA_POR_PAGINA }));
  const consultar = opts.consultar ?? consultarCnpjDetalhado;
  const pararPedido = opts.parar ?? (() => paradaPedida(job.teamId, job.lote));
  const { fonte, locais, cidades } = job.filtros;
  const opcoes = job.filtros.opcoes ?? OPCOES_DA_BUSCA_ANTIGAS;
  // A fonte não traz e-mail: sem consultar o CNPJ não há e-mail para conferir.
  const consultaCadaEmpresa = job.completarContato || exigeEmail(opcoes);
  const resumo = { modo: "filtro", cnaes: fonte.cnaes, ufs: fonte.ufs, cidades };
  // Busca por sócio: o motivo informado fica no rascunho; a máscara e o nome buscados NÃO ficam (só quem foi achado).
  const motivo = job.motivo ?? null;

  return async (ctx) => {
    const inicio = agora();
    let cursor = job.cursor ?? null;
    let saltar = job.saltar ?? 0;
    let aprovadas = 0;
    let lidas = job.lidasAntes ?? 0;
    let consultas = 0;
    const lidasNestaBusca = () => lidas - (job.lidasAntes ?? 0);
    const vistos = new Set<string>();
    const guardar = (c: { cursor: string | null; saltar: number }) =>
      ctx.continuacao({ cursor: c.cursor, saltar: c.saltar, lidasNaFonte: lidas, filtros: job.filtros, motivo, completarContato: consultaCadaEmpresa });
    let continuacao: ContinuacaoDaBusca | null = null;
    let esgotada = false;

    for (;;) {
      if (agora() - inicio > teto) {
        guardar({ cursor, saltar });
        return { interrupcao: { motivo: "tempo_esgotado", detalhe: `${aprovadas} de ${job.limite} empresas` } };
      }
      if (await pararPedido()) {
        guardar({ cursor, saltar });
        return { interrupcao: { motivo: "parada_pelo_usuario", detalhe: `${aprovadas} de ${job.limite} empresas` } };
      }
      let pagina: PaginaDeBusca | null = null;
      let ultimoErro: unknown = null;
      for (let t = 1; t <= BUSCA_TENTATIVAS_PAGINA; t++) {
        try {
          pagina = await buscarPagina(fonte, cursor);
          break;
        } catch (e) {
          ultimoErro = e;
          if (t < BUSCA_TENTATIVAS_PAGINA && esperaErro > 0) await esperar(esperaErro * t);
        }
      }
      if (!pagina) {
        const detalhe = ultimoErro instanceof Error ? ultimoErro.message : String(ultimoErro);
        // Já veio alguma coisa: guarda onde parou e devolve o que há. Nada veio: a busca falha.
        if (aprovadas > 0) {
          guardar({ cursor, saltar });
          return { interrupcao: { motivo: "erro", detalhe } };
        }
        throw new CapturaFalhou("erro", detalhe, { cause: ultimoErro });
      }

      // 1) Candidatas da página: passam nos filtros da fonte e não se repetem. `pos` = posição (1 a N) na página.
      const lidasAntesDaPagina = lidas;
      const registros = pagina.registros;
      const candidatas: { pos: number; base: CnpjResult; reg: (typeof registros)[number] }[] = [];
      registros.slice(saltar).forEach((reg, i) => {
        if (!aprovaRegistro(reg, locais)) return;
        const base = resultadoDoRegistro(reg);
        if (!base || vistos.has(base.cnpj)) return;
        vistos.add(base.cnpj);
        candidatas.push({ pos: saltar + i + 1, base, reg });
      });

      // 2) Já cadastradas e já na fila: fora ANTES de contar (uma consulta por página, não por empresa).
      let elegiveis = candidatas;
      if (candidatas.length) {
        const cnpjs = candidatas.map((c) => c.base.cnpj);
        const [cadastradas, naFila] = await runAsSystem(job.teamId, () =>
          Promise.all([
            opcoes.incluirJaCadastradas ? Promise.resolve(new Set<string>()) : cnpjsJaCadastrados(cnpjs),
            // Só na busca por filtro (com opções); a busca por sócio e os jobs antigos seguem como eram.
            job.filtros.opcoes ? cnpjsPendentesNaFila(cnpjs, job.ownerId ?? null) : Promise.resolve(new Set<string>()),
          ]),
        );
        elegiveis = candidatas.filter((c) => !cadastradas.has(c.base.cnpj) && !naFila.has(c.base.cnpj));
      }

      // 3) Cada candidata: consulta (se há e-mail a conferir), regras de e-mail e só então conta.
      const aGravar: DraftInput[] = [];
      const descarregar = async () => {
        if (aGravar.length) await ctx.gravar(aGravar.splice(0));
        ctx.progresso(aprovadas);
      };
      let paradoEm: { pos: number; motivo: "tempo_esgotado" | "parada_pelo_usuario" | "consultas" } | null = null;
      let parouNoLimite = false;
      let posFinal = registros.length; // até onde esta página foi lida
      let nConsultadasNaPagina = 0;
      for (const { pos, base, reg } of elegiveis) {
        if (consultaCadaEmpresa) {
          // Parar, tempo e teto de consultas são conferidos entre uma consulta e outra.
          if (agora() - inicio > teto) { paradoEm = { pos, motivo: "tempo_esgotado" }; break; }
          if (nConsultadasNaPagina % 5 === 0 && (await pararPedido())) { paradoEm = { pos, motivo: "parada_pelo_usuario" }; break; }
          if (consultas >= consultasMax) { paradoEm = { pos, motivo: "consultas" }; break; }
        }
        // Busca por sócio: o rascunho leva o NOME DA PESSOA procurada e com que confiança foi ligada à empresa.
        const achado = locais.socio ? socioDoRegistro(reg, locais.socio) : null;
        if (achado) {
          base.nome = achado.nome;
          base.nomeSocio = achado.nome;
        }
        let r = base;
        if (consultaCadaEmpresa) {
          consultas++;
          nConsultadasNaPagina++;
          try {
            const { resultado, origem } = await consultar(base.cnpj);
            r = mesclarDetalhe(resultado, base);
            if (origem !== "cache" && pausaConsulta > 0) await esperar(pausaConsulta + Math.random() * pausaConsulta);
          } catch {
            /* a consulta é um extra: sem ela, fica o que a busca trouxe */
          }
        }
        // E-mail: contabilidade exclui a empresa; "só com e-mail" e a palavra do domínio exigem e-mail.
        // Sem e-mail (consulta que falhou) e com filtro de e-mail ativo, a empresa não entra.
        const regra = decidirPorEmail(r.email, (r.emails ?? []).map((e) => e.valor), opcoes);
        if (!regra.aprovada) continue;
        r = { ...r, email: regra.email };
        if (achado) r = { ...r, nome: achado.nome, nomeSocio: achado.nome }; // a consulta traz o 1º sócio: a pessoa procurada continua sendo o nome
        const draft = draftDoCnpj(r);
        aGravar.push({
          ...draft,
          extra: {
            ...(draft.extra as object),
            ...resumo,
            ...(achado ? { busca: "socio", socioBuscado: { confianca: achado.confianca, qualificacao: achado.qualificacao }, motivo } : {}),
          },
        });
        aprovadas++;
        if (aprovadas >= job.limite) {
          parouNoLimite = true;
          posFinal = pos;
          break;
        }
        if (aGravar.length >= 10) await descarregar(); // aos poucos: a tela vê "87 de 200" andando
      }
      if (paradoEm) posFinal = paradoEm.pos - 1;
      lidas = lidasAntesDaPagina + (posFinal - saltar);
      await descarregar();

      if (paradoEm) {
        guardar({ cursor, saltar: posFinal });
        if (paradoEm.motivo === "consultas") {
          return { interrupcao: { motivo: "filtros_apertados", detalhe: `consultei ${consultas} empresas e só ${aprovadas} passaram` } };
        }
        return { interrupcao: { motivo: paradoEm.motivo, detalhe: `${aprovadas} de ${job.limite} empresas` } };
      }
      if (parouNoLimite) {
        // Sobrou página? Continua dela, saltando o que já foi lido; se acabou exatamente no fim, vai para a próxima.
        const sobrou = posFinal < registros.length;
        const proxCursor = sobrou ? cursor : pagina.cursor;
        const proxSaltar = sobrou ? posFinal : 0;
        if (sobrou || pagina.cursor) continuacao = { cursor: proxCursor, saltar: proxSaltar, lidasNaFonte: lidas, filtros: job.filtros, motivo, completarContato: consultaCadaEmpresa };
        break;
      }
      lidas = lidasAntesDaPagina + (registros.length - saltar);
      if (!pagina.cursor) {
        esgotada = true; // fim da fonte antes de juntar a quantidade pedida
        break;
      }
      cursor = pagina.cursor;
      saltar = 0;
      if (lidasNestaBusca() >= lidasMax) {
        guardar({ cursor, saltar: 0 });
        return {
          interrupcao: {
            motivo: "filtros_apertados",
            detalhe: `li ${lidasNestaBusca()} empresas e só ${aprovadas} passaram`,
          },
        };
      }
      if (pausaPagina > 0) await esperar(pausaPagina + Math.random() * (pausaPagina / 3));
    }
    ctx.continuacao(continuacao);
    return { interrupcao: null, ...(esgotada && aprovadas < job.limite ? { fonteEsgotada: true } : {}) };
  };
}
