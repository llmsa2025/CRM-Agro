/**
 * Regras puras da conexão do envio pelo Gmail em Integrações, Canais, aba E-mail (ficha
 * E7b). Sem "use client" e sem importar valor do `@crmagro/core`: o cliente, o servidor e o
 * teste usam isto direto.
 */

/** O que a volta do Google mostra em Canais (`?google=...`), uma vez. */
export type ResultadoDoGoogle = { ok: boolean; texto: string };

/**
 * O texto de cada código que pode voltar do Google para a aba E-mail. Os da Agenda
 * espelham `RESULTADO` de `components/agenda/google-agenda-conexao.tsx`.
 */
export const RESULTADO_GMAIL: Record<string, ResultadoDoGoogle> = {
  "gmail-conectado": { ok: true, texto: "Pronto. Os e-mails desta caixa agora saem pelo seu Gmail." },
  "agenda-antes": { ok: false, texto: "Conecte primeiro a sua Agenda Google (Integrações, Minha Agenda Google)." },
  "sem-gmail": { ok: false, texto: "O Google não liberou o envio. Conecte de novo e marque a permissão do Gmail." },
  // Mesmo texto de `CaixaJaConectadaComSenha` (core).
  "caixa-com-senha": {
    ok: false,
    texto: "Esta caixa já está conectada com senha de app. Para enviar pelo Gmail sem senha, desconecte a caixa com senha primeiro.",
  },
  "gmail-outra-conta": {
    ok: false,
    texto: "Escolha a mesma conta Google da sua Agenda. Para usar outra conta, desconecte a Agenda primeiro.",
  },
  "gmail-desligado": { ok: false, texto: "O envio pelo Gmail ainda não está ligado neste servidor." },
  cancelado: { ok: false, texto: "Conexão cancelada na tela do Google." },
  expirou: { ok: false, texto: "O pedido de conexão expirou ou veio de outro navegador. Tente de novo." },
  "sem-agenda": { ok: false, texto: "O Google não liberou a agenda. Conecte de novo e marque a permissão da agenda." },
  "outra-pessoa": { ok: false, texto: "Esta conta Google já está conectada por outra pessoa no CRM Agro." },
  "nao-liberada": {
    ok: false,
    texto: "A Agenda Google ainda não foi liberada para a sua conta. Ela abre para todos quando o Google terminar de verificar o CRM Agro.",
  },
  "sem-permissao": {
    ok: false,
    texto: "Sem permissão para conectar a agenda: é preciso papel de membro (não \"só leitura\") e a tela Agenda ou Integrações. Fale com o administrador.",
  },
  indisponivel: { ok: false, texto: "A integração com o Google Agenda não está configurada neste servidor." },
  configuracao: { ok: false, texto: "A integração com o Google está mal configurada (cliente OAuth). Avise o administrador." },
  falhou: { ok: false, texto: "Não foi possível conectar agora. Tente de novo em instantes." },
};

/** `null` sem código; código que não conhecemos vira o de "falhou" (nunca texto cru da URL). */
export function resultadoDoGoogleEmCanais(codigo: string | null): ResultadoDoGoogle | null {
  if (!codigo) return null;
  return Object.hasOwn(RESULTADO_GMAIL, codigo) ? RESULTADO_GMAIL[codigo]! : RESULTADO_GMAIL.falhou!;
}

/** O estado do envio pelo Gmail (`envioPeloGmailParaMim`), repetido aqui só como tipo para não importar valor do core. */
export type EstadoDoEnvioPeloGmail = "desligado" | "agenda-antes" | "pode-conectar" | "conectado";

/** Uma das duas formas de conectar e-mail, como o pop-up "Conectar e-mail" mostra. */
export type OpcaoDeConexaoDeEmail = {
  titulo: string;
  descricao: string;
  /** `false`: a opção aparece, mas não dá para escolher agora (o `aviso` diz por quê). */
  habilitada: boolean;
  aviso: string | null;
  /** Aviso que leva a outra tela (ex.: conectar a Agenda antes). */
  avisoLink?: { texto: string; href: string };
};

/**
 * As duas formas de conectar uma caixa de e-mail e o que impede cada uma agora. A regra é
 * uma por endereço: o mesmo e-mail não pode ter as duas conexões ao mesmo tempo (o servidor
 * também recusa, isto só evita levar a pessoa ao Google para voltar com erro).
 * - `enderecoGoogle`: a conta Google da Agenda da pessoa (o Gmail sem senha usa a mesma);
 * - `senhaNoEnderecoDoGoogle`: já existe caixa com senha de app nesse endereço.
 */
export function opcoesDeConexaoDeEmail(p: {
  envioGmail: EstadoDoEnvioPeloGmail;
  enderecoGoogle: string | null;
  senhaNoEnderecoDoGoogle: boolean;
}): { semSenha: OpcaoDeConexaoDeEmail; imap: OpcaoDeConexaoDeEmail } {
  const semSenha: OpcaoDeConexaoDeEmail = {
    titulo: "Sem senha (Gmail)",
    descricao: "Entre com a sua conta Google. O CRM Agro envia pelo seu Gmail e recebe por encaminhamento. Nenhuma senha fica guardada.",
    habilitada: false,
    aviso: null,
  };
  const imap: OpcaoDeConexaoDeEmail = {
    titulo: "IMAP e SMTP (senha de app)",
    descricao: "Serve para qualquer provedor. Você informa os servidores e a senha, e o CRM Agro envia e lê a caixa por eles.",
    habilitada: true,
    aviso: null,
  };

  switch (p.envioGmail) {
    case "desligado":
      semSenha.aviso = "Ainda não está disponível para a sua conta.";
      break;
    case "agenda-antes":
      semSenha.aviso = "Conecte primeiro a sua Agenda Google.";
      semSenha.avisoLink = { texto: "Ir para Integrações", href: "/integracoes" };
      break;
    case "conectado":
      semSenha.aviso = p.enderecoGoogle ? `Já conectado com ${p.enderecoGoogle}.` : "Já conectado.";
      if (p.enderecoGoogle) imap.aviso = `${p.enderecoGoogle} já está conectado sem senha, então não pode usar esta forma. Outros endereços podem.`;
      break;
    case "pode-conectar":
      if (p.senhaNoEnderecoDoGoogle) {
        semSenha.aviso = p.enderecoGoogle
          ? `${p.enderecoGoogle} já está conectado por IMAP e SMTP. Apague essa caixa para conectar sem senha.`
          : "Este endereço já está conectado por IMAP e SMTP. Apague essa caixa para conectar sem senha.";
      } else {
        semSenha.habilitada = true;
      }
      break;
  }
  return { semSenha, imap };
}

/** Para onde o botão "Sem senha (Gmail)" leva: a tela do Google (navegação inteira, a rota põe o cookie). */
export const HREF_CONECTAR_GMAIL = "/api/integracoes/google/conectar?volta=canais&recurso=gmail";

/** Como a linha da caixa chama o provedor: a conta do Gmail sem senha tem nome próprio. */
export function rotuloDoProvedor(provider: string): string {
  if (provider === "gmail_api") return "Gmail (sem senha)";
  if (provider === "linkedin_official") return "LinkedIn (entrar e publicar)";
  return provider;
}

/**
 * Mensagem de tela quando desligar o envio pelo Gmail falha. NUNCA a mensagem crua do
 * core (traz o id da caixa): só o NOME do erro decide o texto.
 */
export function mensagemDoErroDeDesligarGmail(nome: string): string {
  if (nome === "OwnedNotFound" || nome === "ForbiddenError") {
    return "Só o dono da caixa ou um administrador pode desligar o envio pelo Gmail.";
  }
  return "Não deu para desligar agora. Tente de novo em instantes.";
}
