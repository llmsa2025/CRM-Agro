/**
 * Modelos dos e-mails da PLATAFORMA (redefinir senha, convite de equipe,
 * confirmação de cadastro, aviso de cadastro com e-mail que já tem conta,
 * alerta de saúde): HTML + texto puro, com a marca do CRM Agro (identidade v2).
 *
 * Regras de e-mail (Gmail, Outlook, Apple Mail):
 * - tudo em tabela e estilo INLINE (o Gmail descarta boa parte do `<style>`);
 * - SEM imagem externa: o símbolo do sol (components/brand/logo.tsx) é
 *   desenhado com células de tabela coloridas. No Outlook de mesa, que ignora
 *   `border-radius`, o semicírculo vira um retângulo dourado (degrada bem);
 * - todo texto que vem de pessoa (nome, nome do time, e-mail digitado) passa
 *   por `nomeSeguro` (sem quebra de linha nem controle, com tamanho máximo) e
 *   por `escaparHtml`;
 * - o texto puro tem o mesmo conteúdo (leitor de tela, cliente sem HTML e
 *   filtro de spam, que desconfia de e-mail só com HTML).
 */

import { EMAIL_MAX } from "./endereco";

/** Verde-mata e dourado da marca; tinta e linhas do design system. */
const COR = {
  mata: "#1F4A3A",
  sol: "#D4A13A",
  papel: "#F2F5F3",
  branco: "#FFFFFF",
  tinta: "#1A1F1C",
  tinta2: "#505752",
  tinta3: "#69706B",
  linha: "#E5E8E6",
} as const;

const FONTE = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIFA = "Georgia,'Times New Roman',Times,serif";

export type EmailMontado = { subject: string; text: string; html: string };

/**
 * Linha do rodapé sobre responder:
 * - `nao-responda`: remetente da plataforma sem reply-to (`noreply` não recebe);
 * - `responda`: com PLATFORM_EMAIL_REPLY_TO, a resposta chega à equipe do CRM Agro;
 * - `omitir`: envio legado pela caixa de uma pessoa do time (ela recebe a
 *   resposta; nenhuma das duas frases seria verdade).
 */
export type RodapeDeResposta = "nao-responda" | "responda" | "omitir";

/** Escapa texto para dentro do HTML (conteúdo e atributo). */
export function escaparHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Nome digitado por alguém (pessoa, time) para caber num e-mail: sem quebra de
 * linha nem caractere de controle, e curto — um nome de time não vira um
 * parágrafo de phishing dentro do e-mail da plataforma.
 */
export function nomeSeguro(s: string | null | undefined, max = 60): string {
  // eslint-disable-next-line no-control-regex
  const limpo = (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return limpo.length > max ? `${limpo.slice(0, max - 1).trimEnd()}…` : limpo;
}

/** Só http(s): um link montado com base errada não vira `javascript:`. */
function linkSeguro(link: string): string {
  if (!/^https?:\/\//i.test(link)) throw new Error("link do e-mail precisa começar com http:// ou https://");
  return link;
}

// ─── Blocos do layout ─────────────────────────────────────────────────────────

/** Célula de cor sólida (a "tinta" do símbolo). Altura exata também no Outlook. */
function celula(largura: number, altura: number, cor: string, raio: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>` +
    `<td width="${largura}" height="${altura}" bgcolor="${cor}" style="width:${largura}px;height:${altura}px;background-color:${cor};border-radius:${raio};font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td>` +
    `</tr></table>`
  );
}

function espaco(altura: number): string {
  return `<tr><td height="${altura}" style="height:${altura}px;font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td></tr>`;
}

/**
 * Símbolo do CRM Agro — sol nascendo sobre a lavoura (LogoMark ×1,5): semicírculo
 * dourado sobre duas linhas brancas — e o nome em serifa.
 */
function marca(): string {
  const simbolo =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="30" style="width:30px;">` +
    `<tr><td align="center">${celula(20, 10, COR.sol, "10px 10px 0 0")}</td></tr>` +
    espaco(3) +
    `<tr><td align="center">${celula(30, 3, COR.branco, "2px")}</td></tr>` +
    espaco(3) +
    `<tr><td align="center">${celula(18, 3, COR.branco, "2px")}</td></tr>` +
    `</table>`;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td valign="middle" style="padding-right:12px;">${simbolo}</td>` +
    `<td valign="middle" style="font-family:${SERIFA};font-size:24px;line-height:24px;color:${COR.branco};letter-spacing:-0.3px;">crmagro</td>` +
    `</tr></table>`
  );
}

/** Botão "à prova de Outlook": fundo na célula, o link ocupa o botão inteiro. */
function botao(rotulo: string, link: string): string {
  const href = escaparHtml(linkSeguro(link));
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr>` +
    `<td align="center" bgcolor="${COR.mata}" style="background-color:${COR.mata};border-radius:6px;">` +
    `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 26px;font-family:${FONTE};font-size:15px;line-height:20px;font-weight:bold;color:${COR.branco};text-decoration:none;border-radius:6px;border:1px solid ${COR.mata};">${escaparHtml(rotulo)}</a>` +
    `</td></tr></table>`
  );
}

function paragrafo(html: string, estilo = ""): string {
  return `<p style="margin:0 0 16px;font-family:${FONTE};font-size:15px;line-height:24px;color:${COR.tinta};${estilo}">${html}</p>`;
}

/** Link por extenso para quem não consegue clicar no botão. */
function linkPorExtenso(link: string): string {
  const seguro = escaparHtml(linkSeguro(link));
  return paragrafo(
    `Se o botão não abrir, copie e cole este endereço no navegador:<br>` +
      `<a href="${seguro}" target="_blank" rel="noopener" style="color:${COR.mata};text-decoration:underline;word-break:break-all;">${seguro}</a>`,
    `font-size:13px;line-height:20px;color:${COR.tinta2};`,
  );
}

type Layout = {
  assunto: string;
  /** Resumo que aparece ao lado do assunto na caixa de entrada. */
  previa: string;
  titulo: string;
  /** Miolo já em HTML (montado com `paragrafo`, `botao`, …, e texto escapado). */
  corpo: string;
  /** "Você recebeu este e-mail porque…" (texto puro; é escapado aqui). */
  motivo: string;
  resposta?: RodapeDeResposta;
};

function linhaDeResposta(resposta: RodapeDeResposta = "nao-responda"): string | null {
  if (resposta === "omitir") return null;
  return resposta === "responda"
    ? "Dúvidas? Responda este e-mail que a mensagem chega à equipe do CRM Agro."
    : "Não responda: este endereço não recebe mensagens.";
}

function layout(l: Layout): string {
  const linha = linhaDeResposta(l.resposta);
  const rodape = [l.motivo, ...(linha ? [linha] : [])].map(escaparHtml).join("<br><br>");
  return `<!DOCTYPE html>
<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escaparHtml(l.assunto)}</title>
</head>
<body style="margin:0;padding:0;background-color:${COR.papel};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${COR.papel};">${escaparHtml(l.previa)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COR.papel}" style="background-color:${COR.papel};">
<tr><td align="center" style="padding:32px 16px;">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td bgcolor="${COR.mata}" style="background-color:${COR.mata};border-radius:8px 8px 0 0;border-bottom:3px solid ${COR.sol};padding:22px 32px;">${marca()}</td></tr>
<tr><td bgcolor="${COR.branco}" style="background-color:${COR.branco};border:1px solid ${COR.linha};border-top:0;border-radius:0 0 8px 8px;padding:32px 32px 16px;">
<h1 style="margin:0 0 20px;font-family:${SERIFA};font-size:24px;line-height:32px;font-weight:normal;color:${COR.tinta};">${escaparHtml(l.titulo)}</h1>
${l.corpo}
</td></tr>
<tr><td style="padding:24px 32px 8px;font-family:${FONTE};font-size:12px;line-height:18px;color:${COR.tinta3};text-align:center;">${rodape}</td></tr>
<tr><td style="padding:8px 32px 0;font-family:${SERIFA};font-size:13px;line-height:18px;color:${COR.mata};text-align:center;">crmagro</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

/** Texto puro com o mesmo conteúdo e o rodapé. */
function textoPuro(linhas: string[], motivo: string, resposta?: RodapeDeResposta): string {
  const linha = linhaDeResposta(resposta);
  return [...linhas, "", motivo, ...(linha ? [linha] : [])].join("\n");
}

// ─── Modelos ──────────────────────────────────────────────────────────────────

/** Opção comum: a linha do rodapé sobre responder (padrão: "não responda"). */
type Comum = { resposta?: RodapeDeResposta };

/** "Esqueci a senha": link com o token (válido por `validadeMin`). */
export function modeloRedefinirSenha(p: Comum & { nome?: string | null; email: string; link: string; validadeMin: number }): EmailMontado {
  const nome = nomeSeguro(p.nome);
  const subject = "Redefinição de senha no CRM Agro";
  const motivo = `Você recebeu este e-mail porque alguém pediu para redefinir a senha da conta ${nomeSeguro(p.email, EMAIL_MAX)} no CRM Agro.`;
  const saudacao = nome ? `Olá, ${nome}.` : "Olá.";
  const html = layout({
    assunto: subject,
    previa: `Crie uma nova senha para o CRM Agro. O link vale por ${p.validadeMin} minutos.`,
    titulo: "Redefina a sua senha",
    corpo:
      paragrafo(escaparHtml(saudacao)) +
      paragrafo(`Recebemos um pedido para redefinir a senha da sua conta no CRM Agro. O link abaixo vale por <strong>${p.validadeMin} minutos</strong> e só pode ser usado uma vez.`) +
      botao("Criar nova senha", p.link) +
      linkPorExtenso(p.link) +
      paragrafo(`Se não foi você que pediu, ignore este e-mail: a sua senha continua a mesma.`, `color:${COR.tinta2};`),
    motivo,
    resposta: p.resposta,
  });
  const text = textoPuro(
    [
      saudacao,
      "",
      "Recebemos um pedido para redefinir a senha da sua conta no CRM Agro.",
      `Abra o link abaixo para criar uma nova senha (vale por ${p.validadeMin} minutos e só pode ser usado uma vez):`,
      "",
      p.link,
      "",
      "Se não foi você que pediu, ignore este e-mail: a sua senha continua a mesma.",
    ],
    motivo,
    p.resposta,
  );
  return { subject, text, html };
}

/** Convite para entrar na equipe: link para criar a conta (válido por `validadeDias`). */
export function modeloConvite(
  p: Comum & { email: string; link: string; validadeDias: number; nomeDoTime?: string | null; quemConvidou?: string | null },
): EmailMontado {
  const time = nomeSeguro(p.nomeDoTime);
  const quem = nomeSeguro(p.quemConvidou);
  const subject = time ? `Convite para a equipe ${time} no CRM Agro` : "Você foi convidado para o CRM Agro";
  const frase = `${quem || "Uma pessoa da equipe"} convidou você para ${time ? `a equipe ${time} no CRM Agro` : "o CRM Agro"}.`;
  const fraseHtml =
    `${quem ? `<strong>${escaparHtml(quem)}</strong>` : "Uma pessoa da equipe"} convidou você para ` +
    `${time ? `a equipe <strong>${escaparHtml(time)}</strong> no CRM Agro` : "o CRM Agro"}.`;
  const motivo =
    `Você recebeu este e-mail porque ${quem || "alguém"} convidou ${nomeSeguro(p.email, EMAIL_MAX)} para ${time ? `a equipe ${time}` : "uma equipe"} no CRM Agro. ` +
    `Se não esperava este convite, pode ignorá-lo.`;
  const html = layout({
    assunto: subject,
    previa: `Crie a sua conta e defina a sua senha. O convite vale por ${p.validadeDias} dias.`,
    titulo: "Você foi convidado",
    corpo:
      paragrafo(fraseHtml) +
      paragrafo(`Crie a sua conta e defina a sua senha pelo botão abaixo. O convite vale por <strong>${p.validadeDias} dias</strong>.`) +
      botao("Aceitar o convite", p.link) +
      linkPorExtenso(p.link),
    motivo,
    resposta: p.resposta,
  });
  const text = textoPuro(
    [
      "Olá.",
      "",
      frase,
      `Crie a sua conta e defina a sua senha pelo link abaixo (o convite vale por ${p.validadeDias} dias):`,
      "",
      p.link,
    ],
    motivo,
    p.resposta,
  );
  return { subject, text, html };
}

/**
 * Confirmação do e-mail de quem criou a conta da empresa com e-mail e senha
 * (auth/cadastro-com-senha.ts). O link abre a tela que pede a senha do
 * cadastro: sem abrir o link, a conta não nasce.
 *
 * Texto FIXO: nada do que foi digitado no formulário (nome da pessoa, nome da
 * empresa) entra no e-mail. O formulário é anônimo e o destino ainda não foi
 * comprovado — com o nome da empresa no corpo, qualquer um mandaria, com o
 * SPF/DKIM do CRM Agro, um texto seu ("Pix bloqueado: libere em golpe.com") para
 * qualquer caixa. A tela /confirmar-email mostra a empresa depois do clique.
 */
export function modeloConfirmarCadastro(p: Comum & { email: string; link: string; validadeHoras: number }): EmailMontado {
  const horas = p.validadeHoras === 1 ? "1 hora" : `${p.validadeHoras} horas`;
  const subject = "Confirme o seu e-mail no CRM Agro";
  const frase = "Confirme o seu e-mail para criar a conta da sua empresa no CRM Agro.";
  const motivo = `Você recebeu este e-mail porque alguém usou ${nomeSeguro(p.email, EMAIL_MAX)} para criar a conta de uma empresa no CRM Agro.`;
  const html = layout({
    assunto: subject,
    previa: `Confirme o seu e-mail para ativar a conta. O link vale por ${horas}.`,
    titulo: "Confirme o seu e-mail",
    corpo:
      paragrafo("Olá.") +
      paragrafo(frase) +
      paragrafo(
        `Abra o link abaixo e digite a senha que você escolheu no cadastro. Ele vale por <strong>${horas}</strong> e só pode ser usado uma vez.`,
      ) +
      botao("Confirmar e-mail", p.link) +
      linkPorExtenso(p.link) +
      paragrafo(`Se não foi você que pediu, ignore este e-mail: sem a confirmação, nenhuma conta é criada.`, `color:${COR.tinta2};`),
    motivo,
    resposta: p.resposta,
  });
  const text = textoPuro(
    [
      "Olá.",
      "",
      frase,
      `Abra o link abaixo e digite a senha que você escolheu no cadastro (vale por ${horas} e só pode ser usado uma vez):`,
      "",
      p.link,
      "",
      "Se não foi você que pediu, ignore este e-mail: sem a confirmação, nenhuma conta é criada.",
    ],
    motivo,
    p.resposta,
  );
  return { subject, text, html };
}

/**
 * "Alguém tentou criar conta com o seu e-mail": vai para o DONO de uma conta
 * que já existe quando o cadastro com senha recebe o e-mail dele. A tela do
 * cadastro responde igual (não revela que o e-mail tem conta); quem de fato é
 * o dono fica sabendo por aqui. Não leva nada do que foi digitado no
 * formulário (nome da empresa, nome) — só o nome que já está na conta.
 */
export function modeloAvisoCadastroExistente(
  p: Comum & { nome?: string | null; email: string; linkEntrar: string; linkEsqueci: string },
): EmailMontado {
  const nome = nomeSeguro(p.nome);
  const email = nomeSeguro(p.email, EMAIL_MAX);
  const subject = "Tentativa de criar conta no CRM Agro com o seu e-mail";
  const saudacao = nome ? `Olá, ${nome}.` : "Olá.";
  const motivo = `Você recebeu este e-mail porque alguém tentou criar uma conta no CRM Agro com ${email}, que já tem conta.`;
  const esqueciHtml =
    `Esqueceu a senha? <a href="${escaparHtml(linkSeguro(p.linkEsqueci))}" target="_blank" rel="noopener" style="color:${COR.mata};text-decoration:underline;">Crie uma nova</a>.`;
  const html = layout({
    assunto: subject,
    previa: "Você já tem uma conta no CRM Agro: nada foi criado e nada mudou nela.",
    titulo: "Você já tem uma conta",
    corpo:
      paragrafo(escaparHtml(saudacao)) +
      paragrafo(
        `Alguém tentou criar uma conta no CRM Agro com o seu e-mail (<strong>${escaparHtml(email)}</strong>). ` +
          `Como você já tem uma conta, <strong>nada foi criado e nada mudou nela</strong>.`,
      ) +
      paragrafo(`Se foi você, entre com a conta que já existe:`) +
      botao("Entrar no CRM Agro", p.linkEntrar) +
      paragrafo(esqueciHtml) +
      paragrafo(`Se não foi você, pode ignorar este e-mail.`, `color:${COR.tinta2};`),
    motivo,
    resposta: p.resposta,
  });
  const text = textoPuro(
    [
      saudacao,
      "",
      `Alguém tentou criar uma conta no CRM Agro com o seu e-mail (${email}).`,
      "Como você já tem uma conta, nada foi criado e nada mudou nela.",
      "",
      "Se foi você, entre com a conta que já existe:",
      p.linkEntrar,
      "",
      "Esqueceu a senha? Crie uma nova:",
      p.linkEsqueci,
      "",
      "Se não foi você, pode ignorar este e-mail.",
    ],
    motivo,
    p.resposta,
  );
  return { subject, text, html };
}

/** Alerta de saúde da plataforma para a operação (lista da tela de Configurações ou ALERT_EMAILS). */
export function modeloAlertaSaude(
  p: Comum & { status: string; quando: string; motivos: string[]; linkDaSaude?: string | null },
): EmailMontado {
  const primeiro = p.motivos[0] ?? "fora do normal";
  const subject = `[CRM Agro] ${p.status}: ${primeiro}`;
  const motivo = "Você recebeu este e-mail porque o seu endereço está na lista de alertas da operação do CRM Agro.";
  const itens = p.motivos
    .map(
      (m) =>
        `<tr><td valign="top" style="padding:0 8px 8px 0;font-family:${FONTE};font-size:15px;line-height:22px;color:${COR.sol};">&#9679;</td>` +
        `<td style="padding:0 0 8px;font-family:${FONTE};font-size:15px;line-height:22px;color:${COR.tinta};">${escaparHtml(m)}</td></tr>`,
    )
    .join("");
  const html = layout({
    assunto: subject,
    previa: `${p.status}: ${primeiro}`,
    titulo: `Plataforma ${p.status === "unhealthy" ? "fora do ar" : "fora do normal"}`,
    corpo:
      paragrafo(`Status <strong>${escaparHtml(p.status)}</strong> em ${escaparHtml(p.quando)}.`) +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${itens}</table>` +
      (p.linkDaSaude ? botao("Ver a saúde da plataforma", p.linkDaSaude) : "") +
      paragrafo(`Detalhe: <code>GET /api/health</code> e os logs do pm2 (crmagro-worker / crmagro-web).`, `font-size:13px;color:${COR.tinta2};`),
    motivo,
    resposta: p.resposta,
  });
  const text = textoPuro(
    [
      `Status: ${p.status} (${p.quando})`,
      "",
      ...p.motivos.map((m) => `- ${m}`),
      "",
      ...(p.linkDaSaude ? [`Saúde: ${p.linkDaSaude}`] : []),
      "Detalhe: GET /api/health e os logs do pm2 (crmagro-worker / crmagro-web).",
    ],
    motivo,
    p.resposta,
  );
  return { subject, text, html };
}

/** Alerta de TESTE. */
export function modeloAlertaDeTeste(p: Comum & { quando: string; linkDaTela?: string | null }): EmailMontado {
  const subject = "[CRM Agro] Alerta de teste";
  const motivo = "Você recebeu este e-mail porque o seu endereço está na lista de alertas da operação do CRM Agro e alguém pediu um alerta de teste.";
  const html = layout({
    assunto: subject,
    previa: "Se este e-mail chegou, os alertas do sistema chegam até você.",
    titulo: "Alerta de teste",
    corpo:
      paragrafo("Este é um <strong>teste</strong>: não há nada errado com a plataforma. Se ele chegou à caixa de entrada, os alertas do sistema chegam até você.") +
      paragrafo(`Enviado em ${escaparHtml(p.quando)}.`, `color:${COR.tinta2};`) +
      (p.linkDaTela ? botao("Abrir os alertas do sistema", p.linkDaTela) : ""),
    motivo,
    resposta: p.resposta,
  });
  const text = textoPuro(
    [
      "Este é um TESTE: não há nada errado com a plataforma.",
      "Se ele chegou, os alertas do sistema chegam até você.",
      `Enviado em ${p.quando}.`,
      ...(p.linkDaTela ? ["", p.linkDaTela] : []),
    ],
    motivo,
    p.resposta,
  );
  return { subject, text, html };
}

/** E-mail de teste do remetente (script de operação). */
export function modeloTesteDeEnvio(p: Comum & { linkDoApp?: string | null; quando: string }): EmailMontado {
  const subject = "Teste do remetente da plataforma do CRM Agro";
  const motivo = "Você recebeu este e-mail porque alguém da operação rodou o teste de envio do CRM Agro para este endereço.";
  const html = layout({
    assunto: subject,
    previa: "Se este e-mail chegou, o SMTP e o DNS do remetente estão certos.",
    titulo: "O remetente está funcionando",
    corpo:
      paragrafo(`Se este e-mail chegou à caixa de entrada (e não ao spam), o SMTP e os registros de DNS do remetente da plataforma estão certos.`) +
      paragrafo(`Enviado em ${escaparHtml(p.quando)}.`, `color:${COR.tinta2};`) +
      (p.linkDoApp ? botao("Abrir o CRM Agro", p.linkDoApp) : ""),
    motivo,
    resposta: p.resposta,
  });
  const text = textoPuro(
    [
      "O remetente da plataforma está funcionando.",
      "",
      "Se este e-mail chegou à caixa de entrada (e não ao spam), o SMTP e os registros de DNS estão certos.",
      `Enviado em ${p.quando}.`,
      ...(p.linkDoApp ? ["", p.linkDoApp] : []),
    ],
    motivo,
    p.resposta,
  );
  return { subject, text, html };
}
