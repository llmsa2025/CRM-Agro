import type { PrismaClient } from "@prisma/client";

/**
 * Helper SÓ de teste (F1A-03): o cenário de aceite da fonte única do toque. Sete contatos novos, cada um com uma
 * única Activity de hoje, para provar as duas perguntas separadas:
 * - conta no placar? (só `comprovada`: o único toque de saída com prova);
 * - sai da lista do dia? (`declarada`, `comprovada`, `anotada` saem; `entrada`, `notaComum`, `direcaoNula` e `semNada` ficam).
 * Grava direto no banco, pelo client que o teste passar (o client base: sem passar pelo serviço, para controlar `meta` e
 * `createdAt`). O helper recebe o client por parâmetro de propósito: a lista fechada de `tenancy/base-prisma-lista.test.ts`
 * não deve ganhar mais um arquivo que importa o client sem filtro de time.
 */
export type CenarioDeToques = {
  declarada: string; // ligação de saída sem marcador (o que o caminho manual cria hoje)
  comprovada: string; // ligação de saída com meta.comprovada = true
  entrada: string; // WhatsApp recebido
  anotada: string; // nota com meta.ligacaoForaDoCrmAgro = true
  notaComum: string; // nota sem marcador
  direcaoNula: string; // ligação sem direção (a tarefa de ligar pendente do fluxo)
  semNada: string; // contato sem nenhuma Activity
};

export const QUE_SAEM_DA_LISTA = ["declarada", "comprovada", "anotada"] as const satisfies readonly (keyof CenarioDeToques)[];
export const QUE_FICAM_NA_LISTA = ["entrada", "notaComum", "direcaoNula", "semNada"] as const satisfies readonly (keyof CenarioDeToques)[];

export async function semearToques(prisma: PrismaClient, teamId: string, quando: Date = new Date()): Promise<CenarioDeToques> {
  const novo = async (nome: string) => (await prisma.contact.create({ data: { teamId, nome } })).id;
  const ids: CenarioDeToques = {
    declarada: await novo("Toque declarada"),
    comprovada: await novo("Toque comprovada"),
    entrada: await novo("Toque entrada"),
    anotada: await novo("Toque anotada"),
    notaComum: await novo("Toque nota comum"),
    direcaoNula: await novo("Toque direcao nula"),
    semNada: await novo("Toque sem nada"),
  };
  const base = { teamId, createdAt: quando };
  await prisma.activity.createMany({
    data: [
      { ...base, contactId: ids.declarada, tipo: "call", direcao: "out" },
      { ...base, contactId: ids.comprovada, tipo: "call", direcao: "out", meta: { comprovada: true } },
      { ...base, contactId: ids.entrada, tipo: "whatsapp", direcao: "in" },
      { ...base, contactId: ids.anotada, tipo: "note", meta: { ligacaoForaDoCrmAgro: true } },
      { ...base, contactId: ids.notaComum, tipo: "note" },
      { ...base, contactId: ids.direcaoNula, tipo: "call", direcao: null },
    ],
  });
  return ids;
}

/** Apaga o que `semearToques` criou no time (Activity antes do Contact: a FK é em cascata, mas a ordem deixa claro). */
export async function limparToques(prisma: PrismaClient, teamIds: string[]): Promise<void> {
  const where = { teamId: { in: teamIds } };
  await prisma.activity.deleteMany({ where });
  await prisma.goal.deleteMany({ where });
  await prisma.contact.deleteMany({ where });
}
