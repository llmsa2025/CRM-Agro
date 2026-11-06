import { createHash } from "node:crypto";
import type { ZodError } from "zod";
import { contemSegredo } from "../comum";
import { CAPACIDADES_BOOLEANAS_DE_LIGACAO, MODOS_DE_ORIGINAR_DE_LIGACAO, type CapacidadeBooleanaDeLigacao } from "../capacidades";
import { ErroDeLigacao, NaoEncontradoDeLigacao, NaoSuportadoDeLigacao, RecusadoPeloProvedorDeLigacao, type CodigoDeErroDeLigacao } from "../erros";
import { ResultadoDaConsultaDeLigacaoSchema, ResultadoDaNormalizacaoDeLigacaoSchema, type FatoDeLigacao } from "../fato";
import {
  ehFatoTerminalDeLigacao,
  erroDe,
  fatosDosAvisos,
  formasDoTelefone,
  ligarEConduzir,
  ligarParaTeste,
  nomeDoErro,
  normalizarAviso,
  normalizarAvisos,
} from "./cenas";
import { CAPACIDADES_COMPROVADAS_PELO_ROTEIRO_DE_LIGACAO, type CenarioDeContratoDeLigacao } from "./tipos";

/**
 * Conferências da suíte de contrato que devolvem a LISTA de violações (vazia = tudo certo), em vez de
 * chamar `expect`. Assim a mesma verificação serve à suíte e ao teste que prova que um adaptador defeituoso
 * REPROVA (o que vaza a chave, o que mente na matriz, o que põe telefone no fato): um teste cujo trabalho é
 * falhar não pode usar `expect`.
 *
 * Nenhuma mensagem repete valor vindo do adaptador (pode ser telefone ou chave): só nomes e códigos.
 */

/** O que o zod reprovou, só com o caminho e o código (nunca o valor). */
const resumoDoZod = (e: ZodError): string =>
  e.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "raiz"}: ${i.code}`)
    .join("; ");

// ---------------------------------------------------------------------------------------------------
// FATOS: dentro do schema e sem dado pessoal
// ---------------------------------------------------------------------------------------------------

/**
 * O que o adaptador devolve (aviso e consulta) cabe no schema do fato e NUNCA carrega o telefone do contato.
 * O fato diz o que aconteceu com uma ligação, nunca com quem.
 */
export async function conferirFatos(c: CenarioDeContratoDeLigacao): Promise<string[]> {
  const v: string[] = [];
  const cenas = [
    { nome: "atendida", desfecho: { causa: "atendida" as const } },
    { nome: "não atendeu", desfecho: { causa: "nao_atendeu" as const } },
  ];
  for (const cena of cenas) {
    const e = await erroDe(async () => {
      const l = await ligarEConduzir(c, cena.desfecho, { gravar: true });
      const telefones = formasDoTelefone(l.destinoE164);
      if (contemSegredo(l.providerCallId, telefones)) v.push(`originar (${cena.nome}): o providerCallId carrega o telefone do contato.`);
      l.avisos.forEach((aviso, i) => {
        const r = normalizarAviso(c, aviso);
        const lido = ResultadoDaNormalizacaoDeLigacaoSchema.safeParse(r);
        if (!lido.success) v.push(`normalizarWebhook (${cena.nome}, aviso ${i + 1}): fora do schema do fato (${resumoDoZod(lido.error)}).`);
        if (contemSegredo(r.fatos, telefones)) v.push(`normalizarWebhook (${cena.nome}, aviso ${i + 1}): o fato carrega o telefone do contato.`);
      });
      if (typeof c.provedor.consultar === "function") {
        const q = await c.provedor.consultar(c.ctx, l.providerCallId);
        const lido = ResultadoDaConsultaDeLigacaoSchema.safeParse(q);
        if (!lido.success) v.push(`consultar (${cena.nome}): fora do schema do fato (${resumoDoZod(lido.error)}).`);
        if (contemSegredo(q.fatos, telefones)) v.push(`consultar (${cena.nome}): o fato carrega o telefone do contato.`);
      }
    });
    if (e !== undefined) v.push(`fatos (${cena.nome}): a cena falhou (${nomeDoErro(e)}).`);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------------
// ID DO EVENTO: estável para o mesmo aviso
// ---------------------------------------------------------------------------------------------------

const idsDe = (fatos: readonly FatoDeLigacao[]): string[] => fatos.map((f) => f.idEvento);

/**
 * O `idEvento` do adaptador é estável: o mesmo aviso lido duas vezes dá o mesmo id (é isso que a caixa de
 * entrada usa para não gravar duas vezes), e fatos diferentes não dividem o mesmo id. A consulta repetida
 * também dá os mesmos ids.
 */
export async function conferirIdEventoEstavel(c: CenarioDeContratoDeLigacao): Promise<string[]> {
  const v: string[] = [];
  const e = await erroDe(async () => {
    const l = await ligarEConduzir(c, { causa: "atendida" }, { gravar: true });
    l.avisos.forEach((aviso, i) => {
      const a = idsDe(normalizarAviso(c, aviso).fatos);
      const b = idsDe(normalizarAviso(c, aviso).fatos);
      if (a.join("|") !== b.join("|")) v.push(`idEvento: o mesmo aviso (${i + 1}) deu ids diferentes em duas leituras.`);
    });
    const todos = idsDe(fatosDosAvisos(c, l.avisos));
    if (new Set(todos).size !== todos.length) v.push("idEvento: dois fatos diferentes da mesma ligação ficaram com o mesmo id.");
    if (typeof c.provedor.consultar === "function") {
      const primeira = idsDe((await c.provedor.consultar(c.ctx, l.providerCallId)).fatos);
      const segunda = idsDe((await c.provedor.consultar(c.ctx, l.providerCallId)).fatos);
      if (primeira.join("|") !== segunda.join("|")) v.push("idEvento: a mesma consulta, feita duas vezes, deu ids diferentes.");
    }
  });
  if (e !== undefined) v.push(`idEvento: a cena falhou (${nomeDoErro(e)}).`);
  return v;
}

// ---------------------------------------------------------------------------------------------------
// PONTAS: o destino e a origem que o aviso traz
// ---------------------------------------------------------------------------------------------------

/**
 * Com `pontasNoAviso`, todo fato terminal tem a ponta declarada (e é o destino que foi discado). Sem a
 * declaração, o aviso não traz a ponta: a matriz precisa ser exata, porque é ela que decide se uma ponta que
 * falta é divergência.
 */
export async function conferirPontas(c: CenarioDeContratoDeLigacao): Promise<string[]> {
  const v: string[] = [];
  const cap = c.provedor.capacidades;
  const e = await erroDe(async () => {
    const l = await ligarEConduzir(c, { causa: "atendida" });
    const terminais = normalizarAvisos(c, l.avisos).flatMap((r) =>
      r.fatos.filter(ehFatoTerminalDeLigacao).map((f) => ({ pontas: r.pontas.filter((p) => p.idEvento === f.idEvento) })),
    );
    if (terminais.length === 0) v.push("pontas: o aviso de uma ligação atendida não trouxe fato de fim para conferir.");
    for (const t of terminais) {
      const destinos = t.pontas.map((p) => p.destinoE164).filter((d): d is string => d !== undefined);
      const origens = t.pontas.map((p) => p.origemExterna).filter((o): o is string => o !== undefined);
      if (cap.pontasNoAviso.destino && destinos.length === 0) v.push("pontas: declarada com destino, mas o fato de fim chegou sem a ponta do destino.");
      if (!cap.pontasNoAviso.destino && destinos.length > 0) v.push("pontas: declarada sem destino, mas o aviso trouxe a ponta do destino.");
      if (cap.pontasNoAviso.destino && destinos.length > 0 && !destinos.includes(l.destinoE164)) v.push("pontas: o destino do aviso não é o número que foi discado.");
      if (cap.pontasNoAviso.origem && origens.length === 0) v.push("pontas: declarada com origem, mas o fato de fim chegou sem a ponta da origem.");
      if (!cap.pontasNoAviso.origem && origens.length > 0) v.push("pontas: declarada sem origem, mas o aviso trouxe a ponta da origem.");
    }
  });
  if (e !== undefined) v.push(`pontas: a cena falhou (${nomeDoErro(e)}).`);
  return v;
}

// ---------------------------------------------------------------------------------------------------
// AUTENTICAÇÃO DO AVISO
// ---------------------------------------------------------------------------------------------------

/**
 * Com `assinatura_do_provedor`, o adaptador confere a assinatura: o aviso assinado passa, o adulterado, o
 * sem assinatura e o de segredo errado não passam, e o segredo anterior vale na janela de rotação. Com
 * `url_assinada`, quem prova a origem é o endereço (a rota o confere): o corpo não tem assinatura, então o
 * adaptador sozinho NUNCA autentica. Aceitar nesse modo seria uma porta aberta para quem escrevesse a rota
 * confiando no adaptador.
 */
export async function conferirAutenticacaoDoAviso(c: CenarioDeContratoDeLigacao): Promise<string[]> {
  const v: string[] = [];
  const cap = c.provedor.capacidades;
  const e = await erroDe(async () => {
    const { avisos } = await ligarEConduzir(c, { causa: "atendida" });
    const req = avisos[0];
    if (!req) {
      v.push("webhook: o provedor não mandou nenhum aviso de uma ligação atendida.");
      return;
    }
    const autentico = (rotulo: string, ctx: typeof c.ctx, aviso: typeof req): boolean => {
      try {
        return c.provedor.verificarWebhook(ctx, aviso).autentico === true;
      } catch (erro) {
        v.push(`webhook (${rotulo}): a verificação lançou ${nomeDoErro(erro)} em vez de recusar.`);
        return false;
      }
    };
    const adulterado = c.roteiro.adulterar(req);
    const semCabecalhos = { ...req, cabecalhos: {} };

    if (cap.webhook === "url_assinada") {
      for (const [rotulo, aviso] of [["assinado", req], ["adulterado", adulterado], ["sem cabeçalhos", semCabecalhos]] as const) {
        if (autentico(rotulo, c.ctx, aviso)) v.push(`webhook (${rotulo}): na URL assinada quem prova a origem é o endereço, e o adaptador sozinho não pode autenticar o aviso.`);
      }
      return;
    }

    const atual = c.ctx.segredoWebhook?.atual;
    if (!atual) {
      v.push("webhook: o cenário não traz o segredo do aviso.");
      return;
    }
    if (!autentico("assinado", c.ctx, req)) v.push("webhook (assinado): o aviso assinado foi recusado.");
    if (autentico("adulterado", c.ctx, adulterado)) v.push("webhook (adulterado): o aviso adulterado foi aceito.");
    if (autentico("sem assinatura", c.ctx, semCabecalhos)) v.push("webhook (sem assinatura): o aviso sem assinatura foi aceito.");
    if (autentico("segredo errado", { ...c.ctx, segredoWebhook: { atual: "outro-segredo-que-nao-e-o-certo" } }, req)) v.push("webhook (segredo errado): o aviso foi aceito com o segredo errado.");
    if (autentico("sem segredo", { ...c.ctx, segredoWebhook: null }, req)) v.push("webhook (sem segredo): o aviso foi aceito sem segredo no contexto.");
    if (!autentico("segredo anterior", { ...c.ctx, segredoWebhook: { atual: "segredo-novo-depois-da-rotacao-01", anterior: atual } }, req)) {
      v.push("webhook (segredo anterior): o segredo anterior deixou de valer na janela de rotação.");
    }
  });
  if (e !== undefined) v.push(`webhook: a cena falhou (${nomeDoErro(e)}).`);
  return v;
}

// ---------------------------------------------------------------------------------------------------
// GRAVAÇÃO
// ---------------------------------------------------------------------------------------------------

/**
 * A gravação chega por onde a matriz diz (webhook, consulta ou nunca), o arquivo confere com o sha256, o prazo
 * do fato é o declarado e, quando a matriz diz que é apagável, depois de apagar o arquivo some.
 */
export async function conferirGravacao(c: CenarioDeContratoDeLigacao): Promise<string[]> {
  const v: string[] = [];
  const p = c.provedor;
  const g = p.capacidades.gravacao;
  const e = await erroDe(async () => {
    const l = await ligarEConduzir(c, { causa: "atendida" }, { gravar: true });
    const dosAvisos = fatosDosAvisos(c, l.avisos).filter((f) => f.tipo === "gravacao_pronta");
    const daConsulta = typeof p.consultar === "function" ? (await p.consultar(c.ctx, l.providerCallId)).fatos.filter((f) => f.tipo === "gravacao_pronta") : [];

    if (g.entrega === "nenhuma") {
      if (dosAvisos.length + daConsulta.length > 0) v.push("gravação: declarada como nenhuma, mas o provedor avisou uma gravação pronta.");
      return;
    }
    const pronta = (g.entrega === "webhook" ? dosAvisos : daConsulta)[0];
    if (!pronta || pronta.tipo !== "gravacao_pronta") {
      v.push(`gravação: declarada como entregue por ${g.entrega}, mas o fato de gravação pronta não chegou por aí.`);
      return;
    }
    if (typeof p.obterGravacao !== "function") {
      v.push("gravação: declarada como entregue, mas o adaptador não tem obterGravacao.");
      return;
    }

    const arquivo = await p.obterGravacao(c.ctx, pronta.refGravacao);
    const hash = createHash("sha256");
    let total = 0;
    for await (const parte of arquivo.stream) {
      hash.update(parte);
      total += parte.byteLength;
    }
    const calculado = hash.digest("hex");
    if (total === 0) v.push("gravação: o arquivo veio vazio.");
    if (arquivo.sha256Esperado !== null && arquivo.sha256Esperado !== calculado) v.push("gravação: o sha256 informado na entrega não confere com os bytes.");
    if (pronta.sha256 !== undefined && pronta.sha256 !== calculado) v.push("gravação: o sha256 do aviso não confere com os bytes.");
    if (arquivo.mime !== pronta.mime) v.push("gravação: o tipo do arquivo é diferente do que o aviso disse.");

    if (g.prazoHoras !== null) {
      if (!pronta.expiraEm) v.push("gravação: há prazo declarado, mas o fato não traz expiraEm.");
      else {
        const horas = (Date.parse(pronta.expiraEm) - Date.parse(pronta.ocorridoEm)) / 3_600_000;
        if (Math.abs(horas - g.prazoHoras) > 1 / 60) v.push(`gravação: o prazo declarado é de ${g.prazoHoras} h, mas o fato indica ${horas.toFixed(2)} h.`);
      }
    } else if (pronta.expiraEm) v.push("gravação: não há prazo declarado, mas o fato traz expiraEm.");

    if (g.apagavel) {
      if (typeof p.apagarGravacao !== "function") v.push("gravação: declarada como apagável, mas o adaptador não tem apagarGravacao.");
      else {
        await p.apagarGravacao(c.ctx, pronta.refGravacao);
        const depois = await erroDe(() => p.obterGravacao!(c.ctx, pronta.refGravacao));
        if (!(depois instanceof NaoEncontradoDeLigacao)) v.push("gravação: depois de apagar, o arquivo ainda pôde ser obtido.");
      }
    }
  });
  if (e !== undefined) v.push(`gravação: a cena falhou (${nomeDoErro(e)}).`);
  return v;
}

// ---------------------------------------------------------------------------------------------------
// HONESTIDADE DA MATRIZ
// ---------------------------------------------------------------------------------------------------

/**
 * Capacidade `true` precisa de prova que passa; capacidade `false` precisa fazer a operação ser recusada ou o
 * método não existir. Um adaptador que diz "sim" e não faz reprova. Um que diz "não" e faz também: a matriz
 * tem de ser exata, porque é ela que decide o que o CRM Agro tenta e o que ele aceita como prova.
 */
export async function conferirHonestidadeDaMatriz(c: CenarioDeContratoDeLigacao): Promise<string[]> {
  const v: string[] = [];
  const p = c.provedor;
  const cap = p.capacidades;
  const ctx = c.ctx;

  // Os métodos opcionais existem exatamente quando a matriz os declara.
  const presenca = (tem: boolean, declarado: boolean, mensagem: string): void => {
    if (tem !== declarado) v.push(mensagem);
  };
  presenca(typeof p.consultar === "function", cap.consulta.porId, "consultar: o método e a capacidade consulta.porId discordam.");
  presenca(typeof p.provisionarLinha === "function", cap.provisionarLinha !== "manual", "provisionarLinha: o método e a capacidade discordam.");
  presenca(typeof p.responderOriginacao === "function", cap.originacaoSincrona, "responderOriginacao: o método e a capacidade originacaoSincrona discordam.");
  presenca(typeof p.obterGravacao === "function", cap.gravacao.entrega !== "nenhuma", "obterGravacao: o método e a capacidade gravacao.entrega discordam.");
  presenca(typeof p.apagarGravacao === "function", cap.gravacao.apagavel, "apagarGravacao: o método e a capacidade gravacao.apagavel discordam.");

  // originar: cada modo funciona se declarado e lança nao_suportado se não.
  for (const modo of MODOS_DE_ORIGINAR_DE_LIGACAO) {
    const declarado = cap.originar.includes(modo);
    const erro = await erroDe(async () => {
      const l = await ligarParaTeste(c, { modo });
      await p.encerrar(ctx, l.providerCallId);
    });
    if (declarado && erro !== undefined) v.push(`originar(${modo}): declarado como sim, mas a operação falhou (${nomeDoErro(erro)}).`);
    if (!declarado && erro === undefined) v.push(`originar(${modo}): declarado como não, mas a operação funcionou.`);
    if (!declarado && erro !== undefined && !(erro instanceof NaoSuportadoDeLigacao)) v.push(`originar(${modo}): declarado como não, mas lançou ${nomeDoErro(erro)} em vez de nao_suportado.`);
  }

  // provisionarLinha: devolve a linha e só campos de escopo "linha".
  if (typeof p.provisionarLinha === "function") {
    const erro = await erroDe(async () => {
      const r = await p.provisionarLinha!(ctx, { rotulo: "Linha de teste" });
      if (typeof r.idExterno !== "string" || r.idExterno.length === 0) throw new Error("sem idExterno");
      const camposDaLinha = new Set(c.descritor.campos.filter((campo) => campo.escopo === "linha").map((campo) => campo.chave));
      if (Object.keys(r.credenciais).some((k) => !camposDaLinha.has(k))) v.push("provisionarLinha: devolveu credencial que o descritor não declara no escopo linha.");
    });
    if (erro !== undefined) v.push(`provisionarLinha: declarada como sim, mas a operação falhou (${nomeDoErro(erro)}).`);
  }

  // originacaoSincrona: responde com tipo e corpo.
  if (typeof p.responderOriginacao === "function") {
    const erro = await erroDe(async () => {
      const r = p.responderOriginacao!(ctx, { callId: c.roteiro.novoCallId(), destinoE164: c.roteiro.novoDestino() });
      if (typeof r.contentType !== "string" || r.contentType.length === 0 || typeof r.corpo !== "string" || r.corpo.length === 0) throw new Error("resposta vazia");
    });
    if (erro !== undefined) v.push(`originacaoSincrona: declarada como sim, mas responderOriginacao falhou (${nomeDoErro(erro)}).`);
  }

  // ligaAFrio: sem permissão do contato, liga se declarado; senão o provedor recusa por falta de permissão.
  {
    const erro = await erroDe(async () => {
      const l = await ligarParaTeste(c, { comPermissao: false });
      await p.encerrar(ctx, l.providerCallId);
    });
    if (cap.ligaAFrio && erro !== undefined) v.push(`ligaAFrio: declarada como sim, mas ligar para quem não deu permissão falhou (${nomeDoErro(erro)}).`);
    if (!cap.ligaAFrio && erro === undefined) v.push("ligaAFrio: declarada como não, mas ligar para quem não deu permissão funcionou.");
    if (!cap.ligaAFrio && erro !== undefined && !(erro instanceof RecusadoPeloProvedorDeLigacao && erro.motivo === "sem_permissao")) {
      v.push(`ligaAFrio: declarada como não, mas a recusa foi ${nomeDoErro(erro)} em vez de recusado_pelo_provedor por falta de permissão.`);
    }
  }

  // eventosAoVivo, duracaoDesdeAtendimento e trazAtendimento: lidos de uma ligação atendida.
  const erroDaCena = await erroDe(async () => {
    const l = await ligarEConduzir(c, { causa: "atendida" });
    const fatos = fatosDosAvisos(c, l.avisos);
    const aoVivo = fatos.filter((f) => f.tipo === "chamando" || f.tipo === "atendida");
    if (cap.eventosAoVivo && aoVivo.length === 0) v.push("eventosAoVivo: declarada como sim, mas o aviso de uma ligação atendida só trouxe o fim.");
    if (!cap.eventosAoVivo && aoVivo.length > 0) v.push("eventosAoVivo: declarada como não, mas o provedor avisou o toque ou o atendimento.");

    const fim = fatos.find((f) => f.tipo === "encerrada");
    if (!fim || fim.tipo !== "encerrada") v.push("o aviso de uma ligação atendida não trouxe o fato de fim.");
    else {
      const trouxe = fim.duracaoConectadaS !== undefined;
      if (cap.duracaoDesdeAtendimento && !trouxe) v.push("duracaoDesdeAtendimento: declarada como sim, mas o fato de fim não traz a duração conectada.");
      if (!cap.duracaoDesdeAtendimento && trouxe) v.push("duracaoDesdeAtendimento: declarada como não, mas o fato de fim traz a duração como conectada.");
    }

    if (typeof p.consultar === "function") {
      const q = await p.consultar(ctx, l.providerCallId);
      const trouxe = q.fatos.some((f) => f.tipo === "atendida" || (f.tipo === "encerrada" && f.atendidaEm !== undefined));
      if (cap.consulta.trazAtendimento && !trouxe) v.push("consulta.trazAtendimento: declarada como sim, mas a consulta de uma ligação atendida não diz que ela foi atendida.");
      if (!cap.consulta.trazAtendimento && trouxe) v.push("consulta.trazAtendimento: declarada como não, mas a consulta diz que a ligação foi atendida.");
    }
  });
  if (erroDaCena !== undefined) v.push(`a cena de uma ligação atendida falhou (${nomeDoErro(erroDaCena)}).`);

  // As capacidades que a interface não exercita: a prova vem do roteiro.
  for (const nome of CAPACIDADES_COMPROVADAS_PELO_ROTEIRO_DE_LIGACAO) {
    const promessa = cap[nome];
    const prova = c.roteiro.comprovar?.[nome];
    if (promessa && !prova) {
      v.push(`${nome}: declarada como sim, mas o roteiro não tem prova.`);
      continue;
    }
    if (!prova) continue;
    const erro = await erroDe(prova);
    if (erro !== undefined) {
      v.push(`${nome}: a prova do roteiro falhou (${nomeDoErro(erro)}).`);
      continue;
    }
    const resultado = await prova();
    if (promessa && resultado !== true) v.push(`${nome}: declarada como sim, mas a prova do roteiro não confirmou.`);
    if (!promessa && resultado === true) v.push(`${nome}: declarada como não, mas a prova do roteiro mostrou que o provedor faz.`);
  }

  // Matriz e descritor concordam sobre o ambiente de teste e o modo do aviso.
  if (cap.sandbox !== c.descritor.ambientes.includes("teste")) v.push("sandbox: a matriz e o descritor discordam sobre existir o ambiente de teste.");
  if (cap.webhook !== c.descritor.webhook.modo) v.push("webhook: a matriz e o descritor discordam sobre o modo do aviso.");

  // Toda capacidade booleana está coberta por uma das conferências acima (se entrar uma nova, este teste avisa).
  const cobertas: ReadonlySet<CapacidadeBooleanaDeLigacao> = new Set<CapacidadeBooleanaDeLigacao>([
    "originacaoSincrona",
    "ligaAFrio",
    "eventosAoVivo",
    "duracaoDesdeAtendimento",
    "sandbox",
    ...CAPACIDADES_COMPROVADAS_PELO_ROTEIRO_DE_LIGACAO,
  ]);
  for (const nome of CAPACIDADES_BOOLEANAS_DE_LIGACAO) if (!cobertas.has(nome)) v.push(`${nome}: nenhuma conferência cobre esta capacidade.`);

  return v;
}

// ---------------------------------------------------------------------------------------------------
// ERROS NEUTROS
// ---------------------------------------------------------------------------------------------------

/** Cada resposta de erro provocada tem de cair num dos 8 erros neutros, com o código esperado. */
export async function conferirErrosNeutros(c: CenarioDeContratoDeLigacao): Promise<string[]> {
  const v: string[] = [];
  for (const p of c.roteiro.respostasDeErro(c)) {
    const e = await erroDe(p.provocar);
    if (e === undefined) v.push(`erro "${p.nome}": a chamada devia falhar e deu certo.`);
    else if (!(e instanceof ErroDeLigacao)) v.push(`erro "${p.nome}": escapou como ${nomeDoErro(e)}, não como erro neutro.`);
    else if (e.codigo !== p.esperado) v.push(`erro "${p.nome}": virou ${e.codigo}, o esperado era ${p.esperado}.`);
  }
  return v;
}

/** Quais dos 8 códigos as provocações do cenário cobrem. */
export function codigosCobertos(c: CenarioDeContratoDeLigacao): Set<CodigoDeErroDeLigacao> {
  return new Set(c.roteiro.respostasDeErro(c).map((p) => p.esperado));
}

// ---------------------------------------------------------------------------------------------------
// SIGILO
// ---------------------------------------------------------------------------------------------------

/**
 * Nenhum segredo em erro, em resposta nem em nada serializável. O adaptador que "vaza" a chave no erro faz
 * esta conferência devolver violações (e a suíte, falhar).
 */
export async function conferirSigilo(c: CenarioDeContratoDeLigacao): Promise<string[]> {
  const v: string[] = [];
  const confere = (onde: string, valor: unknown): void => {
    if (contemSegredo(valor, c.segredos)) v.push(`${onde}: contém um segredo.`);
  };

  // Credencial errada: o erro não pode repetir a chave (a errada nem a certa).
  const erroDeChave = await erroDe(() => c.provedor.testarConexao(c.ctxComCredencialErrada));
  if (erroDeChave === undefined) v.push("testarConexao com credencial errada devia falhar.");
  confere("erro de credencial", erroDeChave);
  for (const errada of Object.values(c.ctxComCredencialErrada.credenciais)) {
    if (contemSegredo(erroDeChave, [errada])) v.push("erro de credencial: repete a chave digitada.");
  }

  // Toda provocação de erro.
  for (const p of c.roteiro.respostasDeErro(c)) confere(`erro "${p.nome}"`, await erroDe(p.provocar));

  // Respostas normais e verificação do aviso (cada passo falha sozinho, sem esconder os outros).
  const passo = async (rotulo: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
    try {
      confere(rotulo, await fn());
    } catch (e) {
      v.push(`${rotulo}: a conferência falhou (${nomeDoErro(e)}).`);
    }
  };
  await passo("testarConexao", () => c.provedor.testarConexao(c.ctx));
  let avisos: Awaited<ReturnType<typeof ligarEConduzir>> | null = null;
  await passo("originar", async () => {
    avisos = await ligarEConduzir(c, { causa: "atendida" }, { gravar: true });
    return { providerCallId: avisos.providerCallId };
  });
  const feito = avisos as Awaited<ReturnType<typeof ligarEConduzir>> | null;
  if (feito?.avisos[0]) {
    const req = feito.avisos[0];
    await passo("verificarWebhook (válido)", () => c.provedor.verificarWebhook(c.ctx, req));
    await passo("verificarWebhook (adulterado)", () => c.provedor.verificarWebhook(c.ctx, c.roteiro.adulterar(req)));
    await passo("normalizarWebhook", () => normalizarAviso(c, req));
  }
  if (feito && typeof c.provedor.consultar === "function") await passo("consultar", () => c.provedor.consultar!(c.ctx, feito.providerCallId));
  return v;
}
