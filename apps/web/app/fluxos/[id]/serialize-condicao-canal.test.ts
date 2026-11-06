import { describe, expect, it } from "vitest";
import { CRITERIO_LABELS, criterioLabel, fromFlowNodes, toSnapshotNodes, type BuilderNode } from "./serialize";

describe("condições 'tem WhatsApp' e 'tem e-mail' no construtor", () => {
  it("o rótulo padrão do ramo vem do critério, e o rótulo gerado é reconhecido como automático", () => {
    expect(criterioLabel({ type: "has_whatsapp" })).toBe("Tem WhatsApp");
    expect(criterioLabel({ type: "has_email" })).toBe("Tem e-mail");
    // Sem isto, trocar o critério deixaria o rótulo antigo no ramo, como se o usuário o tivesse escrito.
    expect(CRITERIO_LABELS.has("Tem WhatsApp")).toBe(true);
    expect(CRITERIO_LABELS.has("Tem e-mail")).toBe(true);
  });

  it("salva os dois critérios do jeito que o motor lê", () => {
    const cond: BuilderNode = {
      id: "c",
      type: "flowNode",
      position: { x: 0, y: 0 },
      data: {
        tipo: "condition",
        label: "Canal",
        branches: [
          { id: "w", label: "Tem WhatsApp", condition: { type: "has_whatsapp" }, nextNodeId: "zap" },
          { id: "e", label: "Tem e-mail", condition: { type: "has_email" }, nextNodeId: "mail" },
        ],
        defaultNext: null,
      } as never,
    };
    const [salvo] = toSnapshotNodes([cond]) as Array<{ branches: { branches: Array<{ condition: { type: string } }> } }>;
    expect(salvo!.branches.branches.map((b) => b.condition.type)).toEqual(["has_whatsapp", "has_email"]);
  });
});

describe("'Tem WhatsApp' conferido no WhatsApp no construtor", () => {
  const nodeComRamo = (condition: object): BuilderNode => ({
    id: "c",
    type: "flowNode",
    position: { x: 0, y: 0 },
    data: { tipo: "condition", label: "Canal", branches: [{ id: "w", label: "Tem WhatsApp", condition, nextNodeId: "zap" }], defaultNext: null } as never,
  });
  const condicaoSalva = (condition: object) =>
    (toSnapshotNodes([nodeComRamo(condition)]) as Array<{ branches: { branches: Array<{ condition: object }> } }>)[0]!.branches.branches[0]!.condition;

  it("o rótulo do modo novo diz que foi conferido no WhatsApp, e os dois rótulos contam como automáticos", () => {
    expect(criterioLabel({ type: "has_whatsapp", modo: "verificar" })).toBe("Tem WhatsApp (conferido no WhatsApp)");
    expect(criterioLabel({ type: "has_whatsapp", modo: "cadastro" })).toBe("Tem WhatsApp");
    expect(criterioLabel({ type: "has_whatsapp" })).toBe("Tem WhatsApp");
    // Sem isto, trocar o modo deixaria o rótulo antigo no ramo, como se o usuário o tivesse escrito.
    expect(CRITERIO_LABELS.has("Tem WhatsApp (conferido no WhatsApp)")).toBe(true);
  });

  it("o `modo` sobrevive ao salvar e ao reabrir o fluxo (o save não perde a chave)", () => {
    expect(condicaoSalva({ type: "has_whatsapp", modo: "verificar" })).toEqual({ type: "has_whatsapp", modo: "verificar" });
    const [salvo] = toSnapshotNodes([nodeComRamo({ type: "has_whatsapp", modo: "verificar" })]) as Array<{ id: string; tipo: string; config: unknown; nextNodeId: string | null; branches: unknown }>;
    const [reaberto] = fromFlowNodes([{ id: salvo!.id, tipo: "condition" as never, config: salvo!.config, nextNodeId: salvo!.nextNodeId, branches: salvo!.branches }]);
    expect(reaberto!.data.branches?.[0]?.condition).toEqual({ type: "has_whatsapp", modo: "verificar" });
  });

  it("o modo padrão (cadastro) NÃO é gravado: o fluxo de antes salva o mesmo grafo, sem a chave `modo`", () => {
    expect(condicaoSalva({ type: "has_whatsapp" })).toStrictEqual({ type: "has_whatsapp" });
    expect("modo" in condicaoSalva({ type: "has_whatsapp" })).toBe(false);
  });
});

