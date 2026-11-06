/**
 * Texto de tela do motivo pelo qual o teste da chave de IA falhou. Sem "use client" e sem importar valor do
 * `@crmagro/core`: o cliente e o teste usam isto direto. Nunca recebe nem mostra a chave.
 */

/** O mesmo conjunto de `MotivoDaChave` do core, repetido aqui como tipo para não importar valor dele. */
export type MotivoDoTeste = "ok" | "formato" | "token_oauth" | "espaco" | "recusada" | "sem_acesso" | "limite" | "indisponivel" | "rede";

const NOME: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", glm: "GLM (z.ai)" };
const ONDE_GERAR: Record<string, string> = {
  anthropic: "console.anthropic.com, API Keys",
  openai: "platform.openai.com, API Keys",
  glm: "o painel da z.ai",
};
const PREFIXO: Record<string, string> = { anthropic: "sk-ant-", openai: "sk-" };

/** O que dizer quando o teste falhou. Sem motivo conhecido, o texto geral de antes. */
export function mensagemDoMotivoDaChave(provider: string, motivo: MotivoDoTeste | string | undefined): string {
  const nome = NOME[provider] ?? "o provedor";
  const onde = ONDE_GERAR[provider] ?? "o painel do provedor";
  switch (motivo) {
    case "formato":
      return PREFIXO[provider]
        ? `Esta não parece uma chave de API da ${nome}. Ela começa com ${PREFIXO[provider]}. Gere uma em ${onde}.`
        : "Esta não parece uma chave de API. Confira se copiou a chave certa.";
    case "token_oauth":
      return `Este é um token do Claude Code (começa com sk-ant-oat), que não funciona como chave de API. Gere uma chave de API em ${onde}.`;
    case "espaco":
      return "A chave tem espaço ou quebra de linha no meio. Cole de novo só a chave, de uma vez.";
    case "recusada":
      return `A ${nome} recusou a chave. Confira se copiou a chave inteira, sem espaço no começo ou no fim, e se ela não foi apagada no painel.`;
    case "sem_acesso":
      return `A ${nome} negou o acesso com esta chave. Confira as permissões da chave e se a conta tem acesso à API.`;
    case "limite":
      return `A ${nome} limitou as chamadas por agora. Tente de novo em um minuto.`;
    case "indisponivel":
      return `A ${nome} está com problema no momento. Tente de novo mais tarde.`;
    case "rede":
      return `O CRM Agro não conseguiu falar com a ${nome} (sem resposta em 10 segundos). Pode ser a rede do servidor. Tente de novo e, se continuar, avise o suporte.`;
    default:
      return "Verifique a chave.";
  }
}

/**
 * O campo para colar a chave só aparece quando faz falta: sem chave, com chave que deu erro, ou depois de
 * "Trocar a chave". Com a chave conectada e testada, o campo some (não há por que colar de novo) e fica só a
 * chave mascarada, com o botão de trocar.
 */
export function mostrarCampoDaChave(p: { connected: boolean; trocando: boolean }): boolean {
  return !p.connected || p.trocando;
}
