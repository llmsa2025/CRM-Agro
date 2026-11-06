import { describe, expect, it } from "vitest";
import type { CapturaAtual, EstadoCaptura, MotivoCaptura, StatusCaptura } from "@crmagro/core";
import {
  RESULTADO_VISIVEL_MS,
  avisoDaBusca,
  avisoDoErroAoIniciar,
  botaoDaCaptura,
  tentarDepoisDas,
  textoDeAndamento,
} from "./captacao-estado";

/**
 * Regras puras da tela de Captação: quando o botão "Buscar" fica desativado, o que ele e o andamento
 * dizem, e o aviso de como a busca terminou (com o motivo e o que fazer). O estado vem do servidor.
 */
const AGORA = Date.parse("2026-09-30T15:00:00Z");
const status = (extra: Partial<StatusCaptura> = {}): StatusCaptura => ({
  lote: "3f2a9c1e-5b7d-4e2a-9c1e-5b7d3f2a9c1e",
  origem: "instagram",
  estado: "rodando",
  total: 100,
  processados: 12,
  criados: 12,
  falhas: 0,
  falhasAmostra: [],
  motivo: null,
  mensagem: null,
  iniciadoEm: null,
  atualizadoEm: new Date(AGORA - 10_000).toISOString(),
  ...extra,
});
const atual = (st: Partial<StatusCaptura>, emAndamento: boolean): CapturaAtual => ({ status: status(st), emAndamento });

describe("botão de buscar", () => {
  it("livre quando não há busca: rótulo normal, sem andamento", () => {
    expect(botaoDaCaptura({ iniciando: false, atual: null }, "Buscar seguidores")).toEqual({ desativado: false, rotulo: "Buscar seguidores", andamento: null });
  });

  it("desativado enquanto a busca anda (estado do servidor), com 'Buscando...' e 'N de M'", () => {
    expect(botaoDaCaptura({ iniciando: false, atual: atual({ estado: "rodando", processados: 12, total: 100 }, true) }, "Buscar seguidores")).toEqual({
      desativado: true,
      rotulo: "Buscando...",
      andamento: "12 de 100",
    });
  });

  it("recarregar a página ou abrir outra aba não muda nada: o mesmo estado do servidor manda", () => {
    const doServidor = atual({ estado: "rodando", processados: 40, total: 100 }, true);
    const aba1 = botaoDaCaptura({ iniciando: false, atual: doServidor }, "Buscar");
    const aba2 = botaoDaCaptura({ iniciando: false, atual: doServidor }, "Buscar");
    expect(aba1).toEqual(aba2);
    expect(aba1.desativado).toBe(true);
  });

  it("desativado já no clique, antes de o servidor responder (não dá para clicar duas vezes)", () => {
    expect(botaoDaCaptura({ iniciando: true, atual: null }, "Buscar")).toMatchObject({ desativado: true, rotulo: "Buscando...", andamento: null });
  });

  it("instagram 'na fila': o Chrome ainda não pegou, e o texto diz isso", () => {
    expect(botaoDaCaptura({ iniciando: false, atual: atual({ estado: "na_fila", processados: 0 }, true) }, "Buscar").andamento).toBe("Esperando o Chrome");
  });
  it("Maps e CNPJ 'na fila' mostram 0 de M", () => {
    expect(botaoDaCaptura({ iniciando: false, atual: atual({ origem: "maps", estado: "na_fila", processados: 0, total: 40 }, true) }, "Buscar").andamento).toBe("0 de 40");
    expect(botaoDaCaptura({ iniciando: false, atual: atual({ origem: "cnpj", estado: "rodando", processados: 3, total: 7 }, true) }, "Buscar").andamento).toBe("3 de 7");
  });

  it.each<EstadoCaptura>(["concluida", "vazia", "parcial", "falhou", "interrompida"])("volta ao normal quando termina (%s)", (estado) => {
    expect(botaoDaCaptura({ iniciando: false, atual: atual({ estado }, false) }, "Buscar seguidores")).toEqual({ desativado: false, rotulo: "Buscar seguidores", andamento: null });
  });

  it("busca que venceu (o servidor deixa de dizer 'em andamento' mesmo com o estado antigo): o botão volta", () => {
    expect(botaoDaCaptura({ iniciando: false, atual: atual({ estado: "na_fila" }, false) }, "Buscar").desativado).toBe(false);
  });

  it("o botão só olha o que o servidor diz (emAndamento), não o texto do estado", () => {
    expect(botaoDaCaptura({ iniciando: false, atual: atual({ estado: "concluida" }, true) }, "Buscar").desativado).toBe(true);
  });
});

describe("textoDeAndamento", () => {
  it("N de M, e N nunca passa de M", () => {
    expect(textoDeAndamento({ processados: 12, total: 100 })).toBe("12 de 100");
    expect(textoDeAndamento({ processados: 130, total: 100 })).toBe("100 de 100");
    expect(textoDeAndamento({ processados: 0, total: 100 })).toBe("0 de 100");
  });
  it("sem total, só o número; valores tortos não quebram", () => {
    expect(textoDeAndamento({ processados: 5, total: null })).toBe("5");
    expect(textoDeAndamento({ processados: -3, total: 10 })).toBe("0 de 10");
    expect(textoDeAndamento({ processados: 2.9, total: 10 })).toBe("2 de 10");
    expect(textoDeAndamento({ processados: NaN, total: 10 })).toBe("0 de 10");
  });
});

describe("aviso de como a busca terminou", () => {
  it("não há aviso enquanto anda, sem busca, ou com resultado antigo", () => {
    expect(avisoDaBusca(null, AGORA)).toBeNull();
    expect(avisoDaBusca(atual({ estado: "rodando" }, true), AGORA)).toBeNull();
    const antigo = atual({ estado: "concluida", atualizadoEm: new Date(AGORA - RESULTADO_VISIVEL_MS - 1000).toISOString() }, false);
    expect(avisoDaBusca(antigo, AGORA)).toBeNull();
  });

  it("concluída: 'Busca concluída' com os contatos na fila", () => {
    expect(avisoDaBusca(atual({ estado: "concluida", criados: 30 }, false), AGORA)).toMatchObject({ tom: "ok", titulo: "Busca concluída", texto: "30 contatos na fila para revisar." });
    expect(avisoDaBusca(atual({ estado: "concluida", criados: 1 }, false), AGORA)!.texto).toBe("1 contato na fila para revisar.");
  });

  it("vazia: aviso (não é sucesso), com a mensagem do servidor", () => {
    expect(avisoDaBusca(atual({ estado: "vazia", criados: 0, motivo: "sem_resultados", mensagem: "O perfil não tem seguidores visíveis." }, false), AGORA)).toMatchObject({
      tom: "aviso",
      titulo: "Nada encontrado",
      texto: "O perfil não tem seguidores visíveis.",
      parcial: null,
    });
  });

  const MOTIVOS: [MotivoCaptura, string][] = [
    ["extensao_offline", "A extensão não respondeu"],
    ["sessao_instagram", "A sessão do Instagram caiu"],
    ["limite_instagram", "O Instagram pediu para esperar"],
    ["perfil_privado", "Perfil privado"],
    ["perfil_nao_encontrado", "Perfil não encontrado"],
    ["cota_diaria", "Limite do dia atingido"],
    ["conta_errada", "Outra conta do Instagram neste Chrome"],
    ["tempo_esgotado", "A busca demorou demais"],
    ["bloqueio_google", "O Google bloqueou a busca"],
    ["erro", "A busca parou"],
    ["interrompida", "A busca foi interrompida"],
  ];
  it.each(MOTIVOS)("interrompida por %s: título claro e a frase do servidor (que diz o que fazer)", (motivo, titulo) => {
    const a = avisoDaBusca(atual({ estado: "interrompida", motivo, criados: 0, mensagem: `Texto do servidor para ${motivo}.` }, false), AGORA)!;
    expect(a).toMatchObject({ tom: "erro", titulo, texto: `Texto do servidor para ${motivo}.`, parcial: null });
  });

  it("parou no meio com contatos já na fila: aviso, dizendo quantos ficaram", () => {
    const a = avisoDaBusca(atual({ estado: "interrompida", motivo: "limite_instagram", criados: 24, mensagem: "O Instagram pediu para esperar." }, false), AGORA)!;
    expect(a.tom).toBe("aviso");
    expect(a.parcial).toBe("24 contatos já estão na fila.");
    expect(avisoDaBusca(atual({ estado: "parcial", motivo: "erro", criados: 1, mensagem: "x" }, false), AGORA)!.parcial).toBe("1 contato já está na fila.");
  });

  it("Instagram pediu para esperar: mostra até que horas (só se ainda for no futuro)", () => {
    const futuro = new Date(AGORA + 3_600_000).toISOString();
    const a = avisoDaBusca(atual({ estado: "interrompida", motivo: "limite_instagram", tentarDepoisDe: futuro, mensagem: "m" }, false), AGORA)!;
    expect(a.tentarDepois).toMatch(/^\d{2}:\d{2}$/);
    expect(tentarDepoisDas(new Date(AGORA - 1000).toISOString(), AGORA)).toBeNull();
    expect(tentarDepoisDas(null, AGORA)).toBeNull();
    expect(tentarDepoisDas("lixo", AGORA)).toBeNull();
  });

  it("estado 'parcial' e 'falhou' do worker (Maps e CNPJ) também mostram o motivo", () => {
    expect(avisoDaBusca(atual({ origem: "maps", estado: "falhou", motivo: "bloqueio_google", criados: 0, mensagem: "O Google bloqueou." }, false), AGORA)).toMatchObject({ tom: "erro", titulo: "O Google bloqueou a busca" });
    expect(avisoDaBusca(atual({ origem: "cnpj", estado: "falhou", motivo: "erro", criados: 0, mensagem: "Nenhum CNPJ deu certo (3 falha(s))." }, false), AGORA)).toMatchObject({ tom: "erro", texto: "Nenhum CNPJ deu certo (3 falha(s))." });
  });

  it("sem mensagem do servidor, usa uma frase padrão (nunca vazio)", () => {
    expect(avisoDaBusca(atual({ estado: "falhou", motivo: null, mensagem: null, criados: 0 }, false), AGORA)!.texto).toBe("A busca parou. Tente de novo.");
  });

  it("estado 'na fila' ou 'rodando' que já não conta como andando (ficou para trás) não gera aviso", () => {
    expect(avisoDaBusca(atual({ estado: "rodando" }, false), AGORA)).toBeNull();
  });

  it("os títulos não têm travessão nem meia-risca, e o CRM Agro é masculino", () => {
    for (const [motivo] of MOTIVOS) {
      const a = avisoDaBusca(atual({ estado: "interrompida", motivo, criados: 3, mensagem: "x" }, false), AGORA)!;
      expect(`${a.titulo} ${a.parcial}`).not.toMatch(/[—–]|\ba CRM Agro\b/);
    }
  });
});

describe("recusa do servidor ao pedir a busca", () => {
  it("extensão desligada: título e a frase do servidor com o que fazer", () => {
    expect(avisoDoErroAoIniciar("extensao_offline", "Abra o Chrome com a extensão do CRM Agro ligada e tente de novo.")).toEqual({
      tom: "erro",
      titulo: "Chrome ou extensão desligados",
      texto: "Abra o Chrome com a extensão do CRM Agro ligada e tente de novo.",
      parcial: null,
      tentarDepois: null,
    });
  });
  it("já existe busca: aviso de informação, não de erro", () => {
    expect(avisoDoErroAoIniciar("em_andamento", "Já existe uma busca em andamento.")).toMatchObject({ tom: "info", titulo: "Já existe uma busca em andamento" });
  });
  it("cada código tem título; código desconhecido cai no genérico", () => {
    expect(avisoDoErroAoIniciar("conta_ausente", "x").titulo).toBe("Instagram não encontrado neste Chrome");
    expect(avisoDoErroAoIniciar("sem_conta", "x").titulo).toBe("Instagram não conectado");
    expect(avisoDoErroAoIniciar("perfil_invalido", "x").titulo).toBe("Confira o @ do perfil");
    expect(avisoDoErroAoIniciar("sem_permissao", "x").titulo).toBe("Sem permissão");
    expect(avisoDoErroAoIniciar("qualquer", "x").titulo).toBe("Não deu para iniciar a busca");
    expect(avisoDoErroAoIniciar(undefined, "x").titulo).toBe("Não deu para iniciar a busca");
    expect(avisoDoErroAoIniciar("constructor", "x").titulo).toBe("Não deu para iniciar a busca");
  });
});

describe("busca por filtro: a fonte acabou e o 'Parar'", () => {
  it("pediu mais do que a fonte tinha: aviso informativo com a quantidade que havia", () => {
    const a = avisoDaBusca(
      atual({ origem: "cnpj", estado: "concluida", criados: 134, motivo: "fonte_esgotada", mensagem: "Só havia 134 empresas com esses filtros. A fonte não tem mais." }, false),
      AGORA,
    );
    expect(a).toMatchObject({ tom: "info", titulo: "A fonte não tem mais" });
    expect(a?.texto).toContain("Só havia 134 empresas com esses filtros");
    expect(a?.texto).toContain("134 contatos na fila");
  });

  it("a pessoa parou: aviso informativo (não é erro), com ou sem empresas na fila", () => {
    expect(avisoDaBusca(atual({ origem: "cnpj", estado: "parcial", criados: 87, motivo: "parada_pelo_usuario", mensagem: "Você parou a busca." }, false), AGORA)).toMatchObject({ tom: "info", titulo: "Busca parada" });
    expect(avisoDaBusca(atual({ origem: "cnpj", estado: "interrompida", criados: 0, motivo: "parada_pelo_usuario", mensagem: "Você parou a busca." }, false), AGORA)).toMatchObject({ tom: "info" });
  });

  it("o andamento mostra 'N de M' enquanto anda", () => {
    expect(textoDeAndamento({ processados: 87, total: 200 })).toBe("87 de 200");
  });
});
