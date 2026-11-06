import { describe, expect, it } from "vitest";
import {
  AVISO_AUTOMACOES_NECTAR,
  FRASE_LEADBOARD_DESCONHECIDO,
  FRASE_SEM_LEADBOARD,
  estadoNoHub,
  etiquetaOptOutPronta,
  itensDeFormatos,
  linhaDoFunil,
  linhasDoDiagnostico,
  mensagemDaCredencial,
  mensagemDoErroNectar,
  subtituloDaPagina,
  textoDasEtapas,
  textoDoIpSaida,
  tomDaCredencial,
  type DiagnosticoWeb,
  type NectarStatusWeb,
} from "./conexao";

/** Erro com o `name` que o core usa (a tela não importa as classes do core). */
const erro = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error("x"), { name }, extra);

const diagnosticoBase = (): DiagnosticoWeb => ({
  credencial: "ok",
  leadboard: "tem",
  funisVendas: [{ id: "1", nome: "Funil de venda", etapas: [{ id: "2", nome: "B", sequencia: 2 }, { id: "1", nome: "A", sequencia: 1 }], indisponivel: null }],
  funisPreVenda: [{ id: "7", nome: "Qualificação", etapas: [], indisponivel: null }],
  usuarios: { total: 12, ativos: 10 },
  filas: 2,
  tags: [{ nome: "Opt-out (CRM Agro)", ativa: true, relacionada: "contato", podeIncluir: true }],
  camposObrigatorios: [],
  formatosTelefone: { parenteses_hifen: 30, ddd: 15, e164: 5 },
  avisos: [],
});

const statusBase = (p: Partial<NectarStatusWeb> = {}): NectarStatusWeb => ({
  liberado: true,
  configurado: true,
  status: "connected",
  finalDoToken: "••••abcd",
  atualizadoEm: null,
  ipSaida: null,
  ...p,
});

describe("mensagemDoErroNectar", () => {
  it("cada erro do core tem a frase da ficha", () => {
    expect(mensagemDoErroNectar(erro("CrmCredencialInvalida"))).toBe("O Nectar recusou o token. Confira se copiou inteiro e se ele não venceu.");
    expect(mensagemDoErroNectar(erro("CrmSemPermissao"))).toBe("O usuário do token não pode ler isso no Nectar. Gere o token com um administrador.");
    expect(mensagemDoErroNectar(erro("CrmIndisponivel"))).toBe("O Nectar não respondeu agora. Tente de novo em alguns minutos.");
    expect(mensagemDoErroNectar(erro("CrmForaDoBeta"))).toBe("A integração com o Nectar ainda está em teste e não foi liberada para esta empresa.");
    expect(mensagemDoErroNectar(erro("CrmNaoConfigurado"))).toBe("O Nectar ainda não está conectado. Cole o token e clique em Salvar e testar.");
    expect(mensagemDoErroNectar(erro("CrmConexaoPausada", { motivo: "cota esgotada" }))).toBe(
      "A conexão com o Nectar está pausada: cota esgotada. Veja a aba Orçamento e arquivos.",
    );
    expect(mensagemDoErroNectar(erro("CrmOrcamentoEsgotado"))).toBe(
      "O limite diário de chamadas ao Nectar acabou. Tente de novo depois da meia-noite ou suba o orçamento.",
    );
    expect(mensagemDoErroNectar(erro("ForbiddenError"))).toBe("Só administradores conectam o Nectar.");
  });

  it("ZodError mostra a mensagem do primeiro erro", () => {
    expect(mensagemDoErroNectar(erro("ZodError", { issues: [{ message: "o token parece incompleto" }, { message: "outra" }] }))).toBe("o token parece incompleto");
    expect(mensagemDoErroNectar(erro("ZodError", { issues: [] }))).toBe("Confira os dados informados.");
  });

  it("erro desconhecido, texto solto e null caem na frase genérica", () => {
    expect(mensagemDoErroNectar(new Error("qualquer coisa interna com token-123"))).toBe("Não deu para falar com o Nectar.");
    expect(mensagemDoErroNectar("texto")).toBe("Não deu para falar com o Nectar.");
    expect(mensagemDoErroNectar(null)).toBe("Não deu para falar com o Nectar.");
  });

  it("nenhuma frase tem travessão nem meia-risca (AGENTS.md (texto da interface))", () => {
    const nomes = ["CrmCredencialInvalida", "CrmSemPermissao", "CrmIndisponivel", "CrmForaDoBeta", "CrmNaoConfigurado", "CrmConexaoPausada", "CrmOrcamentoEsgotado", "ForbiddenError", "Outro"];
    const frases = [
      ...nomes.map((n) => mensagemDoErroNectar(erro(n, { motivo: "m" }))),
      FRASE_SEM_LEADBOARD,
      FRASE_LEADBOARD_DESCONHECIDO,
      AVISO_AUTOMACOES_NECTAR,
      textoDoIpSaida("1.2.3.4"),
      textoDoIpSaida(null),
    ];
    for (const f of frases) expect(f).not.toMatch(/[—–]/);
  });
});

describe("credencial", () => {
  it("as 4 credenciais têm a frase certa", () => {
    expect(mensagemDaCredencial("ok")).toBe("Token aceito");
    expect(mensagemDaCredencial("invalida")).toBe(mensagemDoErroNectar(erro("CrmCredencialInvalida")));
    expect(mensagemDaCredencial("sem_permissao")).toBe(mensagemDoErroNectar(erro("CrmSemPermissao")));
    expect(mensagemDaCredencial("indisponivel")).toBe(mensagemDoErroNectar(erro("CrmIndisponivel")));
  });

  it("o ponto de cor: aceito ok, recusado e sem permissão erro, sem resposta atenção", () => {
    expect(tomDaCredencial("ok")).toBe("ok");
    expect(tomDaCredencial("invalida")).toBe("error");
    expect(tomDaCredencial("sem_permissao")).toBe("error");
    expect(tomDaCredencial("indisponivel")).toBe("attention");
  });
});

describe("linhasDoDiagnostico", () => {
  it("Leadboard: a frase exata quando a conta não tem, e a de dúvida quando não deu para saber", () => {
    const nao = linhasDoDiagnostico({ ...diagnosticoBase(), leadboard: "nao_tem", funisPreVenda: [] }).find((l) => l.id === "leadboard");
    expect(nao?.texto).toBe("Sua conta do Nectar não tem o Leadboard (adicional do Nectar). A opção pré-venda não aparece nos envios.");
    const desc = linhasDoDiagnostico({ ...diagnosticoBase(), leadboard: "desconhecido", funisPreVenda: [] }).find((l) => l.id === "leadboard");
    expect(desc?.texto).toBe("Não deu para saber se a conta tem o Leadboard.");
    const tem = linhasDoDiagnostico(diagnosticoBase()).find((l) => l.id === "leadboard");
    expect(tem?.texto).toBe("1 funil");
  });

  it("usuários: '12 usuários (10 ativos)', singular e lista que não veio", () => {
    const texto = (d: DiagnosticoWeb) => linhasDoDiagnostico(d).find((l) => l.id === "usuarios")?.texto;
    expect(texto(diagnosticoBase())).toBe("12 usuários (10 ativos)");
    expect(texto({ ...diagnosticoBase(), usuarios: { total: 1, ativos: 1 } })).toBe("1 usuário (1 ativo)");
    expect(texto({ ...diagnosticoBase(), usuarios: null })).toBe("A lista não veio. Cada pessoa vai digitar o e-mail de login dela no Nectar.");
  });

  it("filas: quantidade, nenhuma e não deu para ler", () => {
    const texto = (d: DiagnosticoWeb) => linhasDoDiagnostico(d).find((l) => l.id === "filas")?.texto;
    expect(texto(diagnosticoBase())).toBe("2 filas");
    expect(texto({ ...diagnosticoBase(), filas: 1 })).toBe("1 fila");
    expect(texto({ ...diagnosticoBase(), filas: 0 })).toBe("Nenhuma fila");
    expect(texto({ ...diagnosticoBase(), filas: null })).toBe("Não deu para ler as filas.");
  });

  it("etiqueta de opt-out: pronta, ou o aviso para criar", () => {
    const linha = (d: DiagnosticoWeb) => linhasDoDiagnostico(d).find((l) => l.id === "optout");
    expect(linha(diagnosticoBase())).toMatchObject({ tom: "ok", texto: "A etiqueta “Opt-out (CRM Agro)” está pronta para contatos." });
    expect(linha({ ...diagnosticoBase(), tags: [] })).toMatchObject({ tom: "attention", texto: "Crie no Nectar a etiqueta “Opt-out (CRM Agro)” para contatos." });
  });

  it("etiquetaOptOutPronta: maiúscula não importa; inativa, sem permissão ou só de oportunidade não valem", () => {
    const base = { nome: "OPT-OUT (CRM AGRO)", ativa: true, relacionada: "ambos" as const, podeIncluir: true };
    expect(etiquetaOptOutPronta([base])).toBe(true);
    expect(etiquetaOptOutPronta([{ ...base, relacionada: null }])).toBe(true);
    expect(etiquetaOptOutPronta([{ ...base, ativa: false }])).toBe(false);
    expect(etiquetaOptOutPronta([{ ...base, podeIncluir: false }])).toBe(false);
    expect(etiquetaOptOutPronta([{ ...base, relacionada: "oportunidade" }])).toBe(false);
  });

  it("campos obrigatórios: os nomes, ou Nenhum", () => {
    const texto = (d: DiagnosticoWeb) => linhasDoDiagnostico(d).find((l) => l.id === "campos")?.texto;
    expect(texto(diagnosticoBase())).toBe("Nenhum");
    expect(texto({ ...diagnosticoBase(), camposObrigatorios: [{ nome: "Área (ha)" }, { nome: "Código" }] })).toBe("Área (ha), Código");
  });

  it("formatos de telefone: do mais comum ao menos comum, 'x de total'", () => {
    expect(itensDeFormatos({ parenteses_hifen: 30, ddd: 15, e164: 5 })).toEqual([
      "(62) 99999-8888: 30 de 50",
      "62999998888: 15 de 50",
      "+5562999998888: 5 de 50",
    ]);
    expect(itensDeFormatos({})).toEqual([]);
    const linha = linhasDoDiagnostico({ ...diagnosticoBase(), formatosTelefone: {} }).find((l) => l.id === "telefones");
    expect(linha?.texto).toBe("Sem telefones na amostra.");
    expect(linha?.itens).toBeUndefined();
  });
});

describe("funis", () => {
  it("etapas em ordem de sequência, numeradas", () => {
    expect(textoDasEtapas([{ id: "2", nome: "B", sequencia: 2 }, { id: "1", nome: "A", sequencia: 1 }])).toBe("1. A · 2. B");
    expect(textoDasEtapas([])).toBe("");
  });

  it("funil indisponível leva o motivo; funil sem etapa diz 'sem etapas'", () => {
    expect(linhaDoFunil({ id: "1", nome: "X", etapas: [], indisponivel: "o funil exige produto" })).toEqual({
      nome: "X",
      etapas: "sem etapas",
      indisponivel: "o funil exige produto",
    });
    expect(linhaDoFunil(diagnosticoBase().funisVendas[0]!)).toEqual({ nome: "Funil de venda", etapas: "1. A · 2. B", indisponivel: null });
  });
});

describe("estadoNoHub", () => {
  it("time fora do beta (null): Em breve, sem botão", () => {
    expect(estadoNoHub(null)).toEqual({ label: "Em breve", tone: "empty", botao: null });
  });

  it("conectado, com erro e não conectado; o botão depende de ter token", () => {
    expect(estadoNoHub(statusBase())).toEqual({ label: "Conectado", tone: "ok", botao: "Gerenciar" });
    expect(estadoNoHub(statusBase({ status: "error" }))).toEqual({ label: "Com erro", tone: "error", botao: "Gerenciar" });
    expect(estadoNoHub(statusBase({ status: "disconnected" }))).toEqual({ label: "Não conectado", tone: "empty", botao: "Gerenciar" });
    expect(estadoNoHub(statusBase({ status: "disconnected", configurado: false, finalDoToken: null }))).toEqual({
      label: "Não conectado",
      tone: "empty",
      botao: "Conectar",
    });
  });

  it("subtítulo da página", () => {
    expect(subtituloDaPagina(statusBase())).toBe("Conectado");
    expect(subtituloDaPagina(statusBase({ status: "error" }))).toBe("Com erro");
    expect(subtituloDaPagina(statusBase({ status: "disconnected" }))).toBe("Não conectado");
  });
});

describe("IP de saída", () => {
  it("com IP mostra o texto da ficha; sem IP pede ao suporte", () => {
    expect(textoDoIpSaida("203.0.113.10")).toBe(
      "IP do servidor do CRM Agro: 203.0.113.10. Se o usuário do token tiver restrição por IP ou por horário no Nectar, libere esse IP ou tire a restrição.",
    );
    expect(textoDoIpSaida(null)).toBe("Peça ao suporte do CRM Agro o IP do servidor.");
  });
});
