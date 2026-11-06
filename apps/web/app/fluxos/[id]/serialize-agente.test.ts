import { describe, expect, it } from "vitest";
import { defaultNodeData, fromFlowNodes, toSnapshotNodes, type BuilderNode } from "./serialize";

const noDoBuilder = (data: ReturnType<typeof defaultNodeData>): BuilderNode => ({ id: "n1", type: "ai_agent", position: { x: 0, y: 0 }, data });

/** O que o editor salva vira o que ele lê de volta (como a página do fluxo faz). */
function ida_e_volta(node: BuilderNode) {
  const [salvo] = toSnapshotNodes([node]) as Array<{ id: string; tipo: string; config: Record<string, unknown>; nextNodeId: string | null }>;
  const lido = fromFlowNodes([{ id: salvo!.id, tipo: "ai_agent" as never, config: salvo!.config, nextNodeId: null, branches: null, posX: 0, posY: 0 }]);
  return { salvo: salvo!, lido: lido[0]!.data };
}

describe("nó Agente IA no editor", () => {
  it("nó novo nasce conversando e sem orientação", () => {
    const d = defaultNodeData("ai_agent");
    expect(d).toMatchObject({ aiModo: "conversa", orientacao: "" });
  });

  it("conversa: salva e lê de volta todos os campos", () => {
    const d = {
      ...defaultNodeData("ai_agent"),
      aiModo: "conversa" as const,
      orientacao: "Apresente o adubo e proponha 15 minutos.",
      tom: "consultivo",
      maxRespostas: 8,
      silencioHoras: 48,
      avisarVendedor: false,
    };
    const { salvo, lido } = ida_e_volta(noDoBuilder(d));
    expect(salvo.config).toMatchObject({
      modo: "conversa",
      canal: "whatsapp",
      orientacao: "Apresente o adubo e proponha 15 minutos.",
      tom: "consultivo",
      maxRespostas: 8,
      silencioHoras: 48,
      avisarVendedor: false,
    });
    expect(lido).toMatchObject({ aiModo: "conversa", orientacao: d.orientacao, maxRespostas: 8, silencioHoras: 48, avisarVendedor: false });
  });

  it("avisar o vendedor é o padrão: só grava quando a pessoa desliga", () => {
    const { salvo, lido } = ida_e_volta(noDoBuilder({ ...defaultNodeData("ai_agent"), orientacao: "x" }));
    expect(salvo.config).not.toHaveProperty("avisarVendedor");
    expect(lido.avisarVendedor).toBe(true);
  });

  it("trocar de modo e salvar guarda os dois grupos de campos", () => {
    const d = { ...defaultNodeData("ai_agent"), aiModo: "mensagem" as const, orientacao: "guardada", objetivo: "apresentar", aiFallbackText: "Oi!" };
    const { salvo } = ida_e_volta(noDoBuilder(d));
    expect(salvo.config).toMatchObject({ modo: "mensagem", orientacao: "guardada", objetivo: "apresentar", fallbackText: "Oi!" });
  });

  it("fluxo antigo (sem `modo`) lê como 'mensagem'", () => {
    const [n] = fromFlowNodes([{ id: "a", tipo: "ai_agent" as never, config: { canal: "whatsapp", objetivo: "apresentar" }, nextNodeId: null, branches: null, posX: 0, posY: 0 }]);
    expect(n!.data).toMatchObject({ aiModo: "mensagem", objetivo: "apresentar", orientacao: "" });
  });
});
