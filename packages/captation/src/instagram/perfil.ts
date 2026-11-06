/**
 * @ de um perfil do Instagram, como a Captação o aceita: "@fulano", "fulano" ou a URL do perfil.
 * Devolve o @ em minúsculas, ou null se não for um @ válido (1 a 30 letras, números, ponto e
 * sublinhado). Função pura, sem dependência: a extensão (apps/extension/instagram.js) tem uma
 * cópia testada contra esta (lib/extensao/instagram.contrato.test.ts).
 */
export function normalizarPerfilInstagram(bruto: string): string | null {
  let u = String(bruto ?? "").trim();
  const m = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)/i.exec(u);
  if (m) u = m[1]!;
  u = u.replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(u)) return null;
  return u;
}
