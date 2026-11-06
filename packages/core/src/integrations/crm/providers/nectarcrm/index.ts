/**
 * Conector do NectarCRM (plano §4.1 e §4.2). Ficha N1: LEITURA (funis,
 * usuários, filas, etiquetas, campos e a amostra dos formatos de telefone).
 * Ficha N3: busca e escrita (contato, oportunidade, qualificação e notas). O
 * CRM Agro nunca apaga nada no Nectar: não há método de exclusão.
 *
 * Regra da pasta `providers/nectarcrm/`: só importa `zod`, tipos e `node:crypto`
 * (mais os arquivos irmãos de `crm/`). Nada de banco, de config do app
 * nem do logger.
 */
import { z } from "zod";
import type {
  BuscaExata,
  CampoExterno,
  CapacidadeCrm,
  ConectorCrm,
  ConexaoAberta,
  ContatoRemoto,
  ContatoSaida,
  DiagnosticoConexao,
  DistribuicaoFormatos,
  EstadoCapacidade,
  FilaExterna,
  FunilExterno,
  NotaSaida,
  OportunidadeExterna,
  OportunidadeSaida,
  ProcuraMarcador,
  QualificacaoExterna,
  QualificacaoSaida,
  RefExterna,
  TagExterna,
  TipoFunil,
  UsuarioExterno,
} from "../../contract";
import { CrmCredencialInvalida, CrmNaoEncontrado, CrmRequisitoFaltando, CrmSemPermissao } from "../../errors";
import { criarClienteNectar, segmento, type TransporteNectar } from "./client";
import {
  camposPersonalizadosSchema,
  contatoRemotoSchema,
  contatosAmostraSchema,
  contatosRemotosSchema,
  listasSchema,
  oportunidadesRemotasSchema,
  pipelinesSchema,
  publicacoesSchema,
  qualificacoesRemotasSchema,
  queuesSchema,
  refSchema,
  usuariosSchema,
  type PipelineNectar,
} from "./schema";
import { distribuicaoDeFormatos } from "./telefone";

/** Nome da etiqueta que marca quem pediu para sair (plano §2.9). O admin a cria no Nectar. */
export const ETIQUETA_OPT_OUT = "Opt-out (CRM Agro)";

/** Campos do usuário que o CRM Agro pede (`attribute=`): os sensíveis (`sipPassword`, `listaIps`) nem saem do Nectar. */
const ATRIBUTOS_USUARIO = ["id", "nome", "email", "login", "ativo", "virtual", "isSuporte"];

const AVISO_SEM_USUARIOS = "A lista de usuários não veio. Cada pessoa vai digitar o e-mail de login dela no Nectar.";
const AVISO_SEM_OPT_OUT = "Crie no Nectar a etiqueta “Opt-out (CRM Agro)” para contatos.";
const AVISO_SEM_TAGS = "A lista de etiquetas do Nectar não veio.";
const AVISO_SEM_CAMPOS = "A lista de campos personalizados do Nectar não veio.";

/** Tudo pendente até a homologação (N5 roda, N20 aplica). Mover card fica de fora (decisão 8 do plano). */
const CAPACIDADES: Readonly<Record<CapacidadeCrm, EstadoCapacidade>> = {
  ler_catalogos: "pendente_homologacao",
  buscar_contato: "pendente_homologacao",
  criar_contato: "pendente_homologacao",
  atualizar_contato: "pendente_homologacao",
  criar_oportunidade: "pendente_homologacao",
  atualizar_oportunidade: "pendente_homologacao",
  criar_qualificacao: "pendente_homologacao",
  criar_nota: "pendente_homologacao",
  criar_nota_com_anexo: "pendente_homologacao",
  comentar_nota: "pendente_homologacao",
  procurar_marcador: "pendente_homologacao",
  mover_card: "nao_suportada",
};

function funilExterno(p: PipelineNectar, tipo: TipoFunil): FunilExterno {
  return {
    id: p.id,
    nome: p.nome,
    tipo,
    ativo: p.ativo,
    padrao: p.padrao,
    etapas: [...p.sequencias]
      .sort((a, b) => a.sequencia - b.sequencia)
      .map((e) => ({ id: e.id, nome: e.nome, sequencia: e.sequencia })),
    iniciarQualquerEtapa: p.iniciarQualquerEtapa,
    produtoObrigatorio: p.produtoObrigatorio,
    modeloVenda: p.modeloVenda === 0 ? "b2b" : "b2c",
    indisponivel: p.produtoObrigatorio ? "o funil exige produto" : !p.ativo ? "funil inativo" : null,
  };
}

function relacionadaDaTag(n: 0 | 1 | 2 | null | undefined): TagExterna["relacionada"] {
  return n === 0 ? "contato" : n === 1 ? "oportunidade" : n === 2 ? "ambos" : null;
}

/** A etiqueta "Opt-out (CRM Agro)" existe, está ativa, pode ser usada e vale para contato? (relacionada desconhecida conta como sim.) */
export function temEtiquetaOptOutUtilizavel(tags: TagExterna[]): boolean {
  return tags.some(
    (t) =>
      t.nome.trim().toLowerCase() === ETIQUETA_OPT_OUT.toLowerCase() &&
      t.ativa &&
      t.podeIncluir &&
      (t.relacionada === null || t.relacionada === "contato" || t.relacionada === "ambos"),
  );
}

/** Escapa o texto para usar dentro de uma expressão regular. */
const escaparRegex = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function criarConectorNectar(deps: { transporte?: TransporteNectar; base?: string } = {}): ConectorCrm {
  const cliente = (c: ConexaoAberta) => criarClienteNectar({ token: c.token, transporte: deps.transporte, base: deps.base });

  const listPipelines = async (c: ConexaoAberta, tipo: TipoFunil): Promise<FunilExterno[]> => {
    const lista = await cliente(c).get("/pipeline/", pipelinesSchema, { type: tipo === "vendas" ? 0 : 1, page: -1 });
    return lista.map((p) => funilExterno(p, tipo));
  };

  const listUsers = async (c: ConexaoAberta): Promise<UsuarioExterno[]> => {
    const query = { page: -1, attribute: ATRIBUTOS_USUARIO };
    let lista;
    try {
      lista = await cliente(c).get("/usuarios/", usuariosSchema, query);
    } catch (e) {
      // A rota certa (`/usuarios/` ou `/usuario/`) é a homologar: cai para a outra só no 404.
      if (!(e instanceof CrmNaoEncontrado)) throw e;
      lista = await cliente(c).get("/usuario/", usuariosSchema, query);
    }
    // `virtual` e `isSuporte` precisam estar no `attribute`: com a lista limitada a API não os devolveria.
    // Os inativos FICAM (com `ativo: false`); a tela decide se esconde.
    return lista
      .filter((u) => !u.virtual && !u.isSuporte)
      .map((u) => ({ id: u.id, nome: u.nome, email: u.email ?? null, login: u.login ?? null, ativo: u.ativo }));
  };

  const listQueues = async (c: ConexaoAberta): Promise<FilaExterna[]> => {
    const lista = await cliente(c).get("/queues/", queuesSchema);
    return lista.map((q) => ({ id: q.id, nome: q.name }));
  };

  const listTags = async (c: ConexaoAberta): Promise<TagExterna[]> => {
    const lista = await cliente(c).get("/lista/", listasSchema, { page: -1 });
    return lista.map((l) => ({
      id: l.id,
      nome: l.nome,
      ativa: l.ativo,
      relacionada: relacionadaDaTag(l.relacionada),
      podeIncluir: l.podeIncluir,
    }));
  };

  const listCustomFields = async (c: ConexaoAberta): Promise<CampoExterno[]> => {
    const lista = await cliente(c).get("/campoPersonalizado/", camposPersonalizadosSchema, { page: -1 });
    return lista.map((f) => ({ id: f.id, nome: f.nome, tipo: f.tipo ?? null, obrigatorio: f.obrigatorio, entidade: null }));
  };

  const amostraFormatosTelefone = async (c: ConexaoAberta): Promise<DistribuicaoFormatos> => {
    const contatos = await cliente(c).get("/contatos/", contatosAmostraSchema, { displayLength: 50 });
    // Só a distribuição sai daqui: o número em si nunca é guardado nem devolvido.
    return distribuicaoDeFormatos(contatos.flatMap((ct) => ct.telefones.map((t) => (typeof t === "string" ? t : t.numero))));
  };

  /** Cada passo do "Testar" é independente: falhou, vira `null`/vazio com aviso, e o resto segue. */
  const testConnection = async (c: ConexaoAberta): Promise<DiagnosticoConexao> => {
    const diag: DiagnosticoConexao = {
      credencial: "ok",
      leadboard: "desconhecido",
      funisVendas: [],
      funisPreVenda: [],
      usuarios: null,
      filas: null,
      tags: [],
      camposObrigatorios: [],
      formatosTelefone: {},
      avisos: [],
    };

    // 1. Funis de vendas: é também a prova do token. 401 ou 403 param aqui, sem gastar mais chamadas.
    try {
      diag.funisVendas = await listPipelines(c, "vendas");
    } catch (e) {
      diag.credencial =
        e instanceof CrmCredencialInvalida ? "invalida" : e instanceof CrmSemPermissao ? "sem_permissao" : "indisponivel";
      return diag;
    }

    // 2. Funis de pré-venda: lista vazia, 403 ou 404 = a conta não tem o Leadboard.
    try {
      diag.funisPreVenda = await listPipelines(c, "pre_venda");
      diag.leadboard = diag.funisPreVenda.length > 0 ? "tem" : "nao_tem";
    } catch (e) {
      diag.leadboard = e instanceof CrmSemPermissao || e instanceof CrmNaoEncontrado ? "nao_tem" : "desconhecido";
      // CrmIndisponivel e o resto: não dá para saber ("desconhecido"); a última resposta conhecida vale (quem grava é o N7).
    }

    // 3. Usuários.
    try {
      const usuarios = await listUsers(c);
      diag.usuarios = { total: usuarios.length, ativos: usuarios.filter((u) => u.ativo).length };
    } catch {
      diag.avisos.push(AVISO_SEM_USUARIOS);
    }

    // 4. Filas, etiquetas, campos obrigatórios e formatos de telefone.
    try {
      diag.filas = (await listQueues(c)).length;
    } catch {
      diag.filas = null;
    }
    try {
      diag.tags = await listTags(c);
      if (!temEtiquetaOptOutUtilizavel(diag.tags)) diag.avisos.push(AVISO_SEM_OPT_OUT);
    } catch {
      diag.avisos.push(AVISO_SEM_TAGS);
    }
    try {
      diag.camposObrigatorios = (await listCustomFields(c)).filter((f) => f.obrigatorio);
    } catch {
      diag.avisos.push(AVISO_SEM_CAMPOS);
    }
    try {
      diag.formatosTelefone = await amostraFormatosTelefone(c);
    } catch {
      diag.formatosTelefone = {};
    }
    return diag;
  };


  // ─── Busca e escrita (ficha N3) ───────────────────────────────────────────

  /** Rotas da busca exata. Todo caminho com dado pessoal sai dos erros pelo `caminhoParaLog`. */
  const findContact = async (c: ConexaoAberta, q: BuscaExata): Promise<ContatoRemoto[]> => {
    const valor = q.email ?? q.telefone ?? q.cpf ?? q.cnpj ?? q.codigo;
    if (!valor || !valor.trim()) throw new CrmRequisitoFaltando("a busca de contato precisa de um identificador");
    // Nunca com `*`: vira busca parcial (plano §2.4).
    if (valor.includes("*")) throw new CrmRequisitoFaltando("o valor da busca de contato não pode ter *");
    const cli = cliente(c);
    try {
      if (q.email) return await cli.get(`/contatos/email/${segmento(q.email)}`, contatosRemotosSchema);
      if (q.telefone) return await cli.get(`/contatos/telefone/${segmento(q.telefone)}`, contatosRemotosSchema);
      if (q.cpf) return await cli.get(`/contatos/cpf/${segmento(q.cpf)}`, contatosRemotosSchema);
      if (q.cnpj) return await cli.get(`/contatos/cnpj/${segmento(q.cnpj)}`, contatosRemotosSchema);
      // O filtro `nome` do Nectar aceita "nome ou código": com `exato=true` acha o `codigo`.
      return await cli.get("/contatos/", contatosRemotosSchema, { nome: valor, exato: "true" });
    } catch (e) {
      if (e instanceof CrmNaoEncontrado) return []; // 404 = nenhum contato com esse identificador
      throw e;
    }
  };

  /** Lista de um recurso por contato; 404 = nada ainda. */
  const listarPorContato = async <T>(c: ConexaoAberta, caminho: string, schema: z.ZodType<T[], z.ZodTypeDef, unknown>): Promise<T[]> => {
    try {
      return await cliente(c).get(caminho, schema);
    } catch (e) {
      if (e instanceof CrmNaoEncontrado) return [];
      throw e;
    }
  };

  const findTimelineMarker = async (c: ConexaoAberta, marcador: string, desde: Date, maxPaginas: number): Promise<ProcuraMarcador> => {
    // "[CRM Agro #<marcador>]" (nota inteira) ou "[CRM Agro #<marcador>:<i>]" (parte i). Fechar o colchete evita que "#12" case com "#123".
    const alvo = new RegExp(`\\[CRM Agro #${escaparRegex(marcador)}(?::\\d+)?\\]`);
    let anterior: number | null = null;
    let paginasLidas = 0;
    for (let pagina = 1; pagina <= maxPaginas; pagina++) {
      const notas = await cliente(c).get("/publicacao/", publicacoesSchema, { page: pagina });
      paginasLidas += 1;
      // A lista acabou sem achar: a nota não existe (conclusivo).
      if (notas.length === 0) return { achou: null, conclusiva: true, paginasLidas };
      for (const nota of notas) {
        if (alvo.test(nota.descricao ?? "")) return { achou: { id: nota.id }, conclusiva: true, paginasLidas };
        const criada = Date.parse(nota.dataCriacao);
        // Sem data legível, ou uma nota mais nova que a anterior (lista fora de ordem): não dá para confiar.
        if (Number.isNaN(criada) || (anterior !== null && criada > anterior)) return { achou: null, conclusiva: false, paginasLidas };
        anterior = criada;
        // Chegou numa nota criada ANTES do início da operação: o marcador não está mais acima (conclusivo).
        if (criada < desde.getTime()) return { achou: null, conclusiva: true, paginasLidas };
      }
    }
    // Bateu no teto de páginas sem chegar ao ponto de parada: inconclusivo, não serve para reenviar.
    return { achou: null, conclusiva: false, paginasLidas };
  };

  return {
    provedor: "nectarcrm",
    capacidades: CAPACIDADES,
    testConnection,
    listPipelines,
    listUsers,
    listQueues,
    listTags,
    listCustomFields,
    amostraFormatosTelefone,
    findContact,
    getContact: (c, id) => cliente(c).get(`/contatos/${segmento(id)}`, contatoRemotoSchema),
    createContact: (c, d: ContatoSaida): Promise<RefExterna> => cliente(c).post("/contatos/", d, refSchema),
    // O corpo já vem mesclado (o mapper une as listas antes): o PUT do Nectar substitui a lista inteira.
    updateContact: async (c, id, d: Partial<ContatoSaida>) => {
      await cliente(c).put(`/contatos/${segmento(id)}`, d, z.unknown());
    },
    findOpportunity: (c, contatoId): Promise<OportunidadeExterna[]> =>
      listarPorContato(c, `/oportunidades/contatoId/${segmento(contatoId)}`, oportunidadesRemotasSchema),
    createOpportunity: (c, d: OportunidadeSaida): Promise<RefExterna> => cliente(c).post("/oportunidades/", d, refSchema),
    updateOpportunity: async (c, id, d: Partial<OportunidadeSaida>) => {
      await cliente(c).put(`/oportunidades/${segmento(id)}`, d, z.unknown());
    },
    findQualification: (c, contatoId): Promise<QualificacaoExterna[]> =>
      listarPorContato(c, `/qualificacoes/contatoId/${segmento(contatoId)}`, qualificacoesRemotasSchema),
    createQualification: (c, d: QualificacaoSaida): Promise<RefExterna> => cliente(c).post("/qualificacoes/", d, refSchema),
    appendTimelineEntry: (c, nota: NotaSaida): Promise<RefExterna> =>
      cliente(c).post(
        "/publicacao/",
        {
          assunto: nota.assunto,
          descricao: nota.descricaoHtml,
          contato: { id: nota.contatoId },
          ...(nota.oportunidadeId ? { oportunidade: { id: nota.oportunidadeId } } : {}),
          ...(nota.qualificacaoId ? { qualificacao: { id: nota.qualificacaoId } } : {}),
        },
        refSchema,
      ),
    // O nome do campo do comentário ("descricao") é a homologar (N5/N20).
    appendTimelineComment: async (c, notaId, texto) => {
      await cliente(c).post(`/publicacao/${segmento(notaId)}/comentario`, { descricao: texto }, z.unknown());
    },
    findTimelineMarker,
  };
}
