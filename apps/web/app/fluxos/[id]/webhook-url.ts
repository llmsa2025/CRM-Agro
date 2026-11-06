/**
 * O que a tela do gatilho Webhook mostra sobre a URL (regra pura, sem React, para testar).
 *
 * O servidor guarda só o HASH do token, então a URL completa só pode
 * aparecer em dois casos:
 *  - "nova": acabou de ser gerada nesta tela (aparece uma vez, com o aviso para copiar);
 *  - "legado": fluxo antigo, com o texto ainda no banco (aparece de novo, com um aviso discreto).
 * Em qualquer outro caso a tela só diz que existe uma URL ("gerada"), ou que ainda não há ("nenhuma").
 */
export type EstadoDaUrl = "nova" | "legado" | "gerada" | "nenhuma";

export function estadoDaUrl(p: { urlNova: string | null; tokenLegado: string | null; webhookTem: boolean }): EstadoDaUrl {
  if (p.urlNova) return "nova";
  if (p.tokenLegado) return "legado";
  return p.webhookTem ? "gerada" : "nenhuma";
}

/** URL completa do webhook para um token. `origem` é o endereço do app (window.location.origin). */
export function urlDoWebhook(origem: string, token: string): string {
  return `${origem}/api/webhooks/flow/${token}`;
}

/**
 * Aviso da caixa da URL recém-gerada. Com a chave FLOW_WEBHOOK_TOKEN_HASH ligada (`soHash`), o servidor
 * não guarda o texto, então a frase diz a verdade: não aparece de novo. Com a chave desligada o texto
 * ainda fica no banco, e a tela não promete o que não cumpre.
 */
export function avisoDaUrlNova(soHash: boolean): string {
  return soHash ? "Copie e guarde agora. Não será mostrada de novo." : "Copie e guarde agora.";
}

/** Aviso discreto sob a URL de fluxo antigo (texto ainda no banco). */
export function avisoDaUrlLegada(soHash: boolean): string {
  return soHash
    ? "Esta URL ainda está guardada em texto no banco. Gere uma nova e o CRM Agro passa a guardar só uma versão embaralhada dela."
    : "Esta URL está guardada em texto no banco.";
}

/** Frase do estado "gerada": a data (já formatada) quando se sabe, e o convite para gerar outra se perdeu. */
export function fraseDaUrlGerada(dataFormatada: string | null): string {
  const inicio = dataFormatada ? `URL gerada em ${dataFormatada}` : "URL já gerada";
  return `${inicio}, gere uma nova se perdeu. Por segurança, ela não aparece de novo.`;
}
