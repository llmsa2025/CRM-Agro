#!/usr/bin/env node
/**
 * Seed de DEMONSTRAÇÃO do CRM Agro: um time fictício com contatos do agro, funil com negócios, conversas de
 * WhatsApp e e-mail, campanhas, agenda e fluxos de automação. Serve para conhecer o produto e para tirar os
 * prints do README. TODOS os dados são inventados: nomes, fazendas, telefones (sequenciais, 99999-xxxx)
 * e e-mails (domínio .example).
 *
 * Uso:
 *   pnpm db:seed:demo            # cria o time demo (recusa se ele já existe)
 *   pnpm db:seed:demo --reset    # apaga o time demo e cria de novo
 *
 * Login do demo: demo@crmagro.example / DemoCrmAgro2026! (ou o valor de DEMO_SENHA, se definido).
 *
 * Só roda contra banco local (localhost/127.0.0.1) a não ser que SEED_DEMO_PERMITIR_REMOTO=1.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const url = process.env.DATABASE_URL ?? "";
const local = /@(localhost|127\.0\.0\.1|postgres)(:|\/)/.test(url);
if (!local && process.env.SEED_DEMO_PERMITIR_REMOTO !== "1") {
  console.error("Recusado: DATABASE_URL não aponta para um banco local. O usuário demo é dono do time e a senha padrão é pública.\nPara forçar num ambiente de teste, use SEED_DEMO_PERMITIR_REMOTO=1 e defina DEMO_SENHA com uma senha sua.");
  process.exit(1);
}

const TEAM = "00000000-0000-0000-0000-00000000de01";
const EMAIL = "demo@crmagro.example";
// A senha do demo é pública (está no README). Em qualquer ambiente que não seja só seu, defina DEMO_SENHA.
const SENHA = process.env.DEMO_SENHA ?? "DemoCrmAgro2026!";
const prisma = new PrismaClient();

// ---- datas (fuso de Brasília, UTC-3) ---------------------------------------------------------------
function local3(y, m, d, hh = 9, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh + 3, mm));
}
const partes = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" })
  .formatToParts(new Date())
  .reduce((a, p) => ({ ...a, [p.type]: Number(p.value) }), {});
const HOJE = { y: partes.year, m: partes.month, d: partes.day };
const hoje = (hh, mm = 0) => local3(HOJE.y, HOJE.m, HOJE.d, hh, mm);
const diasAtras = (n, hh = 10, mm = 0) => {
  const t = local3(HOJE.y, HOJE.m, HOJE.d, hh, mm);
  t.setUTCDate(t.getUTCDate() - n);
  return t;
};
const diasFrente = (n, hh = 10, mm = 0) => diasAtras(-n, hh, mm);

// ---- dados fictícios -------------------------------------------------------------------------------
// Centro aproximado de cada cidade (lat, lng). O Mapa precisa de coordenada.
const CIDADES = {
  Sorriso: [-12.545, -55.72], Sinop: [-11.865, -55.505], "Lucas do Rio Verde": [-13.05, -55.91], "Nova Mutum": [-13.83, -56.08],
  "Primavera do Leste": [-15.56, -54.3], "Rondonópolis": [-16.47, -54.635], "Campo Verde": [-15.545, -55.165], "Cuiabá": [-15.6, -56.1],
  Sapezal: [-13.54, -58.81], Diamantino: [-14.41, -56.44], "Rio Verde": [-17.79, -50.92], "Jataí": [-17.88, -51.72],
  Dourados: [-22.22, -54.81], Maracaju: [-21.61, -55.17], "Luís Eduardo Magalhães": [-12.09, -45.8], Uberaba: [-19.75, -47.93],
  Cascavel: [-24.96, -53.46], Londrina: [-23.31, -51.16],
};

// [nome, empresa, cidade, uf, relacionamento, interesse, produtor, agroTipos, tags, diasDesdeCadastro]
const CONTATOS = [
  ["Helena Duarte", "Fazenda Horizonte Verde", "Sorriso", "MT", "cliente", "interessado", "produtor", ["produtor", "fazenda"], ["soja", "milho"], 45],
  ["Ricardo Nogueira", "Agropecuária Vale Dourado", "Sinop", "MT", "ja_conversou", "talvez", "produtor", ["produtor", "fazenda"], ["soja"], 40],
  ["Tereza Viana", "Fazenda Santa Aurora", "Rondonópolis", "MT", "ja_conversou", "interessado", "produtor", ["produtor", "fazenda"], ["milho"], 38],
  ["Otávio Camargo", "Agro Campo Alto", "Lucas do Rio Verde", "MT", "cliente", "interessado", "produtor", ["produtor"], ["soja", "algodão"], 60],
  ["Beatriz Montenegro", "Algodoeira Fibra Nobre", "Primavera do Leste", "MT", "ja_conversou", "interessado", "provavel_produtor", ["algodoeira"], ["algodão"], 33],
  ["Eduardo Tavares", "Fazenda Rio Claro", "Nova Mutum", "MT", "cliente", "interessado", "produtor", ["produtor", "fazenda"], ["milho"], 70],
  ["Denise Prado", "Insumos Grão Forte", "Lucas do Rio Verde", "MT", "ja_conversou", "talvez", "nao_produtor", [], ["revenda"], 28],
  ["Sérgio Albuquerque", "Fazenda Novo Horizonte", "Campo Verde", "MT", "ja_conversou", "interessado", "produtor", ["produtor", "fazenda"], ["soja"], 25],
  ["Márcia Rezende", "Armazéns Silo Central", "Sorriso", "MT", "ja_conversou", "talvez", "nao_produtor", ["armazem"], ["revenda"], 24],
  ["Luiz Fernandes", "Fazenda Três Irmãos", "Diamantino", "MT", "ja_conversou", "interessado", "produtor", ["produtor", "fazenda"], ["soja", "milho"], 22],
  ["Leandra Bastos", "Fazenda Santa Clara", "Sapezal", "MT", "novo", "nao_avaliado", "produtor", ["produtor", "fazenda"], ["algodão"], 2],
  ["Otto Brandão", "Fazenda Três Lagoas", "Sinop", "MT", "novo", "nao_avaliado", "produtor", ["produtor"], ["soja"], 3],
  ["Heloísa Moura", "Agropecuária Campos Gerais", "Sinop", "MT", "novo", "nao_avaliado", "produtor", ["produtor", "pecuaria"], ["milho", "feira"], 3],
  ["Rosana Cavalcante", "Sementes Planalto", "Rondonópolis", "MT", "novo", "nao_avaliado", "nao_produtor", [], ["revenda"], 4],
  ["Gilberto Machado", "Fazenda Água Limpa", "Primavera do Leste", "MT", "novo", "nao_avaliado", "produtor", ["produtor", "fazenda"], ["soja"], 5],
  ["Tatiane Moraes", "Fazenda Boa Esperança", "Rio Verde", "GO", "novo", "nao_avaliado", "provavel_produtor", ["fazenda"], [], 6],
  ["Vilmar Leal", "Agro Vale Verde", "Jataí", "GO", "novo", "nao_avaliado", "produtor", ["produtor"], ["milho"], 7],
  ["Paulo Cardoso", "Fazenda Santa Rita do Cerrado", "Rio Verde", "GO", "ja_conversou", "interessado", "produtor", ["produtor", "fazenda"], ["soja"], 18],
  ["Marcelo Teixeira", "Sítio Recanto Verde", "Dourados", "MS", "opt_out", "sem_interesse", "nao_produtor", [], [], 30],
  ["Patrícia Alves", "Agro Alvorada", "Maracaju", "MS", "novo", "nao_avaliado", "provavel_produtor", ["produtor"], ["feira"], 9],
  ["Luciano Ferraz", "Fazenda Aurora do Sul", "Dourados", "MS", "novo", "nao_avaliado", "produtor", ["produtor", "fazenda"], ["soja"], 9],
  ["Cristiane Lopes", "Fazenda Bela Vista", "Luís Eduardo Magalhães", "BA", "ja_conversou", "talvez", "produtor", ["produtor", "fazenda"], ["soja", "milho"], 15],
  ["Jairo Vasconcelos", "Agropecuária Serra Alta", "Luís Eduardo Magalhães", "BA", "ja_conversou", "interessado", "produtor", ["produtor"], ["soja"], 12],
  ["Adriano Barros", "Agropecuária Bom Jardim", "Uberaba", "MG", "novo", "nao_avaliado", "produtor", ["produtor", "pecuaria"], ["algodão"], 1],
  ["Clóvis Lacerda", "Agrícola Três Barras", "Cascavel", "PR", "novo", "nao_avaliado", "produtor", ["produtor"], ["soja"], 1],
  ["Ivone Amaral", "Fazenda Santa Luzia", "Londrina", "PR", "novo", "nao_avaliado", "produtor", ["produtor", "fazenda"], ["milho"], 1],
  ["Neusa Freitas", "Cerealista Vale do Teles Pires", "Sinop", "MT", "ja_conversou", "talvez", "nao_produtor", ["armazem"], ["revenda"], 20],
  ["Eliana Ribeiro", "Fazenda Boa Safra", "Sapezal", "MT", "cliente", "interessado", "produtor", ["produtor", "fazenda"], ["algodão", "soja"], 90],
  ["Wagner Xavier", "Agro Terra Nova", "Lucas do Rio Verde", "MT", "cliente", "interessado", "produtor", ["produtor"], ["milho"], 120],
  ["Diego Pires", "Grãos do Cerrado", "Nova Mutum", "MT", "novo", "nao_avaliado", "produtor", ["produtor"], ["soja"], 8],
  ["Elisa Rocha", "Fazenda Santa Helena", "Campo Verde", "MT", "ja_conversou", "interessado", "produtor", ["produtor", "fazenda"], ["soja"], 11],
  ["Marlene Dantas", "Agropecuária Ouro Verde", "Sorriso", "MT", "novo", "nao_avaliado", "produtor", ["produtor", "pecuaria"], ["soja", "milho"], 2],
  ["Ivo Medeiros", "Fazenda Pedra Branca", "Nova Mutum", "MT", "ja_conversou", "talvez", "produtor", ["produtor", "fazenda"], ["soja"], 14],
  ["Roberta Neves", "Agro Neves Filial", "Campo Verde", "MT", "cliente", "interessado", "produtor", ["produtor"], ["soja"], 50],
  ["Grãos Cuiabá", "Grãos Cuiabá Ltda", "Cuiabá", "MT", "ja_conversou", "interessado", "nao_produtor", ["armazem"], ["revenda"], 16],
  ["Anselmo Rota", "Transportes Rota Verde", "Rondonópolis", "MT", "ja_conversou", "talvez", "nao_produtor", ["transportadora"], [], 19],
];

const TAGS = [["soja", "emerald"], ["milho", "amber"], ["algodão", "sky"], ["feira", "violet"], ["revenda", "slate"], ["sem-resposta", "slate"]];

let seq = 1;
const telefone = (uf) => {
  const ddd = { MT: "66", GO: "64", MS: "67", BA: "77", MG: "34", PR: "45" }[uf] ?? "66";
  return `+55${ddd}99999${String(seq++).padStart(4, "0")}`;
};
const semAcento = (s) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

async function main() {
  const reset = process.argv.includes("--reset");
  const existente = await prisma.team.findUnique({ where: { id: TEAM } });
  if (existente && !reset) {
    console.error("O time demo já existe. Rode com --reset para apagar e criar de novo.");
    process.exit(1);
  }
  if (existente) {
    await prisma.team.update({ where: { id: TEAM }, data: { masterId: null } });
    await prisma.team.delete({ where: { id: TEAM } });
    console.log("time demo anterior apagado");
  }

  // ---- time, usuário, meta -------------------------------------------------------------------------
  await prisma.team.create({ data: { id: TEAM, name: "Agro Demo", cidade: "Sorriso", estado: "MT" } });
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: { teamId: TEAM, name: "Carolina Mendes", role: "owner", passwordHash: await bcrypt.hash(SENHA, 10), emailVerificadoEm: new Date() },
    create: { teamId: TEAM, name: "Carolina Mendes", email: EMAIL, role: "owner", passwordHash: await bcrypt.hash(SENHA, 10), emailVerificadoEm: new Date() },
  });
  await prisma.team.update({ where: { id: TEAM }, data: { masterId: user.id } });

  const periodo = `${HOJE.y}-${String(HOJE.m).padStart(2, "0")}`;
  await prisma.goal.create({ data: { teamId: TEAM, ownerId: user.id, periodo, toquesPorDia: 80, metaValor: 500000 } });
  await prisma.teamConfig.upsert({
    where: { teamId: TEAM },
    update: {},
    create: { teamId: TEAM, respectBusinessHours: true, businessHourStart: "08:00", businessHourEnd: "18:00" },
  });

  // ---- tags ----------------------------------------------------------------------------------------
  const tags = {};
  for (const [nome, cor] of TAGS) tags[nome] = await prisma.tag.create({ data: { teamId: TEAM, nome, cor } });

  // ---- canais: WhatsApp (aquecido, com uso do dia) e e-mail ----------------------------------------
  const conta = await prisma.channelAccount.create({
    data: {
      teamId: TEAM, canal: "whatsapp", label: "WhatsApp comercial", provider: "evolution",
      credentials: { instance: "demo", number: "5511999990000" }, status: "connected",
      dailyLimit: 100, warmupStartedAt: diasAtras(23), paused: false,
    },
  });
  await prisma.channelAccountUsage.create({
    data: { teamId: TEAM, channelAccountId: conta.id, day: new Date(Date.UTC(HOJE.y, HOJE.m - 1, HOJE.d)), sent: 64 },
  });
  const contaEmail = await prisma.channelAccount.create({
    data: {
      teamId: TEAM, canal: "email", label: "E-mail comercial", provider: "smtp", status: "connected", dailyLimit: 200,
      credentials: { host: "smtp.demo.example", port: 587, user: "comercial@agrodemo.example", from: "comercial@agrodemo.example" },
    },
  });

  // ---- contatos ------------------------------------------------------------------------------------
  const porNome = {};
  let k = 0;
  for (const [nome, empresa, cidade, uf, status, interesse, produtor, agro, tgs, dias] of CONTATOS) {
    const [primeiro, ...resto] = nome.split(" ");
    const tel = telefone(uf);
    const [lat0, lng0] = CIDADES[cidade] ?? [-15.6, -56.1];
    k += 1;
    // Deslocamento determinístico (até ~8 km) para os pinos do Mapa não se sobreporem.
    const latitude = lat0 + (((k * 7) % 11) - 5) * 0.015;
    const longitude = lng0 + (((k * 5) % 13) - 6) * 0.015;
    const c = await prisma.contact.create({
      data: {
        teamId: TEAM, nome: primeiro, sobrenome: resto.join(" ") || null, empresa, cidade, estado: uf,
        latitude, longitude, geoPrecisao: "cidade", geoAtualizadoEm: diasAtras(1),
        relacionamentoStatus: status, interesse, produtorLabel: produtor, isProdutor: produtor === "produtor",
        agroTipos: agro,
        origem: dias <= 3 ? "Planilha da feira" : "Importação",
        createdAt: diasAtras(dias, 9), ownerId: user.id,
        identifiers: {
          create: [
            { teamId: TEAM, canal: "whatsapp", valor: tel, isPrimary: true },
            ...(dias % 2 === 0 ? [{ teamId: TEAM, canal: "email", valor: `${semAcento(primeiro)}.${semAcento(resto.join(""))}@email.example`, isPrimary: true }] : []),
          ],
        },
        contactTags: { create: tgs.map((t) => ({ teamId: TEAM, tagId: tags[t].id })) },
      },
    });
    porNome[nome] = { ...c, telefone: tel };
  }
  console.log("contatos:", Object.keys(porNome).length);

  // ---- funil de vendas -----------------------------------------------------------------------------
  const funil = await prisma.funnel.create({
    data: {
      teamId: TEAM, nome: "Vendas", codigo: "vendas", tipo: "vendas",
      stages: {
        create: [
          { teamId: TEAM, nome: "Respondeu", codigo: "respondeu", ordem: 0, cor: "brand" },
          { teamId: TEAM, nome: "Reunião", codigo: "reuniao", ordem: 1, cor: "sky" },
          { teamId: TEAM, nome: "Proposta", codigo: "proposta", ordem: 2, cor: "amber" },
          { teamId: TEAM, nome: "Negociação", codigo: "negociacao", ordem: 3, cor: "violet" },
          { teamId: TEAM, nome: "Ganho", codigo: "ganho", ordem: 4, cor: "emerald" },
        ],
      },
    },
    include: { stages: { orderBy: { ordem: "asc" } } },
  });
  const st = Object.fromEntries(funil.stages.map((s) => [s.codigo, s.id]));
  const negocios = [
    ["Helena Duarte", "respondeu", 0, 0], ["Paulo Cardoso", "respondeu", 48000, 2], ["Denise Prado", "respondeu", 0, 3],
    ["Grãos Cuiabá", "reuniao", 120000, 1], ["Beatriz Montenegro", "reuniao", 65000, 4], ["Ivo Medeiros", "reuniao", 42000, 6],
    ["Tereza Viana", "proposta", 210000, 1], ["Sérgio Albuquerque", "proposta", 95000, 11], ["Márcia Rezende", "proposta", 38000, 8], ["Luiz Fernandes", "proposta", 72000, 9],
    ["Ricardo Nogueira", "negociacao", 340000, 6], ["Otávio Camargo", "negociacao", 180000, 2],
    ["Eduardo Tavares", "ganho", 150000, 5], ["Eliana Ribeiro", "ganho", 260000, 12],
  ];
  for (const [nome, etapa, valor, dias] of negocios) {
    await prisma.deal.create({
      data: { teamId: TEAM, funnelId: funil.id, stageId: st[etapa], contactId: porNome[nome].id, valor, status: "open", enteredStageAt: diasAtras(dias, 11) },
    });
  }

  // ---- conversas de WhatsApp -----------------------------------------------------------------------
  async function conversa(nome, msgs, unread = 0) {
    const c = nome ? porNome[nome] : null;
    const ultima = msgs[msgs.length - 1];
    const conv = await prisma.conversation.create({
      data: {
        teamId: TEAM, canal: "whatsapp", channelAccountId: conta.id, contactId: c?.id ?? null,
        externalNumber: c ? c.telefone : "+5566999990900", status: "open", unreadCount: unread,
        lastMessageAt: ultima[2], lastMessagePreview: ultima[1].slice(0, 200), lastMessageDirecao: ultima[0],
      },
    });
    for (const [direcao, texto, quando] of msgs) {
      await prisma.message.create({
        data: {
          teamId: TEAM, conversationId: conv.id, direcao, tipo: "text", conteudo: texto,
          status: direcao === "out" ? "read" : "sent", createdAt: quando, providerMessageId: `demo-${conv.id.slice(0, 8)}-${quando.getTime()}`,
        },
      });
      if (c) await prisma.activity.create({ data: { teamId: TEAM, contactId: c.id, tipo: "whatsapp", direcao, conteudo: texto, createdAt: quando } });
    }
  }
  await conversa("Helena Duarte", [
    ["out", "Oi Helena, foi um prazer conversar na feira!", diasAtras(20, 17, 40)],
    ["in", "Igualmente, vamos falando.", diasAtras(20, 17, 52)],
    ["out", "Bom dia, Helena! Aqui é o Marcos, da Agro Demo. Vi que a Horizonte Verde fica em Sorriso e estamos ajudando produtores da região a planejar a compra de insumos da safra. Posso te mandar um resumo de 1 minuto?", hoje(11, 2)],
    ["in", "Pode mandar sim! Estamos fechando o planejamento da safra essa semana.", hoje(14, 18)],
  ], 1);
  await conversa("Ricardo Nogueira", [
    ["out", "Ricardo, tudo bem? Te mandei a proposta da Vale Dourado ontem. Conseguiu olhar?", hoje(9, 30)],
    ["in", "Agora estou na colheita, me chama semana que vem.", hoje(13, 52)],
  ], 1);
  await conversa(null, [["in", "Quem é? Como conseguiu meu número?", hoje(13, 40)]], 1);
  await conversa("Tereza Viana", [
    ["in", "Marcos, e a proposta?", diasAtras(1, 16, 5)],
    ["out", "Te mando a proposta ainda hoje.", diasAtras(1, 16, 20)],
  ]);
  await conversa("Grãos Cuiabá", [
    ["out", "Podemos marcar uma reunião essa semana?", diasAtras(3, 10, 0)],
    ["in", "Combinado, quinta às 16:30.", diasAtras(3, 10, 30)],
  ]);
  await conversa("Otávio Camargo", [
    ["out", "Otávio, segue a versão final da proposta da Campo Alto.", diasAtras(2, 15, 0)],
    ["in", "Recebi, vou olhar com o sócio e te retorno.", diasAtras(2, 15, 45)],
  ]);
  await conversa("Beatriz Montenegro", [
    ["out", "Beatriz, a gente conversou sobre o algodão da próxima safra. Ainda faz sentido falar essa semana?", diasAtras(1, 9, 10)],
    ["in", "Faz sim. Pode ser quarta à tarde?", diasAtras(1, 9, 40)],
  ]);

  // ---- atividades dos últimos 7 dias (o Painel mostra o progresso do dia) ---------------------------
  const nomes = CONTATOS.map((c) => c[0]);
  const plano = [64, 71, 58, 80, 66, 12, 0]; // hoje, ontem, ...
  for (let d = 0; d < 7; d++) {
    const rows = [];
    for (let i = 0; i < plano[d]; i++) {
      rows.push({ teamId: TEAM, contactId: porNome[nomes[(i * 7 + d) % nomes.length]].id, tipo: "whatsapp", direcao: "out", conteudo: "Mensagem de prospecção", createdAt: diasAtras(d, 8 + Math.floor(i / 8), (i * 7) % 60) });
    }
    for (let i = 0; i < Math.round(plano[d] * 0.14); i++) {
      rows.push({ teamId: TEAM, contactId: porNome[nomes[(i * 5 + d) % nomes.length]].id, tipo: "whatsapp", direcao: "in", conteudo: "Resposta do contato", createdAt: diasAtras(d, 10 + Math.floor(i / 3), (i * 11) % 60) });
    }
    if (rows.length) await prisma.activity.createMany({ data: rows });
  }
  // Envios das últimas 2 horas: garantem número maior que zero em "hoje" mesmo se o Painel cortar o dia no fuso do servidor.
  await prisma.activity.createMany({
    data: [
      ...Array.from({ length: 22 }, (_, i) => ({ teamId: TEAM, contactId: porNome[nomes[(i * 3) % nomes.length]].id, tipo: "whatsapp", direcao: "out", conteudo: "Mensagem de prospecção", createdAt: new Date(Date.now() - (i + 1) * 4 * 60_000) })),
      ...Array.from({ length: 4 }, (_, i) => ({ teamId: TEAM, contactId: porNome[nomes[(i * 9 + 1) % nomes.length]].id, tipo: "whatsapp", direcao: "in", conteudo: "Resposta do contato", createdAt: new Date(Date.now() - (i + 1) * 11 * 60_000) })),
    ],
  });
  await prisma.activity.create({ data: { teamId: TEAM, contactId: porNome["Helena Duarte"].id, tipo: "stage_change", conteudo: "Negócio aberto em Vendas", meta: { de: null, para: "Respondeu" }, createdAt: hoje(14, 18) } });
  await prisma.activity.create({ data: { teamId: TEAM, contactId: porNome["Tereza Viana"].id, tipo: "call", direcao: "out", conteudo: "Ligação, atendeu, 6 min. Pediu proposta para a safra 26/27.", createdAt: diasAtras(3, 14, 0) } });
  await prisma.activity.create({ data: { teamId: TEAM, contactId: porNome["Helena Duarte"].id, tipo: "note", conteudo: "Produtora de soja e milho em Sorriso. Conheceu a equipe na feira de agosto.", createdAt: diasAtras(40, 9, 0) } });

  // ---- agenda --------------------------------------------------------------------------------------
  const ag = (titulo, tipo, quando, contato, status = "pendente") => ({
    teamId: TEAM, titulo, descricao: "demo", tipo, inicio: quando, fim: null, status, contactId: contato ? porNome[contato].id : null,
  });
  await prisma.appointment.createMany({
    data: [
      ag("Ligação com Tereza", "ligacao", hoje(15, 0), "Tereza Viana"),
      ag("Reunião Grãos Cuiabá", "reuniao", hoje(16, 30), "Grãos Cuiabá"),
      ag("Visita Algodoeira Fibra Nobre", "reuniao", diasFrente(3, 9, 0), "Beatriz Montenegro"),
      ag("Reunião Campo Alto", "reuniao", diasFrente(4, 14, 0), "Otávio Camargo"),
      ag("Retorno Denise", "follow_up", diasFrente(6, 10, 0), "Denise Prado"),
      ag("Retorno Ricardo, depois da colheita", "follow_up", diasFrente(11, 9, 0), "Ricardo Nogueira"),
      ag("Visita Campo Alto", "reuniao", diasAtras(22, 10, 0), "Otávio Camargo", "concluido"),
      ag("Ligação Ricardo", "ligacao", diasAtras(20, 9, 30), "Ricardo Nogueira", "concluido"),
      ag("Reunião Rio Claro", "reuniao", diasAtras(15, 14, 0), "Eduardo Tavares", "concluido"),
      ag("Ligação Beatriz", "ligacao", diasAtras(13, 10, 0), "Beatriz Montenegro", "concluido"),
      ag("Reunião Santa Aurora", "reuniao", diasAtras(7, 15, 0), "Tereza Viana", "concluido"),
      ag("Retorno Denise", "follow_up", diasAtras(6, 11, 0), "Denise Prado", "concluido"),
      ag("Ligação Tereza", "ligacao", diasAtras(2, 10, 0), "Tereza Viana", "concluido"),
    ],
  });

  // ---- fluxos de automação (com nós, para o editor visual) -----------------------------------------
  const uuid = () => randomUUID();
  async function fluxo(nome, triggerType, status, nos, extra = {}) {
    const f = await prisma.flow.create({
      data: { teamId: TEAM, nome, triggerType, status, tipo: "prospeccao", createdById: user.id, compartilhado: true, ...extra },
    });
    let i = 0;
    for (const n of nos) {
      await prisma.flowNode.create({
        data: { id: n.id, teamId: TEAM, flowId: f.id, tipo: n.tipo, config: n.config ?? null, nextNodeId: n.next ?? null, branches: n.branches ?? null, posX: n.x, posY: n.y, createdAt: new Date(Date.now() + i++) },
      });
    }
    return f;
  }
  const [n1, n2, n3, n4, n5, n6, n7, n8, n9] = Array.from({ length: 9 }, uuid);
  await fluxo("Boas-vindas ao lead novo", "contact_created", "active", [
    { id: n1, tipo: "send_message", x: 0, y: 130, next: n2, config: { channelAccountId: conta.id, text: "{saudacao}, {primeiro_nome}! Aqui é a equipe da Agro Demo. Estamos ajudando produtores de {cidade|sua região} a planejar a safra 26/27. Posso te contar em duas linhas como funciona?" } },
    { id: n2, tipo: "wait", x: 190, y: 130, next: n3, config: { duration: 1, unit: "day" } },
    {
      id: n3, tipo: "condition", x: 380, y: 130,
      branches: { branches: [{ id: "respondeu", label: "Respondeu", condition: { type: "responded", janelaMin: 1440 }, nextNodeId: n4 }], default: n7 },
    },
    { id: n4, tipo: "update_stage", x: 570, y: 40, next: n5, config: { funnelId: funil.id, stageId: st.respondeu } },
    { id: n5, tipo: "notify_user", x: 760, y: 40, next: n6, config: { message: "{nome} respondeu. Vale chamar agora." } },
    { id: n6, tipo: "end", x: 1140, y: 130 },
    { id: n7, tipo: "send_message", x: 570, y: 230, next: n8, config: { channelAccountId: conta.id, text: "{saudacao}, {primeiro_nome}. Passando para saber se ficou alguma dúvida. Se não for o momento, é só me avisar." } },
    { id: n8, tipo: "wait", x: 760, y: 230, next: n9, config: { duration: 2, unit: "day" } },
    { id: n9, tipo: "add_tag", x: 950, y: 230, next: n6, config: { tag: "sem-resposta" } },
  ]);
  const [a1, a2, a3] = Array.from({ length: 3 }, uuid);
  await fluxo("Pós-resposta", "message_received", "active", [
    { id: a1, tipo: "notify_user", x: 0, y: 100, next: a2, config: { message: "{nome} respondeu no WhatsApp." } },
    { id: a2, tipo: "add_tag", x: 300, y: 100, next: a3, config: { tag: "feira" } },
    { id: a3, tipo: "end", x: 600, y: 100 },
  ]);
  const [r1, r2, r3] = Array.from({ length: 3 }, uuid);
  await fluxo("Retomada de clientes inativos", "manual", "draft", [
    { id: r1, tipo: "send_message", x: 0, y: 100, next: r2, config: { channelAccountId: conta.id, text: "{saudacao}, {primeiro_nome}! Faz um tempo que a gente conversou. Como foi a safra por aí?" } },
    { id: r2, tipo: "wait", x: 300, y: 100, next: r3, config: { duration: 3, unit: "day" } },
    { id: r3, tipo: "end", x: 600, y: 100 },
  ]);

  // ---- campanhas -----------------------------------------------------------------------------------
  const fluxoPos = await prisma.flow.findFirst({ where: { teamId: TEAM, nome: "Pós-resposta" } });
  const enviando = await prisma.campaign.create({
    data: {
      teamId: TEAM, nome: "Produtores do Centro-Oeste, safra 26/27", status: "sending", etapa: 4, channelAccountId: conta.id,
      listaOrigem: {
        tipo: "planilha", arquivo: "produtores-centro-oeste.xlsx", versao: "demo-1", estado: "pronta",
        resumo: { linhas: 24, invalidos: 1, duplicados: 1, semWhatsApp: 1, contatosNovos: 6, fila: 18, segurados: 2, pulados: 1, porMotivo: { "já conversou": 2, "sem WhatsApp": 1 } },
      },
      regraJaConversou: "hold", diasSemCampanha: 30,
      mensagem: "{saudacao}, {primeiro_nome|tudo bem}? Aqui é o Marcos, da Agro Demo. Estou conversando com produtores de {cidade|sua região} sobre a safra 26/27. Posso te mandar em 2 linhas como funciona?",
      variacoes: ["{saudacao}, {primeiro_nome}! Marcos, da Agro Demo. Estamos ajudando produtores de {cidade|MT} a planejar a 26/27. Posso te contar rapidinho?"],
      limiteDiario: 60, flowId: fluxoPos?.id ?? null, iniciadaEm: diasAtras(2, 8, 30), iniciaEm: diasAtras(2, 8, 30), terminoPrevisto: diasFrente(1, 17), ultimoEnvioEm: hoje(10, 12),
      createdById: user.id, createdAt: diasAtras(3, 16),
    },
  });
  const destinatarios = [
    ["replied", "Helena Duarte", "interessada"], ["replied", "Tereza Viana", "duvida"], ["replied", "Jairo Vasconcelos", "pediu_depois"],
    ["opted_out", "Marcelo Teixeira", "saiu"], ["read", "Otávio Camargo"], ["read", "Beatriz Montenegro"], ["delivered", "Eduardo Tavares"],
    ["delivered", "Sérgio Albuquerque"], ["sent", "Luiz Fernandes"], ["sent", "Paulo Cardoso"], ["failed", "Rosana Cavalcante"],
    ["queued", "Leandra Bastos"], ["queued", "Otto Brandão"], ["queued", "Heloísa Moura"], ["queued", "Gilberto Machado"], ["queued", "Tatiane Moraes"],
    ["queued", "Vilmar Leal"], ["queued", "Adriano Barros"], ["held", "Ricardo Nogueira"], ["held", "Denise Prado"], ["skipped", "Márcia Rezende"],
  ];
  let ordem = 0;
  for (const [status, nome, classificacao] of destinatarios) {
    const c = porNome[nome];
    if (!c) continue;
    ordem += 1;
    const enviado = ["sent", "delivered", "read", "replied", "opted_out"].includes(status);
    await prisma.campaignRecipient.create({
      data: {
        teamId: TEAM, campaignId: enviando.id, contactId: c.id, status, telefone: c.telefone,
        motivo: status === "held" ? "já conversou" : status === "skipped" ? "sem WhatsApp" : null,
        variacao: ordem % 2, sentAt: enviado ? diasAtras(ordem > 6 ? 0 : 1, 9 + (ordem % 6), (ordem * 7) % 60) : null,
        repliedAt: status === "replied" || status === "opted_out" ? hoje(8 + (ordem % 3), (ordem * 11) % 60) : null,
        classificacao: classificacao ?? null, scheduledAt: status === "queued" ? hoje(13 + Math.floor(ordem / 3), (ordem * 9) % 60) : null,
        createdAt: diasAtras(3, 16, ordem),
      },
    });
  }
  await prisma.campaign.create({
    data: {
      teamId: TEAM, nome: "Clientes inativos, retomada", status: "done", etapa: 4, channelAccountId: conta.id,
      listaOrigem: { tipo: "filtro", versao: "demo-3", estado: "pronta", resumo: { linhas: 4, invalidos: 0, duplicados: 0, semWhatsApp: 0, contatosNovos: 0, fila: 4, segurados: 0, pulados: 0, porMotivo: {} } },
      mensagem: "{saudacao}, {primeiro_nome}! Faz um tempo que a gente conversou. Como foi a safra por aí?",
      iniciadaEm: diasAtras(12, 9), concluidaEm: diasAtras(10, 16), createdById: user.id, createdAt: diasAtras(13, 10),
      recipients: {
        create: ["Eliana Ribeiro", "Wagner Xavier", "Roberta Neves", "Eduardo Tavares"].map((n, i) => ({
          teamId: TEAM, contactId: porNome[n].id, status: i < 2 ? "replied" : "read", telefone: porNome[n].telefone,
          sentAt: diasAtras(11, 10 + i, 5 * i), repliedAt: i < 2 ? diasAtras(11, 14 + i) : null, createdAt: diasAtras(13, 10),
        })),
      },
    },
  });

  // ---- conversas de e-mail -------------------------------------------------------------------------
  const threads = [
    ["Helena Duarte", "Proposta safra 26/27", [
      ["out", "Oi Helena, segue a proposta para a safra 26/27 conforme conversamos. Qualquer dúvida estou à disposição.", 3, 10],
      ["in", "Marcos, recebi. Vou analisar com o Carlos e te retorno até sexta. Obrigada!", 2, 15],
      ["out", "Perfeito, Helena. Fico no aguardo.", 2, 16],
    ]],
    ["Otávio Camargo", "Re: Visita técnica na Campo Alto", [
      ["in", "Marcos, confirmando a visita na quinta às 9h. Você traz os relatórios de solo?", 1, 9],
      ["out", "Confirmado, Otávio. Levo os relatórios e a simulação de custo.", 1, 11],
    ]],
    ["Grãos Cuiabá", "Tabela de preços de outubro", [
      ["in", "Bom dia. Vocês têm a tabela atualizada de outubro? Precisamos fechar o pedido até dia 5.", 0, 8],
    ]],
  ];
  for (const [nome, assunto, msgs] of threads) {
    const c = porNome[nome];
    const ultima = msgs[msgs.length - 1];
    const conv = await prisma.conversation.create({
      data: {
        teamId: TEAM, contactId: c.id, canal: "email", channelAccountId: contaEmail.id, status: "open",
        unreadCount: ultima[0] === "in" ? 1 : 0, lastMessageAt: diasAtras(ultima[2], ultima[3]),
        lastMessagePreview: ultima[1].slice(0, 200), lastMessageDirecao: ultima[0], lastMessageSubject: assunto,
      },
    });
    await prisma.message.createMany({
      data: msgs.map(([direcao, texto, d, h], i) => ({
        teamId: TEAM, conversationId: conv.id, direcao, tipo: "text", conteudo: texto, status: direcao === "in" ? "read" : "sent",
        createdAt: diasAtras(d, h, i * 3), providerMessageId: `demo-email-${conv.id}-${i}`,
        meta: { subject: i === 0 ? assunto : assunto.startsWith("Re:") ? assunto : `Re: ${assunto}`, from: direcao === "in" ? `${semAcento(nome)}@cliente.example` : "comercial@agrodemo.example" },
      })),
    });
  }

  console.log("Seed demo pronto.");
  console.log(`  login: ${EMAIL}`);
  console.log(`  senha: ${SENHA}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
