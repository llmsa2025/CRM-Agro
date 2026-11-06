/**
 * Conexão social pela extensão (rota /api/relay/connect-social): regras PURAS de
 * origem e de identidade, testáveis sem servidor.
 *
 * Duas conferências, as duas em profundidade (quem chama é a extensão, com o
 * token do time; nada aqui substitui o token):
 *
 *  1. ORIGEM. A extensão só aciona a conexão a pedido de uma página do CRM Agro
 *     (content script restrito a estas origens) e informa a origem da página em
 *     `origemPagina`. O servidor recusa origem fora da lista. Como o dado vem
 *     do próprio cliente, é uma barreira de coerência (pega extensão antiga,
 *     origem errada, dev apontando para produção), NÃO uma prova de autoria. Já
 *     o cabeçalho `Origin` de um navegador comum é honesto: uma página de outro
 *     site que tentasse chamar a rota (com um token roubado) é recusada aqui.
 *  2. IDENTIDADE. Quando a conexão nasce na tela do CRM Agro, a página manda o
 *     usuário e o time da SESSÃO dela; o servidor confere com o dono do token
 *     da extensão. Assim uma extensão ligada ao token de outra pessoa (o admin
 *     entregou o token dele ao vendedor) não cadastra a conta do vendedor
 *     como se fosse do admin.
 */

/**
 * Origens do CRM Agro: o endereço atual e os domínios antigos que ainda atendem
 * (deploy/Caddyfile). Espelho de ORIGENS_CRMAGRO em apps/extension/ponte.js: o
 * teste de contrato (lib/extensao/ponte.contrato.test.ts) confere as duas listas.
 */
export const ORIGENS_CRMAGRO = [
  "https://app.crmagro.example",
  "https://legacy.crmagro.example",
  "https://legacy-ip.crmagro.example",
] as const;

export interface OpcoesOrigem {
  /** Origens extras aceitas (a do próprio pedido, AUTH_URL, APP_PUBLIC_URL). */
  extras?: ReadonlyArray<string | null | undefined>;
  /** Em produção, http://localhost não vale (só em desenvolvimento). */
  producao?: boolean;
}

/** Normaliza para a origem pura ("https://host[:porta]"); null se não for uma URL http(s). */
function origemPura(valor: string | null | undefined): string | null {
  if (!valor) return null;
  try {
    const u = new URL(valor);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** `origem` é EXATAMENTE uma origem do CRM Agro (sem caminho, sem usuário@)? */
export function origemDoCrmAgroPermitida(origem: string | null | undefined, opcoes: OpcoesOrigem = {}): boolean {
  if (typeof origem !== "string") return false;
  const pura = origemPura(origem);
  if (!pura || pura !== origem) return false;
  if ((ORIGENS_CRMAGRO as readonly string[]).includes(pura)) return true;
  for (const extra of opcoes.extras ?? []) {
    if (origemPura(extra) === pura) return true;
  }
  if (!opcoes.producao) {
    const u = new URL(pura);
    if (u.protocol === "http:" && u.hostname === "localhost") return true;
  }
  return false;
}

/**
 * Cabeçalho `Origin` do pedido. Ausente (curl, script), "null" ou de extensão
 * (chrome-extension://…, moz-extension://…) passam: o serviço real é a extensão,
 * que fala do service worker. Só é recusado o que declara ser uma PÁGINA
 * http(s) de fora do CRM Agro.
 */
export function origemDoPedidoPermitida(cabecalho: string | null | undefined, opcoes: OpcoesOrigem = {}): boolean {
  if (!cabecalho) return true;
  if (!/^https?:\/\//i.test(cabecalho)) return true;
  return origemDoCrmAgroPermitida(cabecalho, opcoes);
}

export interface IdentidadeEsperada {
  userId?: string;
  teamId?: string;
}

/**
 * O `esperado` que a extensão repassou (identidade da sessão da página) bate
 * com o dono do token?
 *  - ausente → ok (popup da extensão, sem tela por trás);
 *  - malformado → "invalida";
 *  - time diferente, ou usuário diferente (quando o token tem dono) → "diferente".
 * Token sem dono (antigo/dev): só o time é conferido.
 */
export function conferirIdentidadeEsperada(
  esperado: unknown,
  dono: { teamId: string; userId: string | null },
): "ok" | "invalida" | "diferente" {
  if (esperado === undefined || esperado === null) return "ok";
  if (typeof esperado !== "object" || Array.isArray(esperado)) return "invalida";
  const e = esperado as Record<string, unknown>;
  if (typeof e.userId !== "string" || !e.userId || typeof e.teamId !== "string" || !e.teamId) return "invalida";
  if (e.teamId !== dono.teamId) return "diferente";
  if (dono.userId && e.userId !== dono.userId) return "diferente";
  return "ok";
}
