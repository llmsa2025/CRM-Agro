import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";

const evolution = vi.hoisted(() => ({ url: vi.fn(), baixar: vi.fn() }));
vi.mock("@crmagro/channels", async (orig) => ({
  ...(await orig<typeof import("@crmagro/channels")>()),
  fetchEvolutionProfilePictureUrl: evolution.url,
  baixarFotoDePerfil: evolution.baixar,
}));

/** Redis em memória: só os comandos que o lote usa. Nada aqui encosta no Redis de verdade. */
const redisFalso = vi.hoisted(() => {
  const dados = new Map<string, Map<string, string>>();
  const conjuntos = new Map<string, Set<string>>();
  const chaves = new Map<string, string>();
  const hash = (k: string) => {
    if (!dados.has(k)) dados.set(k, new Map());
    return dados.get(k)!;
  };
  const cliente = {
    hgetall: async (k: string) => Object.fromEntries(dados.get(k) ?? []),
    hset: async (k: string, a: string | Record<string, string | number>, b?: string) => {
      const h = hash(k);
      if (typeof a === "string") h.set(a, String(b));
      else for (const [c, v] of Object.entries(a)) h.set(c, String(v));
      return 1;
    },
    hincrby: async (k: string, c: string, n: number) => {
      const h = hash(k);
      const v = Number(h.get(c) ?? 0) + n;
      h.set(c, String(v));
      return v;
    },
    sadd: async (k: string, m: string) => {
      const s = conjuntos.get(k) ?? new Set<string>();
      conjuntos.set(k, s);
      if (s.has(m)) return 0;
      s.add(m);
      return 1;
    },
    set: async (k: string, v: string, ...resto: unknown[]) => {
      if (resto.includes("NX") && chaves.has(k)) return null;
      chaves.set(k, v);
      return "OK";
    },
    del: async (...ks: string[]) => {
      for (const k of ks) {
        dados.delete(k);
        conjuntos.delete(k);
        chaves.delete(k);
      }
      return ks.length;
    },
    expire: async () => 1,
    multi: () => {
      const fila: (() => Promise<unknown>)[] = [];
      const m = {
        hincrby: (k: string, c: string, n: number) => (fila.push(() => cliente.hincrby(k, c, n)), m),
        expire: () => (fila.push(async () => 1), m),
        exec: async () => Promise.all(fila.map((f) => f())),
      };
      return m;
    },
  };
  return {
    cliente,
    zerar: () => {
      dados.clear();
      conjuntos.clear();
      chaves.clear();
    },
  };
});
vi.mock("../shared/redis-cache", () => ({ redisEstado: () => redisFalso.cliente, redisCache: () => redisFalso.cliente }));

const fila = vi.hoisted(() => ({ enfileirar: vi.fn() }));
vi.mock("./fila", () => ({ AGRO_QUEUE: "agro", AGRO_TENTATIVAS: 3, enfileirarBlocosAgro: fila.enfileirar }));

import { runWithTeam } from "../test-support/identidade";
import { ForbiddenError } from "../auth/authz";
import {
  AgroLoteEmAndamento,
  AgroLoteVazio,
  andamentoDaVerificacaoAgro,
  cancelarVerificacaoAgro,
  fecharBlocoAgroComFalha,
  iniciarVerificacaoAgro,
  processarBlocoAgro,
} from "./lote";
import type { BlocoAgro } from "./fila";
import { ajustarAgroManual } from "./service";

const TEAM = "00000000-0000-0000-0000-0000000a9205";
const ANA = "00000000-0000-0000-0000-0000000a92a1";
const BIA = "00000000-0000-0000-0000-0000000a92a2";
const NUMERO = "+5566999887766";
const adm = { userId: "adm", role: "admin" };
const sistema = { userId: "system", role: "system" };

const como = <T>(fn: () => Promise<T>, id: { userId: string; role: string } = adm) => runWithTeam(TEAM, fn, id);
const semRespiro = async () => {};

let fazenda: string;
let comum: string;
let manual: string;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Agro lote (test)" } });
  for (const [id, email] of [
    [ANA, "ana-agro-lote@teste.local"],
    [BIA, "bia-agro-lote@teste.local"],
  ] as const) {
    await basePrisma.user.upsert({ where: { id }, update: { teamId: TEAM }, create: { id, teamId: TEAM, name: "Membro", email, role: "member" } });
  }
});

beforeEach(async () => {
  redisFalso.zerar();
  fila.enfileirar.mockReset();
  evolution.url.mockReset();
  evolution.baixar.mockReset();
  await basePrisma.conversation.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.contactCompany.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.company.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.channelIdentifier.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.channelAccount.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.contact.deleteMany({ where: { teamId: TEAM } });

  await basePrisma.channelAccount.create({
    data: { teamId: TEAM, canal: "whatsapp", label: "WhatsApp (teste)", provider: "evolution", externalId: "agro-lote-instancia", status: "connected" },
  });
  const novo = async (nome: string, sobrenome: string, ownerId: string | null, numero?: string) => {
    const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome, sobrenome, ownerId } });
    if (numero) await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: c.id, canal: "whatsapp", valor: numero, isPrimary: true } });
    return c.id;
  };
  fazenda = await novo("Fazenda", "Santa Maria", ANA, NUMERO);
  comum = await novo("Carlos", "Souza", ANA, "+5566999880000");
  manual = await novo("Pedro", "Lima", BIA);
});

const lerContato = (id: string) => basePrisma.contact.findUniqueOrThrow({ where: { id } });
const blocosEnfileirados = (): BlocoAgro[] => fila.enfileirar.mock.calls.flatMap((c) => c[0] as BlocoAgro[]);
const bloco = (fase: BlocoAgro["fase"], loteId: string, ids: string[], indice = 0): BlocoAgro => ({ teamId: TEAM, loteId, fase, indice, ids });

describe("iniciarVerificacaoAgro", () => {
  it("cria o lote e enfileira as duas rodadas, cadastro e foto", async () => {
    const r = await como(() => iniciarVerificacaoAgro([fazenda, comum, manual]));
    expect(r.total).toBe(3);

    const blocos = blocosEnfileirados();
    expect(blocos.map((b) => b.fase)).toEqual(["cadastro", "foto"]);
    expect(blocos[0]!.ids).toEqual([fazenda, comum, manual]);

    const a = await como(() => andamentoDaVerificacaoAgro());
    expect(a).toMatchObject({ estado: "andando", total: 3, cadastro: 0, fotos: 0, falhas: 0 });
  });

  it("parte a lista em blocos de 200", async () => {
    const ids = Array.from({ length: 450 }, () => crypto.randomUUID());
    await basePrisma.contact.createMany({ data: ids.map((id) => ({ id, teamId: TEAM, nome: "Lote", ownerId: ANA })) });
    await como(() => iniciarVerificacaoAgro(ids));
    const cadastro = blocosEnfileirados().filter((b) => b.fase === "cadastro");
    expect(cadastro.map((b) => b.ids.length)).toEqual([200, 200, 50]);
    expect(cadastro.map((b) => b.indice)).toEqual([0, 1, 2]);
  });

  it("só entram os contatos que a pessoa pode alterar (membro: os dele)", async () => {
    const r = await como(() => iniciarVerificacaoAgro([fazenda, comum, manual]), { userId: ANA, role: "member" });
    expect(r.total).toBe(2); // o Pedro é da Bia
    expect(blocosEnfileirados()[0]!.ids.sort()).toEqual([fazenda, comum].sort());
  });

  it("sem nada que possa alterar, recusa", async () => {
    await expect(como(() => iniciarVerificacaoAgro([manual]), { userId: ANA, role: "member" })).rejects.toBeInstanceOf(AgroLoteVazio);
    await expect(como(() => iniciarVerificacaoAgro([]))).rejects.toBeInstanceOf(AgroLoteVazio);
  });

  it("quem só lê não começa lote", async () => {
    await expect(como(() => iniciarVerificacaoAgro([fazenda]), { userId: "leitor", role: "viewer" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("um lote por vez", async () => {
    await como(() => iniciarVerificacaoAgro([fazenda]));
    await expect(como(() => iniciarVerificacaoAgro([comum]))).rejects.toBeInstanceOf(AgroLoteEmAndamento);
  });

  it("se a fila não aceita, não deixa lote 'andando' para trás", async () => {
    fila.enfileirar.mockRejectedValueOnce(new Error("redis fora"));
    await expect(como(() => iniciarVerificacaoAgro([fazenda]))).rejects.toThrow("redis fora");
    expect(await como(() => andamentoDaVerificacaoAgro())).toBeNull();
    await expect(como(() => iniciarVerificacaoAgro([fazenda]))).resolves.toMatchObject({ total: 1 });
  });
});

describe("processarBlocoAgro", () => {
  async function comecar(ids = [fazenda, comum, manual]) {
    await como(() => iniciarVerificacaoAgro(ids));
    return (await como(() => andamentoDaVerificacaoAgro()))!.loteId;
  }

  it("rodada do cadastro: classifica pelo nome, sem falar com o WhatsApp", async () => {
    const lote = await comecar();
    const r = await como(() => processarBlocoAgro(bloco("cadastro", lote, [fazenda, comum, manual]), { dormir: semRespiro }), sistema);

    expect(r).toBe("feito");
    expect(evolution.url).not.toHaveBeenCalled();
    expect((await lerContato(fazenda)).agroTipos).toEqual(["fazenda"]);
    expect((await lerContato(comum)).agroTipos).toEqual([]);
    expect(await como(() => andamentoDaVerificacaoAgro())).toMatchObject({ estado: "andando", cadastro: 3, fotos: 0 });
  });

  it("rodada da foto: procura a foto de quem nunca teve, dá respiro e conta as que vão para o Claude", async () => {
    const lote = await comecar([fazenda, comum]);
    await como(() => processarBlocoAgro(bloco("cadastro", lote, [fazenda, comum]), { dormir: semRespiro }), sistema);
    evolution.url.mockImplementation(async (a: { numero: string }) => (a.numero === NUMERO ? "https://pps.whatsapp.net/foto.jpg" : null));
    const dormir = vi.fn(async () => {});

    await como(() => processarBlocoAgro(bloco("foto", lote, [fazenda, comum]), { dormir }), sistema);

    expect(evolution.url).toHaveBeenCalledTimes(2);
    expect(dormir).toHaveBeenCalledTimes(2);
    const a = await como(() => andamentoDaVerificacaoAgro());
    expect(a).toMatchObject({ estado: "concluido", cadastro: 2, fotos: 2, naFila: 1 });
  });

  it("a rodada da foto não pergunta de novo a quem já teve a foto olhada", async () => {
    const lote = await comecar([fazenda]);
    await como(() => processarBlocoAgro(bloco("cadastro", lote, [fazenda]), { dormir: semRespiro }), sistema);
    evolution.url.mockResolvedValue("https://pps.whatsapp.net/foto.jpg");
    await como(() => processarBlocoAgro(bloco("foto", lote, [fazenda]), { dormir: semRespiro }), sistema);
    expect(evolution.url).toHaveBeenCalledTimes(1);

    // Novo lote sobre o mesmo contato: a foto já está na fila, o WhatsApp não é consultado de novo.
    const outro = await comecar([fazenda]);
    const dormir = vi.fn(async () => {});
    await como(() => processarBlocoAgro(bloco("foto", outro, [fazenda]), { dormir }), sistema);
    expect(evolution.url).toHaveBeenCalledTimes(1);
    expect(dormir).not.toHaveBeenCalled();
  });

  it("o mesmo bloco rodado de novo (tentativa) não conta duas vezes", async () => {
    const lote = await comecar([fazenda, comum]);
    const b = bloco("cadastro", lote, [fazenda, comum]);
    await como(() => processarBlocoAgro(b, { dormir: semRespiro }), sistema);
    await como(() => processarBlocoAgro(b, { dormir: semRespiro }), sistema);
    expect(await como(() => andamentoDaVerificacaoAgro())).toMatchObject({ cadastro: 2 });
  });

  it("contato ajustado à mão é respeitado e contado", async () => {
    await como(() => ajustarAgroManual(manual, ["transportadora"]));
    const lote = await comecar([manual]);
    await como(() => processarBlocoAgro(bloco("cadastro", lote, [manual]), { dormir: semRespiro }), sistema);
    expect((await lerContato(manual)).agroTipos).toEqual(["transportadora"]);
    expect(await como(() => andamentoDaVerificacaoAgro())).toMatchObject({ manuais: 1 });
  });

  it("contato que sumiu no meio conta como falha e o bloco segue", async () => {
    const lote = await comecar([fazenda, comum]);
    await basePrisma.contact.delete({ where: { id: comum } });
    await como(() => processarBlocoAgro(bloco("cadastro", lote, [fazenda, comum]), { dormir: semRespiro }), sistema);
    expect(await como(() => andamentoDaVerificacaoAgro())).toMatchObject({ cadastro: 2, falhas: 1 });
    expect((await lerContato(fazenda)).agroTipos).toEqual(["fazenda"]);
  });

  it("bloco de lote velho é pulado", async () => {
    await comecar();
    const r = await como(() => processarBlocoAgro(bloco("cadastro", "outro-lote", [fazenda]), { dormir: semRespiro }), sistema);
    expect(r).toBe("obsoleto");
    expect((await lerContato(fazenda)).agroTipos).toEqual([]);
  });

  it("bloco que esgotou as tentativas conta como falha e deixa o lote terminar", async () => {
    const lote = await comecar([fazenda, comum]);
    await como(() => processarBlocoAgro(bloco("cadastro", lote, [fazenda, comum]), { dormir: semRespiro }), sistema);
    await como(() => fecharBlocoAgroComFalha(bloco("foto", lote, [fazenda, comum])), sistema);
    expect(await como(() => andamentoDaVerificacaoAgro())).toMatchObject({ estado: "concluido", falhas: 2 });
  });
});

describe("cancelar e recomeçar", () => {
  it("cancelado, os blocos que faltam são pulados e o que já foi verificado fica", async () => {
    await como(() => iniciarVerificacaoAgro([fazenda, comum]));
    const lote = (await como(() => andamentoDaVerificacaoAgro()))!.loteId;
    await como(() => processarBlocoAgro(bloco("cadastro", lote, [fazenda]), { dormir: semRespiro }), sistema);

    await como(() => cancelarVerificacaoAgro());
    expect(await como(() => andamentoDaVerificacaoAgro())).toMatchObject({ estado: "cancelado" });

    const r = await como(() => processarBlocoAgro(bloco("cadastro", lote, [comum], 1), { dormir: semRespiro }), sistema);
    expect(r).toBe("parado");
    expect((await lerContato(fazenda)).agroTipos).toEqual(["fazenda"]);
  });

  it("depois de concluído ou cancelado dá para começar outro", async () => {
    await como(() => iniciarVerificacaoAgro([fazenda]));
    await como(() => cancelarVerificacaoAgro());
    await expect(como(() => iniciarVerificacaoAgro([comum]))).resolves.toMatchObject({ total: 1 });
    expect(await como(() => andamentoDaVerificacaoAgro())).toMatchObject({ estado: "andando", total: 1 });
  });

  it("o andamento não aparece para quem só lê", async () => {
    await como(() => iniciarVerificacaoAgro([fazenda]));
    expect(await como(() => andamentoDaVerificacaoAgro(), { userId: "leitor", role: "viewer" })).toBeNull();
  });
});
