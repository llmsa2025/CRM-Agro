/**
 * Telas por pessoa no WEB (plano-equipe-permissoes F2b): rótulos para a tela
 * de Equipe e o mapa rota → tela para o middleware.
 *
 * O middleware roda no Edge e NÃO importa `@crmagro/core` (puxaria o Prisma):
 * por isso a regra fica duplicada aqui, em poucas linhas. A fonte da verdade é
 * `packages/core/src/auth/modulos.ts` — mudou lá (tela nova), mude aqui.
 */
export const TELAS: { id: string; label: string }[] = [
  { id: "painel", label: "Painel" },
  { id: "atividades", label: "Atividades" },
  { id: "conversas", label: "Conversas" },
  { id: "ligacoes", label: "Ligações" },
  { id: "agenda", label: "Agenda" },
  { id: "contatos", label: "Contatos" },
  { id: "campanhas", label: "Campanhas" },
  { id: "captacao", label: "Captação" },
  { id: "funis", label: "Funis" },
  { id: "fluxos", label: "Fluxos" },
  { id: "mapa", label: "Mapa" },
  { id: "integracoes", label: "Integrações" },
  { id: "configuracoes", label: "Configurações" },
];

/**
 * Telas cujos registros têm dono — as do "ver tudo" POR TELA (F3): em cada uma
 * o administrador escolhe se a pessoa vê "só os meus" ou "de todos". Espelha
 * `MODULOS_COM_DONO` (packages/core/src/auth/modulos.ts), na mesma ordem;
 * mudou lá, mude aqui. `dica`: o que mais segue a escolha.
 */
export const TELAS_COM_DONO: { id: string; label: string; dica?: string }[] = [
  { id: "contatos", label: "Contatos", dica: "vale também para o Painel e o Mapa" },
  { id: "funis", label: "Funis", dica: "os negócios no kanban" },
  { id: "conversas", label: "Conversas", dica: "os números e as caixas de e-mail" },
  { id: "ligacoes", label: "Ligações" },
  { id: "agenda", label: "Agenda", dica: "os compromissos e visitas" },
  { id: "campanhas", label: "Campanhas" },
  { id: "fluxos", label: "Fluxos" },
  { id: "captacao", label: "Captação", dica: "a fila de revisão" },
];

/** Mesma regra do core: master/admin e lista vazia = todas; o Painel sempre. */
export function temTela(role: string | null | undefined, modulos: readonly string[] | null | undefined, tela: string): boolean {
  if (role === "owner" || role === "admin") return true;
  if (!modulos || modulos.length === 0) return true;
  return tela === "painel" || modulos.includes(tela);
}

/**
 * Tela de cada caminho (páginas e as APIs de leitura, que não passam pelo
 * `requireCan`). `null` = não é tela de ninguém (auth, health, webhooks…).
 */
const PREFIXOS: [RegExp, string][] = [
  [/^\/(atividades)(\/|$)/, "atividades"],
  [/^\/(conversas)(\/|$)/, "conversas"],
  [/^\/(ligacoes|api\/calls)(\/|$)/, "ligacoes"],
  [/^\/(agenda)(\/|$)/, "agenda"],
  [/^\/(contatos|api\/contacts|api\/contatos)(\/|$)/, "contatos"],
  [/^\/(campanhas)(\/|$)/, "campanhas"],
  [/^\/(captacao)(\/|$)/, "captacao"],
  [/^\/(funis|api\/funnels)(\/|$)/, "funis"],
  [/^\/(fluxos|api\/flows)(\/|$)/, "fluxos"],
  [/^\/(mapa|api\/mapa)(\/|$)/, "mapa"],
  [/^\/(integracoes)(\/|$)/, "integracoes"],
  [/^\/(configuracoes|api\/configuracoes)(\/|$)/, "configuracoes"],
];

export function telaDoCaminho(pathname: string): string | null {
  for (const [re, tela] of PREFIXOS) if (re.test(pathname)) return tela;
  return null;
}
