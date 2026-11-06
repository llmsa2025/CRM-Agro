import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

/**
 * CATRACA da unificação de contatos (F1A-01). Estática, sem banco.
 *
 * `mergeContacts` apaga o duplicado no fim, e toda FK para `Contact` do schema é `Cascade` ou `SetNull`. Um model
 * que aponta para o contato e que ninguém lembrou de mover some junto (a Call, com a prova do provedor, sumia
 * assim) ou perde o contato em silêncio (compromisso e convite). Aqui, todo model com FK para `Contact` precisa
 * estar num mapa, em uma de três categorias:
 *
 * - "move": o passo 2 de `mergeContacts` o move (`tx.<model>.update`/`updateMany`, trocando o `contactId`), com dedup
 *   quando há índice único; `delete` sozinho não conta como mover (apagar a prova era o defeito original);
 * - "a parte": tem tratamento próprio, num arquivo e numa função que `mergeContacts` chama;
 * - "apaga junto": some de propósito com o duplicado, e o motivo fica escrito aqui.
 *
 * Model novo com FK para `Contact` quebra o teste até alguém classificá-lo. É pela FORMA do schema e do código:
 * pega o esquecimento, não prova o comportamento (isso é do `merge-fluxo.test.ts`, com banco).
 */

type Classe =
  | { categoria: "move" }
  | { categoria: "a parte"; arquivo: string; funcao: string }
  | { categoria: "apaga junto"; motivo: string };

const RELACOES: Record<string, Classe> = {
  Activity: { categoria: "move" },
  Deal: { categoria: "move" },
  Enrollment: { categoria: "move" },
  ChannelIdentifier: { categoria: "move" },
  ContactTag: { categoria: "move" },
  Call: { categoria: "move" },
  Appointment: { categoria: "move" },
  AppointmentAttendee: { categoria: "move" },
  ContactCompany: { categoria: "move" },
  // Passo 3: a mesclagem tem transação própria (índice único conta + contato).
  Conversation: { categoria: "a parte", arquivo: "conversations/vinculo.ts", funcao: "vincularConversaAoContato" },
  // Passo 4: segue a pessoa para não apagar o histórico de envio nem o "pediu para sair".
  CampaignRecipient: { categoria: "a parte", arquivo: "campaigns/unificar.ts", funcao: "moverDestinatariosDeCampanha" },
};

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const lerService = () => readFileSync(join(SRC, "contacts", "service.ts"), "utf8");

/** Models do schema que têm uma FK para `Contact` (quem carrega a coluna, não o lado inverso). */
function modelosComFkParaContact(): string[] {
  return Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.kind === "object" && f.type === "Contact" && (f.relationFromFields?.length ?? 0) > 0))
    .map((m) => m.name)
    .sort();
}

/** Texto da função `mergeContacts`, sem os comentários (um comentário não conta como mover). */
export function corpoDoMerge(fonte: string): string {
  const ini = fonte.indexOf("export async function mergeContacts");
  if (ini < 0) return "";
  const resto = fonte.slice(ini);
  // A função termina na primeira chave de fechamento na coluna 0.
  const fim = resto.search(/\n}\n/);
  const corpo = fim < 0 ? resto : resto.slice(0, fim + 2);
  return corpo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const primeiraMinuscula = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * O corpo do merge MOVE `tx.<model>` (update ou updateMany)? `delete` não conta: trocar o `updateMany` por um
 * `delete` voltaria a apagar a prova e a catraca não pode ficar verde nesse caso. O dedup (tags, identificadores,
 * empresas) apaga o repetido, mas sempre move o restante com `update`.
 */
export function moveNaTransacao(corpo: string, model: string): boolean {
  return new RegExp(`\\btx\\.${primeiraMinuscula(model)}\\.(update|updateMany)\\s*\\(`).test(corpo);
}

describe("unificar contatos: toda relação com Contact está classificada", () => {
  it("todo model com FK para Contact está no mapa (model novo quebra até ser classificado)", () => {
    const faltando = modelosComFkParaContact().filter((m) => !(m in RELACOES));
    expect(
      faltando,
      `Model com FK para Contact sem classificação: ${faltando.join(", ")}. Em contacts/service.ts, mergeContacts apaga o ` +
        "duplicado no fim e a FK é Cascade ou SetNull. Mova o model no passo 2, dê um tratamento próprio ou " +
        "declare aqui que ele some junto, com o motivo.",
    ).toEqual([]);
  });

  it("o mapa não guarda model que deixou de existir ou de apontar para Contact", () => {
    const reais = new Set(modelosComFkParaContact());
    expect(Object.keys(RELACOES).filter((m) => !reais.has(m))).toEqual([]);
  });

  it("'move': o passo 2 de mergeContacts mexe mesmo no model", () => {
    const corpo = corpoDoMerge(lerService());
    expect(corpo.length).toBeGreaterThan(500); // achou a função
    const semMover = Object.entries(RELACOES)
      .filter(([, c]) => c.categoria === "move")
      .map(([m]) => m)
      .filter((m) => !moveNaTransacao(corpo, m));
    expect(semMover, `Classificados como "move", mas mergeContacts não move com tx.<model>.update/updateMany: ${semMover.join(", ")}`).toEqual([]);
  });

  it("'a parte': o arquivo existe, exporta a função e mergeContacts a chama", () => {
    const corpo = corpoDoMerge(lerService());
    for (const [model, c] of Object.entries(RELACOES)) {
      if (c.categoria !== "a parte") continue;
      const caminho = join(SRC, c.arquivo);
      expect(existsSync(caminho), `${model}: ${c.arquivo} não existe`).toBe(true);
      expect(readFileSync(caminho, "utf8"), `${model}: ${c.arquivo} não exporta ${c.funcao}`).toMatch(
        new RegExp(`export\\s+(async\\s+)?function\\s+${c.funcao}\\b`),
      );
      expect(corpo, `${model}: mergeContacts não chama ${c.funcao}`).toMatch(new RegExp(`\\b${c.funcao}\\s*\\(`));
    }
  });

  it("'apaga junto': traz o motivo escrito", () => {
    for (const [model, c] of Object.entries(RELACOES)) {
      if (c.categoria === "apaga junto") expect(c.motivo.trim().length, `${model} sem motivo`).toBeGreaterThan(10);
    }
  });
});

describe("auto-teste da catraca", () => {
  const fonte = `
export async function mergeContacts(a: string) {
  // tx.call.updateMany(...)  <- comentário não conta
  await prisma.$transaction(async (tx) => {
    await tx.activity.updateMany({});
    await tx.contactTag.update({});
    await tx.deal.deleteMany({});
    await tx.enrollment.delete({});
  });
}
export function outra() { return tx.deal.updateMany({}); }
`;
  it("lê só o corpo de mergeContacts e ignora comentário", () => {
    const corpo = corpoDoMerge(fonte);
    expect(moveNaTransacao(corpo, "Activity")).toBe(true);
    expect(moveNaTransacao(corpo, "ContactTag")).toBe(true);
    expect(moveNaTransacao(corpo, "Call")).toBe(false); // só em comentário
    expect(moveNaTransacao(corpo, "Deal")).toBe(false); // só apaga, não move (e em outra função há um updateMany)
    expect(moveNaTransacao(corpo, "Enrollment")).toBe(false); // delete sozinho não conta como mover
  });

  it("a leitura do DMMF não ficou vazia (senão a catraca passaria sem olhar nada)", () => {
    expect(modelosComFkParaContact().length).toBeGreaterThan(0);
  });
});
