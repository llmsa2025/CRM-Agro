#!/usr/bin/env node
/**
 * Cria (ou redefine a senha de) um usuário da plataforma.
 *
 * Bootstrap: sem isto não há como entrar depois que o login passou a existir —
 * o cadastro pela UI ainda não existe (é feature de Configurações → Equipe).
 *
 * Uso:
 *   node packages/db/scripts/criar-usuario.mjs <email> <nome> [teamId] [--papel admin|member|viewer]
 *   node packages/db/scripts/criar-usuario.mjs <email> <nome> --novo-time "<nome do time>"
 *
 * `--papel`: papel de quem ENTRA num time existente — administrador (padrão),
 * membro ou só leitura. Nunca "owner": o master é um só por time (quem criou;
 * `Team.masterId`) e só muda por `script de operação`. Conta que já
 * existe só troca a senha (o papel fica).
 *
 * `--novo-time`: cria um TIME NOVO com este usuário como DONO (o master) — igual ao
 * cadastro aberto pelo Google (funil "Vendas" com 5 etapas + meta do mês; ver
 * `seedNewTeam` em packages/core/src/auth/provisioning.ts). Serve para dar a
 * alguém um time próprio para testar, sem ver nada dos outros times. Recusa se
 * o e-mail já existe (não move ninguém de time).
 *
 * `--permitir-senha-curta`: aceita senha de 6 a 9 caracteres (conta de
 * demonstração combinada com o dono). O padrão continua exigindo 10.
 *
 * A senha NÃO vem por argumento de propósito: argumento de linha de comando
 * fica no histórico do shell e é visível em `ps`. É lida do stdin, sem eco.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import readline from "node:readline";
import { Writable } from "node:stream";

const args = process.argv.slice(2);
const permitirSenhaCurta = args.includes("--permitir-senha-curta");
const iNovoTime = args.indexOf("--novo-time");
const nomeNovoTime = iNovoTime >= 0 ? args[iNovoTime + 1]?.trim() : undefined;
const iPapel = args.indexOf("--papel");
const papel = iPapel >= 0 ? args[iPapel + 1]?.trim() : "admin";
const posicionais = args.filter(
  (a, i) => !a.startsWith("--") && !(iNovoTime >= 0 && i === iNovoTime + 1) && !(iPapel >= 0 && i === iPapel + 1),
);
const [email, nome, teamIdArg] = posicionais;
if (!email || !nome || (iNovoTime >= 0 && !nomeNovoTime) || (nomeNovoTime && teamIdArg) || !["admin", "member", "viewer"].includes(papel ?? "")) {
  console.error("uso: node packages/db/scripts/criar-usuario.mjs <email> <nome> [teamId] [--papel admin|member|viewer]");
  console.error('     node packages/db/scripts/criar-usuario.mjs <email> <nome> --novo-time "<nome do time>" [--permitir-senha-curta]');
  process.exit(1);
}

/** Etapas padrão do funil — espelha DEFAULT_STAGES de packages/core/src/auth/provisioning.ts. */
const ETAPAS_PADRAO = [
  { nome: "Novo", cor: "#6b7280" },
  { nome: "Contatado", cor: "#3b82f6" },
  { nome: "Qualificado", cor: "#8b5cf6" },
  { nome: "Proposta", cor: "#f59e0b" },
  { nome: "Fechado", cor: "#10b981" },
];

/**
 * Lê senha + confirmação.
 *
 * Dois modos, porque o comportamento do stdin difere:
 * - **Terminal**: uma única interface readline, sem eco (a saída é engolida por
 *   um Writable mudo). Reusar a MESMA interface importa — fechar e recriar sobre
 *   o mesmo stdin faz a segunda leitura nunca disparar.
 * - **Pipe** (`printf 'senha\nsenha\n' | node ...`): lê o stdin inteiro de uma
 *   vez e separa por linha. Tentar readline duas vezes aqui trava o processo
 *   (await que nunca resolve, exit 13).
 */
async function lerSenhas() {
  if (!process.stdin.isTTY) {
    const bruto = await new Promise((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (buf += c));
      process.stdin.on("end", () => resolve(buf));
    });
    const linhas = bruto.split("\n").map((l) => l.trim());
    return [linhas[0] ?? "", linhas[1] ?? ""];
  }

  let mudo = false;
  const saida = new Writable({
    write(chunk, _enc, cb) {
      if (!mudo) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: saida, terminal: true });
  const perguntar = (prompt) =>
    new Promise((resolve) => {
      mudo = false;
      process.stdout.write(prompt);
      mudo = true;
      rl.question("", (r) => {
        process.stdout.write("\n");
        resolve(r.trim());
      });
    });
  const senha = await perguntar("Senha: ");
  const confirma = await perguntar("Confirme: ");
  rl.close();
  return [senha, confirma];
}

const prisma = new PrismaClient();
try {
  const [senha, confirma] = await lerSenhas();
  const minimo = permitirSenhaCurta ? 6 : 10;
  if (senha.length < minimo) {
    console.error(`Senha muito curta — use ao menos ${minimo} caracteres.`);
    process.exit(1);
  }
  if (senha.length < 10) console.warn("Aviso: senha com menos de 10 caracteres (--permitir-senha-curta).");
  if (senha !== confirma) {
    console.error("As senhas não conferem.");
    process.exit(1);
  }

  const normalizadoNovo = email.trim().toLowerCase();
  if (nomeNovoTime) {
    if (await prisma.user.findUnique({ where: { email: normalizadoNovo } })) {
      console.error(`${normalizadoNovo} já existe — não movo ninguém de time. Use sem --novo-time para só trocar a senha.`);
      process.exit(1);
    }
    const passwordHashNovo = await bcrypt.hash(senha, 12);
    // Tudo numa transação: ou nasce o time completo com o dono, ou nada.
    const { team, user } = await prisma.$transaction(async (tx) => {
      const team = await tx.team.create({ data: { name: nomeNovoTime } });
      const user = await tx.user.create({
        data: { teamId: team.id, name: nome, email: normalizadoNovo, passwordHash: passwordHashNovo, role: "owner" },
      });
      // Quem cria o time é o MASTER dele (um só; ver packages/core/src/auth/equipe.ts).
      await tx.team.update({ where: { id: team.id }, data: { masterId: user.id } });
      const funil = await tx.funnel.create({ data: { teamId: team.id, nome: "Vendas", tipo: "pre_vendas" } });
      for (let i = 0; i < ETAPAS_PADRAO.length; i++) {
        await tx.stage.create({ data: { teamId: team.id, funnelId: funil.id, nome: ETAPAS_PADRAO[i].nome, ordem: i, cor: ETAPAS_PADRAO[i].cor } });
      }
      const d = new Date();
      const periodo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      await tx.goal.create({ data: { teamId: team.id, ownerId: user.id, periodo, metaValor: 0, toquesPorDia: 0 } });
      return { team, user };
    });
    console.log(`ok: ${user.email} (${user.name}) é DONO do time novo "${team.name}" (${team.id})`);
    process.exit(0);
  }

  const teamId = teamIdArg ?? process.env.DEV_TEAM_ID;
  if (!teamId) {
    console.error("teamId não informado e DEV_TEAM_ID ausente no ambiente.");
    process.exit(1);
  }
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) {
    console.error(`Time ${teamId} não existe.`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(senha, 12);
  const normalizado = email.trim().toLowerCase();

  const user = await prisma.user.upsert({
    where: { email: normalizado },
    update: { passwordHash, name: nome },
    // Nunca "owner" (o master é um só por time): o papel escolhido em --papel.
    create: { email: normalizado, name: nome, teamId, passwordHash, role: papel },
  });

  console.log(`ok: ${user.email} (${user.name}, ${user.role}) no time ${team.name}`);
} finally {
  await prisma.$disconnect();
}
