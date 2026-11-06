import { describe, expect, it } from "vitest";
import {
  avisoDoRecebimento,
  caixaParaAbrirRecebimento,
  deveContinuarPerguntando,
  diasSemEmail,
  linkDeConfirmacaoExibivel,
  mensagemDoErroDeEncaminhamento,
  PASSOS_DO_ASSISTENTE_TOTAL,
  TITULOS_DOS_PASSOS,
  linhaDoRecebimento,
  passoAposAtualizacao,
  passoInicialDoAssistente,
  recebimentoEmAndamento,
  urlDoEncaminhamentoDoGmail,
} from "./encaminhamento";

const MIN = 60_000;
const DIA = 86_400_000;

describe("linkDeConfirmacaoExibivel (só link do Google vira botão)", () => {
  it("aceita o link do mail-settings.google.com e o do mail.google.com com /u/N", () => {
    const a = "https://mail-settings.google.com/mail/vf-%5BABC%5D-xyz";
    const b = "https://mail.google.com/mail/u/0/vf-%5BABC%5D-xyz?a=1&b=2";
    expect(linkDeConfirmacaoExibivel(a)).toBe(a);
    expect(linkDeConfirmacaoExibivel(b)).toBe(b);
  });

  it("recusa host falso, http, uf-, javascript: e texto que não é URL", () => {
    for (const ruim of [
      "https://mail-settings.google.com.evil.io/mail/vf-x",
      "https://evilgoogle.com/mail/vf-x",
      "https://sub.mail.google.com/mail/vf-x",
      "https://mail-settings.google.com@evil.io/mail/vf-x",
      "http://mail.google.com/mail/vf-x",
      "https://mail.google.com/mail/uf-%5BABC%5D-xyz",
      "https://mail.google.com/outro/vf-x",
      "javascript:alert(1)",
      "isto não é uma url",
      "",
    ]) {
      expect(linkDeConfirmacaoExibivel(ruim), ruim).toBeNull();
    }
    expect(linkDeConfirmacaoExibivel(null)).toBeNull();
  });
});

describe("deveContinuarPerguntando (polling só com o diálogo aberto e por pouco tempo)", () => {
  const abriu = 1_000_000;

  it("continua com 9 minutos e para com 10, enquanto falta a confirmação", () => {
    for (const estado of ["aguardando_confirmacao", "confirmar"]) {
      expect(deveContinuarPerguntando(estado, abriu, abriu + 9 * MIN), estado).toBe(true);
      expect(deveContinuarPerguntando(estado, abriu, abriu + 10 * MIN), estado).toBe(false);
    }
  });

  it("não pergunta de novo quando já está funcionando ou parado", () => {
    expect(deveContinuarPerguntando("funcionando", abriu, abriu + MIN)).toBe(false);
    expect(deveContinuarPerguntando("sem_email_recente", abriu, abriu + MIN)).toBe(false);
    expect(deveContinuarPerguntando("estado-desconhecido", abriu, abriu + MIN)).toBe(false);
  });
});

describe("diasSemEmail", () => {
  const agora = Date.parse("2026-10-10T12:00:00Z");

  it("nunca recebeu (ou data inválida) → null", () => {
    expect(diasSemEmail(null, agora)).toBeNull();
    expect(diasSemEmail("não é data", agora)).toBeNull();
  });

  it("conta dias inteiros: 3 dias e meio → 3", () => {
    expect(diasSemEmail(new Date(agora - 3.5 * DIA).toISOString(), agora)).toBe(3);
    expect(diasSemEmail(new Date(agora - 5 * MIN).toISOString(), agora)).toBe(0);
  });

  it("data no futuro (relógio adiantado) não dá número negativo", () => {
    expect(diasSemEmail(new Date(agora + DIA).toISOString(), agora)).toBe(0);
  });
});

describe("mensagemDoErroDeEncaminhamento (nunca a mensagem crua do core)", () => {
  it("OwnedNotFound e ForbiddenError: só o dono ou um administrador", () => {
    const texto = "Só o dono da caixa ou um administrador pode ligar o recebimento sem senha.";
    expect(mensagemDoErroDeEncaminhamento("OwnedNotFound")).toBe(texto);
    expect(mensagemDoErroDeEncaminhamento("ForbiddenError")).toBe(texto);
  });

  it("entrada desligada e erro qualquer", () => {
    expect(mensagemDoErroDeEncaminhamento("EntradaDeEmailDesligada")).toBe("O recebimento sem senha não está ligado neste servidor.");
    expect(mensagemDoErroDeEncaminhamento("Error")).toBe("Não deu para concluir agora. Tente de novo em instantes.");
    expect(mensagemDoErroDeEncaminhamento("")).toBe("Não deu para concluir agora. Tente de novo em instantes.");
  });
});

describe("avisoDoRecebimento (a linha da caixa do Gmail sem senha)", () => {
  it("funcionando e estado desconhecido não dizem nada", () => {
    expect(avisoDoRecebimento("funcionando")).toBeNull();
    expect(avisoDoRecebimento(undefined)).toBeNull();
  });

  it("★ cada estado que ainda não recebe diz o que falta, e o primeiro avisa que o envio já vale", () => {
    expect(avisoDoRecebimento("sem_endereco")).toBe("Envia pelo Gmail. Falta ligar o recebimento das respostas.");
    expect(avisoDoRecebimento("aguardando_confirmacao")).toBe("Falta adicionar o endereço de encaminhamento no Gmail.");
    expect(avisoDoRecebimento("confirmar")).toBe("Falta terminar o encaminhamento no Gmail.");
    expect(avisoDoRecebimento("sem_email_recente")).toContain("Nenhum e-mail chegou há mais de 3 dias");
    for (const e of ["sem_endereco", "aguardando_confirmacao", "confirmar", "sem_email_recente"] as const) {
      const texto = avisoDoRecebimento(e)!;
      expect(texto, e).not.toMatch(/[—–]/); // sem travessão (regra de texto da interface)
    }
  });
});

describe("caixaParaAbrirRecebimento (o passo a passo abre sozinho depois de conectar o Gmail)", () => {
  const eu = "u-eu";
  const contas = [
    { id: "c-imap", canal: "email", provider: "smtp", ownerId: eu },
    { id: "c-gmail", canal: "email", provider: "gmail_api", ownerId: eu },
    { id: "c-zap", canal: "whatsapp", provider: "evolution", ownerId: eu },
  ];

  it("só abre na volta do Google com 'gmail-conectado'", () => {
    expect(caixaParaAbrirRecebimento("gmail-conectado", contas, eu)).toBe("c-gmail");
    for (const outro of [null, "", "agenda-antes", "caixa-com-senha", "cancelado", "gmail-desligado"]) {
      expect(caixaParaAbrirRecebimento(outro, contas, eu), String(outro)).toBeNull();
    }
  });

  it("★ abre a caixa DA PESSOA, nunca a de outra", () => {
    const duas = [
      { id: "c-dela", canal: "email", provider: "gmail_api", ownerId: "u-outra" },
      { id: "c-minha", canal: "email", provider: "gmail_api", ownerId: eu },
    ];
    expect(caixaParaAbrirRecebimento("gmail-conectado", duas, eu)).toBe("c-minha");
    // Sem saber quem é a pessoa e com mais de uma caixa, não adivinha.
    expect(caixaParaAbrirRecebimento("gmail-conectado", duas, null)).toBeNull();
    // A única caixa do Gmail é de outra pessoa (um administrador vê as dos outros): não abre.
    expect(caixaParaAbrirRecebimento("gmail-conectado", [duas[0]!], eu)).toBeNull();
    // Sem saber quem é, uma caixa só vale.
    expect(caixaParaAbrirRecebimento("gmail-conectado", [duas[0]!], null)).toBe("c-dela");
  });

  it("sem caixa do Gmail (só IMAP ou WhatsApp), não abre nada", () => {
    expect(caixaParaAbrirRecebimento("gmail-conectado", [contas[0]!, contas[2]!], eu)).toBeNull();
    expect(caixaParaAbrirRecebimento("gmail-conectado", [], eu)).toBeNull();
  });
});

describe("urlDoEncaminhamentoDoGmail", () => {
  it("com o e-mail da caixa abre na conta certa (authuser); sem ele, na primeira conta", () => {
    const com = new URL(urlDoEncaminhamentoDoGmail("maria.silva@gmail.com"));
    expect(com.hostname).toBe("mail.google.com");
    expect(com.searchParams.get("authuser")).toBe("maria.silva@gmail.com");
    expect(com.hash).toBe("#settings/fwdandpop");
    expect(urlDoEncaminhamentoDoGmail(null)).toBe("https://mail.google.com/mail/u/0/?tab=rm&ogbl#settings/fwdandpop");
  });

  it("★ um rótulo que não é e-mail (ou tenta enfiar outra coisa) cai na primeira conta, sem sair do Gmail", () => {
    for (const ruim of ["Caixa comercial", "a@b", "x@evil.io/../../mail", "a b@gmail.com", "x@y.com#hash", "x@y.com&authuser=outro", ""]) {
      const url = urlDoEncaminhamentoDoGmail(ruim);
      expect(url, ruim).toBe("https://mail.google.com/mail/u/0/?tab=rm&ogbl#settings/fwdandpop");
    }
    // Todo resultado é https no mail.google.com.
    expect(new URL(urlDoEncaminhamentoDoGmail("a+b@gmail.com")).origin).toBe("https://mail.google.com");
  });
});

describe("passos do assistente (o CRM Agro acompanha o que consegue saber)", () => {
  const com = (estado: "aguardando_confirmacao" | "confirmar" | "funcionando" | "sem_email_recente") => ({ endereco: "r+x@in.crmagro.example", estado });

  it("o total de passos e os títulos andam juntos, e o último é o de pronto", () => {
    expect(PASSOS_DO_ASSISTENTE_TOTAL).toBe(4);
    expect(TITULOS_DOS_PASSOS).toHaveLength(PASSOS_DO_ASSISTENTE_TOTAL);
    expect(TITULOS_DOS_PASSOS[0]).toBe("Adicionar no Gmail");
    expect(TITULOS_DOS_PASSOS.at(-1)).toBe("Pronto");
    for (const t of TITULOS_DOS_PASSOS) expect(t).not.toMatch(/[—–]/);
  });

  it("abre no passo certo pelo que o servidor já sabe", () => {
    expect(passoInicialDoAssistente(null)).toBe(1);
    expect(passoInicialDoAssistente({ endereco: null, estado: "aguardando_confirmacao" })).toBe(1);
    expect(passoInicialDoAssistente(com("aguardando_confirmacao"))).toBe(1);
    expect(passoInicialDoAssistente(com("confirmar"))).toBe(2);
    expect(passoInicialDoAssistente(com("funcionando"))).toBe(4);
    expect(passoInicialDoAssistente(com("sem_email_recente"))).toBe(4);
  });

  it("★ avança sozinho quando o pedido do Google chega e quando o primeiro e-mail chega", () => {
    expect(passoAposAtualizacao(1, com("confirmar"))).toBe(2);
    for (const p of [1, 2, 3, 4] as const) expect(passoAposAtualizacao(p, com("funcionando")), String(p)).toBe(4);
  });

  it("★ nunca volta nem pula sem sinal: quem já está adiante fica, e o endereço gerado não empurra", () => {
    expect(passoAposAtualizacao(3, com("confirmar"))).toBe(3);
    expect(passoAposAtualizacao(4, com("confirmar"))).toBe(4);
    expect(passoAposAtualizacao(2, com("confirmar"))).toBe(2);
    expect(passoAposAtualizacao(1, com("aguardando_confirmacao"))).toBe(1);
    expect(passoAposAtualizacao(2, com("aguardando_confirmacao"))).toBe(2);
    expect(passoAposAtualizacao(2, null)).toBe(2);
    expect(passoAposAtualizacao(1, { endereco: null, estado: "confirmar" })).toBe(1);
  });
});

describe("linhaDoRecebimento (a linha da caixa diz se funciona, sem abrir o assistente)", () => {
  it("★ funcionando é verde e sem botão, e diz que recebe e envia", () => {
    expect(linhaDoRecebimento("funcionando")).toEqual({ tone: "ok", texto: "Funcionando. Recebe e envia e-mails.", assistente: false });
  });

  it("o que ainda falta é aviso e oferece o passo a passo; sem estado, nada", () => {
    for (const e of ["sem_endereco", "aguardando_confirmacao", "confirmar", "sem_email_recente"] as const) {
      const l = linhaDoRecebimento(e);
      expect(l, e).toMatchObject({ tone: "attention", assistente: true });
      expect(l?.texto).toBe(avisoDoRecebimento(e));
    }
    expect(linhaDoRecebimento(undefined)).toBeNull();
  });

  it("sem travessão nem meia-risca no texto", () => {
    for (const e of ["funcionando", "sem_endereco", "aguardando_confirmacao", "confirmar", "sem_email_recente"] as const) {
      expect(linhaDoRecebimento(e)?.texto, e).not.toMatch(/[—–]| - /);
    }
  });
});

describe("recebimentoEmAndamento (a página só confere de novo enquanto falta o primeiro e-mail)", () => {
  it("só enquanto o Google não confirmou ou o primeiro e-mail não chegou", () => {
    expect(recebimentoEmAndamento(["aguardando_confirmacao"])).toBe(true);
    expect(recebimentoEmAndamento(["funcionando", "confirmar"])).toBe(true);
    expect(recebimentoEmAndamento(["funcionando", "sem_endereco", "sem_email_recente"])).toBe(false);
    expect(recebimentoEmAndamento([])).toBe(false);
  });
});
