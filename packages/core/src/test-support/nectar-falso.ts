/**
 * Nectar FALSO para os testes (plano §6, "Nectar simulado"). Fichas N1 e N3.
 *
 * É um transporte em memória para o `criarClienteNectar`: nenhuma chamada sai
 * do VPS. As fixtures são exemplos genéricos, no formato da API
 * pública do Nectar.
 *
 * Fidelidade que importa aos testes:
 * - o token errado (ou ausente) dá 401;
 * - o falso RESPEITA o `attribute=` da query: com ele devolve só essas chaves
 *   de cada usuário; sem ele devolve tudo, inclusive `sipPassword`, como a API
 *   real faria (por isso o CRM Agro sempre pede `attribute`);
 * - rota desconhecida dá 404;
 * - `falhas` injeta uma resposta de erro (ou qualquer status) por método e caminho;
 * - `tempoEsgotado` faz o transporte lançar um `TimeoutError`.
 *
 * Escrita (N3): contatos, oportunidades, qualificações, notas e comentários
 * ficam em memória, com ids numéricos crescentes. Reproduz o pior caso da API
 * real: o `PUT` com lista SUBSTITUI a lista inteira e campo enviado vazio
 * (`null`, `""`, `[]`, `{}`) é apagado (`putSubstituiListas`).
 */
import type { PedidoNectar, RespostaNectar, TransporteNectar } from "../integrations/crm/providers/nectarcrm/client";

export const TOKEN_FALSO_NECTAR = "token-falso-nectar-123456";

export type FalhaNectarFalso = {
  metodo?: string;
  /** Casa com o caminho (sem o prefixo da base e sem a query), do jeito que foi codificado no endereço. */
  caminho: RegExp;
  /** Se vier, só vale quando estes parâmetros da query forem iguais (ex.: `{ type: "1" }`). */
  query?: Record<string, string>;
  status: number;
  retryAfter?: string;
  texto?: string;
  /** Quantas vezes vale. Sem o campo, vale sempre. */
  vezes?: number;
};

export type ConfigNectarFalso = {
  /** Qualquer outro token recebe 401. */
  token: string;
  funisVendas: unknown[];
  /** Lista de funis, ou "403" e "404" para simular a conta sem Leadboard. */
  funisPreVenda: unknown[] | "403" | "404";
  usuarios: unknown[];
  /** Só a rota escolhida existe; a outra dá 404. */
  rotaUsuarios: "usuarios" | "usuario";
  filas: unknown[];
  tags: unknown[];
  campos: unknown[];
  contatosAmostra: unknown[];
  falhas: FalhaNectarFalso[];
  /** O transporte lança um erro com `name` "TimeoutError" nos caminhos que casarem. */
  tempoEsgotado: RegExp[];
  /** Quantas notas o `GET /publicacao/?page=n` devolve por página. */
  tamanhoPagina: number;
  /** `true` (padrão): o PUT com `emails`, `telefones` ou `listas` troca a lista inteira. `false`: acrescenta. */
  putSubstituiListas: boolean;
  /** Grava e DEPOIS lança `TimeoutError` (o "resultado incerto"): casa com o caminho de um POST ou PUT. */
  tempoEsgotadoDepoisDeGravar: RegExp[];
  /** Contatos com essas constantes não podem ter qualificação (400). Padrão: Cliente, Prospect e Descartado. */
  recusarQualificacaoConstantes: number[];
  /** "desc" (padrão): a mais nova primeiro. "embaralhada": pontas alternadas, fora de ordem. */
  ordemNotas: "desc" | "embaralhada";
  /** Relógio do falso (as notas ganham `dataCriacao` por ele). Cada nota nova é sempre mais nova que a anterior. */
  agora: () => Date;
};

/** Registro em memória (contato, oportunidade, qualificação, nota ou comentário). */
export type RegistroFalso = { id: number } & Record<string, unknown>;

/** Fixtures novas a cada chamada (o teste pode mexer nelas sem vazar para outro). */
function configPadrao(): ConfigNectarFalso {
  return {
    token: TOKEN_FALSO_NECTAR,
    funisVendas: [
      {
        ativo: true,
        id: 1,
        nome: "Funil de venda",
        padrao: true,
        sequencias: [
          { id: 22, nome: "Processo de Cadência", sequencia: 2, prazo: 2, gerarProposta: false },
          { id: 11, nome: "Gerar Interesse", sequencia: 1, prazo: 3, gerarProposta: false },
        ],
        tipo: 0,
        permitePularEtapa: true,
        iniciarQualquerEtapa: true,
        produtoObrigatorio: false,
        modeloVenda: 0,
      },
      {
        ativo: true,
        id: 2,
        nome: "Funil com produto obrigatório",
        padrao: false,
        sequencias: [{ id: 31, nome: "Proposta", sequencia: 1, prazo: 5, gerarProposta: true }],
        tipo: 0,
        iniciarQualquerEtapa: true,
        produtoObrigatorio: true,
        modeloVenda: 1,
      },
    ],
    funisPreVenda: [
      {
        ativo: true,
        id: 7,
        nome: "Qualificação de leads",
        padrao: true,
        sequencias: [
          { id: 71, nome: "Novo lead", sequencia: 1 },
          { id: 72, nome: "Em contato", sequencia: 2 },
        ],
        tipo: 1,
        iniciarQualquerEtapa: false,
        produtoObrigatorio: false,
        modeloVenda: 0,
      },
    ],
    usuarios: [
      {
        id: 1,
        nome: "Ana Vendedora",
        email: "ana@empresa.example",
        login: "ana",
        ativo: true,
        virtual: false,
        isSuporte: false,
        // Campos sensíveis que a API real devolve quando não há `attribute`.
        sipUsername: "1001",
        sipPassword: "segredo-sip",
        listaIps: ["1.2.3.4"],
        restricaoPorIp: true,
      },
      { id: 2, nome: "Bruno Inativo", email: "bruno@empresa.example", login: "bruno", ativo: false, virtual: false, isSuporte: false },
      { id: 3, nome: "Integração Virtual", email: null, login: "virtual", ativo: true, virtual: true, isSuporte: false },
    ],
    rotaUsuarios: "usuarios",
    filas: [{ id: 12, name: "Vendedores", users: [{ id: 16, user: { id: 1, login: "ana", nome: "Ana Vendedora" }, position: 1 }] }],
    tags: [
      { id: 1, nome: "Opt-out (CRM Agro)", ativo: true, relacionada: 0, podeIncluir: true, podeVisualizar: true },
      { id: 2, nome: "Feira 2026", ativo: true, relacionada: 2, podeIncluir: true, podeVisualizar: true },
    ],
    campos: [
      { id: 180, nome: "Área (ha)", alias: "area_ha", tipo: 0, obrigatorio: false, relacionado: "Contato" },
      { id: 181, nome: "Código do cliente", alias: "codigo_cliente", tipo: 1, obrigatorio: true, relacionado: "Contato" },
    ],
    // Os 7 formatos de telefone da §2.4 do plano, um contato para cada.
    contatosAmostra: [
      { id: 101, nome: "Contato 1", telefones: ["+5562999998888"] },
      { id: 102, nome: "Contato 2", telefones: ["5562999998888"] },
      { id: 103, nome: "Contato 3", telefones: ["62999998888"] },
      { id: 104, nome: "Contato 4", telefones: ["(62) 99999-8888"] },
      { id: 105, nome: "Contato 5", telefones: ["(62) 999998888"] },
      { id: 106, nome: "Contato 6", telefones: ["6299998888"] },
      { id: 107, nome: "Contato 7", telefones: ["(62) 9999-8888"] },
    ],
    falhas: [],
    tempoEsgotado: [],
    tamanhoPagina: 50,
    putSubstituiListas: true,
    tempoEsgotadoDepoisDeGravar: [],
    recusarQualificacaoConstantes: [0, 1, 5],
    ordemNotas: "desc",
    agora: () => new Date(),
  };
}

/** Uma resposta do falso: status, corpo (objeto vira JSON; texto vai como está) e cabeçalhos. */
type RespostaFalsa = { status: number; corpo?: unknown; cabecalhos?: Record<string, string> };

/** Só as chaves pedidas em `attribute=` (uma ou mais); sem `attribute`, o objeto inteiro. */
function so(obj: unknown, atributos: string[]): unknown {
  if (atributos.length === 0 || typeof obj !== "object" || obj === null) return obj;
  const origem = obj as Record<string, unknown>;
  return Object.fromEntries(atributos.filter((a) => a in origem).map((a) => [a, origem[a]]));
}

/** Só as chaves de lista que o `PUT` pode substituir ou acrescentar. */
const CHAVES_DE_LISTA = ["emails", "telefones", "listas"] as const;

/** Campo "vazio" que o Nectar apaga quando vem num PUT de contato: `null`, `""`, `[]` e `{}`. */
function vazioParaOPut(v: unknown): boolean {
  if (v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === "object" && v !== null && Object.keys(v).length === 0;
}

const comoTexto = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const idDe = (v: unknown): string => comoTexto((v as { id?: unknown } | null | undefined)?.id);

export function criarNectarFalso(opts: Partial<ConfigNectarFalso> = {}): {
  transporte: TransporteNectar;
  /** Tudo o que chegou (para conferir cabeçalho, URL e corpo). */
  pedidos: PedidoNectar[];
  configurar(p: Partial<ConfigNectarFalso>): void;
  /** O que o falso guarda (só leitura para conferir no teste). */
  dados: {
    contatos: RegistroFalso[];
    oportunidades: RegistroFalso[];
    qualificacoes: RegistroFalso[];
    publicacoes: RegistroFalso[];
    comentarios: RegistroFalso[];
  };
  /** Semeia um contato que "já estava no Nectar" (sem passar por POST). Devolve o id. */
  adicionarContato(reg: Record<string, unknown>): number;
  /** Marca (ou desmarca) o contato como bloqueado para novas oportunidades. */
  bloquearContato(id: string | number, bloqueado?: boolean): void;
  /** Cria `n` notas "de outro usuário", MAIS NOVAS que tudo (simula um lote rodando na conta). */
  notasDeOutros(n: number): void;
} {
  const config: ConfigNectarFalso = { ...configPadrao(), ...opts };
  const pedidos: PedidoNectar[] = [];
  const usos = new WeakMap<FalhaNectarFalso, number>();
  const dados = {
    contatos: [] as RegistroFalso[],
    oportunidades: [] as RegistroFalso[],
    qualificacoes: [] as RegistroFalso[],
    publicacoes: [] as RegistroFalso[],
    comentarios: [] as RegistroFalso[],
  };
  let contador = 0;
  let proximoId = 1;
  let ultimoMs = 0;

  /** Relógio que nunca repete nem volta: cada nota nova é mais nova que a anterior. */
  const agoraMs = () => {
    ultimoMs = Math.max(config.agora().getTime(), ultimoMs + 1);
    return ultimoMs;
  };
  const novoId = () => proximoId++;
  const acharPorId = (lista: RegistroFalso[], id: string) => lista.find((r) => String(r.id) === id);

  function criarNota(corpo: Record<string, unknown>): RegistroFalso {
    const nota: RegistroFalso = { autor: { id: 1, nome: "Ana Vendedora" }, ...corpo, id: novoId(), dataCriacao: new Date(agoraMs()).toISOString() };
    dados.publicacoes.push(nota);
    return nota;
  }

  /** Notas na ordem em que `GET /publicacao/` as devolve. */
  function notasOrdenadas(): RegistroFalso[] {
    const desc = [...dados.publicacoes].sort((a, b) => Date.parse(String(b.dataCriacao)) - Date.parse(String(a.dataCriacao)) || b.id - a.id);
    if (config.ordemNotas === "desc") return desc;
    // Pontas alternadas (mais nova, mais antiga, segunda mais nova...): fora de ordem de propósito.
    const saida: RegistroFalso[] = [];
    let ini = 0;
    let fim = desc.length - 1;
    while (ini <= fim) {
      saida.push(desc[ini++]!);
      if (ini <= fim) saida.push(desc[fim--]!);
    }
    return saida;
  }

  /** PUT de contato: substitui só as chaves enviadas; vazio apaga; lista troca (ou acrescenta, conforme a config). */
  function aplicarPutDeContato(atual: RegistroFalso, corpo: Record<string, unknown>) {
    for (const [chave, valor] of Object.entries(corpo)) {
      if (chave === "id") continue;
      if (vazioParaOPut(valor)) {
        delete atual[chave];
      } else if (!config.putSubstituiListas && (CHAVES_DE_LISTA as readonly string[]).includes(chave) && Array.isArray(valor)) {
        const antes = Array.isArray(atual[chave]) ? (atual[chave] as unknown[]) : [];
        atual[chave] = [...antes, ...valor.filter((v) => !antes.some((a) => JSON.stringify(a) === JSON.stringify(v)))];
      } else {
        atual[chave] = valor;
      }
    }
  }

  const respostaDoContato = (c: RegistroFalso) => ({ ...c, blocked: Boolean(c.blocked) });
  const erro = (status: number, texto: string): RespostaFalsa => ({ status, corpo: { erro: texto } });

  /** Rotas do falso. Devolve `null` quando a rota não existe (vira 404). */
  function rotear(metodo: string, caminho: string, query: URLSearchParams, corpoTexto: string | undefined, multipart?: FormData): RespostaFalsa | null {
    const atributos = query.getAll("attribute");
    let corpo: Record<string, unknown> = {};
    if (corpoTexto) {
      try {
        corpo = JSON.parse(corpoTexto) as Record<string, unknown>;
      } catch {
        return erro(400, "corpo inválido");
      }
    }
    // Decodifica como o pior caso do plano (§2.4): um `+` SEM codificar no caminho chega como espaço; só `%2B` vira `+`.
    const decodificado = (parte: string | undefined) => decodeURIComponent((parte ?? "").replace(/\+/g, " "));

    if (metodo === "GET") {
      if (/^\/pipelines?\/?$/.test(caminho)) {
        if (query.get("type") === "1") {
          if (config.funisPreVenda === "403") return { status: 403, corpo: { erro: "sem permissão" } };
          if (config.funisPreVenda === "404") return { status: 404, corpo: { erro: "não encontrado" } };
          return { status: 200, corpo: config.funisPreVenda };
        }
        return { status: 200, corpo: config.funisVendas };
      }
      if (caminho === (config.rotaUsuarios === "usuarios" ? "/usuarios/" : "/usuario/")) {
        return { status: 200, corpo: config.usuarios.map((u) => so(u, atributos)) };
      }
      if (/^\/queues\/?$/.test(caminho)) return { status: 200, corpo: config.filas };
      if (/^\/lista\/?$/.test(caminho)) return { status: 200, corpo: config.tags };
      if (/^\/campoPersonalizado\/?$/.test(caminho)) return { status: 200, corpo: config.campos };
      if (/^\/customField\/fields\/[12]$/.test(caminho)) return { status: 200, corpo: [] };

      // Busca de contato (exata, sem normalizar: o Nectar guarda como foi digitado).
      const busca = /^\/contatos\/(email|telefone|cpf|cnpj)\/([^/]+)$/.exec(caminho);
      if (busca) {
        const [, campo, bruto] = busca as unknown as [string, string, string];
        const valor = decodificado(bruto);
        const achados = dados.contatos.filter((c) => {
          if (campo === "email") return Array.isArray(c.emails) && (c.emails as string[]).some((e) => e.toLowerCase() === valor.toLowerCase());
          if (campo === "telefone") return Array.isArray(c.telefones) && (c.telefones as string[]).includes(valor);
          return c[campo] === valor;
        });
        return achados.length ? { status: 200, corpo: achados.map(respostaDoContato) } : erro(404, "contato não encontrado");
      }
      if (/^\/contatos\/?$/.test(caminho)) {
        const nome = query.get("nome");
        if (nome !== null) {
          // `exato=true` acha o nome ou o código (o filtro do Nectar aceita "nome ou código").
          const achados = dados.contatos.filter((c) => c.codigo === nome || c.nome === nome);
          return { status: 200, corpo: achados.map(respostaDoContato) };
        }
        const limite = Number(query.get("displayLength") ?? 50);
        return { status: 200, corpo: config.contatosAmostra.slice(0, Number.isFinite(limite) ? limite : 50) };
      }
      const contato = /^\/contatos\/(\d+)$/.exec(caminho);
      if (contato) {
        const c = acharPorId(dados.contatos, contato[1]!);
        return c ? { status: 200, corpo: respostaDoContato(c) } : erro(404, "contato não encontrado");
      }
      const oportunidades = /^\/oportunidades\/contatoId\/(\d+)$/.exec(caminho);
      if (oportunidades) {
        const id = oportunidades[1]!;
        return { status: 200, corpo: dados.oportunidades.filter((o) => idDe(o.cliente) === id || idDe(o.contato) === id) };
      }
      const qualificacoes = /^\/qualificacoes\/contatoId\/(\d+)$/.exec(caminho);
      if (qualificacoes) {
        const id = qualificacoes[1]!;
        return { status: 200, corpo: dados.qualificacoes.filter((q) => idDe(q.cliente) === id) };
      }
      if (/^\/qualificacoes\/?$/.test(caminho)) return { status: 200, corpo: dados.qualificacoes };
      const notaPorId = /^\/publicacao\/(\d+)$/.exec(caminho);
      if (notaPorId) {
        const n = acharPorId(dados.publicacoes, notaPorId[1]!);
        return n ? { status: 200, corpo: n } : erro(404, "nota não encontrada");
      }
      const comentarios = /^\/publicacao\/(\d+)\/comentarios$/.exec(caminho);
      if (comentarios) return { status: 200, corpo: dados.comentarios.filter((c) => String(c.publicacaoId) === comentarios[1]) };
      if (/^\/publicacao\/?$/.test(caminho)) {
        const pagina = Math.max(1, Number(query.get("page") ?? 1) || 1);
        const tam = Math.max(1, config.tamanhoPagina);
        return { status: 200, corpo: notasOrdenadas().slice((pagina - 1) * tam, pagina * tam) };
      }
      return null;
    }

    if (metodo === "POST") {
      if (/^\/contatos\/?$/.test(caminho)) {
        if (typeof corpo.nome !== "string" || corpo.nome === "" || typeof corpo.constante !== "number") return erro(400, "nome e constante são obrigatórios");
        const novo: RegistroFalso = { ...corpo, id: novoId(), blocked: Boolean(corpo.blocked) };
        dados.contatos.push(novo);
        return { status: 200, corpo: respostaDoContato(novo) };
      }
      if (/^\/oportunidades\/?$/.test(caminho)) {
        if (typeof corpo.nome !== "string" || !idDe(corpo.cliente)) return erro(400, "nome e cliente são obrigatórios");
        const pessoa = acharPorId(dados.contatos, idDe(corpo.contato) || idDe(corpo.cliente));
        if (pessoa?.blocked) return erro(400, "contato bloqueado para gerar novas oportunidades");
        const nova: RegistroFalso = { ...corpo, id: novoId(), status: 1 };
        dados.oportunidades.push(nova);
        return { status: 200, corpo: nova };
      }
      if (/^\/qualificacoes\/?$/.test(caminho)) {
        if (typeof corpo.nome !== "string" || !idDe(corpo.cliente)) return erro(400, "nome e cliente são obrigatórios");
        const pessoa = acharPorId(dados.contatos, idDe(corpo.cliente));
        if (pessoa && typeof pessoa.constante === "number" && config.recusarQualificacaoConstantes.includes(pessoa.constante)) {
          return erro(400, "Só é possível criar qualificações para contatos do tipo Lead e Suspect");
        }
        const nova: RegistroFalso = { ...corpo, id: novoId(), status: 1 };
        dados.qualificacoes.push(nova);
        return { status: 200, corpo: nova };
      }
      if (/^\/publicacao\/?$/.test(caminho)) {
        if (typeof corpo.descricao !== "string" || !idDe(corpo.contato)) return erro(400, "descricao e contato são obrigatórios");
        return { status: 200, corpo: criarNota(corpo) };
      }
      if (/^\/publicacao\/incluirComAnexos\/?$/.test(caminho)) {
        // Multipart: o campo `publicacao` (texto JSON) e os `anexos` (arquivos). Guarda nome e tamanho de cada um.
        if (!multipart) return erro(400, "envie multipart/form-data");
        let publicacao: Record<string, unknown>;
        try {
          publicacao = JSON.parse(String(multipart.get("publicacao") ?? "")) as Record<string, unknown>;
        } catch {
          return erro(400, "publicacao inválida");
        }
        if (typeof publicacao.descricao !== "string" || !idDe(publicacao.contato)) return erro(400, "descricao e contato são obrigatórios");
        const anexos = multipart
          .getAll("anexos")
          .filter((a): a is File => typeof a !== "string")
          .map((a) => ({ id: novoId(), nome: a.name, tamanho: a.size }));
        return { status: 200, corpo: criarNota({ ...publicacao, anexos }) };
      }
      const comentario = /^\/publicacao\/(\d+)\/comentario$/.exec(caminho);
      if (comentario) {
        if (!acharPorId(dados.publicacoes, comentario[1]!)) return erro(404, "nota não encontrada");
        const novo: RegistroFalso = { ...corpo, id: novoId(), publicacaoId: Number(comentario[1]) };
        dados.comentarios.push(novo);
        return { status: 200, corpo: novo };
      }
      return null;
    }

    if (metodo === "PUT") {
      const contato = /^\/contatos\/(\d+)$/.exec(caminho);
      if (contato) {
        const c = acharPorId(dados.contatos, contato[1]!);
        if (!c) return erro(404, "contato não encontrado");
        aplicarPutDeContato(c, corpo);
        return { status: 200, corpo: respostaDoContato(c) };
      }
      const qualificacao = /^\/qualificacoes\/(\d+)$/.exec(caminho);
      if (qualificacao) {
        const q = acharPorId(dados.qualificacoes, qualificacao[1]!);
        if (!q) return erro(404, "qualificação não encontrada");
        Object.assign(q, corpo, { id: q.id });
        return { status: 200, corpo: q };
      }
      const oportunidade = /^\/oportunidades\/(\d+)$/.exec(caminho);
      if (oportunidade) {
        const o = acharPorId(dados.oportunidades, oportunidade[1]!);
        if (!o) return erro(404, "oportunidade não encontrada");
        Object.assign(o, corpo, { id: o.id });
        return { status: 200, corpo: o };
      }
      return null;
    }
    return null;
  }

  const transporte: TransporteNectar = async (p) => {
    pedidos.push(p);
    contador += 1;
    const url = new URL(p.url);
    // Tira o prefixo da base real (`/crm/api/1`); numa base de teste sem prefixo, o caminho já é o certo.
    const caminho = url.pathname.replace(/^\/crm\/api\/1(?=\/)/, "");

    if (config.tempoEsgotado.some((r) => r.test(caminho))) {
      throw Object.assign(new Error("tempo esgotado (Nectar falso)"), { name: "TimeoutError" });
    }

    let resp: RespostaFalsa;
    if (p.cabecalhos["Access-Token"] !== config.token) {
      resp = { status: 401, corpo: { erro: "token inválido" } };
    } else {
      const falha = config.falhas.find(
        (f) =>
          (!f.metodo || f.metodo === p.metodo) &&
          f.caminho.test(caminho) &&
          Object.entries(f.query ?? {}).every(([k, v]) => url.searchParams.get(k) === v) &&
          (usos.get(f) ?? 0) < (f.vezes ?? Infinity),
      );
      if (falha) {
        usos.set(falha, (usos.get(falha) ?? 0) + 1);
        resp = {
          status: falha.status,
          corpo: falha.texto ?? "",
          cabecalhos: falha.retryAfter ? { "retry-after": falha.retryAfter } : undefined,
        };
      } else {
        const corpoTexto = typeof p.corpo === "string" ? p.corpo : undefined;
        const multipart = p.corpo instanceof FormData ? p.corpo : undefined;
        resp = rotear(p.metodo, caminho, url.searchParams, corpoTexto, multipart) ?? erro(404, "rota inexistente");
      }
    }

    // O falso gravou e "perdeu" a resposta: o cliente vê só o tempo esgotado (resultado incerto).
    if (p.metodo !== "GET" && resp.status < 300 && config.tempoEsgotadoDepoisDeGravar.some((r) => r.test(caminho))) {
      throw Object.assign(new Error("tempo esgotado depois de gravar (Nectar falso)"), { name: "TimeoutError" });
    }

    const cabecalhos: Record<string, string> = { "x-request-id": `req-falso-${contador}`, ...resp.cabecalhos };
    const texto = typeof resp.corpo === "string" ? resp.corpo : resp.corpo === undefined ? "" : JSON.stringify(resp.corpo);
    const resposta: RespostaNectar = {
      status: resp.status,
      cabecalho: (nome) => cabecalhos[nome.toLowerCase()] ?? null,
      texto,
    };
    return resposta;
  };

  return {
    transporte,
    pedidos,
    configurar(p) {
      Object.assign(config, p);
    },
    dados,
    adicionarContato(reg) {
      const novo: RegistroFalso = { ...reg, id: novoId(), blocked: Boolean(reg.blocked) };
      dados.contatos.push(novo);
      return novo.id;
    },
    bloquearContato(id, bloqueado = true) {
      const c = acharPorId(dados.contatos, String(id));
      if (c) c.blocked = bloqueado;
    },
    notasDeOutros(n) {
      for (let i = 0; i < n; i++) {
        criarNota({
          autor: { id: 99, nome: "Outro usuário" },
          assunto: "Nota de outro usuário",
          descricao: `nota de outro usuário ${i + 1}`,
          contato: { id: 1 },
        });
      }
    },
  };
}
