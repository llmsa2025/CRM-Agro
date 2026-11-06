/**
 * Regras puras da conexão do LinkedIn oficial em Integrações, Canais, aba LinkedIn. Sem "use client" e
 * sem importar valor do `@crmagro/core`: o cliente, o servidor e o teste usam isto direto.
 */

/** O caminho que leva a pessoa à tela de permissão do LinkedIn. */
export const HREF_CONECTAR_LINKEDIN = "/api/integracoes/linkedin/conectar?volta=canais";

/** O que a volta do LinkedIn mostra em Canais (`?linkedin=...`), uma vez. */
export type ResultadoDoLinkedin = { ok: boolean; texto: string };

export const RESULTADO_LINKEDIN: Record<string, ResultadoDoLinkedin> = {
  conectado: { ok: true, texto: "Pronto. O LinkedIn está conectado. Já dá para publicar no seu perfil." },
  cancelado: { ok: false, texto: "Conexão cancelada na tela do LinkedIn." },
  expirou: { ok: false, texto: "O pedido de conexão expirou ou veio de outro navegador. Tente de novo." },
  "sem-publicar": { ok: false, texto: "O LinkedIn não liberou a permissão de publicar. Conecte de novo e marque a permissão." },
  "outra-pessoa": { ok: false, texto: "Este perfil do LinkedIn já está conectado por outra pessoa no CRM Agro." },
  "sem-permissao": {
    ok: false,
    texto: "Sem permissão para conectar: é preciso papel de membro (não \"só leitura\") e a tela Integrações. Fale com o administrador.",
  },
  indisponivel: { ok: false, texto: "A conexão com o LinkedIn não está configurada neste servidor." },
  configuracao: { ok: false, texto: "A integração com o LinkedIn está mal configurada (chave do app). Avise o administrador." },
  falhou: { ok: false, texto: "Não foi possível conectar agora. Tente de novo em instantes." },
};

/** `null` sem código; código que não conhecemos vira o de "falhou" (nunca texto cru da URL). */
export function resultadoDoLinkedinEmCanais(codigo: string | null): ResultadoDoLinkedin | null {
  if (!codigo) return null;
  return Object.hasOwn(RESULTADO_LINKEDIN, codigo) ? RESULTADO_LINKEDIN[codigo]! : RESULTADO_LINKEDIN.falhou!;
}

/** A validade do token, como o core calcula (`situacaoDaValidade`), repetida aqui só como tipo. */
export type ValidadeDoLinkedin = { estado: "ok" | "vence_logo" | "vencida" | "desconhecida"; dias: number | null };

/** O que a linha da conta do LinkedIn diz sobre a validade. `reconectar`: vale oferecer o botão de conectar de novo. */
export type LinhaDoLinkedin = { tone: "ok" | "attention" | "error"; texto: string; reconectar: boolean };

export function linhaDoLinkedin(v: ValidadeDoLinkedin | null | undefined): LinhaDoLinkedin | null {
  if (!v) return null;
  switch (v.estado) {
    case "ok":
      return { tone: "ok", texto: v.dias === null ? "Conectado." : `Conectado. Vale por mais ${v.dias} dias.`, reconectar: false };
    case "vence_logo": {
      const quando = v.dias === 0 ? "hoje" : v.dias === 1 ? "amanhã" : `em ${v.dias} dias`;
      return { tone: "attention", texto: `A conexão vence ${quando}. Conecte de novo para continuar publicando.`, reconectar: true };
    }
    case "vencida":
      return { tone: "error", texto: "A conexão venceu. Conecte de novo para publicar.", reconectar: true };
    default:
      return { tone: "ok", texto: "Conectado.", reconectar: false };
  }
}

/** Mensagem de tela para o erro de uma action. NUNCA a mensagem crua do core. */
export function mensagemDoErroDoLinkedin(nome: string): string {
  if (nome === "ForbiddenError") return "Só o dono da conta ou um administrador pode desconectar o LinkedIn.";
  return "Não deu para concluir agora. Tente de novo em instantes.";
}
