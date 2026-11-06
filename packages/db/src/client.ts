import { PrismaClient, Prisma } from "@prisma/client";
import { env, problemaDoBancoDoApp } from "@crmagro/config";
import { tenantExtension, TenantContextRequiredError } from "./tenant";
import { getCurrentTeamId } from "./context";
import { encryptCredentials, decryptCredentials } from "./crypto";
import { rlsExtensao, rlsTransacao } from "./rls";
import { comCamposCifrados, modoCifraContatos, type ModeloComCifra } from "./contatos-cifra";

/**
 * Client BASE (singleton, com engine). Sem extensão de tenancy — usar só para
 * bootstrap (seed) e admin que escapa do escopo de tenant.
 */
const globalForBase = globalThis as unknown as { __crmagroBasePrisma?: PrismaClient };

export const basePrisma: PrismaClient =
  globalForBase.__crmagroBasePrisma ??
  (globalForBase.__crmagroBasePrisma = new PrismaClient({
    log: env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  }));

// ---------------------------------------------------------------------------
// Extensão de criptografia do campo `credentials` dos models Integration e
// LinhaDeLigacao.
//
// Intercepta escrita (create / createMany / createManyAndReturn / update /
// updateMany / upsert) para criptografar `credentials` com AES-256-GCM antes
// de tocar o DB, e leitura (findUnique / findFirst / findMany / create /
// update / upsert / createManyAndReturn) para descriptografar no retorno.
//
// O model Integration guarda tokens de CRMs (NectarCRM, Gmail, ...); por
// isso as credenciais ficam sempre cifradas no banco. ChannelAccount.credentials
// NÃO é afetado — guarda só identificadores não-secretos (instance/number).
// A LinhaDeLigacao (F1B-05) guarda o que é só da linha (senha do ramal, token da
// pessoa) e passa pela MESMA cifra e pelo mesmo anel de chaves. Model novo com
// `credentials` secreto entra em `MODELOS_COM_CREDENTIALS_CIFRADAS` E em
// `scripts/recifrar-credenciais.ts` (o teste tenancy/credenciais-cifradas cobra).
// ---------------------------------------------------------------------------

/** Operações que gravam (precisam criptografar `credentials` no `data`). */
const WRITE_OPS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
]);

/**
 * Operações de escrita da cifra de `credentials` (as de `WRITE_OPS` mais `updateManyAndReturn`, que também leva
 * `data`). A cifra dos contatos usa só `WRITE_OPS`, de propósito: esta lista é só desta extensão.
 */
const ESCRITA_DE_CREDENTIALS = new Set([...WRITE_OPS, "updateManyAndReturn"]);

/** Operações que devolvem registros (precisam descriptografar o resultado). */
const RETURN_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
]);

/** Operações que não gravam `credentials` nem devolvem o registro (só contagem ou agregado): passam direto. */
const SEM_CREDENTIALS = new Set(["createMany", "deleteMany", "count", "aggregate", "groupBy"]);

/**
 * Operação do Prisma que a cifra de `credentials` não conhece, num model cifrado. Recusada de propósito (fail-closed,
 * como a extensão de tenancy): deixar passar gravaria a senha em texto puro ou devolveria o envelope cifrado como se
 * fosse a credencial. Se aparecer, ensine a operação a `ESCRITA_DE_CREDENTIALS`, `RETURN_OPS` ou `SEM_CREDENTIALS`.
 */
export class CredentialsUnknownOperationError extends Error {
  constructor(operation: string, model: string) {
    super(`CredentialsUnknownOperation: ${operation} em ${model} não é tratada pela cifra de credentials.`);
    this.name = "CredentialsUnknownOperationError";
  }
}

/** Criptografa o campo `credentials` num objeto de dados de create/update. */
function encryptInData(data: unknown): unknown {
  if (data == null || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  // criptografa só se `credentials` estiver presente e não for null
  if (d.credentials === undefined || d.credentials === null) return d;
  return { ...d, credentials: encryptCredentials(d.credentials) };
}

/** Descriptografa o campo `credentials` num registro retornado pelo Prisma. */
function decryptInRecord(record: unknown): unknown {
  if (record == null || typeof record !== "object") return record;
  const r = record as Record<string, unknown>;
  if (!("credentials" in r)) return r;
  return { ...r, credentials: decryptCredentials(r.credentials) };
}

/** Models cujo `credentials` é cifrado em repouso (nomes do client, em minúsculas na frente). */
export const MODELOS_COM_CREDENTIALS_CIFRADAS = ["integration", "linhaDeLigacao"] as const;

/**
 * Extensão Prisma que critografa/descriptografa `credentials` nos models de `MODELOS_COM_CREDENTIALS_CIFRADAS`
 * em qualquer operação de escrita/leitura. Composta com a extensão de tenancy: o tenant injeta teamId
 * primeiro e esta cifra depois.
 */
function credentialsExtension() {
  return Prisma.defineExtension((client) => {
    const porModelo = Object.fromEntries(
      MODELOS_COM_CREDENTIALS_CIFRADAS.map((modelo) => [
        modelo,
        {
          async $allOperations({ args, query, operation }: { args: unknown; query: (a: unknown) => Promise<unknown>; operation: string }) {
            return aplicarCifraDeCredentials(modelo, operation, args, query);
          },
        },
      ]),
    );
    return client.$extends({ query: porModelo as never });
  });
}

/**
 * O miolo da cifra de `credentials` para UMA operação de um model cifrado: criptografa o `data` antes de gravar e
 * descriptografa o que volta. Exportada para os testes passarem por todas as operações sem subir um banco.
 */
export async function aplicarCifraDeCredentials(
  model: string,
  operation: string,
  args: unknown,
  query: (a: unknown) => Promise<unknown>,
): Promise<unknown> {
  const op = operation;
  const escreve = ESCRITA_DE_CREDENTIALS.has(op);
  const devolve = RETURN_OPS.has(op);
  if (!escreve && !devolve && !SEM_CREDENTIALS.has(op)) throw new CredentialsUnknownOperationError(op, model);
  const a = (args ?? {}) as Record<string, unknown>;

  // --- Escrita: criptografar antes de enviar ao DB ---
  if (escreve) {
    if (op === "create") {
      a.data = encryptInData(a.data);
    } else if (op === "createMany" || op === "createManyAndReturn") {
      const data = a.data;
      a.data = Array.isArray(data) ? data.map(encryptInData) : encryptInData(data);
    } else if (op === "update" || op === "updateMany" || op === "updateManyAndReturn") {
      a.data = encryptInData(a.data);
    } else if (op === "upsert") {
      if (a.create != null) a.create = encryptInData(a.create);
      if (a.update != null) a.update = encryptInData(a.update);
    }
  }

  const result = await query(args);

  // --- Leitura: descriptografar no retorno ---
  if (devolve) {
    if (Array.isArray(result)) {
      return result.map(decryptInRecord);
    }
    return decryptInRecord(result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Extensão da cifra de e-mail e telefone dos contatos (CONTATOS_CIFRA).
//
// Rede de segurança da ESCRITA: em create / createMany / createManyAndReturn / update / updateMany /
// upsert dos 5 models com telefone ou e-mail, deriva o valor cifrado e o índice cego a partir do campo
// em claro. Cobre todo escritor que passa por `db()`, inclusive os futuros. Com a flag `off` retorna
// na primeira linha e não custa nada.
//
// NÃO cobre `basePrisma`, o `tx` de `basePrisma.$transaction` nem create aninhado (`identifiers: { create }`):
// esses pontos chamam `comCamposCifrados` explicitamente (e o teste-guarda proíbe o aninhado).
// ---------------------------------------------------------------------------

const MODELOS_COM_CIFRA: ModeloComCifra[] = ["channelIdentifier", "conversation", "whatsAppLid", "call", "campaignRecipient"];

function contatosCifraExtension(teamId: string) {
  return Prisma.defineExtension((client) => {
    const porModelo = {} as Record<ModeloComCifra, { $allOperations: (p: { args: unknown; query: (a: unknown) => Promise<unknown>; operation: string }) => Promise<unknown> }>;
    for (const modelo of MODELOS_COM_CIFRA) {
      porModelo[modelo] = {
        async $allOperations({ args, query, operation }) {
          if (modoCifraContatos() === "off" || !WRITE_OPS.has(operation)) return query(args);
          const a = args as Record<string, unknown>;
          const preparar = (d: unknown, canal?: string | null) =>
            d != null && typeof d === "object" ? comCamposCifrados(modelo, teamId, d as Record<string, unknown>, { canal }) : d;
          if (operation === "create") {
            a.data = preparar(a.data);
          } else if (operation === "createMany" || operation === "createManyAndReturn") {
            a.data = Array.isArray(a.data) ? a.data.map((d) => preparar(d)) : preparar(a.data);
          } else if (operation === "upsert") {
            if (a.create != null) a.create = preparar(a.create);
            if (a.update != null) {
              // No upsert o canal da linha nova (`create.canal`) é o mesmo da existente (a chave única leva o canal).
              const canalDoCreate = (a.create as Record<string, unknown> | undefined)?.canal;
              a.update = await prepararUpdate(client, modelo, a.where, a.update, preparar, typeof canalDoCreate === "string" ? canalDoCreate : null);
            }
          } else if (operation === "update" || operation === "updateMany") {
            a.data = await prepararUpdate(client, modelo, a.where, a.data, preparar);
          }
          return query(args);
        },
      };
    }
    return client.$extends({ query: porModelo as never });
  });
}

/**
 * `update` de ChannelIdentifier que troca o `valor` sem dizer o canal: lê o canal da linha (uma leitura
 * a mais, só nesse caso raro) para saber se é e-mail, telefone ou handle.
 */
async function prepararUpdate(
  client: unknown,
  modelo: ModeloComCifra,
  where: unknown,
  data: unknown,
  preparar: (d: unknown, canal?: string | null) => unknown,
  canalConhecido: string | null = null,
): Promise<unknown> {
  if (modelo !== "channelIdentifier" || data == null || typeof data !== "object") return preparar(data);
  const d = data as Record<string, unknown>;
  if (d.valor === undefined || d.canal !== undefined) return preparar(data);
  if (canalConhecido) return preparar(data, canalConhecido);
  const c = client as { channelIdentifier: { findFirst: (a: unknown) => Promise<{ canal: string } | null> } };
  try {
    const linha = await c.channelIdentifier.findFirst({ where, select: { canal: true } });
    return preparar(data, linha?.canal ?? null);
  } catch {
    // `where` que o findFirst não aceita (chave única composta): sem o canal os derivados são zerados e a linha cai para o texto.
    return preparar(data, null);
  }
}

/**
 * Client do papel `crmagro_app` (RLS), criado só se `DATABASE_URL_APP` existir. Singleton próprio, com
 * pool próprio: o `basePrisma` (dono das tabelas, sem RLS) segue existindo para login, cadastro,
 * worker de sistema e consultas entre times.
 */
const globalForApp = globalThis as unknown as { __crmagroAppPrisma?: PrismaClient };

function appPrisma(): PrismaClient | null {
  if (!env.DATABASE_URL_APP) return null;
  if (!globalForApp.__crmagroAppPrisma) {
    // Guarda: o papel crmagro_app é do MESMO banco que o basePrisma usa. Se as URLs apontam para bancos
    // diferentes (ex.: a URL de produção vazando para um teste que só trocou a DATABASE_URL), o db()
    // falaria com um banco e o basePrisma com outro, sem erro nenhum. Recusa na hora, com mensagem clara.
    const problema = problemaDoBancoDoApp({ DATABASE_URL: env.DATABASE_URL, DATABASE_URL_APP: env.DATABASE_URL_APP });
    if (problema) throw new Error(`[db] RLS recusado: ${problema}`);
    globalForApp.__crmagroAppPrisma = new PrismaClient({
      datasourceUrl: env.DATABASE_URL_APP,
      log: env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    });
    if (env.NODE_ENV !== "test") console.info("[db] RLS ativo: o client do time usa o papel crmagro_app (DATABASE_URL_APP).");
  }
  return globalForApp.__crmagroAppPrisma;
}

/**
 * Resultado da sonda do pool do papel `crmagro_app` (RLS, camada 3). `ativo: false` = o app roda como
 * sempre rodou (DATABASE_URL_APP ausente) e não há o que conferir. Nunca carrega senha nem URL.
 */
export type SondaBancoApp =
  | { ativo: false }
  | { ativo: true; ok: true; papel: string }
  | { ativo: true; ok: false; problema: string };

/** Tira URL de conexão de um texto de erro (pode trazer usuário e host) antes de logar ou expor. */
function textoSemUrl(texto: string): string {
  return texto.replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Sonda do pool do app, SEM declarar time (é exatamente o caso que o RLS tem de fechar). Confere, numa
 * conexão do pool do `crmagro_app`: que o papel é `crmagro_app`, que ele não ignora RLS (BYPASSRLS ou
 * superusuário), que nenhuma linha de Contact aparece sem time declarado, que as tabelas de login e
 * cadastro estão fora do alcance dele e que ele alcança Contact (privilégios em dia, por exemplo depois
 * de um restore). Usada pelo /api/health (check `rls`) e no boot do web e do worker. Nunca lança.
 */
export async function sondarBancoApp(): Promise<SondaBancoApp> {
  let app: PrismaClient | null;
  try {
    app = appPrisma();
  } catch (e) {
    return { ativo: true, ok: false, problema: textoSemUrl(e instanceof Error ? e.message : String(e)) };
  }
  if (!app) return { ativo: false };
  try {
    const [r] = await app.$queryRaw<
      Array<{ papel: string; ignora_rls: boolean | null; time_declarado: string; linhas_sem_time: number; acessa_login: boolean; acessa_contato: boolean }>
    >`SELECT current_user::text AS papel,
             (SELECT (rolbypassrls OR rolsuper) FROM pg_roles WHERE rolname = current_user) AS ignora_rls,
             coalesce(current_setting('app.team_id', true), '') AS time_declarado,
             (SELECT count(*)::int FROM (SELECT 1 FROM "Contact" LIMIT 1) AS uma) AS linhas_sem_time,
             has_table_privilege(current_user, '"PasswordResetToken"', 'SELECT') AS acessa_login,
             has_table_privilege(current_user, '"Contact"', 'SELECT') AS acessa_contato`;
    if (!r) return { ativo: true, ok: false, problema: "a sonda não devolveu linha" };
    const problemas: string[] = [];
    if (r.papel !== "crmagro_app") problemas.push(`a conexão está como "${r.papel}", não como crmagro_app`);
    if (r.ignora_rls !== false) problemas.push("o papel ignora o RLS (BYPASSRLS ou superusuário)");
    if (r.time_declarado !== "") problemas.push("a conexão já chegou com um time declarado");
    if (r.linhas_sem_time !== 0) problemas.push("o papel viu contato(s) sem declarar time: o RLS não está filtrando");
    if (r.acessa_login) problemas.push("o papel alcança PasswordResetToken (deveria ser negado)");
    if (!r.acessa_contato) problemas.push("o papel não alcança Contact (privilégios perdidos, rode rls-papel-app.sh regrant)");
    if (problemas.length) return { ativo: true, ok: false, problema: problemas.join("; ") };
    return { ativo: true, ok: true, papel: r.papel };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string; errorCode?: string } | null)?.code ?? (e as { errorCode?: string } | null)?.errorCode ?? "";
    let problema: string;
    if (code === "P1000" || /Authentication failed|password authentication/i.test(msg)) {
      problema = "o banco recusou o login do crmagro_app (senha errada, papel sem login ou o pooler não aceita o papel)";
    } else if (/permission denied/i.test(msg)) {
      problema = "o crmagro_app perdeu privilégios no banco (reaplique os privilégios do papel crmagro_app no banco)";
    } else if (code === "P1001" || code === "P1002" || code === "P2024") {
      problema = `não consegui conectar como crmagro_app (${code})`;
    } else {
      problema = textoSemUrl(msg);
    }
    return { ativo: true, ok: false, problema };
  }
}

/**
 * Chamada no boot do web e do worker: confere o pool do `crmagro_app` e FALA ALTO. Não derruba o processo
 * (o /api/health fica `unhealthy` pelo check `rls`, e a operação desliga pelo script), mas nunca deixa
 * o RLS falhar em silêncio, nem cair no papel dono sem avisar.
 */
export async function conectarBancoApp(processo: "web" | "worker"): Promise<SondaBancoApp> {
  const sonda = await sondarBancoApp();
  if (!sonda.ativo) return sonda;
  if (sonda.ok) {
    console.info(`[db] RLS conferido no boot do ${processo}: papel ${sonda.papel}, sem BYPASSRLS, 0 linhas sem time declarado.`);
  } else {
    console.error(
      `[db] RLS ATIVO MAS COM PROBLEMA no boot do ${processo}: ${sonda.problema}. ` +
        `Toda consulta do db() vai falhar. Para voltar ao normal: remova DATABASE_URL_APP e DATABASE_URL_APP_WORKER do ambiente e reinicie web e worker`,
    );
  }
  return sonda;
}

/** Cria um client tenant (base + extensão com teamId no closure + cripto de credentials). */
function makeTenantClientPlain(teamId: string) {
  return basePrisma.$extends(tenantExtension(teamId)).$extends(credentialsExtension()).$extends(contatosCifraExtension(teamId));
}

export type TenantPrismaClient = ReturnType<typeof makeTenantClientPlain>;

/**
 * Client do time pelo papel `crmagro_app` (RLS): declara o time em toda transação (rls.ts). A extensão
 * de RLS entra PRIMEIRO (a mais interna) e o `$transaction` é sobrescrito por último; o tipo continua
 * o mesmo, para os serviços não notarem a diferença. Exportada também para os testes.
 */
export function tenantClientViaRls(app: PrismaClient, teamId: string): TenantPrismaClient {
  const cadeia = app.$extends(rlsExtensao(app, teamId)).$extends(tenantExtension(teamId)).$extends(credentialsExtension()).$extends(contatosCifraExtension(teamId));
  return cadeia.$extends(rlsTransacao(cadeia as unknown as PrismaClient, teamId)) as unknown as TenantPrismaClient;
}

function makeTenantClient(teamId: string): TenantPrismaClient {
  const app = appPrisma();
  return app ? tenantClientViaRls(app, teamId) : makeTenantClientPlain(teamId);
}

/**
 * Client tenant cacheado por teamId. $extends só cria um wrapper leve (não
 * spawna engine — todos compartilham o basePrisma singleton), mas evitamos
 * recriar o wrapper a cada chamada. LRU com teto: com muitos times ativos o Map
 * cresceria sem limite; ao estourar, descarta o menos-recentemente-usado (o Map
 * do JS preserva a ordem de inserção — re-inserir "promove" a entrada).
 */
const MAX_TENANT_CLIENTS = Number(process.env.TENANT_CLIENT_CACHE_MAX ?? 500);
const tenantClients = new Map<string, TenantPrismaClient>();

export function tenantPrisma(teamId: string): TenantPrismaClient {
  const cached = tenantClients.get(teamId);
  if (cached) {
    // promove a MRU: remove e re-insere no fim.
    tenantClients.delete(teamId);
    tenantClients.set(teamId, cached);
    return cached;
  }
  const client = makeTenantClient(teamId);
  tenantClients.set(teamId, client);
  if (tenantClients.size > MAX_TENANT_CLIENTS) {
    // evita o LRU: a primeira chave é a menos-recentemente-usada.
    const lru = tenantClients.keys().next().value;
    if (lru !== undefined) tenantClients.delete(lru);
  }
  return client;
}

/**
 * Lê o teamId do AsyncLocalStorage de forma EAGER (síncrona, confiável) e
 * retorna o client tenant. É o gatekeeper fail-closed: sem teamId no contexto
 * → lança TenantContextRequiredError.
 *
 * Serviços devem chamar `db()` no início (antes de qualquer await) e usar o
 * client retornado. Assim o teamId fica no closure e sobrevive à execução
 * lazy do PrismaPromise (que perde o ALS em ambientes bundled).
 */
export function db(): TenantPrismaClient {
  const teamId = getCurrentTeamId();
  if (!teamId) throw new TenantContextRequiredError("db()", "(resolver)");
  return tenantPrisma(teamId);
}
