/**
 * Regras PURAS da tela de conexão do Nectar (ficha N2): mensagens de erro,
 * texto de cada estado e as linhas do diagnóstico. Ficam fora do componente
 * para serem testadas sem DOM (o `apps/web` tem vitest puro).
 *
 * Este arquivo NÃO importa valor do `@crmagro/core` (a tela é cliente): os tipos
 * do core são repetidos aqui, com o comentário "espelha ... do core".
 */

/** Espelha FormatoTelefone do core. */
export type FormatoTelefoneWeb =
  | "e164" | "55" | "ddd" | "parenteses_hifen" | "parenteses" | "sem_nono" | "sem_nono_parenteses_hifen" | "outro";

/** Espelha os campos de FunilExterno do core que a tela usa. */
export type FunilWeb = {
  id: string;
  nome: string;
  etapas: { id: string; nome: string; sequencia: number }[];
  indisponivel: string | null;
};

/** Espelha DiagnosticoConexao do core (só o que a tela lê). */
export type DiagnosticoWeb = {
  credencial: "ok" | "invalida" | "sem_permissao" | "indisponivel";
  leadboard: "tem" | "nao_tem" | "desconhecido";
  funisVendas: FunilWeb[];
  funisPreVenda: FunilWeb[];
  usuarios: { total: number; ativos: number } | null;
  filas: number | null;
  tags: { nome: string; ativa: boolean; relacionada: "contato" | "oportunidade" | "ambos" | null; podeIncluir: boolean }[];
  camposObrigatorios: { nome: string }[];
  formatosTelefone: Partial<Record<FormatoTelefoneWeb, number>>;
  avisos: string[];
};

/** Espelha NectarStatusDTO do core. */
export type NectarStatusWeb = {
  liberado: boolean;
  configurado: boolean;
  status: "connected" | "error" | "disconnected";
  finalDoToken: string | null;
  atualizadoEm: string | null;
  ipSaida: string | null;
};

const FRASE_CREDENCIAL_INVALIDA = "O Nectar recusou o token. Confira se copiou inteiro e se ele não venceu.";
const FRASE_SEM_PERMISSAO = "O usuário do token não pode ler isso no Nectar. Gere o token com um administrador.";
const FRASE_INDISPONIVEL = "O Nectar não respondeu agora. Tente de novo em alguns minutos.";

/** Aviso de conta sem o adicional Leadboard (frase exata do plano, §2.6). */
export const FRASE_SEM_LEADBOARD = "Sua conta do Nectar não tem o Leadboard (adicional do Nectar). A opção pré-venda não aparece nos envios.";
export const FRASE_LEADBOARD_DESCONHECIDO = "Não deu para saber se a conta tem o Leadboard.";

/** Aviso fixo do diagnóstico: automações do Nectar podem mandar mensagem a quem pediu para sair. */
export const AVISO_AUTOMACOES_NECTAR =
  "Automações do próprio Nectar (RD Station, e-mail marketing) podem mandar mensagem para quem pediu para sair, se não filtrarem pela etiqueta “Opt-out (CRM Agro)”.";

/** Texto do ip de saída (ou o pedido de ajuda quando o servidor não informou). */
export function textoDoIpSaida(ipSaida: string | null): string {
  return ipSaida
    ? `IP do servidor do CRM Agro: ${ipSaida}. Se o usuário do token tiver restrição por IP ou por horário no Nectar, libere esse IP ou tire a restrição.`
    : "Peça ao suporte do CRM Agro o IP do servidor.";
}

/** Mensagem para a tela, pelo `name` do erro (o erro vem do core, sem importar a classe). */
export function mensagemDoErroNectar(e: unknown): string {
  const nome = e instanceof Error ? e.name : "";
  switch (nome) {
    case "CrmCredencialInvalida":
      return FRASE_CREDENCIAL_INVALIDA;
    case "CrmSemPermissao":
      return FRASE_SEM_PERMISSAO;
    case "CrmIndisponivel":
      return FRASE_INDISPONIVEL;
    case "CrmForaDoBeta":
      return "A integração com o Nectar ainda está em teste e não foi liberada para esta empresa.";
    case "CrmNaoConfigurado":
      return "O Nectar ainda não está conectado. Cole o token e clique em Salvar e testar.";
    case "CrmConexaoPausada": {
      const motivo = (e as { motivo?: unknown }).motivo;
      return `A conexão com o Nectar está pausada: ${typeof motivo === "string" ? motivo : "sem motivo informado"}. Veja a aba Orçamento e arquivos.`;
    }
    case "CrmOrcamentoEsgotado":
      return "O limite diário de chamadas ao Nectar acabou. Tente de novo depois da meia-noite ou suba o orçamento.";
    case "ForbiddenError":
      return "Só administradores conectam o Nectar.";
    case "ZodError": {
      const primeiro = (e as { issues?: { message?: unknown }[] }).issues?.[0]?.message;
      return typeof primeiro === "string" && primeiro ? primeiro : "Confira os dados informados.";
    }
    default:
      return "Não deu para falar com o Nectar.";
  }
}

/** O que a tela mostra depois do "Salvar e testar": o `testConnection` DEVOLVE a credencial, não lança erro. */
export function mensagemDaCredencial(credencial: DiagnosticoWeb["credencial"]): string {
  switch (credencial) {
    case "ok":
      return "Token aceito";
    case "invalida":
      return FRASE_CREDENCIAL_INVALIDA;
    case "sem_permissao":
      return FRASE_SEM_PERMISSAO;
    case "indisponivel":
      return FRASE_INDISPONIVEL;
  }
}

/** Ponto de cor da credencial (dicionário do StatusDot). */
export function tomDaCredencial(credencial: DiagnosticoWeb["credencial"]): "ok" | "error" | "attention" {
  return credencial === "ok" ? "ok" : credencial === "indisponivel" ? "attention" : "error";
}

/** "1. Etapa A · 2. Etapa B", na ordem da sequência. */
export function textoDasEtapas(etapas: FunilWeb["etapas"]): string {
  return [...etapas]
    .sort((a, b) => a.sequencia - b.sequencia)
    .map((e, i) => `${i + 1}. ${e.nome}`)
    .join(" · ");
}

/** Um funil na lista da tela: nome, etapas e o motivo de estar indisponível (se estiver). */
export function linhaDoFunil(f: FunilWeb): { nome: string; etapas: string; indisponivel: string | null } {
  return { nome: f.nome, etapas: textoDasEtapas(f.etapas) || "sem etapas", indisponivel: f.indisponivel };
}

/** Exemplo de cada formato de telefone, como aparece na tela. */
const EXEMPLO_DO_FORMATO: Record<FormatoTelefoneWeb, string> = {
  e164: "+5562999998888",
  "55": "5562999998888",
  ddd: "62999998888",
  parenteses_hifen: "(62) 99999-8888",
  parenteses: "(62) 999998888",
  sem_nono: "6299998888",
  sem_nono_parenteses_hifen: "(62) 9999-8888",
  outro: "outro formato",
};

/** "(62) 99999-8888: 30 de 50", do formato mais comum para o menos comum. */
export function itensDeFormatos(dist: DiagnosticoWeb["formatosTelefone"]): string[] {
  const pares = (Object.entries(dist) as [FormatoTelefoneWeb, number][]).filter(([, n]) => n > 0);
  const total = pares.reduce((soma, [, n]) => soma + n, 0);
  return pares
    .sort((a, b) => b[1] - a[1])
    .map(([formato, n]) => `${EXEMPLO_DO_FORMATO[formato]}: ${n} de ${total}`);
}

/** A etiqueta "Opt-out (CRM Agro)" existe e vale para contato? Espelha temEtiquetaOptOutUtilizavel do core. */
export function etiquetaOptOutPronta(tags: DiagnosticoWeb["tags"]): boolean {
  return tags.some(
    (t) =>
      t.nome.trim().toLowerCase() === "opt-out (crm agro)" &&
      t.ativa &&
      t.podeIncluir &&
      (t.relacionada === null || t.relacionada === "contato" || t.relacionada === "ambos"),
  );
}

export type LinhaDiagnostico = {
  id: "leadboard" | "usuarios" | "filas" | "optout" | "campos" | "telefones";
  rotulo: string;
  texto: string;
  /** Lista curta abaixo do texto (formatos de telefone). */
  itens?: string[];
  tom: "ok" | "attention" | "empty";
};

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

/** As linhas do diagnóstico que não são a lista de funis: Leadboard, usuários, filas, etiqueta, campos e telefones. */
export function linhasDoDiagnostico(d: DiagnosticoWeb): LinhaDiagnostico[] {
  const leadboard: LinhaDiagnostico =
    d.leadboard === "nao_tem"
      ? { id: "leadboard", rotulo: "Pré-venda (Leadboard)", texto: FRASE_SEM_LEADBOARD, tom: "attention" }
      : d.leadboard === "desconhecido"
        ? { id: "leadboard", rotulo: "Pré-venda (Leadboard)", texto: FRASE_LEADBOARD_DESCONHECIDO, tom: "attention" }
        : { id: "leadboard", rotulo: "Pré-venda (Leadboard)", texto: plural(d.funisPreVenda.length, "funil", "funis"), tom: "ok" };

  const usuarios: LinhaDiagnostico = d.usuarios
    ? {
        id: "usuarios",
        rotulo: "Usuários",
        texto: `${plural(d.usuarios.total, "usuário", "usuários")} (${plural(d.usuarios.ativos, "ativo", "ativos")})`,
        tom: "ok",
      }
    : {
        id: "usuarios",
        rotulo: "Usuários",
        texto: "A lista não veio. Cada pessoa vai digitar o e-mail de login dela no Nectar.",
        tom: "attention",
      };

  const filas: LinhaDiagnostico =
    d.filas === null
      ? { id: "filas", rotulo: "Filas", texto: "Não deu para ler as filas.", tom: "attention" }
      : { id: "filas", rotulo: "Filas", texto: d.filas === 0 ? "Nenhuma fila" : plural(d.filas, "fila", "filas"), tom: d.filas === 0 ? "empty" : "ok" };

  const optout: LinhaDiagnostico = etiquetaOptOutPronta(d.tags)
    ? { id: "optout", rotulo: "Etiqueta de opt-out", texto: "A etiqueta “Opt-out (CRM Agro)” está pronta para contatos.", tom: "ok" }
    : { id: "optout", rotulo: "Etiqueta de opt-out", texto: "Crie no Nectar a etiqueta “Opt-out (CRM Agro)” para contatos.", tom: "attention" };

  const campos: LinhaDiagnostico = {
    id: "campos",
    rotulo: "Campos obrigatórios",
    texto: d.camposObrigatorios.length ? d.camposObrigatorios.map((c) => c.nome).join(", ") : "Nenhum",
    tom: d.camposObrigatorios.length ? "attention" : "ok",
  };

  const itens = itensDeFormatos(d.formatosTelefone);
  const telefones: LinhaDiagnostico = {
    id: "telefones",
    rotulo: "Formatos de telefone da sua base",
    texto: itens.length ? "Como os telefones estão gravados no Nectar (amostra de contatos):" : "Sem telefones na amostra.",
    itens: itens.length ? itens : undefined,
    tom: itens.length ? "ok" : "empty",
  };

  return [leadboard, usuarios, filas, optout, campos, telefones];
}

/** Estado da linha do Nectar no hub de Integrações. */
export type EstadoNoHub = {
  label: "Em breve" | "Conectado" | "Com erro" | "Não conectado";
  tone: "ok" | "error" | "empty";
  botao: "Conectar" | "Gerenciar" | null;
};

/** `null` = time fora do beta: continua "Em breve", sem botão. */
export function estadoNoHub(status: NectarStatusWeb | null): EstadoNoHub {
  if (!status) return { label: "Em breve", tone: "empty", botao: null };
  const botao = status.configurado ? "Gerenciar" : "Conectar";
  if (status.status === "connected") return { label: "Conectado", tone: "ok", botao };
  if (status.status === "error") return { label: "Com erro", tone: "error", botao };
  return { label: "Não conectado", tone: "empty", botao };
}

/** Subtítulo da página (é dado, não frase de marketing). */
export function subtituloDaPagina(status: NectarStatusWeb): string {
  if (status.status === "connected") return "Conectado";
  if (status.status === "error") return "Com erro";
  return "Não conectado";
}
