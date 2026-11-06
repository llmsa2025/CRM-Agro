/**
 * Normaliza CNPJ: só dígitos, exatamente 14. Aceita "11.222.333/0001-81",
 * "11222333000181", etc. Retorna null se inválido.
 */
export function normalizeCnpj(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, "");
  if (digits.length !== 14) return null;
  // CNPJ não pode ser tudo igual (000..., 111...). Rejeita os óbvios.
  if (/^(\d)\1{13}$/.test(digits)) return null;
  return digits;
}
