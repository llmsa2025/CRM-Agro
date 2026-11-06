import { isDeepStrictEqual } from "node:util";
import { CapacidadesDeLigacaoSchema, ChaveDeProvedorDeLigacaoSchema, type CapacidadesDeLigacao, type ChaveDeProvedorDeLigacao } from "./capacidades";
import { problemasDoDescritorDeLigacao, type DescritorDeLigacao } from "./descritor";
import type { FabricaDeProvedorDeLigacao, ProvedorDeLigacao } from "./interface";

/**
 * O REGISTRO de provedores de ligação: chave -> { matriz, descritor, fábrica, flag, comprovado }
 *
 * Adicionar um provedor novo = escrever o adaptador, o descritor e a matriz, passar a suíte de contrato e
 * acrescentar UMA entrada em `PROVEDORES_PADRAO`. O núcleo e a tela só leem daqui.
 *
 * O registro confere a coerência na hora de registrar (descritor válido, chave igual nos três lados, matriz
 * igual à do adaptador, métodos opcionais presentes só com a capacidade). Registro incoerente falha cedo,
 * no boot, e nunca no meio de uma ligação.
 */

export type ProvedorRegistradoDeLigacao = {
  chave: ChaveDeProvedorDeLigacao;
  /** Nome curto para a tela. */
  rotulo: string;
  capacidades: Readonly<CapacidadesDeLigacao>;
  descritor: DescritorDeLigacao;
  fabrica: FabricaDeProvedorDeLigacao;
  /**
   * A LISTA ÚNICA de provedores comprovados (padrão false). Só o gate de cada provedor a liga (F2-23, F4-16):
   * ligação de provedor não comprovado nunca vira "Comprovada pelo provedor", mesmo com fato válido.
   */
  comprovado?: boolean;
  /** A flag que libera o provedor por empresa e serve de pausa: `ligacao_provedor_<chave>`. Nasce no catálogo com o adaptador. */
  flag: string;
};

export class ProvedorDeLigacaoNaoRegistrado extends Error {
  constructor() {
    super("Esse provedor de ligação não está registrado.");
    this.name = "ProvedorDeLigacaoNaoRegistrado";
  }
}

export class RegistroDeLigacaoIncoerente extends Error {
  constructor(readonly problemas: readonly string[]) {
    super(`O provedor de ligação não pôde ser registrado: ${problemas.join(" ")}`);
    this.name = "RegistroDeLigacaoIncoerente";
  }
}

/** Travessão, meia-risca e " - " como separador: proibidos nos textos da interface (AGENTS.md (texto da interface)). */
const TEXTO_FORA_DO_PADRAO = /[—–]|\s-\s/;

export const flagDoProvedorDeLigacao = (chave: ChaveDeProvedorDeLigacao): string => `ligacao_provedor_${chave}`;

/** Confere um provedor (sem registrar). Lista vazia = coerente. */
export function problemasDoRegistroDeLigacao(p: ProvedorRegistradoDeLigacao): string[] {
  const problemas: string[] = [];
  if (!ChaveDeProvedorDeLigacaoSchema.safeParse(p.chave).success) problemas.push("A chave do provedor tem formato inválido.");
  if (p.chave !== p.descritor.chave) problemas.push("A chave do registro é diferente da chave do descritor.");
  if (p.rotulo.trim().length === 0) problemas.push("O provedor precisa de um rótulo.");
  else if (TEXTO_FORA_DO_PADRAO.test(p.rotulo)) problemas.push("O rótulo não pode ter travessão, meia-risca nem ' - ' como separador.");
  if (p.flag !== flagDoProvedorDeLigacao(p.chave)) problemas.push("A flag do provedor precisa ser ligacao_provedor_ seguido da chave.");
  problemas.push(...problemasDoDescritorDeLigacao(p.descritor));

  const cap = CapacidadesDeLigacaoSchema.safeParse(p.capacidades);
  if (!cap.success) problemas.push("A matriz de capacidades é incoerente.");
  else {
    if (cap.data.webhook !== p.descritor.webhook.modo) problemas.push("O modo de webhook do descritor é diferente do da matriz.");
    if (cap.data.sandbox !== p.descritor.ambientes.includes("teste")) problemas.push("A matriz diz que há sandbox, mas o descritor não tem o ambiente de teste (ou o contrário).");
  }

  let adaptador: ProvedorDeLigacao | null = null;
  try {
    adaptador = p.fabrica();
  } catch {
    problemas.push("A fábrica do adaptador falhou ao criar uma instância.");
  }
  if (adaptador) {
    if (adaptador.chave !== p.chave) problemas.push("A chave do adaptador é diferente da chave do registro.");
    if (!isDeepStrictEqual({ ...adaptador.capacidades }, { ...p.capacidades })) problemas.push("A matriz do registro é diferente da matriz do adaptador.");
    // O adaptador tem os métodos opcionais exatamente quando a matriz os declara.
    const c = adaptador.capacidades;
    const confere = (tem: boolean, declarado: boolean, mensagem: string) => {
      if (tem !== declarado) problemas.push(mensagem);
    };
    confere(typeof adaptador.consultar === "function", c.consulta.porId, "O método consultar e a capacidade consulta.porId discordam.");
    confere(typeof adaptador.provisionarLinha === "function", c.provisionarLinha !== "manual", "O método provisionarLinha e a capacidade provisionarLinha discordam.");
    confere(typeof adaptador.responderOriginacao === "function", c.originacaoSincrona, "O método responderOriginacao e a capacidade originacaoSincrona discordam.");
    confere(typeof adaptador.obterGravacao === "function", c.gravacao.entrega !== "nenhuma", "O método obterGravacao e a capacidade gravacao.entrega discordam.");
    confere(typeof adaptador.apagarGravacao === "function", c.gravacao.apagavel, "O método apagarGravacao e a capacidade gravacao.apagavel discordam.");
  }
  return [...new Set(problemas)];
}

export interface RegistroDeProvedoresDeLigacao {
  registrar(p: ProvedorRegistradoDeLigacao): void;
  tem(chave: string): boolean;
  /** Lança `ProvedorDeLigacaoNaoRegistrado`. */
  obter(chave: string): ProvedorRegistradoDeLigacao;
  /** As chaves registradas, em ordem de registro (a rota do aviso valida o parâmetro contra isto). */
  chaves(): ChaveDeProvedorDeLigacao[];
  listar(): ProvedorRegistradoDeLigacao[];
}

/** Cria um registro vazio. Os testes usam um por teste; o app usa `registroPadraoDeLigacao`. */
export function criarRegistroDeLigacao(): RegistroDeProvedoresDeLigacao {
  const mapa = new Map<string, ProvedorRegistradoDeLigacao>();
  return {
    registrar(p) {
      if (!ChaveDeProvedorDeLigacaoSchema.safeParse(p.chave).success) throw new RegistroDeLigacaoIncoerente(["A chave do provedor tem formato inválido."]);
      if (mapa.has(p.chave)) throw new RegistroDeLigacaoIncoerente(["Já existe um provedor com essa chave."]);
      const problemas = problemasDoRegistroDeLigacao(p);
      if (problemas.length > 0) throw new RegistroDeLigacaoIncoerente(problemas);
      mapa.set(p.chave, p);
    },
    tem: (chave) => mapa.has(chave),
    obter(chave) {
      const p = mapa.get(chave);
      if (!p) throw new ProvedorDeLigacaoNaoRegistrado();
      return p;
    },
    chaves: () => [...mapa.keys()],
    listar: () => [...mapa.values()],
  };
}

/**
 * Os provedores do app. Vazio até o primeiro adaptador (F2-03, API4COM) entrar. Cada adaptador é registrado
 * AQUI, com `comprovado` ausente (false) até o gate dele (F2-23, F4-16).
 */
const PROVEDORES_PADRAO: readonly ProvedorRegistradoDeLigacao[] = [];

function montarRegistroPadrao(): RegistroDeProvedoresDeLigacao {
  const registro = criarRegistroDeLigacao();
  for (const p of PROVEDORES_PADRAO) registro.registrar(p);
  return registro;
}

export const registroPadraoDeLigacao: RegistroDeProvedoresDeLigacao = montarRegistroPadrao();

/**
 * O provedor está na lista de comprovados? Chave desconhecida é false. O projetor só marca uma ligação como
 * comprovada quando isto é true (F1B-08, F1B-09).
 */
export function ehProvedorComprovado(chave: string, registro: RegistroDeProvedoresDeLigacao = registroPadraoDeLigacao): boolean {
  return registro.tem(chave) && registro.obter(chave).comprovado === true;
}
