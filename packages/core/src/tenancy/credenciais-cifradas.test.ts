import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { CredentialsUnknownOperationError, MODELOS_COM_CREDENTIALS_CIFRADAS, TENANT_KNOWN_OPERATIONS, aplicarCifraDeCredentials, estaCifrado } from "@crmagro/db";

/**
 * Catraca das credenciais cifradas (F1B-05). Model novo com coluna `credentials` precisa de uma decisão
 * consciente, para a senha de um provedor nunca ir ao banco em texto puro por esquecimento:
 *  1) ou entra na cifra do client (`MODELOS_COM_CREDENTIALS_CIFRADAS`, packages/db/src/client.ts),
 *  2) ou entra em `JA_TRATADOS_FORA_DA_EXTENSAO`, com o motivo;
 *  e todos eles são recifrados na rotação de chaves (packages/db/scripts/recifrar-credenciais.ts).
 */

const JA_TRATADOS_FORA_DA_EXTENSAO: Record<string, string> = {
  ChannelAccount: "guarda só identificadores não secretos (instance, number); o segredo fica em env",
  OAuthConnection: "cifra à mão em agenda/google/conexao.ts",
  OAuthRevogacaoPendente: "cifra à mão em agenda/google/conexao.ts",
};

const comoNomeDoModel = (clientName: string) => clientName[0]!.toUpperCase() + clientName.slice(1);
const comoNomeNoClient = (model: string) => model[0]!.toLowerCase() + model.slice(1);

describe("credenciais cifradas", () => {
  const comCredentials = Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === "credentials")).map((m) => m.name);
  const cifradosPelaExtensao = MODELOS_COM_CREDENTIALS_CIFRADAS.map(comoNomeDoModel);

  it("todo model com a coluna credentials está na cifra do client ou na lista de tratados com motivo", () => {
    const sem = comCredentials.filter((m) => !cifradosPelaExtensao.includes(m) && !(m in JA_TRATADOS_FORA_DA_EXTENSAO));
    expect(sem, "model novo com `credentials`: cifre no client (MODELOS_COM_CREDENTIALS_CIFRADAS) ou explique aqui").toEqual([]);
  });

  it("a cifra do client só lista models que existem e têm credentials", () => {
    expect(cifradosPelaExtensao.filter((m) => !comCredentials.includes(m))).toEqual([]);
    // O que a F1B-05 acrescentou: a linha de ligação passa pela mesma cifra da Integration.
    expect(cifradosPelaExtensao).toEqual(expect.arrayContaining(["Integration", "LinhaDeLigacao"]));
  });

  it("todo model com credentials é recifrado pelo script de rotação de chaves", () => {
    const script = readFileSync(fileURLToPath(new URL("../../../db/scripts/recifrar-credenciais.ts", import.meta.url)), "utf8");
    const faltam = comCredentials.filter((m) => !script.includes(`basePrisma.${comoNomeNoClient(m)}.findMany`));
    expect(faltam, "sem isto, a rotação deixaria essas credenciais ilegíveis").toEqual([]);
  });
});

/**
 * A cifra olha a OPERAÇÃO, não só o model. Operação fora das listas gravava a senha em texto puro
 * (`updateManyAndReturn`) ou devolvia o envelope cifrado como se fosse a credencial (`findFirstOrThrow`,
 * `findUniqueOrThrow`, `delete`). Aqui passa por todas as operações que a extensão de tenancy conhece, sem banco.
 */
describe("a cifra de credentials trata toda operação do Prisma", () => {
  const SEGREDO = "SEGREDO-EM-CLARO-123456";
  const ESCRITAS = ["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert"];
  const LEITURAS = ["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "delete"];
  const SEM_REGISTRO = ["deleteMany", "count", "aggregate", "groupBy"];

  it("toda operação que a tenancy conhece é tratada aqui (nenhuma cai como desconhecida)", async () => {
    const naoTratadas: string[] = [];
    for (const op of TENANT_KNOWN_OPERATIONS) {
      const args = { where: {}, data: {}, create: {}, update: {} };
      await aplicarCifraDeCredentials("linhaDeLigacao", op, args, async () => ({ count: 0 })).catch(() => naoTratadas.push(op));
    }
    expect(naoTratadas, "operação nova na tenancy: ensine-a à cifra de credentials (packages/db/src/client.ts)").toEqual([]);
    expect([...ESCRITAS, ...LEITURAS, ...SEM_REGISTRO].sort()).toEqual([...TENANT_KNOWN_OPERATIONS].sort());
  });

  it("toda escrita cifra o credentials antes de chegar ao banco", async () => {
    for (const op of ESCRITAS) {
      const comSegredo = () => ({ credentials: { senhaDoRamal: SEGREDO } });
      const args: Record<string, unknown> =
        op === "upsert"
          ? { where: { id: "x" }, create: comSegredo(), update: comSegredo() }
          : op === "createMany" || op === "createManyAndReturn"
            ? { data: [comSegredo(), comSegredo()] }
            : { where: { id: "x" }, data: comSegredo() };
      let chegou: unknown;
      await aplicarCifraDeCredentials("linhaDeLigacao", op, args, async (a) => {
        chegou = a;
        return { count: 1 };
      });
      expect(JSON.stringify(chegou), `${op} levou a senha em texto puro ao banco`).not.toContain(SEGREDO);
      const dados = chegou as Record<string, unknown>;
      const gravados = op === "upsert" ? [dados.create, dados.update] : Array.isArray(dados.data) ? dados.data : [dados.data];
      for (const g of gravados) expect(estaCifrado((g as { credentials: unknown }).credentials), op).toBe(true);
    }
  });

  it("toda leitura que devolve o registro abre o credentials (um registro ou uma lista)", async () => {
    // Um envelope que o próprio serviço gravaria: passa pela escrita para obter o cifrado.
    let envelope: unknown;
    await aplicarCifraDeCredentials("linhaDeLigacao", "create", { data: { credentials: { senhaDoRamal: SEGREDO } } }, async (a) => {
      envelope = (a as { data: { credentials: unknown } }).data.credentials;
      return null;
    });
    expect(estaCifrado(envelope)).toBe(true);
    for (const op of [...LEITURAS, "updateManyAndReturn", "createManyAndReturn", "create", "update", "upsert", "updateMany"]) {
      const um = await aplicarCifraDeCredentials("linhaDeLigacao", op, { where: {}, data: {}, create: {}, update: {} }, async () => ({ id: "1", credentials: envelope }));
      expect((um as { credentials: unknown }).credentials, op).toEqual({ senhaDoRamal: SEGREDO });
      const varios = await aplicarCifraDeCredentials("linhaDeLigacao", op, { where: {}, data: {}, create: {}, update: {} }, async () => [{ id: "1", credentials: envelope }]);
      expect((varios as { credentials: unknown }[])[0]!.credentials, op).toEqual({ senhaDoRamal: SEGREDO });
    }
  });

  it("operação que ninguém ensinou à cifra é recusada, em vez de passar sem cifrar", async () => {
    await expect(aplicarCifraDeCredentials("integration", "operacaoNova", {}, async () => null)).rejects.toBeInstanceOf(CredentialsUnknownOperationError);
  });
});
