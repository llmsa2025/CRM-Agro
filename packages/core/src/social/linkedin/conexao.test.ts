import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { env } from "@crmagro/config";
import { basePrisma, runWithTeam, runAsSystem, decryptCredentials, estaCifrado } from "@crmagro/db";

/**
 * LinkedIn oficial (entrar com LinkedIn) com o LinkedIn SIMULADO. Nenhum teste chama a API de verdade:
 * o módulo `./cliente` (único que fala com o LinkedIn) é trocado por um LinkedIn em memória.
 */
const li = vi.hoisted(() => ({ trocarCodigo: vi.fn(), lerPerfil: vi.fn(), revogarToken: vi.fn() }));
vi.mock("./cliente", async (importOriginal) => ({ ...(await importOriginal<typeof import("./cliente")>()), ...li }));

const { LinkedinApiErro } = await import("./cliente");
const {
  iniciarConexaoLinkedin,
  concluirConexaoLinkedin,
  desconectarLinkedin,
  lerTokenDoLinkedin,
  assinarEstado,
  situacaoDaValidade,
  podeConectarLinkedin,
  PROVEDOR_LINKEDIN,
  LinkedinIndisponivel,
  EstadoLinkedinInvalido,
  PermissaoDePublicarNegada,
  LinkedinDeOutraPessoa,
  LinkedinTokenExpirado,
} = await import("./conexao");
const { assinarEstado: assinarEstadoDoGoogle } = await import("../../agenda/google/conexao");
const { ForbiddenError } = await import("../../auth/authz");

const TEAM = "00000000-0000-0000-0000-0000000a11e1";
const OUTRO = "00000000-0000-0000-0000-0000000a11e2";
const sufixo = Math.random().toString(36).slice(2, 8);

type Pessoa = { id: string; teamId: string; role: string; nome: string; email: string };
const pessoa = (nome: string, teamId: string, role: string): Pessoa => ({ id: randomUUID(), teamId, role, nome, email: `${nome}-${sufixo}@teste.crmagro` });
const U = {
  chefe: pessoa("chefe", TEAM, "admin"),
  ana: pessoa("ana", TEAM, "member"),
  bia: pessoa("bia", TEAM, "member"),
  leitor: pessoa("leitor", TEAM, "viewer"),
  outro: pessoa("outro", OUTRO, "owner"),
};
const como = <T>(p: Pessoa, fn: () => Promise<T> | T, extra: { modulos?: string[] } = {}) =>
  runWithTeam(p.teamId, async () => fn(), { userId: p.id, role: p.role, ...extra });

const envOriginal = {
  LINKEDIN_CLIENT_ID: env.LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET: env.LINKEDIN_CLIENT_SECRET,
  LINKEDIN_REDIRECT_URI: env.LINKEDIN_REDIRECT_URI,
  AUTH_URL: env.AUTH_URL,
};

const ESCOPOS_OK = ["openid", "profile", "email", "w_member_social"];
const DIA = 86_400_000;

/** Perfis do LinkedIn simulado, por `sub`. Cada volta usa o próprio `code`, então voltas ao mesmo tempo não se misturam. */
const perfis = new Map<string, { escopos: string[]; nome: string; dias: number }>();
const subDoCode = (code: string) => code.replace(/^codigo-/, "");
const subDoToken = (token: string) => token.replace(/^token-/, "");

function instalarLinkedinFalso() {
  perfis.clear();
  for (const f of Object.values(li)) f.mockReset();
  li.trocarCodigo.mockImplementation(async ({ code }: { code: string }) => {
    const sub = subDoCode(code);
    const p = perfis.get(sub);
    if (!p) throw new LinkedinApiErro(400, "invalid_request");
    return { accessToken: `token-${sub}`, expiraEm: new Date(Date.now() + p.dias * DIA), escopos: p.escopos };
  });
  li.lerPerfil.mockImplementation(async (token: string) => {
    const sub = subDoToken(token);
    return { sub, nome: perfis.get(sub)?.nome ?? `Pessoa ${sub}`, email: `${sub}@linkedin.teste` };
  });
  li.revogarToken.mockResolvedValue(undefined);
}

/** Registra o perfil `sub` no LinkedIn simulado. */
function linkedinDe(sub: string, opts: { escopos?: string[]; nome?: string; dias?: number } = {}) {
  perfis.set(sub, { escopos: opts.escopos ?? ESCOPOS_OK, nome: opts.nome ?? `Pessoa ${sub}`, dias: opts.dias ?? 60 });
}

/** Faz a ida e a volta completas de uma pessoa, como o navegador faria. */
async function conectar(p: Pessoa, sub: string, opts: Parameters<typeof linkedinDe>[1] = {}) {
  linkedinDe(sub, opts);
  const ida = await como(p, () => iniciarConexaoLinkedin());
  const state = new URL(ida.url).searchParams.get("state")!;
  return como(p, () => concluirConexaoLinkedin({ code: `codigo-${sub}`, state, nonce: ida.nonce }));
}

const contasDe = (teamId: string) => basePrisma.channelAccount.findMany({ where: { teamId, provider: PROVEDOR_LINKEDIN }, orderBy: { createdAt: "asc" } });
const limpar = () => basePrisma.channelAccount.deleteMany({ where: { provider: PROVEDOR_LINKEDIN, teamId: { in: [TEAM, OUTRO] } } });

beforeAll(async () => {
  Object.assign(env, {
    LINKEDIN_CLIENT_ID: "cliente-linkedin-teste",
    LINKEDIN_CLIENT_SECRET: "segredo-linkedin-teste",
    LINKEDIN_REDIRECT_URI: undefined,
    AUTH_URL: "https://app.teste.crmagro",
  });
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team LinkedIn A (test)" } });
  await basePrisma.team.upsert({ where: { id: OUTRO }, update: {}, create: { id: OUTRO, name: "Team LinkedIn B (test)" } });
  await limpar();
  for (const p of Object.values(U)) {
    await basePrisma.user.create({ data: { id: p.id, teamId: p.teamId, role: p.role, name: p.nome, email: p.email } });
  }
});
beforeEach(async () => {
  instalarLinkedinFalso();
  Object.assign(env, { LINKEDIN_CLIENT_ID: "cliente-linkedin-teste", LINKEDIN_CLIENT_SECRET: "segredo-linkedin-teste" });
  await limpar();
});
afterAll(async () => {
  Object.assign(env, envOriginal);
  await limpar();
  await basePrisma.user.deleteMany({ where: { id: { in: Object.values(U).map((p) => p.id) } } });
});

describe("começo da conexão", () => {
  it("monta a autorização com o escopo mínimo, o retorno certo e o state assinado", async () => {
    const r = await como(U.ana, () => iniciarConexaoLinkedin());
    const url = new URL(r.url);
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("cliente-linkedin-teste");
    expect(q.get("redirect_uri")).toBe("https://app.teste.crmagro/api/integracoes/linkedin/callback");
    expect(q.get("scope")).toBe("openid profile email w_member_social");
    expect(q.get("state")).toContain(".");
    expect(r.nonce).toBeTruthy();
    // O segredo do app nunca vai na URL do navegador.
    expect(r.url).not.toContain("segredo-linkedin-teste");
  });

  it("usa LINKEDIN_REDIRECT_URI quando existe", async () => {
    env.LINKEDIN_REDIRECT_URI = "https://outro.teste.crmagro/api/integracoes/linkedin/callback";
    try {
      const r = await como(U.ana, () => iniciarConexaoLinkedin());
      expect(new URL(r.url).searchParams.get("redirect_uri")).toBe("https://outro.teste.crmagro/api/integracoes/linkedin/callback");
    } finally {
      env.LINKEDIN_REDIRECT_URI = undefined;
    }
  });

  it("sem as chaves do app, nada começa (fail-soft)", async () => {
    Object.assign(env, { LINKEDIN_CLIENT_ID: undefined, LINKEDIN_CLIENT_SECRET: undefined });
    await expect(como(U.ana, () => iniciarConexaoLinkedin())).rejects.toBeInstanceOf(LinkedinIndisponivel);
  });

  it("só quem pode conectar a PRÓPRIA conta: membro sim; só leitura e contexto de sistema não", async () => {
    await expect(como(U.ana, () => podeConectarLinkedin())).resolves.toBe(true);
    await expect(como(U.leitor, () => podeConectarLinkedin())).resolves.toBe(false);
    await expect(como(U.leitor, () => iniciarConexaoLinkedin())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runAsSystem(TEAM, async () => iniciarConexaoLinkedin())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("quem tem as telas restritas sem Integrações não conecta", async () => {
    await expect(como(U.ana, () => iniciarConexaoLinkedin(), { modulos: ["conversas"] })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("volta do LinkedIn", () => {
  it("cria a conta da pessoa, com o token cifrado e a validade no meta", async () => {
    const r = await conectar(U.ana, "sub-ana", { nome: "Ana Souza" });
    expect(r).toEqual({ volta: "canais", nome: "Ana Souza" });
    const contas = await contasDe(TEAM);
    expect(contas).toHaveLength(1);
    const c = contas[0]!;
    expect(c).toMatchObject({ canal: "linkedin", provider: "linkedin_official", externalId: "linkedin:sub-ana", ownerId: U.ana.id, label: "Ana Souza", status: "connected" });
    // O token não fica em texto puro no banco.
    expect(JSON.stringify(c.credentials)).not.toContain("token-sub-ana");
    expect(estaCifrado(c.credentials)).toBe(true);
    expect((decryptCredentials(c.credentials) as { accessToken: string }).accessToken).toBe("token-sub-ana");
    const meta = c.meta as { nome: string; escopos: string[]; expiraEm: string };
    expect(meta.nome).toBe("Ana Souza");
    expect(meta.escopos).toContain("w_member_social");
    expect(Math.round((Date.parse(meta.expiraEm) - Date.now()) / DIA)).toBe(60);
  });

  it("reconectar atualiza a MESMA conta (uma por pessoa) e trocar de perfil também", async () => {
    await conectar(U.ana, "sub-ana", { nome: "Ana Souza" });
    const [antes] = await contasDe(TEAM);
    await conectar(U.ana, "sub-ana", { nome: "Ana S." });
    await conectar(U.ana, "sub-ana-2", { nome: "Ana Souza (novo perfil)" });
    const contas = await contasDe(TEAM);
    expect(contas).toHaveLength(1);
    expect(contas[0]).toMatchObject({ id: antes!.id, externalId: "linkedin:sub-ana-2", label: "Ana Souza (novo perfil)", status: "connected", ownerId: U.ana.id });
  });

  it("recusa o mesmo perfil de LinkedIn em outra pessoa, do mesmo time ou de outro, e não mexe na conta da primeira", async () => {
    await conectar(U.ana, "sub-compartilhado");
    const [daAna] = await contasDe(TEAM);
    await expect(conectar(U.bia, "sub-compartilhado")).rejects.toBeInstanceOf(LinkedinDeOutraPessoa);
    await expect(conectar(U.outro, "sub-compartilhado")).rejects.toBeInstanceOf(LinkedinDeOutraPessoa);
    const depois = await basePrisma.channelAccount.findMany({ where: { provider: PROVEDOR_LINKEDIN, teamId: { in: [TEAM, OUTRO] } } });
    expect(depois).toHaveLength(1);
    expect(depois[0]).toMatchObject({ id: daAna!.id, ownerId: U.ana.id, teamId: TEAM });
  });

  it("sem a permissão de publicar, não grava nada", async () => {
    await expect(conectar(U.ana, "sub-ana", { escopos: ["openid", "profile", "email"] })).rejects.toBeInstanceOf(PermissaoDePublicarNegada);
    expect(await contasDe(TEAM)).toHaveLength(0);
  });

  it("recusa state adulterado, vencido, de outra pessoa, de outro time, sem cookie e o do Google", async () => {
    linkedinDe("sub-ana");
    const ida = await como(U.ana, () => iniciarConexaoLinkedin());
    const state = new URL(ida.url).searchParams.get("state")!;
    const volta = (s: string, nonce: string | null | undefined) => como(U.ana, () => concluirConexaoLinkedin({ code: "c", state: s, nonce }));
    const [payload, sig] = state.split(".");

    await expect(volta(`${payload}.${sig!.slice(0, -2)}xx`, ida.nonce)).rejects.toBeInstanceOf(EstadoLinkedinInvalido); // assinatura
    await expect(volta("lixo", ida.nonce)).rejects.toBeInstanceOf(EstadoLinkedinInvalido); // formato
    await expect(volta(state, null)).rejects.toBeInstanceOf(EstadoLinkedinInvalido); // sem o cookie
    await expect(volta(state, "outro-nonce")).rejects.toBeInstanceOf(EstadoLinkedinInvalido); // outro navegador
    await expect(como(U.bia, () => concluirConexaoLinkedin({ code: "c", state, nonce: ida.nonce }))).rejects.toBeInstanceOf(EstadoLinkedinInvalido); // outra pessoa

    const vencido = assinarEstado({ u: U.ana.id, t: TEAM, n: "n1", e: Date.now() - 1000, v: "canais" });
    await expect(volta(vencido, "n1")).rejects.toBeInstanceOf(EstadoLinkedinInvalido);
    const doGoogle = assinarEstadoDoGoogle({ u: U.ana.id, t: TEAM, n: "n1", e: Date.now() + 60_000, v: "canais" });
    await expect(volta(doGoogle, "n1")).rejects.toBeInstanceOf(EstadoLinkedinInvalido);

    expect(li.trocarCodigo).not.toHaveBeenCalled();
    expect(await contasDe(TEAM)).toHaveLength(0);
  });

  it("recusa o code vazio ou gigante sem chamar o LinkedIn", async () => {
    const ida = await como(U.ana, () => iniciarConexaoLinkedin());
    const state = new URL(ida.url).searchParams.get("state")!;
    await expect(como(U.ana, () => concluirConexaoLinkedin({ code: "", state, nonce: ida.nonce }))).rejects.toBeInstanceOf(EstadoLinkedinInvalido);
    await expect(como(U.ana, () => concluirConexaoLinkedin({ code: "x".repeat(2000), state, nonce: ida.nonce }))).rejects.toBeInstanceOf(EstadoLinkedinInvalido);
    expect(li.trocarCodigo).not.toHaveBeenCalled();
  });

  it("o erro do Linkedin na troca do code sobe sem gravar conta", async () => {
    const ida = await como(U.ana, () => iniciarConexaoLinkedin());
    const state = new URL(ida.url).searchParams.get("state")!;
    // O LinkedIn não conhece este code (já usado ou vencido): erro do LinkedIn, sem gravar nada.
    await expect(como(U.ana, () => concluirConexaoLinkedin({ code: "codigo-desconhecido", state, nonce: ida.nonce }))).rejects.toBeInstanceOf(LinkedinApiErro);
    expect(await contasDe(TEAM)).toHaveLength(0);
  });
});

describe("voltas ao mesmo tempo (corrida)", () => {
  const RODADAS = 6;

  it("a mesma pessoa conectando dois perfis ao mesmo tempo fica com UMA conta conectada, sem token nas outras", async () => {
    for (let i = 0; i < RODADAS; i++) {
      await limpar();
      await Promise.allSettled([conectar(U.ana, `sub-a${i}`), conectar(U.ana, `sub-b${i}`)]);
      const minhas = (await contasDe(TEAM)).filter((c) => c.ownerId === U.ana.id);
      const conectadas = minhas.filter((c) => c.status === "connected");
      expect(conectadas, `rodada ${i}`).toHaveLength(1);
      expect(conectadas[0]!.credentials).not.toBeNull();
      for (const c of minhas.filter((x) => x.status !== "connected")) {
        expect(c.credentials).toBeNull();
        expect(c.desconectadaEm).not.toBeNull();
      }
    }
  });

  it("duas pessoas do time conectando o MESMO perfil ao mesmo tempo: uma fica, a outra é recusada, e o dono não troca", async () => {
    for (let i = 0; i < RODADAS; i++) {
      await limpar();
      const r = await Promise.allSettled([conectar(U.ana, `sub-comum${i}`), conectar(U.bia, `sub-comum${i}`)]);
      const ok = r.filter((x) => x.status === "fulfilled");
      const recusadas = r.filter((x): x is PromiseRejectedResult => x.status === "rejected");
      expect(ok, `rodada ${i}`).toHaveLength(1);
      expect(recusadas).toHaveLength(1);
      expect(recusadas[0]!.reason).toBeInstanceOf(LinkedinDeOutraPessoa);
      const contas = await contasDe(TEAM);
      expect(contas).toHaveLength(1);
      // O dono é quem conseguiu: nunca o outro.
      const vencedora = (r[0]!.status === "fulfilled" ? U.ana : U.bia).id;
      expect(contas[0]!.ownerId).toBe(vencedora);
    }
  });

  it("o perfil que já é de uma pessoa não troca de dono quando outra volta chega depois", async () => {
    await conectar(U.ana, "sub-ana");
    const [antes] = await contasDe(TEAM);
    await expect(conectar(U.bia, "sub-ana")).rejects.toBeInstanceOf(LinkedinDeOutraPessoa);
    const [depois] = await contasDe(TEAM);
    expect(depois).toMatchObject({ id: antes!.id, ownerId: U.ana.id, status: "connected" });
    expect(depois!.credentials).toEqual(antes!.credentials);
  });
});

describe("token da conta", () => {
  it("devolve o token e o autor do post (urn da pessoa)", async () => {
    await conectar(U.ana, "sub-ana");
    const [c] = await contasDe(TEAM);
    const r = await como(U.ana, () => lerTokenDoLinkedin(c!.id));
    expect(r).toEqual({ accessToken: "token-sub-ana", autorUrn: "urn:li:person:sub-ana", ownerId: U.ana.id });
  });

  it("token vencido: marca a conta com erro (a tela pede para conectar de novo) e lança", async () => {
    await conectar(U.ana, "sub-ana");
    const [c] = await contasDe(TEAM);
    await expect(como(U.ana, () => lerTokenDoLinkedin(c!.id, Date.now() + 61 * DIA))).rejects.toBeInstanceOf(LinkedinTokenExpirado);
    expect((await contasDe(TEAM))[0]!.status).toBe("error");
    // Depois de marcada, nem tenta de novo.
    await expect(como(U.ana, () => lerTokenDoLinkedin(c!.id))).rejects.toBeInstanceOf(LinkedinTokenExpirado);
  });

  it("não lê conta de outro provedor nem de outro time", async () => {
    await conectar(U.ana, "sub-ana");
    const [c] = await contasDe(TEAM);
    await expect(como(U.outro, () => lerTokenDoLinkedin(c!.id))).rejects.toBeInstanceOf(LinkedinTokenExpirado);
    const wa = await basePrisma.channelAccount.create({ data: { teamId: TEAM, canal: "whatsapp", provider: "evolution", label: "wa-teste-linkedin", status: "connected", credentials: { accessToken: "x" } } });
    try {
      await expect(como(U.ana, () => lerTokenDoLinkedin(wa.id))).rejects.toBeInstanceOf(LinkedinTokenExpirado);
    } finally {
      await basePrisma.channelAccount.delete({ where: { id: wa.id } });
    }
  });

  it("só o DONO usa o token: outro membro, o administrador e quem não tem identidade são negados", async () => {
    await conectar(U.ana, "sub-ana");
    const [c] = await contasDe(TEAM);
    await expect(como(U.bia, () => lerTokenDoLinkedin(c!.id))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(U.chefe, () => lerTokenDoLinkedin(c!.id))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runWithTeam(TEAM, async () => lerTokenDoLinkedin(c!.id))).rejects.toBeInstanceOf(ForbiddenError);
    // E a conta continua conectada (negar não mexe em nada).
    expect((await contasDe(TEAM))[0]!.status).toBe("connected");
  });

  it("o motor (contexto de sistema) lê o token da conta do time", async () => {
    await conectar(U.ana, "sub-ana");
    const [c] = await contasDe(TEAM);
    const r = await runAsSystem(TEAM, () => lerTokenDoLinkedin(c!.id));
    expect(r.autorUrn).toBe("urn:li:person:sub-ana");
  });
});

describe("desconectar", () => {
  it("o dono desconecta: revoga o token, apaga o token da conta e a conta fica desconectada (o histórico segue ligado)", async () => {
    await conectar(U.ana, "sub-ana");
    const [c] = await contasDe(TEAM);
    await como(U.ana, () => desconectarLinkedin(c!.id));
    expect(li.revogarToken).toHaveBeenCalledWith(expect.objectContaining({ token: "token-sub-ana" }));
    const depois = (await contasDe(TEAM))[0]!;
    expect(depois.status).toBe("disconnected");
    expect(depois.credentials).toBeNull();
    expect(depois.desconectadaEm).not.toBeNull();
    await expect(como(U.ana, () => lerTokenDoLinkedin(c!.id))).rejects.toBeInstanceOf(LinkedinTokenExpirado);
  });

  it("outro membro não desconecta a conta alheia; o administrador sim", async () => {
    await conectar(U.ana, "sub-ana");
    const [c] = await contasDe(TEAM);
    await expect(como(U.bia, () => desconectarLinkedin(c!.id))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await contasDe(TEAM))[0]!.status).toBe("connected");
    await como(U.chefe, () => desconectarLinkedin(c!.id));
    expect((await contasDe(TEAM))[0]!.status).toBe("disconnected");
  });

  it("reconectar enquanto a revogação está em andamento NÃO apaga o token novo", async () => {
    await conectar(U.ana, "sub-ana");
    const [c] = await contasDe(TEAM);
    // Durante a chamada ao LinkedIn (depois de o token antigo sair daqui), a pessoa reconecta.
    li.revogarToken.mockImplementation(async () => {
      await conectar(U.ana, "sub-ana", { nome: "Ana de novo" });
    });
    await como(U.ana, () => desconectarLinkedin(c!.id));
    const [depois] = await contasDe(TEAM);
    expect(depois).toMatchObject({ id: c!.id, status: "connected", label: "Ana de novo" });
    expect((decryptCredentials(depois!.credentials) as { accessToken: string }).accessToken).toBe("token-sub-ana");
  });

  it("só revoga o token que acabou de sair daqui, e só uma vez", async () => {
    await conectar(U.ana, "sub-ana");
    const [c] = await contasDe(TEAM);
    await como(U.ana, () => desconectarLinkedin(c!.id));
    await como(U.ana, () => desconectarLinkedin(c!.id)); // já desconectada: sem token, nada a revogar
    expect(li.revogarToken).toHaveBeenCalledTimes(1);
  });

  it("se o LinkedIn não revogar o token, desconecta do mesmo jeito", async () => {
    await conectar(U.ana, "sub-ana");
    const [c] = await contasDe(TEAM);
    li.revogarToken.mockRejectedValue(new LinkedinApiErro(500, null));
    await como(U.ana, () => desconectarLinkedin(c!.id));
    expect((await contasDe(TEAM))[0]).toMatchObject({ status: "disconnected", credentials: null });
  });

  it("não desconecta conta de outro provedor por este caminho", async () => {
    const wa = await basePrisma.channelAccount.create({ data: { teamId: TEAM, canal: "whatsapp", provider: "evolution", label: "wa-teste-linkedin-2", status: "connected", ownerId: U.ana.id } });
    try {
      await expect(como(U.ana, () => desconectarLinkedin(wa.id))).rejects.toBeInstanceOf(ForbiddenError);
      expect((await basePrisma.channelAccount.findUnique({ where: { id: wa.id } }))!.status).toBe("connected");
    } finally {
      await basePrisma.channelAccount.delete({ where: { id: wa.id } });
    }
  });
});

describe("validade da conexão", () => {
  const agora = Date.parse("2026-10-01T12:00:00Z");
  const em = (dias: number) => ({ expiraEm: new Date(agora + dias * DIA).toISOString() });

  it("ok, vence logo, vencida e desconhecida", () => {
    expect(situacaoDaValidade(em(40), agora)).toEqual({ estado: "ok", dias: 40 });
    expect(situacaoDaValidade(em(8), agora).estado).toBe("ok");
    expect(situacaoDaValidade(em(7), agora)).toEqual({ estado: "vence_logo", dias: 7 });
    expect(situacaoDaValidade(em(0.5), agora)).toEqual({ estado: "vence_logo", dias: 0 });
    expect(situacaoDaValidade(em(-1), agora).estado).toBe("vencida");
    // Recém-conectada (um instante abaixo de 60 dias) mostra 60, não 59; vencida há minutos não vira "vence hoje".
    expect(situacaoDaValidade({ expiraEm: new Date(agora + 60 * DIA - 5).toISOString() }, agora)).toEqual({ estado: "ok", dias: 60 });
    expect(situacaoDaValidade({ expiraEm: new Date(agora - 60_000).toISOString() }, agora).estado).toBe("vencida");
    expect(situacaoDaValidade({}, agora)).toEqual({ estado: "desconhecida", dias: null });
    expect(situacaoDaValidade(null, agora).estado).toBe("desconhecida");
    expect(situacaoDaValidade({ expiraEm: "lixo" }, agora).estado).toBe("desconhecida");
  });
});
