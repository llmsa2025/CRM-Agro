/**
 * Duas URLs de conexão apontam para o MESMO banco? (server + projeto + nome do banco)
 *
 * Por que existe: o `crmagro_app` é um papel do MESMO banco que o `basePrisma` usa, e o app mantém dois
 * pools, um por papel. Se `DATABASE_URL_APP` apontasse para outro banco (por exemplo, a URL de produção
 * vazando para um teste que só trocou a `DATABASE_URL`), o `db()` falaria com um banco e o `basePrisma`
 * com outro, sem erro nenhum. Esta checagem pura (sem rede, sem env, sem segredo) é usada:
 *   - pelo client do app (`packages/db/src/client.ts`), que RECUSA criar o pool se os bancos diferem;
 *   - pela guarda do vitest (core e web), que aborta a suíte no mesmo caso;
 *   - pelos testes.
 *
 * A porta não conta (direta 5432 e pooler 6543 são o mesmo banco), nem o usuário (`postgres` e
 * `crmagro_app` são papéis do mesmo banco). No Supabase o projeto aparece no host direto
 * (`db.<ref>.supabase.co`) ou como sufixo do usuário do pooler (`postgres.<ref>`), então os dois
 * formatos casam pelo `<ref>`.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface MarcasDoBanco {
  /** Hosts que identificam o servidor (loopback vira "loopback"). */
  servidores: string[];
  /** Referências de projeto do Supabase achadas no host ou no sufixo do usuário. */
  projetos: string[];
  /** Nome do banco (`postgres` quando a URL não diz). */
  banco: string;
}

/** Lê as marcas de uma URL. Devolve `null` se não for uma URL válida. Nunca devolve senha. */
export function marcasDoBanco(url: string | undefined | null): MarcasDoBanco | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const servidores = [LOOPBACK.has(host) ? "loopback" : host];
  const projetos: string[] = [];
  const doHost = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host);
  if (doHost?.[1]) projetos.push(doHost[1]);
  const usuario = decodeURIComponent(u.username);
  const ponto = usuario.indexOf(".");
  if (ponto > 0 && ponto < usuario.length - 1) projetos.push(usuario.slice(ponto + 1).toLowerCase());
  const banco = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  return { servidores, projetos, banco };
}

/**
 * `true` se as duas URLs são do mesmo banco. Se alguma não for URL válida, devolve `false` (quem chama
 * trata como "não consigo garantir").
 */
export function mesmoBanco(a: string | undefined | null, b: string | undefined | null): boolean {
  const ma = marcasDoBanco(a);
  const mb = marcasDoBanco(b);
  if (!ma || !mb) return false;
  if (ma.banco !== mb.banco) return false;
  // O Supavisor (pooler novo do Supabase) tem UM host por região, dividido por todos os projetos: dois
  // projetos diferentes aparecem com o mesmo host. Quando as duas URLs dizem de qual projeto são, só o
  // projeto decide (o host igual não prova nada).
  if (ma.projetos.length > 0 && mb.projetos.length > 0) return ma.projetos.some((p) => mb.projetos.includes(p));
  return ma.servidores.some((s) => mb.servidores.includes(s));
}

/**
 * Guarda de teste: `DATABASE_URL_APP` (e a do worker), quando existem, precisam apontar para o mesmo banco
 * que `DATABASE_URL`, que é o banco que os testes usam. Devolve a mensagem de erro, ou `null` se está ok.
 * Sem `DATABASE_URL_APP`, não há o que conferir. Nunca inclui host, usuário nem senha na mensagem.
 */
export function problemaDoBancoDoApp(
  fonte: { DATABASE_URL?: string | undefined; DATABASE_URL_APP?: string | undefined; DATABASE_URL_APP_WORKER?: string | undefined },
): string | null {
  for (const nome of ["DATABASE_URL_APP", "DATABASE_URL_APP_WORKER"] as const) {
    const url = fonte[nome];
    if (!url) continue;
    if (!fonte.DATABASE_URL) return `${nome} está definida, mas DATABASE_URL não: não dá para garantir que são o mesmo banco.`;
    if (!mesmoBanco(url, fonte.DATABASE_URL)) {
      return `${nome} aponta para um banco DIFERENTE de DATABASE_URL. O db() falaria com um banco e o client do dono com outro (em teste, isso pode ser a produção). Tire a variável do ambiente ou aponte as duas para o mesmo banco.`;
    }
  }
  return null;
}
