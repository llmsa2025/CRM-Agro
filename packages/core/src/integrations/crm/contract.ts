/**
 * Contrato do conector de CRM (plano do Nectar §4.2). Ficha N1: a parte de
 * LEITURA. Ficha N3: os tipos de saída (o que vai para o Nectar) e os métodos
 * de busca e escrita.
 *
 * Regra da pasta: NÃO importa `@crmagro/*` (o script de homologação do N5 passa
 * por aqui e roda sem o `.env`).
 */

/** validada = homologada na conta de teste; pendente = ainda não testada; nao_suportada = fora de escopo. */
export type EstadoCapacidade = "validada" | "pendente_homologacao" | "nao_suportada";
export type TipoFunil = "vendas" | "pre_venda";
export type CapacidadeCrm =
  | "ler_catalogos" | "buscar_contato" | "criar_contato" | "atualizar_contato"
  | "criar_oportunidade" | "atualizar_oportunidade" | "criar_qualificacao"
  | "criar_nota" | "criar_nota_com_anexo" | "comentar_nota" | "procurar_marcador" | "mover_card";
export type FormatoTelefone =
  | "e164" | "55" | "ddd" | "parenteses_hifen" | "parenteses" | "sem_nono" | "sem_nono_parenteses_hifen" | "outro";
export type DistribuicaoFormatos = Partial<Record<FormatoTelefone, number>>;

/** Conexão já decifrada. Montada no servidor só na hora da chamada; o token nunca vai para job, log ou DTO. */
export type ConexaoAberta = { integrationId: string; token: string; formatosTelefone?: DistribuicaoFormatos };

export type EtapaExterna = { id: string; nome: string; sequencia: number };
export type FunilExterno = {
  id: string; nome: string; tipo: TipoFunil; ativo: boolean; padrao: boolean; etapas: EtapaExterna[];
  iniciarQualquerEtapa: boolean; produtoObrigatorio: boolean; modeloVenda: "b2b" | "b2c";
  indisponivel: string | null; // motivo: "o funil exige produto", "funil inativo"
};
export type UsuarioExterno = { id: string; nome: string; email: string | null; login: string | null; ativo: boolean };
export type FilaExterna = { id: string; nome: string };
export type TagExterna = { id: string; nome: string; ativa: boolean; relacionada: "contato" | "oportunidade" | "ambos" | null; podeIncluir: boolean };
export type CampoExterno = { id: string; nome: string; tipo: number | null; obrigatorio: boolean; entidade: string | null };

export type DiagnosticoConexao = {
  credencial: "ok" | "invalida" | "sem_permissao" | "indisponivel";
  leadboard: "tem" | "nao_tem" | "desconhecido";
  funisVendas: FunilExterno[]; funisPreVenda: FunilExterno[];
  usuarios: { total: number; ativos: number } | null; filas: number | null;
  tags: TagExterna[]; camposObrigatorios: CampoExterno[]; formatosTelefone: DistribuicaoFormatos;
  avisos: string[];
};

/** Parte de leitura do conector (N1). O `ConectorCrm` completo estende esta interface (N3). */
export interface ConectorCrmLeitura {
  readonly provedor: "nectarcrm";
  readonly capacidades: Readonly<Record<CapacidadeCrm, EstadoCapacidade>>;
  testConnection(c: ConexaoAberta): Promise<DiagnosticoConexao>;
  listPipelines(c: ConexaoAberta, tipo: TipoFunil): Promise<FunilExterno[]>;
  listUsers(c: ConexaoAberta): Promise<UsuarioExterno[]>;
  listQueues(c: ConexaoAberta): Promise<FilaExterna[]>;
  listTags(c: ConexaoAberta): Promise<TagExterna[]>;
  listCustomFields(c: ConexaoAberta): Promise<CampoExterno[]>;
  amostraFormatosTelefone(c: ConexaoAberta): Promise<DistribuicaoFormatos>;
}

// ─── Escrita (ficha N3) ─────────────────────────────────────────────────────

/** Dados do CRM Agro que o mapper usa. NÃO é o tipo do Prisma: o N10a monta este objeto. */
export type ContatoLocal = {
  id: string;
  nome: string;
  sobrenome: string | null;
  emails: string[];
  telefonesE164: string[];
  linkedin: string | null;
  /** CPF em texto. Vem SEMPRE do leitor de CPF (`lerCpf`, contacts/cpf.ts): o valor guardado no banco é cifrado. */
  cpf: string | null;
  cargo: string | null;
  cidade: string | null;
  estado: string | null;
  endereco: string | null;
  origem: string | null;
  faturamentoAnual: number | null;
  relacionamentoStatus: "novo" | "ja_conversou" | "cliente" | "opt_out";
  tagNomes: string[];
};

/** Quem fica responsável no Nectar: um usuário (por id ou por login) ou uma fila. Só na criação. */
export type ResponsavelSaida = { responsavel?: { id: string } | { login: string }; queue?: { id: string } };

/** Contato no formato do Nectar (plano §2.3). Campo vazio NUNCA vai: todos opcionais, menos nome e constante. */
export type ContatoSaida = ResponsavelSaida & {
  nome: string;
  /** 0 Cliente, 1 Prospect, 2 Suspect, 3 Lead, 5 Descartado. */
  constante: 0 | 1 | 2 | 3 | 5;
  /** Só na criação. */
  ativo?: true;
  /** Id do CRM Agro; só no POST de um contato que o próprio CRM Agro criou. */
  codigo?: string;
  emails?: string[];
  telefones?: string[];
  /** Formato das listas: a homologar (N20). */
  listas?: { nome: string }[];
  linkedin?: string;
  cpf?: string;
  cargo?: string;
  origem?: string;
  receitaAnual?: number;
  empresaAtual?: { id: string };
  /** Só com `enderecoLiberado` (G6-D7). */
  regiaoMunicipio?: string;
  regiaoEstado?: string;
  /** Contato-empresa (plano §2.5). */
  empresa?: true;
  razaoSocial?: string;
  cnpj?: string;
  site?: string;
};

/** Oportunidade (plano §2.6). Sem `status`: o card nasce em andamento. */
export type OportunidadeSaida = ResponsavelSaida & {
  nome: string;
  cliente: { id: string };
  contato?: { id: string };
  funilVenda: { id: string };
  etapa: number;
  valorAvulso?: number;
};

/** Qualificação da pré-venda (plano §2.6). */
export type QualificacaoSaida = ResponsavelSaida & {
  nome: string;
  cliente: { id: string };
  funilVenda: { id: string };
  etapa: number;
  status: 1;
};

/** Contato como o Nectar o devolve (só o que o CRM Agro usa). */
export type ContatoRemoto = {
  id: string;
  nome: string | null;
  emails: string[];
  telefones: string[];
  /** Nomes das etiquetas. */
  listas: string[];
  codigo: string | null;
  constante: number | null;
  empresaAtualId: string | null;
  cargo: string | null;
  blocked: boolean;
};

export type OportunidadeExterna = { id: string; nome: string; status: number | null; funilId: string | null };
export type QualificacaoExterna = { id: string; status: number | null; funilId: string | null };
export type RefExterna = { id: string };

/** Busca exata (nunca com `*`, que viraria busca parcial). Um identificador por busca. */
export type BuscaExata = { email?: string; telefone?: string; cpf?: string; cnpj?: string; codigo?: string };

export type NotaSaida = {
  assunto: string;
  descricaoHtml: string;
  contatoId: string;
  oportunidadeId?: string;
  qualificacaoId?: string;
};

/**
 * Resultado de procurar o marcador "[CRM Agro #id]" nas notas da conta (plano §4.5).
 * `conclusiva: true` = a nota NÃO está lá (ou achou); `false` = não dá para decidir o reenvio.
 */
export type ProcuraMarcador = { achou: RefExterna | null; conclusiva: boolean; paginasLidas: number };

/** Conector completo: leitura (N1) mais busca e escrita (N3). O CRM Agro nunca apaga nada no Nectar. */
export interface ConectorCrm extends ConectorCrmLeitura {
  findContact(c: ConexaoAberta, q: BuscaExata): Promise<ContatoRemoto[]>;
  getContact(c: ConexaoAberta, id: string): Promise<ContatoRemoto>;
  createContact(c: ConexaoAberta, d: ContatoSaida): Promise<RefExterna>;
  /** O corpo já vem mesclado (o mapper une as listas antes). */
  updateContact(c: ConexaoAberta, id: string, d: Partial<ContatoSaida>): Promise<void>;
  findOpportunity(c: ConexaoAberta, contatoId: string): Promise<OportunidadeExterna[]>;
  createOpportunity(c: ConexaoAberta, d: OportunidadeSaida): Promise<RefExterna>;
  updateOpportunity(c: ConexaoAberta, id: string, d: Partial<OportunidadeSaida>): Promise<void>;
  findQualification(c: ConexaoAberta, contatoId: string): Promise<QualificacaoExterna[]>;
  createQualification(c: ConexaoAberta, d: QualificacaoSaida): Promise<RefExterna>;
  appendTimelineEntry(c: ConexaoAberta, nota: NotaSaida): Promise<RefExterna>;
  appendTimelineComment(c: ConexaoAberta, notaId: string, texto: string): Promise<void>;
  findTimelineMarker(c: ConexaoAberta, marcador: string, desde: Date, maxPaginas: number): Promise<ProcuraMarcador>;
}
