/**
 * Abas de Integrações → Canais (uma por canal). Módulo comum (sem "use client")
 * porque a página (servidor) lê o `?canal=` da URL e o cliente desenha as abas
 * — valor exportado de módulo cliente chega ao servidor como referência, não
 * como o array.
 */
export const CANAIS_DA_TELA = ["whatsapp", "instagram", "linkedin", "email"] as const;
export type CanalDaTela = (typeof CANAIS_DA_TELA)[number];

/** `?canal=` da URL → aba; inválido/ausente = WhatsApp. */
export function canalDaUrl(v: string | string[] | undefined | null): CanalDaTela {
  const c = Array.isArray(v) ? v[0] : v;
  return (CANAIS_DA_TELA as readonly string[]).includes(c ?? "") ? (c as CanalDaTela) : "whatsapp";
}

/**
 * Canais SEM caixa de mensagens ainda: em Conversas aparecem com "Em breve", sem botão e sem nenhuma
 * conta. O LinkedIn é um deles: o caminho oficial só entra e publica, a caixa chega depois. Uma conta que
 * já exista no banco fica guardada, só não aparece.
 */
export const CANAIS_EM_BREVE: readonly CanalDaTela[] = ["linkedin"];

export function canalEmBreve(canal: string): boolean {
  return (CANAIS_EM_BREVE as readonly string[]).includes(canal);
}

/** As contas que Conversas mostra: sem as de canal em breve. */
export function semCanaisEmBreve<T extends { canal: string }>(contas: readonly T[]): T[] {
  return contas.filter((c) => !canalEmBreve(c.canal));
}

/** `ChannelAccount.provider` da conta oficial do LinkedIn (entrar e publicar). */
const PROVEDOR_LINKEDIN_OFICIAL = "linkedin_official";

/**
 * Em Integrações o canal abre quando dá para conectar: o LinkedIn oficial (entrar e publicar) abre assim
 * que o app do LinkedIn está configurado no servidor; até lá segue "Em breve", como os outros canais sem
 * caixa.
 */
export function canalAbreEmIntegracoes(canal: string, linkedinLigado: boolean): boolean {
  return canal === "linkedin" ? linkedinLigado : true;
}

/**
 * As contas que Integrações mostra: no LinkedIn, só a oficial (a antiga, pela extensão, fica guardada e
 * escondida) e só com o app do LinkedIn configurado.
 */
export function contasDeIntegracoes<T extends { canal: string; provider: string }>(contas: readonly T[], linkedinLigado: boolean): T[] {
  return contas.filter((c) => (c.canal === "linkedin" ? linkedinLigado && c.provider === PROVEDOR_LINKEDIN_OFICIAL : true));
}
