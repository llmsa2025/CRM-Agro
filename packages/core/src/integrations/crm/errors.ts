/**
 * Erros nomeados do conector de CRM (AGENTS.md §9). Ficha N1 do Nectar.
 *
 * Regra da pasta: este arquivo NÃO importa `@crmagro/*` (o script de homologação
 * do N5 passa por ele e roda sem o `.env`). Só TypeScript puro.
 *
 * A mensagem de todo erro segue o formato
 * `"<Nome>: <MÉTODO> <caminho para log> → HTTP <status> (x-request-id <id>)"`
 * e NUNCA leva o token, o corpo da resposta nem a query (plano §4.8: log só
 * com ids).
 */

export class ErroCrm extends Error {
  constructor(
    readonly codigo: string,
    mensagem: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(mensagem);
    this.name = "ErroCrm";
  }
}

/** 401: o Nectar recusou o token. */
export class CrmCredencialInvalida extends ErroCrm {
  constructor(mensagem: string, status?: number, requestId?: string) {
    super("credencial_invalida", mensagem, status, requestId);
    this.name = "CrmCredencialInvalida";
  }
}

/** 403: o usuário do token não pode fazer isso no Nectar. */
export class CrmSemPermissao extends ErroCrm {
  constructor(mensagem: string, status?: number, requestId?: string) {
    super("sem_permissao", mensagem, status, requestId);
    this.name = "CrmSemPermissao";
  }
}

/** 400 ou 422: o Nectar recusou o dado enviado. */
export class CrmDadoInvalido extends ErroCrm {
  constructor(mensagem: string, status?: number, requestId?: string) {
    super("dado_invalido", mensagem, status, requestId);
    this.name = "CrmDadoInvalido";
  }
}

/** 404: registro ou rota inexistente. */
export class CrmNaoEncontrado extends ErroCrm {
  constructor(mensagem: string, status?: number, requestId?: string) {
    super("nao_encontrado", mensagem, status, requestId);
    this.name = "CrmNaoEncontrado";
  }
}

/** 409: conflito (por exemplo, e-mail ou telefone repetido). */
export class CrmConflito extends ErroCrm {
  constructor(mensagem: string, status?: number, requestId?: string) {
    super("conflito", mensagem, status, requestId);
    this.name = "CrmConflito";
  }
}

/** 429: limite de chamadas. `retryAfterMs` vem do cabeçalho `Retry-After`, se houver. */
export class CrmLimite extends ErroCrm {
  constructor(
    mensagem: string,
    status?: number,
    requestId?: string,
    readonly retryAfterMs?: number,
  ) {
    super("limite", mensagem, status, requestId);
    this.name = "CrmLimite";
  }
}

/** Rede ou 5xx numa LEITURA: dá para repetir sem risco. */
export class CrmIndisponivel extends ErroCrm {
  constructor(mensagem: string, status?: number, requestId?: string) {
    super("indisponivel", mensagem, status, requestId);
    this.name = "CrmIndisponivel";
  }
}

/**
 * Timeout ou 5xx DEPOIS de um POST ou PUT: o Nectar pode ter gravado.
 * Nunca se repete a escrita às cegas: quem trata é o motor (plano §4.5).
 */
export class CrmResultadoIncerto extends ErroCrm {
  constructor(mensagem: string, status?: number, requestId?: string) {
    super("resultado_incerto", mensagem, status, requestId);
    this.name = "CrmResultadoIncerto";
  }
}

/** A resposta parece "cota do plano esgotada": o motor pausa a conexão. */
export class CrmCotaEsgotada extends ErroCrm {
  constructor(mensagem: string, status?: number, requestId?: string) {
    super("cota_esgotada", mensagem, status, requestId);
    this.name = "CrmCotaEsgotada";
  }
}

/** O zod da resposta falhou (formato diferente do esperado). */
export class CrmRespostaInvalida extends ErroCrm {
  constructor(mensagem: string, status?: number, requestId?: string) {
    super("resposta_invalida", mensagem, status, requestId);
    this.name = "CrmRespostaInvalida";
  }
}

/** Requisito da conta ou do funil que faltou; recusado ANTES de chamar a API. */
export class CrmRequisitoFaltando extends ErroCrm {
  constructor(readonly motivo: string) {
    super("requisito_faltando", `CrmRequisitoFaltando: ${motivo}`);
    this.name = "CrmRequisitoFaltando";
  }
}

/** O card não foi enviado (contato bloqueado, segundo card no mesmo funil). O cadastro segue. */
export class CrmCardNaoEnviado extends ErroCrm {
  constructor(readonly motivo: string) {
    super("card_nao_enviado", `CrmCardNaoEnviado: ${motivo}`);
    this.name = "CrmCardNaoEnviado";
  }
}

/** Anexo recusado (extensão, tamanho, teto ou armazenamento): vira link, não erro do item. */
export class CrmAnexoRecusado extends ErroCrm {
  constructor(readonly motivo: string) {
    super("anexo_recusado", `CrmAnexoRecusado: ${motivo}`);
    this.name = "CrmAnexoRecusado";
  }
}

/** O orçamento diário de chamadas acabou; o job volta atrasado até `ateMs` (época em ms). */
export class CrmOrcamentoEsgotado extends ErroCrm {
  constructor(readonly ateMs: number) {
    super("orcamento_esgotado", "CrmOrcamentoEsgotado: orçamento diário de chamadas esgotado");
    this.name = "CrmOrcamentoEsgotado";
  }
}

/** A capacidade ainda não foi homologada, ou não é suportada pelo conector. */
export class CrmCapacidadeNaoSuportada extends ErroCrm {
  constructor(readonly capacidade: string) {
    super("capacidade_nao_suportada", `CrmCapacidadeNaoSuportada: ${capacidade}`);
    this.name = "CrmCapacidadeNaoSuportada";
  }
}

/** O time ainda não conectou o Nectar (sem linha ou sem token). */
export class CrmNaoConfigurado extends ErroCrm {
  constructor() {
    super("nao_configurado", "CrmNaoConfigurado: o Nectar não está conectado");
    this.name = "CrmNaoConfigurado";
  }
}

/** O time não está na lista do beta (`CRM_BETA_TEAM_IDS`). */
export class CrmForaDoBeta extends ErroCrm {
  constructor() {
    super("fora_do_beta", "CrmForaDoBeta: integração com o Nectar não liberada para este time");
    this.name = "CrmForaDoBeta";
  }
}

/** A conexão foi pausada (401 persistente, cota esgotada, Leadboard que sumiu). */
export class CrmConexaoPausada extends ErroCrm {
  constructor(readonly motivo: string) {
    super("conexao_pausada", `CrmConexaoPausada: ${motivo}`);
    this.name = "CrmConexaoPausada";
  }
}

/**
 * Troca o dado pessoal do caminho por `:valor` antes de ir para mensagem de
 * erro ou log (plano §4.8). Vale para o segmento que vem depois de `/email/`,
 * `/telefone/`, `/cpf/` e `/cnpj/`. A query, se vier junto, é cortada.
 * Ex.: `/contatos/cpf/12345678901` vira `/contatos/cpf/:valor`.
 */
export function caminhoParaLog(caminho: string): string {
  const semQuery = caminho.split(/[?#]/, 1)[0] ?? "";
  return semQuery.replace(/\/(email|telefone|cpf|cnpj)\/[^/]+/g, "/$1/:valor");
}
