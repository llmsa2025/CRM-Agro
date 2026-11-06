import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/calls/[id] (F1A-08): o PATCH é uma LISTA DE PERMISSÃO, só `notes` e `disposition`. Com o serviço trocado por
 * falso (a regra de verdade, com banco, está em packages/core/src/calls/service.test.ts e seguranca/dois-usuarios.test.ts):
 *  - qualquer campo do provedor (status, duração, gravação, transcrição, resumo) dá 400 e o serviço nem é chamado;
 *  - corpo vazio, ilegível ou que não é objeto também dá 400;
 *  - o corpo bom chega ao serviço só com `notes` e `disposition`;
 *  - sem sessão é 401 e ligação que não é da pessoa (ou do time) é 404.
 * O schema é o de verdade (o arquivo do core, que só depende do zod).
 */
const h = vi.hoisted(() => {
  class CallNotFound extends Error {
    constructor(id: string) {
      super(`CallNotFound: nenhuma ligação com id ${id} neste time.`);
      this.name = "CallNotFound";
    }
  }
  return {
    CallNotFound,
    anotar: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: "ligacao-1" })),
    buscar: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: "ligacao-1" })),
    usuario: vi.fn(async (): Promise<unknown> => ({ id: "u1", teamId: "t1", role: "member" })),
  };
});

vi.mock("@crmagro/db", () => ({ runWithTeam: (_teamId: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/tenant", () => ({ currentUser: () => h.usuario(), identidade: () => ({ userId: "u1", role: "member" }) }));
vi.mock("@crmagro/core", async () => {
  const { anotarLigacaoApiSchema } = await import("../../../../../../packages/core/src/calls/schema");
  return {
    anotarLigacaoApiSchema,
    anotarCamposDaLigacao: (...a: unknown[]) => h.anotar(...a),
    getCall: (...a: unknown[]) => h.buscar(...a),
  };
});

const rota = await import("./route");

const ID = "00000000-0000-0000-0000-0000000000c1";
const ctx = { params: Promise.resolve({ id: ID }) };
const patch = (corpo: unknown, bruto = false) =>
  rota.PATCH(
    new Request(`https://app.crmagro.example/api/calls/${ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: bruto ? String(corpo) : JSON.stringify(corpo),
    }),
    ctx,
  );

beforeEach(() => {
  h.anotar.mockClear();
  h.buscar.mockClear();
  h.usuario.mockImplementation(async () => ({ id: "u1", teamId: "t1", role: "member" }));
});

describe("PATCH /api/calls/[id]", () => {
  it("só exporta GET e PATCH (não há PUT, POST nem DELETE)", () => {
    expect(Object.keys(rota).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k)).sort()).toEqual(["GET", "PATCH"]);
  });

  it("notes e disposition chegam ao serviço com o id da rota, e a resposta é a ligação", async () => {
    const r = await patch({ notes: "  bom lead ", disposition: "interested" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: "ligacao-1" });
    expect(h.anotar).toHaveBeenCalledTimes(1);
    expect(h.anotar).toHaveBeenCalledWith(ID, { notes: "bom lead", disposition: "interested" });
  });

  it("só notes: o serviço recebe só notes", async () => {
    await patch({ notes: "ligar amanhã" });
    expect(h.anotar).toHaveBeenCalledWith(ID, { notes: "ligar amanhã" });
  });

  it.each([
    ["status", "completed"],
    ["durationSeconds", 120],
    ["recordingUrl", "https://gravacao.exemplo.invalid/a.mp3"],
    ["transcript", "texto"],
    ["summary", "resumo"],
    ["startedAt", "2032-05-01T10:00:00Z"],
    ["outcome", "answered"],
    ["providerCallId", "prov-1"],
  ])("%s dá 400 e o serviço não é chamado (nada muda)", async (campo, valor) => {
    const so = await patch({ [campo]: valor });
    expect(so.status).toBe(400);
    expect((await so.json()).error).toBe("ValidationError");
    // Mesmo acompanhado de um campo permitido, nada é aplicado pela metade.
    const junto = await patch({ notes: "ok", [campo]: valor });
    expect(junto.status).toBe(400);
    expect(h.anotar).not.toHaveBeenCalled();
  });

  it("corpo vazio, ilegível, nulo ou que não é objeto dá 400", async () => {
    expect((await patch({})).status).toBe(400);
    expect((await patch("isto não é json", true)).status).toBe(400);
    expect((await patch(null)).status).toBe(400);
    expect((await patch([])).status).toBe(400);
    expect((await patch({ notes: 5 })).status).toBe(400);
    expect(h.anotar).not.toHaveBeenCalled();
  });

  it("sem sessão é 401 e o serviço não é chamado", async () => {
    h.usuario.mockImplementation(async () => null);
    const r = await patch({ notes: "x" });
    expect(r.status).toBe(401);
    expect(h.anotar).not.toHaveBeenCalled();
  });

  it("ligação de outro vendedor ou de outro time é 404 (a mesma resposta de 'não existe')", async () => {
    h.anotar.mockImplementationOnce(async () => {
      throw new h.CallNotFound(ID);
    });
    const r = await patch({ notes: "x" });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("CallNotFound");
  });
});
