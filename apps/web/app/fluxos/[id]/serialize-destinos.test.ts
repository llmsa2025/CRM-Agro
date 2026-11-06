import { describe, expect, it } from "vitest";
import { deriveEdges, toSnapshotNodes, type BuilderNode } from "./serialize";

const no = (id: string, y: number, data: object): BuilderNode => ({ id, type: "flowNode", position: { x: 0, y }, data: { tipo: "wait", label: id, ...data } as never });

describe("condição com vários destinos no construtor", () => {
  const cond = no("c", 0, {
    tipo: "condition",
    branches: [{ id: "b1", label: "Sim", condition: { type: "channel_history", canal: "whatsapp" }, nextNodeId: "reg", maisDestinos: ["enr", "nome"] }],
    defaultNext: "enr",
    defaultMais: [],
  });
  const nos = [cond, no("reg", 100, { tipo: "save_history" }), no("nome", 200, { tipo: "sync_name" }), no("enr", 300, { tipo: "enrich_data" })];

  it("salva os destinos da saída na ordem do mapa (de cima para baixo)", () => {
    const [c] = toSnapshotNodes(nos) as Array<{ branches: { branches: Array<{ nextNodeId: string; maisDestinos?: string[] }>; default: string | null; defaultMais?: string[] } }>;
    expect(c!.branches.branches[0]).toMatchObject({ nextNodeId: "reg", maisDestinos: ["nome", "enr"] });
    expect(c!.branches.default).toBe("enr");
    expect(c!.branches.defaultMais).toBeUndefined();
  });

  it("desenha uma seta por destino; só a do principal tem o id simples", () => {
    const ids = deriveEdges(nos).filter((e) => e.source === "c").map((e) => [e.id, e.target]);
    expect(ids).toEqual([
      ["e_c_b1", "reg"],
      ["e_c_b1~enr", "enr"],
      ["e_c_b1~nome", "nome"],
      ["e_c_default", "enr"],
    ]);
  });

  it("o passo Enriquecer dados vai para o snapshot", () => {
    const enr = (toSnapshotNodes(nos) as Array<{ id: string; tipo: string }>).find((n) => n.id === "enr");
    expect(enr).toMatchObject({ tipo: "enrich_data", config: {}, nextNodeId: null });
  });
});
