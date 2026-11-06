import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "@crmagro/config";
import { basePrisma } from "@crmagro/db";

/**
 * Criar a conta da empresa com e-mail e senha — com CONFIRMAÇÃO OBRIGATÓRIA do
 * e-mail (auditoria do #148: sem a prova do e-mail, qualquer um reservava o
 * e-mail de outra pessoa).
 *
 * Banco e Redis de TESTE. O envio é FALSO: o `EmailProvider` da plataforma é
 * um espião — nenhum e-mail sai de verdade. O remetente é ligado/desligado
 * mexendo no `env` deste arquivo (o vitest.config.ts zera PLATFORM_*).
 * O bcrypt mora no web: aqui o hash é "hash:<senha>".
 */
const envio = vi.hoisted(() => ({
  plataforma: vi.fn(async (_input: { to: string; content: { subject: string; text: string; html?: string } }) => ({
    providerMessageId: "<plataforma@teste>",
  })),
}));
vi.mock("../push/service", () => ({ enviarPush: vi.fn(async () => ({ enviados: 0, removidas: 0, falhas: 0 })) }));
vi.mock("@crmagro/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crmagro/channels")>();
  class EmailProviderFalso {
    send(input: { to: string; content: { subject: string; text: string; html?: string } }) {
      return envio.plataforma(input);
    }
  }
  return { ...real, EmailProvider: EmailProviderFalso };
});

const {
  iniciarCadastroComSenha,
  aguardarCadastros,
  confirmarCadastro,
  verificarLinkDeCadastro,
  reenviarConfirmacao,
  cadastroEmpresaComSenhaAberto,
  cadastroComSenhaDisponivel,
  limparCadastrosPendentesVencidos,
  CADASTRO_LIMITES,
  CADASTRO_VIDA_MAX_MS,
  MENSAGEM_INDISPONIVEL,
} = await import("./cadastro-com-senha");
const { conferirSenhaDoLogin, HASH_DE_SENHA_FALSO } = await import("./login-senha");
const { provisionUserFromGoogle } = await import("./provisioning");
const { rateLimit } = await import("../rate-limit/service");

type Ajustes = Partial<
  Pick<
    typeof env,
    | "PLATFORM_EMAIL_FROM"
    | "PLATFORM_SMTP_HOST"
    | "PLATFORM_SMTP_USER"
    | "PLATFORM_SMTP_PASS"
    | "PLATFORM_EMAIL_LIMITE_DIA"
    | "AUTH_URL"
    | "APP_PUBLIC_URL"
    | "CADASTRO_EMPRESA"
    | "CADASTRO_EMPRESA_SENHA"
  >
>;
const PLATAFORMA: Ajustes = {
  PLATFORM_EMAIL_FROM: "CRM Agro <noreply@crmagro.example>",
  PLATFORM_SMTP_HOST: "smtp.resend.teste.invalid",
  PLATFORM_SMTP_USER: "resend",
  PLATFORM_SMTP_PASS: "re_chave_de_teste",
  // O Redis de TESTE acumula a contagem do dia entre execuções: teto alto aqui.
  PLATFORM_EMAIL_LIMITE_DIA: "1000000",
};
const CHAVES = [...Object.keys(PLATAFORMA), "AUTH_URL", "APP_PUBLIC_URL", "CADASTRO_EMPRESA", "CADASTRO_EMPRESA_SENHA"] as Array<keyof Ajustes>;
const original: Ajustes = Object.fromEntries(CHAVES.map((k) => [k, (env as Ajustes)[k]]));
const APP = "https://app.crmagro.example";

function configurar(p: { plataforma: boolean } & Ajustes): void {
  const alvo = env as Ajustes;
  for (const k of CHAVES) delete alvo[k];
  const { plataforma, ...resto } = p;
  if (plataforma) Object.assign(alvo, PLATAFORMA);
  Object.assign(alvo, { AUTH_URL: APP }, resto);
}

const sufixo = randomUUID().slice(0, 8);
let seq = 0;
/** E-mail novo por teste: os limites por e-mail (Redis de teste) não passam de uma execução para outra. */
const novoEmail = (n: string) => `cad-${n}-${sufixo}-${++seq}@exemplo.com.br`;
const hashSenha = async (s: string) => `hash:${s}`;
const compararSenha = async (s: string, h: string) => h === `hash:${s}`;
const SENHA = "colheita-de-soja-2026";
const emailsUsados: string[] = [];
const timesCriados: string[] = [];

function formulario(email: string, extra: Partial<{ senha: string; confirmar: string; nome: string; empresa: string; cnpj: string; estado: string }> = {}) {
  emailsUsados.push(email);
  const senha = extra.senha ?? SENHA;
  return {
    empresa: { nome: extra.empresa ?? "Fazenda Três Rios", cidade: "Sorriso", estado: extra.estado ?? "mt", cnpj: extra.cnpj ?? "12.345.678/0001-90" },
    nome: extra.nome ?? "Maria Pereira",
    email,
    senha,
    confirmar: extra.confirmar ?? senha,
  };
}

/** Pede o cadastro e espera o segundo plano (gravação + envio). */
async function cadastrar(email: string, extra: Parameters<typeof formulario>[1] = {}, ip?: string) {
  const r = await iniciarCadastroComSenha(formulario(email, extra), { hashSenha, ip });
  await aguardarCadastros();
  return r;
}

/** Token do último e-mail de confirmação enviado para `para`. */
function tokenDoUltimoEmail(para: string): string {
  const chamadas = envio.plataforma.mock.calls.filter((c) => c[0].to === para);
  const texto = chamadas.at(-1)?.[0].content.text ?? "";
  const m = texto.match(/\/confirmar-email\?token=([^\s]+)/);
  if (!m) throw new Error(`sem link de confirmação para ${para}`);
  return decodeURIComponent(m[1]!);
}

beforeEach(() => {
  configurar({ plataforma: true });
  envio.plataforma.mockReset();
  envio.plataforma.mockImplementation(async () => ({ providerMessageId: "<plataforma@teste>" }));
});
afterEach(() => {
  const alvo = env as Ajustes;
  for (const k of CHAVES) delete alvo[k];
  Object.assign(alvo, Object.fromEntries(Object.entries(original).filter(([, v]) => v !== undefined)));
});
afterAll(async () => {
  await basePrisma.cadastroPendente.deleteMany({ where: { email: { in: emailsUsados } } });
  const donos = await basePrisma.user.findMany({ where: { email: { in: emailsUsados } }, select: { teamId: true } });
  for (const teamId of new Set([...timesCriados, ...donos.map((d) => d.teamId)])) {
    await basePrisma.team.delete({ where: { id: teamId } }).catch(() => {});
  }
});

describe("sem remetente da plataforma, sem opção de senha (fail-safe)", () => {
  it("a opção só aparece com o remetente OK e a base do link", () => {
    expect(cadastroEmpresaComSenhaAberto()).toBe(true);

    configurar({ plataforma: false });
    expect(cadastroEmpresaComSenhaAberto()).toBe(false);

    // Remetente configurado pela metade (inválido): também some.
    configurar({ plataforma: false, PLATFORM_SMTP_HOST: "smtp.resend.teste.invalid" });
    expect(cadastroEmpresaComSenhaAberto()).toBe(false);

    configurar({ plataforma: true, AUTH_URL: undefined, APP_PUBLIC_URL: undefined });
    expect(cadastroEmpresaComSenhaAberto()).toBe(false);

    // Trava da operação e cadastro de empresas fechado.
    configurar({ plataforma: true, CADASTRO_EMPRESA_SENHA: "off" });
    expect(cadastroEmpresaComSenhaAberto()).toBe(false);
    configurar({ plataforma: true, CADASTRO_EMPRESA: "off" });
    expect(cadastroEmpresaComSenhaAberto()).toBe(false);
    // "on" (valor antigo) continua valendo — e nunca dispensa a confirmação.
    configurar({ plataforma: true, CADASTRO_EMPRESA_SENHA: "on" });
    expect(cadastroEmpresaComSenhaAberto()).toBe(true);
  });

  it("sem remetente, o cadastro é recusado e nada é gravado nem enviado", async () => {
    configurar({ plataforma: false });
    const email = novoEmail("sem-remetente");
    const r = await cadastrar(email);
    expect(r).toMatchObject({ ok: false, motivo: "fechado" });
    expect(await basePrisma.cadastroPendente.count({ where: { email } })).toBe(0);
    expect(envio.plataforma).not.toHaveBeenCalled();
  });
});

describe("confirmação obrigatória", () => {
  it("o cadastro NÃO cria conta: só o pedido e o e-mail com o link", async () => {
    const email = novoEmail("pedido");
    const r = await cadastrar(email);
    expect(r).toMatchObject({ ok: true, email });

    expect(await basePrisma.user.findUnique({ where: { email } })).toBeNull();
    const pedido = await basePrisma.cadastroPendente.findFirstOrThrow({ where: { email } });
    expect(pedido).toMatchObject({ nome: "Maria Pereira", empresaNome: "Fazenda Três Rios", empresaCnpj: "12345678000190", empresaEstado: "MT", passwordHash: `hash:${SENHA}` });
    expect(r.ok && r.handle).toBe(pedido.id);

    expect(envio.plataforma).toHaveBeenCalledTimes(1);
    const { to, content } = envio.plataforma.mock.calls[0]![0];
    expect(to).toBe(email);
    expect(content.subject).toBe("Confirme o seu e-mail no CRM Agro");
    const token = tokenDoUltimoEmail(email);
    // No banco, só o hash do token (nunca o texto puro).
    expect(pedido.tokenHash).not.toContain(token);
    expect(JSON.stringify(pedido)).not.toContain(token);
  });

  it("o link + a senha do cadastro criam a conta comprovada, com a empresa, o master e os padrões", async () => {
    const email = novoEmail("confirma");
    await cadastrar(email);
    const token = tokenDoUltimoEmail(email);

    // O GET da tela só mostra para quem é (não confirma nada).
    expect(await verificarLinkDeCadastro(token)).toEqual({ valido: true, email, empresa: "Fazenda Três Rios" });
    expect(await basePrisma.user.findUnique({ where: { email } })).toBeNull();

    const r = await confirmarCadastro(token, SENHA, { compararSenha });
    expect(r).toMatchObject({ ok: true, email });
    if (!r.ok) throw new Error("não confirmou");
    timesCriados.push(r.teamId);

    const dono = await basePrisma.user.findUniqueOrThrow({ where: { email } });
    expect(dono).toMatchObject({ id: r.userId, teamId: r.teamId, role: "owner", name: "Maria Pereira", passwordHash: `hash:${SENHA}` });
    expect(dono.emailVerificadoEm).not.toBeNull();
    const time = await basePrisma.team.findUniqueOrThrow({ where: { id: r.teamId } });
    expect(time).toMatchObject({ name: "Fazenda Três Rios", cnpj: "12345678000190", cidade: "Sorriso", estado: "MT", masterId: dono.id });
    const funis = await basePrisma.funnel.findMany({ where: { teamId: r.teamId }, include: { stages: true } });
    expect(funis.map((f) => [f.nome, f.stages.length])).toEqual([["Vendas", 5]]);
    expect(await basePrisma.goal.count({ where: { teamId: r.teamId, ownerId: dono.id } })).toBe(1);
    // O pedido some com a confirmação.
    expect(await basePrisma.cadastroPendente.count({ where: { email } })).toBe(0);

    // Conta comprovada: o login Google do mesmo e-mail depois NÃO apaga a senha.
    const g = await provisionUserFromGoogle({ email });
    expect(g.userId).toBe(dono.id);
    expect((await basePrisma.user.findUniqueOrThrow({ where: { email } })).passwordHash).toBe(`hash:${SENHA}`);
  });
});

describe("token de uso único e com validade", () => {
  it("o mesmo link não serve duas vezes", async () => {
    const email = novoEmail("uso-unico");
    await cadastrar(email);
    const token = tokenDoUltimoEmail(email);
    const r = await confirmarCadastro(token, SENHA, { compararSenha });
    expect(r.ok).toBe(true);
    if (r.ok) timesCriados.push(r.teamId);
    expect(await confirmarCadastro(token, SENHA, { compararSenha })).toEqual({ ok: false, motivo: "invalido" });
    expect(await verificarLinkDeCadastro(token)).toEqual({ valido: false });
    expect(await basePrisma.team.count({ where: { masterId: r.ok ? r.userId : "" } })).toBe(1);
  });

  it("dois cliques ao mesmo tempo: só uma conta", async () => {
    const email = novoEmail("corrida");
    await cadastrar(email);
    const token = tokenDoUltimoEmail(email);
    const rs = await Promise.all([confirmarCadastro(token, SENHA, { compararSenha }), confirmarCadastro(token, SENHA, { compararSenha })]);
    const ok = rs.filter((r) => r.ok);
    for (const r of ok) if (r.ok) timesCriados.push(r.teamId);
    expect(ok).toHaveLength(1);
    expect(await basePrisma.user.count({ where: { email } })).toBe(1);
  });

  it("link vencido não confirma", async () => {
    const email = novoEmail("vencido");
    await cadastrar(email);
    const token = tokenDoUltimoEmail(email);
    await basePrisma.cadastroPendente.updateMany({ where: { email }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await verificarLinkDeCadastro(token)).toEqual({ valido: false });
    expect(await confirmarCadastro(token, SENHA, { compararSenha })).toEqual({ ok: false, motivo: "invalido" });
    expect(await basePrisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("token inventado ou vazio não confirma", async () => {
    expect(await confirmarCadastro("cfe_inventado", SENHA, { compararSenha })).toEqual({ ok: false, motivo: "invalido" });
    expect(await confirmarCadastro("", SENHA, { compararSenha })).toEqual({ ok: false, motivo: "invalido" });
  });

  it("senha errada não confirma; 5 erros travam o pedido por um tempo", async () => {
    const email = novoEmail("senha-errada");
    await cadastrar(email);
    const token = tokenDoUltimoEmail(email);
    for (let i = 0; i < CADASTRO_LIMITES.confirmarFalhasPorCadastro.max; i++) {
      expect(await confirmarCadastro(token, "chute-errado-123", { compararSenha })).toEqual({ ok: false, motivo: "senha" });
    }
    // Travado: nem a senha certa passa agora (força bruta no link).
    expect(await confirmarCadastro(token, SENHA, { compararSenha })).toEqual({ ok: false, motivo: "limite" });
    expect(await basePrisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("reenviar troca o link: o antigo morre, o novo confirma", async () => {
    const email = novoEmail("reenvio");
    const r = await cadastrar(email);
    const antigo = tokenDoUltimoEmail(email);
    expect(await reenviarConfirmacao(r.ok ? r.handle : null)).toEqual({ ok: true });
    await aguardarCadastros();
    const novo = tokenDoUltimoEmail(email);
    expect(novo).not.toBe(antigo);
    expect(await verificarLinkDeCadastro(antigo)).toEqual({ valido: false });
    const c = await confirmarCadastro(novo, SENHA, { compararSenha });
    expect(c.ok).toBe(true);
    if (c.ok) timesCriados.push(c.teamId);
  });

  it("reenviar tem limite por pedido, e um id inventado não envia nada", async () => {
    const email = novoEmail("reenvio-limite");
    const r = await cadastrar(email);
    const id = r.ok ? r.handle : null;
    for (let i = 0; i < CADASTRO_LIMITES.reenvioPorCadastro.max; i++) expect((await reenviarConfirmacao(id)).ok).toBe(true);
    expect(await reenviarConfirmacao(id)).toMatchObject({ ok: false, motivo: "limite" });
    await aguardarCadastros();

    envio.plataforma.mockClear();
    expect(await reenviarConfirmacao(randomUUID())).toEqual({ ok: true });
    expect(await reenviarConfirmacao("nao-e-um-id")).toEqual({ ok: true });
    await aguardarCadastros();
    expect(envio.plataforma).not.toHaveBeenCalled();
  });

  it("pedido com mais de 24 h não reenvia (começa de novo)", async () => {
    const email = novoEmail("velho");
    const r = await cadastrar(email);
    await basePrisma.cadastroPendente.updateMany({ where: { email }, data: { createdAt: new Date(Date.now() - CADASTRO_VIDA_MAX_MS - 60_000) } });
    envio.plataforma.mockClear();
    expect(await reenviarConfirmacao(r.ok ? r.handle : null)).toEqual({ ok: true });
    await aguardarCadastros();
    expect(envio.plataforma).not.toHaveBeenCalled();
  });
});

describe("e-mail que já tem conta: a tela não revela", () => {
  it("resposta igual à de um e-mail novo; nada é criado; o DONO recebe o aviso (sem link de confirmação)", async () => {
    const existente = novoEmail("existente");
    const timeDono = await basePrisma.team.create({ data: { name: `Time do dono ${sufixo}` } });
    timesCriados.push(timeDono.id);
    await basePrisma.user.create({ data: { teamId: timeDono.id, name: "Dona Antiga", email: existente, role: "owner", passwordHash: "hash:dela", emailVerificadoEm: new Date() } });

    const novo = novoEmail("novo");
    const rNovo = await cadastrar(novo);
    const rExistente = await cadastrar(existente);

    // Mesma forma de resposta (ok + id + e-mail), sem pista de que a conta existe.
    expect(rExistente.ok).toBe(true);
    expect(Object.keys(rExistente).sort()).toEqual(Object.keys(rNovo).sort());
    expect(rExistente.ok && rExistente.handle).toMatch(/^[0-9a-f-]{36}$/);

    // Nada gravado para o e-mail existente; a conta dele segue intacta.
    expect(await basePrisma.cadastroPendente.count({ where: { email: existente } })).toBe(0);
    const conta = await basePrisma.user.findUniqueOrThrow({ where: { email: existente } });
    expect(conta).toMatchObject({ passwordHash: "hash:dela", teamId: timeDono.id });

    // O dono é avisado por e-mail — e o aviso NÃO leva link de confirmação nem o que foi digitado.
    const aviso = envio.plataforma.mock.calls.find((c) => c[0].to === existente)?.[0];
    expect(aviso?.content.subject).toBe("Tentativa de criar conta no CRM Agro com o seu e-mail");
    expect(aviso?.content.text).not.toContain("confirmar-email");
    expect(aviso?.content.text).not.toContain("Fazenda Três Rios");
    expect(aviso?.content.text).toContain(`${APP}/login`);
    expect(aviso?.content.text).toContain(`${APP}/esqueci-senha`);

    // Reenviar com o id "de mentira" do e-mail existente também responde igual e não envia.
    envio.plataforma.mockClear();
    expect(await reenviarConfirmacao(rExistente.ok ? rExistente.handle : null)).toEqual({ ok: true });
    await aguardarCadastros();
    expect(envio.plataforma).not.toHaveBeenCalled();
  });

  it("mesmo trabalho antes de responder: o hash sai nos dois casos e a busca da conta e o envio ficam para depois", async () => {
    const existente = novoEmail("existente-tempo");
    const t = await basePrisma.team.create({ data: { name: `Time ${sufixo}` } });
    timesCriados.push(t.id);
    await basePrisma.user.create({ data: { teamId: t.id, name: "Y", email: existente, role: "owner" } });

    // O envio fica "preso" até o fim do teste: se a resposta esperasse a busca
    // ou o SMTP, o `iniciarCadastroComSenha` não voltaria.
    let soltar: () => void = () => {};
    const preso = new Promise<void>((r) => (soltar = r));
    envio.plataforma.mockImplementation(async () => {
      await preso;
      return { providerMessageId: "<plataforma@teste>" };
    });
    const hash = vi.fn(hashSenha);
    for (const email of [existente, novoEmail("novo-tempo")]) {
      emailsUsados.push(email);
      const r = await iniciarCadastroComSenha(formulario(email), { hashSenha: hash });
      expect(r.ok).toBe(true);
    }
    expect(hash).toHaveBeenCalledTimes(2);
    soltar();
    await aguardarCadastros();
    expect(envio.plataforma).toHaveBeenCalledTimes(2); // o aviso ao dono e a confirmação
  });

  it("e-mail existente em MAIÚSCULAS também não vira pedido", async () => {
    const existente = novoEmail("existente-maiusc");
    const t = await basePrisma.team.create({ data: { name: `Time ${sufixo}` } });
    timesCriados.push(t.id);
    await basePrisma.user.create({ data: { teamId: t.id, name: "X", email: existente, role: "owner" } });
    const r = await cadastrar(existente.toUpperCase());
    expect(r.ok).toBe(true);
    expect(await basePrisma.cadastroPendente.count({ where: { email: existente } })).toBe(0);
  });
});

describe("limite de tentativas", () => {
  it("por e-mail: 3 por hora (contado igual com ou sem conta)", async () => {
    const email = novoEmail("limite-email");
    for (let i = 0; i < CADASTRO_LIMITES.porEmail.max; i++) expect((await cadastrar(email)).ok).toBe(true);
    expect(await cadastrar(email)).toMatchObject({ ok: false, motivo: "limite" });
    expect(await basePrisma.cadastroPendente.count({ where: { email } })).toBe(CADASTRO_LIMITES.porEmail.max);
  });

  it("por IP: 5 por hora", async () => {
    const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < CADASTRO_LIMITES.porIp.max; i++) expect((await cadastrar(novoEmail("ip"), {}, ip)).ok).toBe(true);
    const bloqueado = await cadastrar(novoEmail("ip"), {}, ip);
    expect(bloqueado).toMatchObject({ ok: false, motivo: "limite" });
    expect(bloqueado.ok ? "" : bloqueado.mensagem).toMatch(/Aguarde/);
  });

  it("confirmar: 10 tentativas por IP a cada 15 min", async () => {
    const ip = `172.16.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < CADASTRO_LIMITES.confirmarPorIp.max; i++) {
      expect(await confirmarCadastro(`cfe_x${i}`, SENHA, { compararSenha, ip })).toEqual({ ok: false, motivo: "invalido" });
    }
    expect(await confirmarCadastro("cfe_y", SENHA, { compararSenha, ip })).toEqual({ ok: false, motivo: "limite" });
  });
});

describe("validação e mensagens claras", () => {
  it("senha fraca, senhas diferentes e dados da empresa inválidos voltam com o campo e a mensagem; nada é gravado", async () => {
    const email = novoEmail("valida");
    expect(await cadastrar(email, { senha: "12345678" })).toMatchObject({ ok: false, motivo: "invalido", campo: "senha" });
    expect(await cadastrar(email, { senha: "Maria2026", nome: "Maria Pereira" })).toMatchObject({ ok: false, campo: "senha" });
    expect(await cadastrar(email, { senha: email })).toMatchObject({ ok: false, campo: "senha" });
    expect(await cadastrar(email, { confirmar: "outra-coisa-bem-diferente" })).toMatchObject({ ok: false, campo: "confirmar" });
    expect(await cadastrar(email, { cnpj: "123" })).toMatchObject({ ok: false, campo: "cnpj" });
    expect(await cadastrar(email, { estado: "MTT" })).toMatchObject({ ok: false, campo: "estado" });
    expect(await cadastrar(email, { empresa: "" })).toMatchObject({ ok: false, campo: "empresa" });
    expect(await cadastrar("a@b.com,c@d.com")).toMatchObject({ ok: false, campo: "email" });
    expect(await cadastrar("Fulano <x@y.com>")).toMatchObject({ ok: false, campo: "email" });
    expect(await basePrisma.cadastroPendente.count({ where: { email } })).toBe(0);
    expect(envio.plataforma).not.toHaveBeenCalled();
    // Validação não gasta o limite do e-mail: depois de acertar, passa.
    expect((await cadastrar(email)).ok).toBe(true);
  });
});

describe("sequestro de antemão impossível", () => {
  it("o pedido de quem usou o e-mail alheio não impede o dono nem dá acesso a quem o criou", async () => {
    const vitima = novoEmail("vitima");
    const SENHA_INVASOR = "senha-do-invasor-77";
    const SENHA_DONO = "pomar-de-laranja-do-dono";

    // 1) O invasor cria o pedido com o e-mail da vítima (o link vai para a CAIXA da vítima).
    await cadastrar(vitima, { senha: SENHA_INVASOR, empresa: "Empresa do Invasor", nome: "Invasor" });
    const linkDoInvasor = tokenDoUltimoEmail(vitima);
    // O invasor não tem o link; com a senha dele, o login só diz "confirme o e-mail".
    expect(await basePrisma.user.findUnique({ where: { email: vitima } })).toBeNull();

    // 2) A vítima, se clicar no link que não pediu, NÃO consegue ativar a conta do
    //    invasor com a senha dela (e a do invasor ela não sabe).
    expect(await confirmarCadastro(linkDoInvasor, SENHA_DONO, { compararSenha })).toEqual({ ok: false, motivo: "senha" });
    expect(await basePrisma.user.findUnique({ where: { email: vitima } })).toBeNull();

    // 3) O pedido do invasor não bloqueia o dono: ele faz o dele e confirma.
    await cadastrar(vitima, { senha: SENHA_DONO, empresa: "Fazenda do Dono", nome: "Dono Verdadeiro" });
    const linkDoDono = tokenDoUltimoEmail(vitima);
    const r = await confirmarCadastro(linkDoDono, SENHA_DONO, { compararSenha });
    expect(r.ok).toBe(true);
    if (r.ok) timesCriados.push(r.teamId);
    const conta = await basePrisma.user.findUniqueOrThrow({ where: { email: vitima } });
    expect(conta).toMatchObject({ name: "Dono Verdadeiro", passwordHash: `hash:${SENHA_DONO}` });
    expect(conta.emailVerificadoEm).not.toBeNull();
    expect((await basePrisma.team.findUniqueOrThrow({ where: { id: conta.teamId } })).name).toBe("Fazenda do Dono");

    // 4) O pedido do invasor morreu junto: o link dele não serve mais, nem com a senha certa.
    expect(await basePrisma.cadastroPendente.count({ where: { email: vitima } })).toBe(0);
    expect(await confirmarCadastro(linkDoInvasor, SENHA_INVASOR, { compararSenha })).toEqual({ ok: false, motivo: "invalido" });
    // E a senha do invasor não entra na conta (não confere com a do dono) nem acha pedido.
    expect(await compararSenha(SENHA_INVASOR, conta.passwordHash!)).toBe(false);
    expect(await conferirSenhaDoLogin(vitima, SENHA_INVASOR, { compararSenha })).toBeNull();
  });

  it("o dono cria pelo 'Registrar com Google' (/criar-empresa) com um pedido alheio pendurado: a conta é dele e o pedido vira 'já tem conta'", async () => {
    const dono = novoEmail("google");
    await cadastrar(dono, { senha: "senha-do-invasor-88", empresa: "Empresa do Invasor" });
    const linkDoInvasor = tokenDoUltimoEmail(dono);

    // Google continua funcionando e comprovando na hora. (Pelo botão de
    // /criar-empresa, que grava o cookie da empresa — `cadastroAberto: true`;
    // o "Entrar com Google" do /login recusa e-mail sem conta nem convite.)
    const g = await provisionUserFromGoogle({ email: dono, name: "Dono Google" }, { cadastroAberto: true, empresa: { nome: "Agro do Dono" } });
    timesCriados.push(g.teamId);
    const conta = await basePrisma.user.findUniqueOrThrow({ where: { email: dono } });
    expect(conta).toMatchObject({ id: g.userId, passwordHash: null });
    expect(conta.emailVerificadoEm).not.toBeNull();

    // Mesmo com o link e a senha certos, o pedido não vira outra conta nem mexe na do dono.
    expect(await confirmarCadastro(linkDoInvasor, "senha-do-invasor-88", { compararSenha })).toEqual({ ok: false, motivo: "ja_tem_conta" });
    expect(await basePrisma.cadastroPendente.count({ where: { email: dono } })).toBe(0);
    expect((await basePrisma.user.findUniqueOrThrow({ where: { email: dono } })).passwordHash).toBeNull();
  });
});

describe("login não revela se o e-mail tem conta (revisão do #177)", () => {
  it("a senha do PRÓPRIO pedido dá o mesmo resultado para e-mail com conta e sem conta, com o mesmo trabalho", async () => {
    const SENHA_ATACANTE = "senha-do-atacante-42";
    const SENHA_DONA = "senha-da-dona-de-verdade";
    const semConta = novoEmail("oraculo-sem-conta");
    const comConta = novoEmail("oraculo-com-conta");
    const semSenha = novoEmail("oraculo-so-google");
    const t = await basePrisma.team.create({ data: { name: `Time oráculo ${sufixo}` } });
    timesCriados.push(t.id);
    await basePrisma.user.create({ data: { teamId: t.id, name: "Dona", email: comConta, role: "owner", passwordHash: `hash:${SENHA_DONA}` } });
    await basePrisma.user.create({ data: { teamId: t.id, name: "Só Google", email: semSenha, role: "member" } });

    // (1) O atacante pede o cadastro nos três e-mails com a senha dele (no sem
    // conta, três vezes: vários pedidos pendentes no mesmo e-mail).
    for (let i = 0; i < 3; i++) expect((await cadastrar(semConta, { senha: SENHA_ATACANTE })).ok).toBe(true);
    expect((await cadastrar(comConta, { senha: SENHA_ATACANTE })).ok).toBe(true);
    expect((await cadastrar(semSenha, { senha: SENHA_ATACANTE })).ok).toBe(true);
    expect(await basePrisma.cadastroPendente.count({ where: { email: semConta } })).toBe(3);

    // (2) E tenta entrar com a mesma senha: mesma resposta e UMA comparação em todos.
    for (const email of [semConta, comConta, semSenha, novoEmail("oraculo-nada")]) {
      const comparar = vi.fn(compararSenha);
      expect(await conferirSenhaDoLogin(email, SENHA_ATACANTE, { compararSenha: comparar })).toBeNull();
      expect(comparar).toHaveBeenCalledTimes(1);
    }
    // Sem conta e conta sem senha: a comparação é contra o hash falso (o mesmo custo).
    const comparar = vi.fn(compararSenha);
    await conferirSenhaDoLogin(semSenha, SENHA_ATACANTE, { compararSenha: comparar });
    expect(comparar).toHaveBeenCalledWith(SENHA_ATACANTE, HASH_DE_SENHA_FALSO);

    // A dona entra com a senha dela (e-mail em maiúsculas também).
    expect((await conferirSenhaDoLogin(comConta.toUpperCase(), SENHA_DONA, { compararSenha }))?.email).toBe(comConta);
  });

  it("HASH_DE_SENHA_FALSO é um hash bcrypt VÁLIDO (60 caracteres, custo 10): comparar contra ele custa um bcrypt de verdade", () => {
    // O antigo tinha 65 caracteres e o bcryptjs devolvia `false` na hora (sem bcrypt).
    expect(HASH_DE_SENHA_FALSO).toHaveLength(60);
    expect(HASH_DE_SENHA_FALSO).toMatch(/^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/);
  });
});

describe("cota de e-mails de cadastro no fim: a tela não promete um link que não sai", () => {
  const DIA_MS = 24 * 60 * 60 * 1000;

  it("responde 'indisponível, use Registrar com Google' a todos, esconde a opção e não mexe no link que ainda vale", async () => {
    const email = novoEmail("cota");
    const r = await cadastrar(email);
    const antigo = tokenDoUltimoEmail(email);
    expect(await cadastroComSenhaDisponivel()).toBe(true);

    // Teto do dia = 1 e o contador de "cadastro" de hoje (Redis de TESTE) já passou dele.
    await rateLimit("email-plataforma:tipo:cadastro", 1e9, DIA_MS);
    configurar({ plataforma: true, PLATFORM_EMAIL_LIMITE_DIA: "1" });
    envio.plataforma.mockClear();

    expect(await cadastroComSenhaDisponivel()).toBe(false);
    // Igual para e-mail novo e para qualquer outro: é estado global.
    const novo = novoEmail("cota-novo");
    expect(await cadastrar(novo)).toEqual({ ok: false, motivo: "fechado", mensagem: MENSAGEM_INDISPONIVEL });
    expect(await basePrisma.cadastroPendente.count({ where: { email: novo } })).toBe(0);
    // Reenviar também recusa ANTES de trocar o link: o antigo continua valendo.
    expect(await reenviarConfirmacao(r.ok ? r.handle : null)).toMatchObject({ ok: false, motivo: "fechado" });
    await aguardarCadastros();
    expect(envio.plataforma).not.toHaveBeenCalled();
    expect(await verificarLinkDeCadastro(antigo)).toMatchObject({ valido: true });

    // Cota de volta: a opção volta.
    configurar({ plataforma: true });
    expect(await cadastroComSenhaDisponivel()).toBe(true);
  });

  it("reenviar: se o link novo não sai (SMTP), o antigo continua valendo", async () => {
    const email = novoEmail("reenvio-falha");
    const r = await cadastrar(email);
    const antigo = tokenDoUltimoEmail(email);
    envio.plataforma.mockRejectedValueOnce(new Error("SMTP fora do ar"));
    expect(await reenviarConfirmacao(r.ok ? r.handle : null)).toEqual({ ok: true });
    await aguardarCadastros();
    expect(envio.plataforma).toHaveBeenCalledTimes(2); // a confirmação e o reenvio que falhou
    expect(await verificarLinkDeCadastro(antigo)).toMatchObject({ valido: true });
    const c = await confirmarCadastro(antigo, SENHA, { compararSenha });
    expect(c.ok).toBe(true);
    if (c.ok) timesCriados.push(c.teamId);
  });
});

describe("limites que não se contornam trocando o endereço", () => {
  it("por e-mail: conta a CAIXA (sem +sufixo; no Gmail, sem pontos e googlemail = gmail)", async () => {
    const base = `cadcaixa${sufixo}${++seq}`;
    const variantes = [`${base}+1@gmail.com`, `${base.slice(0, 3)}.${base.slice(3)}@gmail.com`, `${base}+x@googlemail.com`];
    for (const e of variantes) expect((await cadastrar(e)).ok).toBe(true);
    expect(await cadastrar(`${base}@gmail.com`)).toMatchObject({ ok: false, motivo: "limite" });
  });

  it("por IP: no IPv6 conta o /64 inteiro", async () => {
    const h = () => Math.floor(Math.random() * 0xffff).toString(16);
    const prefixo = `2001:db8:${h()}:${h()}`;
    for (let i = 1; i <= CADASTRO_LIMITES.porIp.max; i++) {
      expect((await cadastrar(novoEmail("ipv6"), {}, `${prefixo}::${i.toString(16)}`)).ok).toBe(true);
    }
    // Outro endereço do MESMO /64: bloqueado.
    expect(await cadastrar(novoEmail("ipv6"), {}, `${prefixo}:${h()}:${h()}:${h()}:${h()}`)).toMatchObject({ ok: false, motivo: "limite" });
  });

  it("por IP no dia: um IP sozinho não leva a cota de cadastro do dia (10 por dia, abaixo dos 27 do padrão)", async () => {
    const ip = `10.99.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    // O dia deste IP já está cheio (Redis de TESTE), mas a hora não: barra pelo teto do dia.
    for (let i = 0; i < CADASTRO_LIMITES.porIpDia.max; i++) await rateLimit(`cadastro:ip-dia:${ip}`, 1e9, CADASTRO_LIMITES.porIpDia.janelaMs);
    expect(await cadastrar(novoEmail("ip-dia"), {}, ip)).toMatchObject({ ok: false, motivo: "limite" });
    expect(CADASTRO_LIMITES.porIpDia.max).toBeLessThan(27);
  });
});

describe("retenção: pedido não confirmado expira e é limpo", () => {
  it("apaga o que passou de 24 h com o link vencido; o recente fica", async () => {
    const velho = novoEmail("ret-velho");
    const recente = novoEmail("ret-recente");
    const vencidoRecente = novoEmail("ret-vencido-recente");
    await cadastrar(velho);
    await cadastrar(recente);
    await cadastrar(vencidoRecente);
    const antes = new Date(Date.now() - CADASTRO_VIDA_MAX_MS - 60 * 60_000);
    await basePrisma.cadastroPendente.updateMany({ where: { email: velho }, data: { createdAt: antes, expiresAt: new Date(antes.getTime() + 60_000) } });
    // Link vencido, mas dentro das 24 h: ainda dá para reenviar — fica.
    await basePrisma.cadastroPendente.updateMany({ where: { email: vencidoRecente }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    const r = await limparCadastrosPendentesVencidos();
    expect(r.apagados).toBeGreaterThanOrEqual(1);
    expect(await basePrisma.cadastroPendente.count({ where: { email: velho } })).toBe(0);
    expect(await basePrisma.cadastroPendente.count({ where: { email: recente } })).toBe(1);
    expect(await basePrisma.cadastroPendente.count({ where: { email: vencidoRecente } })).toBe(1);
  });
});
