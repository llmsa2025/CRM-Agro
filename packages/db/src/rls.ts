import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * RLS no Postgres: o app conecta com o papel `crmagro_app` (sem BYPASSRLS) e CADA transação declara de
 * qual time ela é, antes de qualquer consulta:
 *     SELECT set_config('app.team_id', '<time>', true)     -- true = vale só nesta transação
 * As políticas (migration 20261001120100_rls_politicas_por_time) comparam "teamId" com esse valor.
 * Sem declarar, nenhuma linha passa. O valor nunca "vaza" para a próxima transação da conexão, o que
 * é o que torna isto seguro atrás do pooler em modo transação (Supavisor/pgbouncer).
 *
 * Este arquivo só existe quando `DATABASE_URL_APP` está configurada (client.ts). Sem ela, o app segue
 * como antes (dono das tabelas + filtro de time da extensão), e o RLS fica como segunda trava só para
 * quem conecta por outro papel (API de dados do Supabase, por exemplo).
 *
 * Ordem das extensões (importa): a de RLS vai PRIMEIRO, é a mais interna. O `query(args)` que ela
 * recebe é então a consulta de verdade (lazy), e dá para enfileirá-la no mesmo lote do `set_config`.
 * Se outra extensão assíncrona ficasse por dentro, o `query(args)` já teria rodado sozinho, numa
 * transação à parte, e o `set_config` não valeria para ele.
 */
export const RLS_TEAM_SETTING = "app.team_id";

/** O que o Prisma passa de interno ao hook: se a operação já está dentro de uma transação. */
type ParamsInternos = { transaction?: unknown } | undefined;

const definirTime = (client: PrismaClient, teamId: string) =>
  client.$executeRaw`SELECT set_config('app.team_id', ${teamId}, true)`;

/**
 * Operação avulsa (fora de transação): vira um lote [set_config, consulta], na mesma conexão e na
 * mesma transação. Dentro de uma transação (interativa ou em lote), `__internalParams.transaction`
 * vem preenchido e o `set_config` já foi posto pelo `$transaction` (rlsTransacao), então passa direto.
 */
export function rlsExtensao(app: PrismaClient, teamId: string) {
  const envolver = async (query: (args: never) => PromiseLike<unknown>, args: unknown, interno: ParamsInternos) => {
    if (interno?.transaction) return query(args as never);
    const [, resultado] = await app.$transaction([definirTime(app, teamId), query(args as never) as never]);
    return resultado;
  };

  return Prisma.defineExtension({
    name: "crmagro-rls",
    query: {
      $allModels: {
        async $allOperations({ args, query, __internalParams }: { args: unknown; query: (a: never) => PromiseLike<unknown>; __internalParams?: ParamsInternos }) {
          return envolver(query, args, __internalParams);
        },
      },
      async $queryRaw({ args, query, __internalParams }: { args: unknown; query: (a: never) => PromiseLike<unknown>; __internalParams?: ParamsInternos }) {
        return envolver(query, args, __internalParams);
      },
      async $executeRaw({ args, query, __internalParams }: { args: unknown; query: (a: never) => PromiseLike<unknown>; __internalParams?: ParamsInternos }) {
        return envolver(query, args, __internalParams);
      },
      async $queryRawUnsafe({ args, query, __internalParams }: { args: unknown; query: (a: never) => PromiseLike<unknown>; __internalParams?: ParamsInternos }) {
        return envolver(query, args, __internalParams);
      },
      async $executeRawUnsafe({ args, query, __internalParams }: { args: unknown; query: (a: never) => PromiseLike<unknown>; __internalParams?: ParamsInternos }) {
        return envolver(query, args, __internalParams);
      },
    },
  } as never);
}

/**
 * `$transaction` do client do time com o `set_config` na frente:
 *  - interativa (`$transaction(async (tx) => ...)`): o `set_config` é o primeiro comando da transação,
 *    e o `tx` que o callback recebe já carrega as extensões (tenant, credenciais, RLS);
 *  - em lote (`$transaction([a, b])`): o `set_config` entra na frente e o resultado dele é descartado.
 * `cadeia` é o client JÁ com as três extensões (sem este override), por onde a transação de fato roda.
 */
export function rlsTransacao(cadeia: PrismaClient, teamId: string) {
  return Prisma.defineExtension({
    name: "crmagro-rls-transacao",
    client: {
      $transaction(arg: unknown, opcoes?: unknown) {
        if (typeof arg === "function") {
          return (cadeia as unknown as { $transaction: (fn: unknown, o?: unknown) => Promise<unknown> }).$transaction(
            async (tx: PrismaClient) => {
              await definirTime(tx, teamId);
              return (arg as (t: PrismaClient) => Promise<unknown>)(tx);
            },
            opcoes,
          );
        }
        const lote = arg as Prisma.PrismaPromise<unknown>[];
        return (cadeia as unknown as { $transaction: (l: unknown, o?: unknown) => Promise<unknown[]> })
          .$transaction([definirTime(cadeia, teamId), ...lote], opcoes)
          .then((resultados) => resultados.slice(1));
      },
    },
  } as never);
}
