/**
 * Modo da política de segurança de conteúdo (CSP) do app web, lido de `CSP_MODO`.
 *
 * Fica num arquivo próprio, sem zod e sem ler `process.env`, de propósito: o middleware do Next roda
 * no Edge Runtime e não pode importar o `index.ts` (que valida o ambiente inteiro e puxa o banco).
 * Por isso o middleware importa `@crmagro/config/csp-modo` e o `index.ts` reexporta daqui.
 *
 * - `desligada`: não manda cabeçalho nenhum (comportamento de antes da CSP);
 * - `relatorio` (PADRÃO): manda `Content-Security-Policy-Report-Only`. O navegador NÃO bloqueia nada,
 *   só avisa o que a política bloquearia (POST em /api/csp-report). Não quebra a interface;
 * - `aplicada`: manda `Content-Security-Policy`. O navegador bloqueia o que a política não permite.
 */
export type ModoCsp = "desligada" | "relatorio" | "aplicada";

export const MODOS_CSP: readonly ModoCsp[] = ["desligada", "relatorio", "aplicada"];

/** Sem a chave (ou com valor que não se reconhece), o modo é o relatório: nunca liga o bloqueio por engano. */
export const MODO_CSP_PADRAO: ModoCsp = "relatorio";

const APELIDOS: Record<string, ModoCsp> = {
  desligada: "desligada",
  desligado: "desligada",
  off: "desligada",
  nao: "desligada",
  não: "desligada",
  relatorio: "relatorio",
  relatório: "relatorio",
  "report-only": "relatorio",
  reportonly: "relatorio",
  aplicada: "aplicada",
  aplicado: "aplicada",
  enforce: "aplicada",
};

/** O texto de `CSP_MODO` é um modo conhecido (ou está vazio, que vale o padrão)? */
export function modoCspReconhecido(valor: string | undefined | null): boolean {
  const v = (valor ?? "").trim().toLowerCase();
  return v === "" || v in APELIDOS;
}

/**
 * Traduz o texto de `CSP_MODO` no modo efetivo. Pura, para testar sem env. Maiúscula e espaço nas pontas
 * não importam. Ausente, vazio ou desconhecido = `relatorio` (o padrão): só `aplicada` (ou os apelidos
 * `aplicado` e `enforce`) liga o bloqueio, então um erro de digitação nunca derruba a interface.
 */
export function modoCsp(valor: string | undefined | null): ModoCsp {
  const v = (valor ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(APELIDOS, v) ? APELIDOS[v]! : MODO_CSP_PADRAO;
}
