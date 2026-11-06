import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Bug "imagem com ícone vermelho de erro, mas ENTREGUE no celular do destinatário".
 *
 * Causa: `sendMediaMessage` tratava QUALQUER exceção do envio (inclusive o prazo
 * de 30 s estourado com a Evolution já tendo aceito) como falha definitiva, e a
 * linha falha nascia SEM o id do WhatsApp — então nem o eco `fromMe` nem o
 * recibo ✓✓ a encontravam para corrigir (e, mesmo achando, `failed` valia mais
 * que `read` na ordem de status e nunca saía dali).
 *
 * A EVOLUTION É FALSA: nada vai à rede. O provedor é um mock; um dos testes usa
 * o `EvolutionProvider` de verdade com o `fetch` trocado por um que estoura o
 * prazo (a Evolution "travou depois de aceitar").
 */
vi.mock("../flows/queue", () => ({ scheduleStep: vi.fn(), getFlowQueue: () => ({}) }));
const provedor = vi.hoisted(() => ({ sendMedia: vi.fn() }));
vi.mock("@crmagro/channels", async (original) => ({
  ...(await original<typeof import("@crmagro/channels")>()),
  getChannelProvider: () => ({
    send: async () => ({ providerMessageId: "FAKE-TEXTO" }),
    sendMedia: (...a: unknown[]) => provedor.sendMedia(...a),
  }),
  baixarMidiaEvolution: async () => ({ ok: false, motivo: "falha" }),
}));

const { sendMediaMessage, receiveInbound, applyStatusUpdate, listMessages } = await import("./service");
const { EnvioAindaNaoConfirmado, JANELA_CONFIRMACAO_MS } = await import("./envio-incerto");
const { ChannelSendFailed, EvolutionProvider } = await import("@crmagro/channels");

const TEAM = "00000000-0000-0000-0000-0000000009e1";
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `envio-incerto-${sufixo}`;
const NUMERO = "5565988885555";
const FOTO_A = Buffer.from("foto-a").toString("base64");
const FOTO_B = Buffer.from("foto-b").toString("base64");

let conversaId = "";

const entrada = (id: string, extra: Record<string, unknown> = {}) => ({
  from: NUMERO,
  fromMe: false,
  text: "manda a foto",
  media: null,
  providerMessageId: `${id}-${sufixo}`,
  timestamp: null,
  name: "Lead",
  instance: INSTANCIA,
  ...extra,
});

/** O eco `fromMe` que a Evolution devolve quando a imagem é enviada. */
const eco = (id: string) =>
  entrada(id, { fromMe: true, text: null, media: { kind: "image", mime: "image/png", fileName: null, size: 6 } });

const enviar = (base64 = FOTO_A, extra: { confirmarReenvio?: boolean } = {}) =>
  runWithTeam(TEAM, () => sendMediaMessage(conversaId, { mediaPath: `${conversaId}/${base64.slice(0, 6)}.png`, mediaMime: "image/png", base64, ...extra }));

const imagensDeSaida = () =>
  basePrisma.message.findMany({ where: { teamId: TEAM, conversationId: conversaId, direcao: "out", tipo: "image" }, orderBy: { createdAt: "asc" } });

const recibo = (id: string, status: "sent" | "delivered" | "read" | "failed", errorCode: string | null = null) =>
  applyStatusUpdate({ providerMessageId: `${id}-${sufixo}`, status, errorCode, instance: INSTANCIA });

const estouroDoPrazo = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Envio incerto (test)" } });
});

beforeEach(async () => {
  provedor.sendMedia.mockReset();
  const w = { teamId: TEAM };
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  await basePrisma.channelAccount.create({
    data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: INSTANCIA, status: "connected" },
  });
  // A conversa nasce pelo caminho real do inbound (número solto, sem contato).
  await receiveInbound(entrada("abertura"));
  conversaId = (await basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM } })).id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("envio de mídia com prazo estourado DEPOIS de aceito (Evolution falsa)", () => {
  it("não vira falha definitiva: fica 'não confirmado' com a marca e a impressão do arquivo", async () => {
    // EvolutionProvider de verdade; só o fetch é falso: a Evolution aceitou e travou.
    const fetchFalso = vi.fn(async () => {
      throw estouroDoPrazo();
    });
    vi.stubGlobal("fetch", fetchFalso);
    provedor.sendMedia.mockImplementation((i: Parameters<InstanceType<typeof EvolutionProvider>["sendMedia"]>[0]) =>
      new EvolutionProvider("inst", "http://evolution.invalid", "chave-falsa").sendMedia(i),
    );

    const dto = await enviar();

    expect(fetchFalso).toHaveBeenCalledTimes(1);
    expect(String((fetchFalso.mock.calls[0] as unknown[])[0])).toContain("/message/sendMedia/");
    expect(dto.status).toBe("unconfirmed"); // antes: "failed" (ícone vermelho)
    const [linha] = await imagensDeSaida();
    expect(linha?.status).toBe("failed"); // o banco segue conservador
    expect(linha?.providerMessageId).toBeNull();
    expect(linha?.meta).toMatchObject({ envio: "nao_confirmado" });
    expect((linha?.meta as { sha256?: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("o eco fromMe da Evolution chega depois: adota o id na MESMA linha (sem duplicar) e o ✓✓ seguinte a atualiza", async () => {
    provedor.sendMedia.mockRejectedValue(new ChannelSendFailed("Evolution sendMedia: timeout", "unknown", false));
    await enviar();

    await receiveInbound(eco("eco-1")); // a imagem TINHA saído

    const linhas = await imagensDeSaida();
    expect(linhas).toHaveLength(1); // antes: 2 (a vermelha + a do eco)
    expect(linhas[0]).toMatchObject({ status: "sent", providerMessageId: `eco-1-${sufixo}`, meta: null });

    await recibo("eco-1", "delivered");
    const { items } = await runWithTeam(TEAM, () => listMessages(conversaId));
    expect(items.find((m) => m.tipo === "image")?.status).toBe("delivered");
    await recibo("eco-1", "read");
    expect((await imagensDeSaida())[0]?.status).toBe("read");
  });

  it("o eco chegou ANTES da gravação: reaproveita a linha do eco (1 mensagem, enviada, com a nossa mídia)", async () => {
    provedor.sendMedia.mockImplementation(async () => {
      await receiveInbound(eco("eco-2")); // o eco ganha a corrida
      throw new ChannelSendFailed("Evolution sendMedia: timeout", "unknown", false);
    });

    const dto = await enviar();

    expect(dto.status).toBe("sent");
    const linhas = await imagensDeSaida();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ status: "sent", providerMessageId: `eco-2-${sufixo}` });
    expect(linhas[0]?.mediaPath).toContain(conversaId); // o eco veio sem arquivo; ficou o nosso
  });

  it("envio OK e o eco chegou antes de gravarmos: não vira 'Falha ao enviar mídia' (índice único)", async () => {
    provedor.sendMedia.mockImplementation(async () => {
      await receiveInbound(eco("eco-3"));
      return { providerMessageId: `eco-3-${sufixo}` };
    });

    const dto = await enviar(); // antes: rejeitava por violação do índice único

    expect(dto.status).toBe("sent");
    expect(await imagensDeSaida()).toHaveLength(1);
  });
});

describe("falha DE VERDADE continua falha (sem recibo)", () => {
  it("4xx da Evolution (número inválido): 'failed' vermelho, sem marca; um eco qualquer NÃO a adota", async () => {
    provedor.sendMedia.mockRejectedValue(new ChannelSendFailed("Evolution sendMedia 400: numero invalido", "not_sent", false, 400));

    const dto = await enviar();
    expect(dto.status).toBe("failed");
    const [falha] = await imagensDeSaida();
    expect(falha).toMatchObject({ status: "failed", providerMessageId: null, meta: null });

    await receiveInbound(eco("outra-imagem")); // imagem que NÃO é esta (ex.: mandada pelo celular)
    const linhas = await imagensDeSaida();
    expect(linhas).toHaveLength(2);
    expect(linhas.find((l) => l.id === falha!.id)?.status).toBe("failed");
  });

  it("erro qualquer que não é da Evolution (não classificado): 'failed' como sempre", async () => {
    provedor.sendMedia.mockRejectedValue(new Error("Evolution fora do ar"));
    const dto = await enviar();
    expect(dto.status).toBe("failed");
  });
});

describe("recibo depois de 'failed' (transição de status)", () => {
  async function linhaFalha(id: string, extra: { errorCode?: string; statusAt?: Date } = {}) {
    return basePrisma.message.create({
      data: {
        teamId: TEAM, conversationId: conversaId, direcao: "out", tipo: "image", conteudo: null,
        status: "failed", providerMessageId: `${id}-${sufixo}`, statusAt: extra.statusAt ?? new Date(), errorCode: extra.errorCode ?? null,
      },
    });
  }
  const statusDe = async (id: string) => (await basePrisma.message.findUniqueOrThrow({ where: { id } })).status;

  it("ERROR sem código seguido de ✓✓: a mensagem entregue deixa de ficar vermelha", async () => {
    const m = await linhaFalha("f-1");
    await recibo("f-1", "delivered");
    expect(await statusDe(m.id)).toBe("delivered"); // antes: continuava "failed"
    await recibo("f-1", "read");
    expect(await statusDe(m.id)).toBe("read");
  });

  it("recusa do servidor (código 463) segue definitiva: recibo de entrega não a desfaz", async () => {
    const m = await linhaFalha("f-2", { errorCode: "463" });
    await recibo("f-2", "delivered");
    expect(await statusDe(m.id)).toBe("failed");
  });

  it("ERROR sem código chegando DEPOIS da entrega não derruba para 'failed'", async () => {
    const m = await basePrisma.message.create({
      data: { teamId: TEAM, conversationId: conversaId, direcao: "out", tipo: "image", status: "delivered", providerMessageId: `f-3-${sufixo}`, statusAt: new Date() },
    });
    await recibo("f-3", "failed");
    expect(await statusDe(m.id)).toBe("delivered");
  });
});

describe("idempotência: reenviar o MESMO arquivo enquanto o anterior não foi confirmado", () => {
  it("pede confirmação (não chama a Evolution de novo); 'enviar mesmo assim' envia; outro arquivo não é barrado", async () => {
    provedor.sendMedia.mockRejectedValue(new ChannelSendFailed("Evolution sendMedia: timeout", "unknown", false));
    await enviar(FOTO_A);
    expect(provedor.sendMedia).toHaveBeenCalledTimes(1);

    await expect(enviar(FOTO_A)).rejects.toBeInstanceOf(EnvioAindaNaoConfirmado);
    expect(provedor.sendMedia).toHaveBeenCalledTimes(1); // nada foi reenviado sem aviso
    expect(await imagensDeSaida()).toHaveLength(1); // nem gravou outra linha

    let n = 0;
    provedor.sendMedia.mockImplementation(async () => ({ providerMessageId: `ok-${++n}-${sufixo}` }));
    const outro = await enviar(FOTO_B); // arquivo diferente: liberado
    expect(outro.status).toBe("sent");
    const deNovo = await enviar(FOTO_A, { confirmarReenvio: true }); // a pessoa confirmou
    expect(deNovo.status).toBe("sent");
    expect(provedor.sendMedia).toHaveBeenCalledTimes(3);
    expect(await imagensDeSaida()).toHaveLength(3); // a incerta + as duas enviadas
  });

  it("falha DEFINITIVA não trava o reenvio (a pessoa pode tentar de novo sem aviso)", async () => {
    provedor.sendMedia.mockRejectedValueOnce(new ChannelSendFailed("Evolution sendMedia 400: numero invalido", "not_sent", false, 400));
    await enviar(FOTO_A);
    provedor.sendMedia.mockResolvedValue({ providerMessageId: `ok-2-${sufixo}` });
    await expect(enviar(FOTO_A)).resolves.toMatchObject({ status: "sent" });
  });

  it("janela vencida sem eco/recibo: a falha vale (volta a 'failed'), o reenvio é liberado e um eco tardio não a adota", async () => {
    provedor.sendMedia.mockRejectedValue(new ChannelSendFailed("Evolution sendMedia: timeout", "unknown", false));
    await enviar(FOTO_A);
    await basePrisma.message.updateMany({
      where: { teamId: TEAM, tipo: "image" },
      data: { createdAt: new Date(Date.now() - JANELA_CONFIRMACAO_MS - 60_000) },
    });

    const { items } = await runWithTeam(TEAM, () => listMessages(conversaId));
    expect(items.find((m) => m.tipo === "image")?.status).toBe("failed");

    await receiveInbound(eco("tardio"));
    expect(await imagensDeSaida()).toHaveLength(2); // o eco tardio entrou como mensagem própria

    provedor.sendMedia.mockResolvedValue({ providerMessageId: `ok-3-${sufixo}` });
    await expect(enviar(FOTO_A)).resolves.toMatchObject({ status: "sent" });
  });
});
