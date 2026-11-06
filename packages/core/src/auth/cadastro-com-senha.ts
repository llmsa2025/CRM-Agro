import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "@crmagro/config";
import { basePrisma } from "@crmagro/db";
import { logger } from "../logger/index";
import { chaveDoIp, peekRateLimit, rateLimit } from "../rate-limit/service";
import { EMAIL_MAX, caixaDoEmail, ehEmailSimples } from "../email/endereco";
import { modeloAvisoCadastroExistente, modeloConfirmarCadastro } from "../email/modelos";
import { cabeEmailDaPlataforma, enviarEmailDaPlataforma, erroParaLog, estadoDaPlataforma, mascararEmail, rodapeDeResposta } from "../email/plataforma";
import { cadastroEmpresaAberto, dadosEmpresaSchema, type DadosEmpresaInput } from "./empresa";
import type { HashDeSenha } from "./invites";
import type { CompararSenha } from "./login-senha";
import { motivoSenhaFraca } from "./senha";
import { seedNewTeam } from "./seed-time";

/**
 * Criar a conta da empresa com E-MAIL E SENHA — com CONFIRMAÇÃO OBRIGATÓRIA do
 * e-mail pelo remetente da plataforma (`CRM Agro <noreply@crmagro.example>`).
 *
 * Por que a confirmação (auditoria do #148): com senha e sem prova do e-mail,
 * qualquer um criava a conta com o e-mail de OUTRA pessoa e "reservava" o
 * endereço (sequestro de antemão). Agora:
 *
 * 1. `iniciarCadastroComSenha` valida o formulário, aplica os limites (IP e
 *    e-mail) e calcula o hash da senha. NADA de time nem de usuário nasce: o
 *    pedido vai para `CadastroPendente` (só o sha256 do token) e o link sai por
 *    e-mail. Responde SEMPRE igual e no mesmo tempo, exista ou não conta com o
 *    e-mail: a busca e o envio rodam em segundo plano. Se o e-mail já tem
 *    conta, o dono recebe "alguém tentou criar conta com o seu e-mail" (em vez
 *    de a tela revelar).
 * 2. `confirmarCadastro` pede o TOKEN do link (prova a caixa de e-mail) E a
 *    SENHA do cadastro (prova quem preencheu). Os dois juntos fecham os dois
 *    golpes: quem usou o e-mail alheio não tem o link; e o dono do e-mail, se
 *    clicar no link de um cadastro que não fez, não sabe a senha — não dá para
 *    enganá-lo a "confirmar" a conta de outra pessoa. Também para o robô de
 *    segurança do provedor de e-mail, que abre os links (o GET só mostra a tela).
 *    Uso único: a confirmação apaga o pedido e todos os outros do mesmo e-mail.
 * 3. Vários pedidos para o mesmo e-mail convivem (cada um com o seu link e a
 *    sua senha): um pedido de outra pessoa não impede o dono verdadeiro, nem
 *    dá acesso a quem o criou.
 * 4. A conta nasce com `emailVerificadoEm` preenchido (a caixa foi provada).
 * 5. O LOGIN não olha estes pedidos (ver `auth/login-senha.ts`): quem ainda
 *    não confirmou vê "e-mail ou senha inválidos", como qualquer outro caso.
 * 6. A cota de e-mails de cadastro é GLOBAL e acaba: antes de aceitar (e de
 *    reenviar), consulta se ainda cabe um e-mail; se não, responde a todos
 *    "indisponível agora, use Registrar com Google" e a opção some da tela.
 *    Os limites de pedir e de reenviar são fail-closed (Redis fora = indisponível).
 *
 * O bcrypt mora no web: `hashSenha`/`compararSenha` são injetados.
 * Porta aberta só com o remetente da plataforma OK (`cadastroEmpresaComSenhaAberto`).
 */

/** Validade do link de confirmação (reenviar gera outro link com a mesma validade). */
export const CONFIRMACAO_TTL_MS = 2 * 60 * 60 * 1000;
/** Vida máxima de um pedido: depois disso não reenvia mais (começa de novo) e a retenção apaga. */
export const CADASTRO_VIDA_MAX_MS = 24 * 60 * 60 * 1000;
const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
const QUINZE_MIN_MS = 15 * 60 * 1000;

/**
 * Limites (Redis, janela fixa). Os de pedir e de reenviar (cada um gasta um
 * e-mail da cota da plataforma) são FAIL-CLOSED: Redis fora = indisponível.
 * IP: IPv6 conta pelo /64 (`chaveDoIp`). E-mail: pela CAIXA (`caixaDoEmail`:
 * sem `+sufixo`, e sem pontos no Gmail).
 */
export const CADASTRO_LIMITES = {
  /** Cadastros por IP (cada um vira um e-mail da plataforma). */
  porIp: { max: 5, janelaMs: HORA_MS },
  /** Teto do dia por IP: um IP sozinho não leva a cota de cadastro do dia inteiro. */
  porIpDia: { max: 10, janelaMs: DIA_MS },
  /** Cadastros por e-mail de destino (contado ANTES de saber se tem conta). */
  porEmail: { max: 3, janelaMs: HORA_MS },
  /** Reenvios do mesmo pedido. */
  reenvioPorCadastro: { max: 3, janelaMs: HORA_MS },
  reenvioPorIp: { max: 10, janelaMs: HORA_MS },
  /** Tentativas de confirmar (cada uma roda o bcrypt). */
  confirmarPorIp: { max: 10, janelaMs: QUINZE_MIN_MS },
  /** Senha errada na confirmação, por pedido. */
  confirmarFalhasPorCadastro: { max: 5, janelaMs: QUINZE_MIN_MS },
} as const;

const TOKEN_PREFIX = "cfe_";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function gerarToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}
/** Chave de limite pela CAIXA do e-mail, sem o endereço em claro no Redis. */
function chaveDoEmail(email: string): string {
  return createHash("sha256").update(caixaDoEmail(email)).digest("hex").slice(0, 32);
}
/** Base pública do link (AUTH_URL, senão APP_PUBLIC_URL), sem a barra final. */
function baseDoLink(): string | null {
  const base = env.AUTH_URL ?? env.APP_PUBLIC_URL ?? null;
  return base ? base.replace(/\/$/, "") : null;
}

/**
 * A opção "Registrar com e-mail" está disponível? Só com o remetente da
 * plataforma OK (sem ele não há como provar o e-mail: a opção some — fail-safe)
 * e com a base do link. `CADASTRO_EMPRESA_SENHA=off` esconde (trava da
 * operação); `CADASTRO_EMPRESA=off` fecha toda criação de empresa.
 */
export function cadastroEmpresaComSenhaAberto(): boolean {
  return cadastroEmpresaAberto() && env.CADASTRO_EMPRESA_SENHA !== "off" && estadoDaPlataforma().estado === "ok" && baseDoLink() !== null;
}

/** Ainda cabe um e-mail de cadastro hoje? Estado GLOBAL (não diz nada de um e-mail); Redis fora = não. */
function cabeEmailDeCadastro(): Promise<boolean> {
  return cabeEmailDaPlataforma("cadastro", { falhaFecha: true });
}

/**
 * A tela mostra a opção "Registrar com e-mail"? `cadastroEmpresaComSenhaAberto`
 * e ainda cabe um e-mail de cadastro hoje (a cota é global e acaba — sem esta
 * conferência, a pessoa via "Confira o seu e-mail" e o link nunca chegava).
 */
export async function cadastroComSenhaDisponivel(): Promise<boolean> {
  return cadastroEmpresaComSenhaAberto() && (await cabeEmailDeCadastro());
}

/** Resposta de quando o envio está indisponível (cota do dia no fim ou Redis fora): igual para todos. */
export const MENSAGEM_INDISPONIVEL = "O cadastro com e-mail e senha está indisponível agora. Use \"Registrar com Google\" ou tente de novo mais tarde.";
const MENSAGEM_ENVIO_INDISPONIVEL = "O envio de e-mails está indisponível agora. Tente mais tarde ou use \"Registrar com Google\".";

/** Limite fail-closed de pedir e de reenviar: "ok", "limite" ou "indisponivel" (Redis fora). */
async function limitar(chave: string, L: { max: number; janelaMs: number }): Promise<"ok" | "limite" | "indisponivel"> {
  const r = await rateLimit(chave, L.max, L.janelaMs, { falhaFecha: true });
  return r.allowed ? "ok" : r.semRedis ? "indisponivel" : "limite";
}

// ─── 1. Pedir o cadastro ──────────────────────────────────────────────────────

const dadosDoCadastroSchema = z.object({
  empresa: dadosEmpresaSchema,
  nome: z.string().trim().min(2).max(120),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(EMAIL_MAX)
    .email()
    .refine((e) => ehEmailSimples(e)),
});

export type CadastroComSenhaInput = {
  empresa: DadosEmpresaInput;
  nome: string;
  email: string;
  senha: string;
  confirmar: string;
};

export type CampoDoCadastro = "empresa" | "cnpj" | "cidade" | "estado" | "nome" | "email" | "senha" | "confirmar";

export type ResultadoDoCadastro =
  /** `handle`: id do pedido, para o "reenviar" (cookie). Vem sempre, exista ou não conta com o e-mail. */
  | { ok: true; handle: string; email: string }
  | { ok: false; motivo: "fechado" | "limite" | "invalido"; mensagem: string; campo?: CampoDoCadastro };

const MENSAGEM_DO_CAMPO: Record<Exclude<CampoDoCadastro, "senha" | "confirmar">, string> = {
  empresa: "Informe o nome da empresa (ao menos 2 letras).",
  cnpj: "O CNPJ precisa ter 14 dígitos (ou deixe em branco).",
  cidade: "A cidade pode ter no máximo 80 caracteres.",
  estado: "A UF tem 2 letras, como MT ou GO.",
  nome: "Informe o seu nome.",
  email: "Confira o e-mail: ele parece incompleto.",
};

function campoDoErro(e: z.ZodError): Exclude<CampoDoCadastro, "senha" | "confirmar"> {
  const [a, b] = e.issues[0]?.path ?? [];
  if (a === "empresa") return b === "cnpj" || b === "cidade" || b === "estado" ? b : "empresa";
  return a === "nome" ? "nome" : "email";
}

export const MENSAGEM_LIMITE = "Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.";

/** Trabalho em segundo plano (busca da conta, gravação e envio) — os testes esperam por ele. */
const tarefas = new Set<Promise<void>>();
function emSegundoPlano(nome: string, fn: () => Promise<void>): void {
  const t = fn().catch((e: unknown) => {
    logger.warn({ err: erroParaLog(e), etapa: nome }, "[cadastro-senha] falha em segundo plano");
  });
  tarefas.add(t);
  void t.finally(() => tarefas.delete(t));
}

/** Espera o trabalho em segundo plano terminar (testes, encerramento). */
export async function aguardarCadastros(): Promise<void> {
  while (tarefas.size) await Promise.allSettled([...tarefas]);
}

/**
 * Recebe o formulário de "Registrar com e-mail". Valida, aplica os limites
 * e calcula o hash; a busca da conta, a gravação do pedido e o e-mail rodam em
 * SEGUNDO PLANO. A resposta de sucesso é a mesma com ou sem conta no e-mail.
 */
export async function iniciarCadastroComSenha(
  input: CadastroComSenhaInput,
  opts: { ip?: string | null; hashSenha: HashDeSenha; aberto?: boolean },
): Promise<ResultadoDoCadastro> {
  if (!(opts.aberto ?? cadastroEmpresaComSenhaAberto())) {
    return { ok: false, motivo: "fechado", mensagem: "O cadastro com e-mail e senha não está disponível agora. Use \"Registrar com Google\" ou fale com o suporte." };
  }
  // Cota de e-mails de cadastro do dia no fim: nada de prometer um link que não sai.
  if (!(await cabeEmailDeCadastro())) return { ok: false, motivo: "fechado", mensagem: MENSAGEM_INDISPONIVEL };
  const r = dadosDoCadastroSchema.safeParse({ empresa: input.empresa, nome: input.nome, email: input.email });
  if (!r.success) {
    const campo = campoDoErro(r.error);
    return { ok: false, motivo: "invalido", campo, mensagem: MENSAGEM_DO_CAMPO[campo] };
  }
  const d = r.data;
  const senha = input.senha ?? "";
  const fraca = motivoSenhaFraca(senha, { email: d.email, nomes: [d.nome, d.empresa.nome] });
  if (fraca) return { ok: false, motivo: "invalido", campo: "senha", mensagem: fraca };
  if (senha !== (input.confirmar ?? "")) {
    return { ok: false, motivo: "invalido", campo: "confirmar", mensagem: "As senhas não coincidem. Digite a mesma senha nos dois campos." };
  }

  // Limites ANTES do bcrypt e da busca: por IP (robô; na hora e no dia) e por
  // caixa de destino (não vira rajada de e-mails para a mesma caixa). O do
  // e-mail conta igual para quem tem e quem não tem conta — não revela nada.
  const limites: Array<[string, { max: number; janelaMs: number }]> = [];
  if (opts.ip) {
    const ip = chaveDoIp(opts.ip);
    limites.push([`cadastro:ip:${ip}`, CADASTRO_LIMITES.porIp], [`cadastro:ip-dia:${ip}`, CADASTRO_LIMITES.porIpDia]);
  }
  limites.push([`cadastro:email:${chaveDoEmail(d.email)}`, CADASTRO_LIMITES.porEmail]);
  for (const [chave, L] of limites) {
    const r = await limitar(chave, L);
    if (r === "indisponivel") return { ok: false, motivo: "fechado", mensagem: MENSAGEM_INDISPONIVEL };
    if (r === "limite") return { ok: false, motivo: "limite", mensagem: MENSAGEM_LIMITE };
  }

  // O hash sai SEMPRE (mesmo tempo com ou sem conta) e a senha em claro não
  // vai para o segundo plano.
  const passwordHash = await opts.hashSenha(senha);
  const handle = randomUUID();
  emSegundoPlano("pedido", () => registrarPedido(handle, d, passwordHash));
  return { ok: true, handle, email: d.email };
}

async function registrarPedido(handle: string, d: z.infer<typeof dadosDoCadastroSchema>, passwordHash: string): Promise<void> {
  const conta = await basePrisma.user.findUnique({ where: { email: d.email }, select: { name: true } });
  if (conta) {
    // E-mail que já tem conta: nada é criado; o DONO fica sabendo por e-mail.
    await avisarDonoDoEmail(d.email, conta.name);
    return;
  }
  const token = gerarToken();
  await basePrisma.cadastroPendente.create({
    data: {
      id: handle,
      email: d.email,
      nome: d.nome,
      passwordHash,
      empresaNome: d.empresa.nome,
      empresaCnpj: d.empresa.cnpj ?? null,
      empresaCidade: d.empresa.cidade ?? null,
      empresaEstado: d.empresa.estado ?? null,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + CONFIRMACAO_TTL_MS),
    },
  });
  await enviarLinkDeConfirmacao({ email: d.email, token });
}

/**
 * Manda o link. `true` = o SMTP aceitou; `false` = não saiu (limite da cota,
 * erro do SMTP, remetente desligado, sem a base do link) — já registrado no log.
 * O e-mail tem texto FIXO: nada do formulário anônimo vai para a caixa alheia.
 */
async function enviarLinkDeConfirmacao(p: { email: string; token: string }): Promise<boolean> {
  const base = baseDoLink();
  if (!base) {
    logger.warn("[cadastro-senha] AUTH_URL/APP_PUBLIC_URL ausentes — link de confirmação não montado");
    return false;
  }
  const m = modeloConfirmarCadastro({
    email: p.email,
    link: `${base}/confirmar-email?token=${encodeURIComponent(p.token)}`,
    validadeHoras: Math.round(CONFIRMACAO_TTL_MS / HORA_MS),
    resposta: rodapeDeResposta(),
  });
  try {
    // SÓ pelo remetente da plataforma: não há time (nem caixa de time) ainda.
    const enviado = await enviarEmailDaPlataforma({ to: p.email, ...m, tipo: "cadastro" });
    if (!enviado) logger.warn({ para: mascararEmail(p.email) }, "[cadastro-senha] remetente da plataforma desligado: confirmação não enviada");
    return enviado;
  } catch (e) {
    logger.warn({ para: mascararEmail(p.email), err: erroParaLog(e) }, "[cadastro-senha] falha ao enviar a confirmação");
    return false;
  }
}

async function avisarDonoDoEmail(email: string, nome: string | null): Promise<void> {
  const base = baseDoLink();
  if (!base) return;
  const m = modeloAvisoCadastroExistente({
    nome,
    email,
    linkEntrar: `${base}/login`,
    linkEsqueci: `${base}/esqueci-senha`,
    resposta: rodapeDeResposta(),
  });
  try {
    await enviarEmailDaPlataforma({ to: email, ...m, tipo: "cadastro" });
  } catch (e) {
    logger.warn({ para: mascararEmail(email), err: erroParaLog(e) }, "[cadastro-senha] falha ao avisar o dono do e-mail");
  }
}

// ─── 2. Reenviar o link ───────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Reenviar o link": gera um link NOVO para o pedido `handle` (o antigo morre
 * SÓ SE o novo sair) e renova a validade. O `handle` vem do cookie de quem fez
 * o cadastro. Responde igual exista ou não o pedido (o e-mail pode ter conta —
 * ver `iniciarCadastroComSenha`); o envio roda em segundo plano. Pedido com
 * mais de 24 h não reenvia: começa de novo. Sem cota de e-mail no dia (ou com
 * o Redis fora): "indisponível", antes de mexer no link que ainda vale.
 */
export async function reenviarConfirmacao(
  handle: string | null | undefined,
  opts: { ip?: string | null; aberto?: boolean } = {},
): Promise<{ ok: true } | { ok: false; motivo: "fechado" | "limite"; mensagem: string }> {
  if (!(opts.aberto ?? cadastroEmpresaComSenhaAberto())) {
    return { ok: false, motivo: "fechado", mensagem: MENSAGEM_ENVIO_INDISPONIVEL };
  }
  if (!(await cabeEmailDeCadastro())) return { ok: false, motivo: "fechado", mensagem: MENSAGEM_ENVIO_INDISPONIVEL };
  const id = (handle ?? "").trim();
  if (!UUID.test(id)) return { ok: true };
  if (opts.ip) {
    const porIp = await limitar(`cadastro:reenvio:ip:${chaveDoIp(opts.ip)}`, CADASTRO_LIMITES.reenvioPorIp);
    if (porIp === "indisponivel") return { ok: false, motivo: "fechado", mensagem: MENSAGEM_ENVIO_INDISPONIVEL };
    if (porIp === "limite") return { ok: false, motivo: "limite", mensagem: MENSAGEM_LIMITE };
  }
  const porPedido = await limitar(`cadastro:reenvio:${id}`, CADASTRO_LIMITES.reenvioPorCadastro);
  if (porPedido === "indisponivel") return { ok: false, motivo: "fechado", mensagem: MENSAGEM_ENVIO_INDISPONIVEL };
  if (porPedido === "limite") return { ok: false, motivo: "limite", mensagem: "Você já pediu vários links. Confira a caixa de spam ou aguarde alguns minutos." };
  emSegundoPlano("reenvio", () => reenviar(id));
  return { ok: true };
}

async function reenviar(id: string): Promise<void> {
  const agora = Date.now();
  const p = await basePrisma.cadastroPendente.findUnique({ where: { id } });
  if (!p || p.createdAt.getTime() < agora - CADASTRO_VIDA_MAX_MS) return;
  if (await basePrisma.user.findUnique({ where: { email: p.email }, select: { id: true } })) {
    // A conta já nasceu por outro caminho (Google, convite): o pedido não serve mais.
    await basePrisma.cadastroPendente.deleteMany({ where: { email: p.email } });
    return;
  }
  const token = gerarToken();
  const novoHash = hashToken(token);
  const { count } = await basePrisma.cadastroPendente.updateMany({
    where: { id, tokenHash: p.tokenHash },
    data: { tokenHash: novoHash, expiresAt: new Date(agora + CONFIRMACAO_TTL_MS) },
  });
  if (count !== 1) return; // confirmado ou reenviado no meio do caminho
  if (!(await enviarLinkDeConfirmacao({ email: p.email, token }))) {
    // O link novo não saiu (cota, SMTP): o antigo volta a valer — a pessoa não
    // fica sem link nenhum. Só se ninguém trocou o link de novo nesse meio tempo.
    await basePrisma.cadastroPendente.updateMany({ where: { id, tokenHash: novoHash }, data: { tokenHash: p.tokenHash, expiresAt: p.expiresAt } });
  }
}

// ─── 3. Confirmar ─────────────────────────────────────────────────────────────

/** O link é válido? (a tela mostra para qual e-mail e empresa, antes de pedir a senha). */
export async function verificarLinkDeCadastro(rawToken: string | null | undefined): Promise<{ valido: true; email: string; empresa: string } | { valido: false }> {
  const token = (rawToken ?? "").trim();
  if (!token) return { valido: false };
  const p = await basePrisma.cadastroPendente.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { email: true, empresaNome: true, expiresAt: true },
  });
  if (!p || p.expiresAt.getTime() <= Date.now()) return { valido: false };
  return { valido: true, email: p.email, empresa: p.empresaNome };
}

export type ResultadoDaConfirmacao =
  | { ok: true; email: string; userId: string; teamId: string }
  | { ok: false; motivo: "invalido" | "senha" | "limite" | "ja_tem_conta" | "fechado" };

/**
 * Confirma o cadastro: token do link (a caixa) + senha do cadastro (quem
 * preencheu). Só então nasce o time com o nome da empresa, o dono (master, com
 * o e-mail comprovado) e os padrões — numa transação que também apaga o pedido
 * (uso único) e todos os outros pedidos do mesmo e-mail.
 */
export async function confirmarCadastro(
  rawToken: string,
  senha: string,
  opts: { ip?: string | null; compararSenha: CompararSenha; aberto?: boolean },
): Promise<ResultadoDaConfirmacao> {
  if (!(opts.aberto ?? cadastroEmpresaAberto())) return { ok: false, motivo: "fechado" };
  const token = (rawToken ?? "").trim();
  if (!token) return { ok: false, motivo: "invalido" };
  // Confirmar não manda e-mail e exige o token do link: o limite segue
  // fail-open (Redis fora não impede quem tem o link de ativar a conta).
  if (opts.ip) {
    const porIp = await rateLimit(`cadastro:confirmar:ip:${chaveDoIp(opts.ip)}`, CADASTRO_LIMITES.confirmarPorIp.max, CADASTRO_LIMITES.confirmarPorIp.janelaMs);
    if (!porIp.allowed) return { ok: false, motivo: "limite" };
  }
  const p = await basePrisma.cadastroPendente.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!p || p.expiresAt.getTime() <= Date.now()) return { ok: false, motivo: "invalido" };

  const L = CADASTRO_LIMITES.confirmarFalhasPorCadastro;
  const chaveFalhas = `cadastro:confirmar:falha:${p.id}`;
  if (!(await peekRateLimit(chaveFalhas, L.max, L.janelaMs)).allowed) return { ok: false, motivo: "limite" };
  if (!(await opts.compararSenha(senha ?? "", p.passwordHash))) {
    await rateLimit(chaveFalhas, L.max, L.janelaMs);
    return { ok: false, motivo: "senha" };
  }

  const agora = new Date();
  const r = await basePrisma
    .$transaction(async (tx): Promise<ResultadoDaConfirmacao> => {
      // Uso único: dois cliques ao mesmo tempo — só um apaga o pedido.
      const { count } = await tx.cadastroPendente.deleteMany({ where: { id: p.id, tokenHash: p.tokenHash, expiresAt: { gt: agora } } });
      if (count !== 1) return { ok: false, motivo: "invalido" };
      // Os outros pedidos deste e-mail (de outra pessoa, ou tentativas antigas) morrem junto.
      await tx.cadastroPendente.deleteMany({ where: { email: p.email } });
      if (await tx.user.findUnique({ where: { email: p.email }, select: { id: true } })) return { ok: false, motivo: "ja_tem_conta" };
      // Bootstrap de tenant (sem time no contexto ainda): basePrisma com teamId explícito.
      const team = await tx.team.create({
        data: { name: p.empresaNome, cnpj: p.empresaCnpj, cidade: p.empresaCidade, estado: p.empresaEstado },
      });
      const user = await tx.user.create({
        data: {
          teamId: team.id,
          name: p.nome,
          email: p.email,
          role: "owner",
          passwordHash: p.passwordHash,
          // A caixa foi provada pelo link: a conta nasce comprovada (o login
          // Google do mesmo e-mail depois NÃO apaga a senha).
          emailVerificadoEm: agora,
        },
      });
      // Quem cria a empresa é o MASTER do time (um só; ver auth/equipe.ts).
      await tx.team.update({ where: { id: team.id }, data: { masterId: user.id } });
      await seedNewTeam(team.id, user.id, tx);
      return { ok: true, email: p.email, userId: user.id, teamId: team.id };
    })
    .catch((e: unknown): ResultadoDaConfirmacao => {
      // Corrida com outro cadastro do mesmo e-mail (unique): nada foi criado.
      if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") return { ok: false, motivo: "ja_tem_conta" };
      throw e;
    });
  if (r.ok) logger.info({ para: mascararEmail(r.email), teamId: r.teamId }, "[cadastro-senha] conta da empresa criada (e-mail confirmado)");
  return r;
}

// ─── 4. Retenção ──────────────────────────────────────────────────────────────

/**
 * Apaga pedido que não pode mais ser confirmado nem reenviado: mais velho que
 * a vida máxima (24 h) E com o link vencido. Roda no job de retenção do worker.
 */
export async function limparCadastrosPendentesVencidos(opts: { agora?: Date } = {}): Promise<{ apagados: number }> {
  const agora = opts.agora ?? new Date();
  const { count } = await basePrisma.cadastroPendente.deleteMany({
    where: { createdAt: { lt: new Date(agora.getTime() - CADASTRO_VIDA_MAX_MS) }, expiresAt: { lt: agora } },
  });
  if (count) logger.info({ apagados: count }, "[retencao] cadastros com senha não confirmados apagados");
  return { apagados: count };
}
