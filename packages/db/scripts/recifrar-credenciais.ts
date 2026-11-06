/**
 * Recifra `credentials` (Integration, LinhaDeLigacao, ChannelAccount e OAuthConnection), mais o token e o link de
 * confirmação do EmailEncaminhamento, o CPF do contato (`Contact.cpfCifrado`, que também cifra o que
 * ainda estiver em texto puro) e o e-mail e telefone cifrados dos contatos (as 5 colunas `*Cifrado`, CONTATOS_CIFRA),
 * com a chave ATUAL do anel
 * (item 3.7, S20). Converte o formato antigo (v1, sem kid) para v2 e tira os
 * registros de chaves aposentadas. Idempotente: o que já está na chave atual
 * não é regravado. Texto puro legado não é tocado (só contado).
 *
 * ROTAÇÃO, passo a passo (produção, com pg_dump antes):
 *   1. gerar a nova: openssl rand -base64 48
 *   2. .env: CREDENTIALS_ENCRYPTION_KEYS="<nova>,<CREDENTIALS_ENCRYPTION_KEY atual>"
 *      (a CREDENTIALS_ENCRYPTION_KEY fica como está) → deploy (web + worker)
 *   3. cd /srv/crmagro/packages/db
 *      pnpm exec dotenv -e ../../.env -- tsx scripts/recifrar-credenciais.ts            # só conta
 *      pnpm exec dotenv -e ../../.env -- tsx scripts/recifrar-credenciais.ts --aplicar  # regrava
 *   4. rodar de novo sem --aplicar: "a recifrar: 0"
 *   5. só então aposentar a antiga: CREDENTIALS_ENCRYPTION_KEY=<nova> e
 *      CREDENTIALS_ENCRYPTION_KEYS=<nova> (ou vazia) → deploy.
 *
 * Usa o `basePrisma` (sem a extensão de cripto): lê e grava o valor cifrado
 * cru, camada por camada. Não imprime credencial nenhuma.
 */
import { basePrisma } from "../src/client";
import {
  CONTEXTO_CPF,
  anelDoAmbiente,
  cifrarTextoCom,
  decifrarTextoCom,
  estaCifrado,
  precisaRecifrar,
  recifrarCom,
  textoPrecisaRecifrar,
} from "../src/crypto";
import { Prisma } from "@prisma/client";
import { CONTEXTOS_CONTATO } from "../src/contatos-cifra";

const aplicar = process.argv.includes("--aplicar");
const anel = anelDoAmbiente();

type Linha = { id: string; credentials: Prisma.JsonValue | null };

async function processar(
  nome: string,
  linhas: Linha[],
  gravar: (id: string, credentials: Prisma.InputJsonValue) => Promise<unknown>,
) {
  let recifrar = 0;
  let textoPuro = 0;
  let falhas = 0;
  for (const l of linhas) {
    if (l.credentials == null) continue;
    if (!estaCifrado(l.credentials)) {
      textoPuro++;
      continue;
    }
    try {
      if (!precisaRecifrar(anel, l.credentials)) continue;
      recifrar++;
      if (aplicar) await gravar(l.id, recifrarCom(anel, l.credentials) as Prisma.InputJsonValue);
    } catch (e) {
      falhas++;
      console.error(`${nome} ${l.id}: não decifrou (${e instanceof Error ? e.name : "erro"})`);
    }
  }
  console.log(
    `${nome}: ${linhas.length} linha(s) · a recifrar: ${recifrar}${aplicar ? " (regravadas)" : ""} · texto puro: ${textoPuro} · falhas: ${falhas}`,
  );
}

/**
 * CPF do contato (coluna de texto). Cifra o texto puro que sobrou e recifra o que está numa chave
 * antiga. Grava por SQL direto para NÃO mexer no `updatedAt` (a ordenação das listas usa essa data).
 */
async function processarCpf() {
  let total = 0;
  let aCifrar = 0;
  let aRecifrar = 0;
  let falhas = 0;
  let cursor: string | undefined;
  for (;;) {
    const lote = await basePrisma.contact.findMany({
      where: { cpfCifrado: { not: null } },
      select: { id: true, cpfCifrado: true },
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (lote.length === 0) break;
    cursor = lote[lote.length - 1]!.id;
    for (const c of lote) {
      const valor = c.cpfCifrado!;
      total++;
      try {
        if (!textoPrecisaRecifrar(anel, valor)) continue;
        const claro = decifrarTextoCom(anel, valor, CONTEXTO_CPF);
        if (valor === claro) aCifrar++;
        else aRecifrar++;
        if (aplicar) {
          const novo = cifrarTextoCom(anel, claro, CONTEXTO_CPF);
          await basePrisma.$executeRaw`UPDATE "Contact" SET "cpfCifrado" = ${novo} WHERE "id" = ${c.id}`;
        }
      } catch (e) {
        falhas++;
        console.error(`Contact.cpfCifrado ${c.id}: não decifrou (${e instanceof Error ? e.name : "erro"})`);
      }
    }
  }
  console.log(
    `Contact.cpfCifrado: ${total} linha(s) · texto puro a cifrar: ${aCifrar} · chave antiga a recifrar: ${aRecifrar}${aplicar ? " (regravadas)" : ""} · falhas: ${falhas}`,
  );
}

/**
 * Telefone e e-mail cifrados dos contatos (CONTATOS_CIFRA): as 5 colunas `*Cifrado`. Recifra o que está
 * numa chave antiga do anel. NÃO mexe nos índices cegos (a chave deles é outra, CONTATOS_INDICE_KEY) e não
 * cifra texto puro (isso é o `cifrar-contatos.ts`). SQL direto, sem tocar `updatedAt`.
 */
const COLUNAS_DE_CONTATO = [
  { tabela: "ChannelIdentifier", coluna: "valorCifrado", contexto: CONTEXTOS_CONTATO.channelIdentifierValor },
  { tabela: "Conversation", coluna: "externalNumberCifrado", contexto: CONTEXTOS_CONTATO.conversationExternalNumber },
  { tabela: "WhatsAppLid", coluna: "telefoneCifrado", contexto: CONTEXTOS_CONTATO.whatsappLidTelefone },
  { tabela: "Call", coluna: "phoneNumberCifrado", contexto: CONTEXTOS_CONTATO.callPhoneNumber },
  { tabela: "CampaignRecipient", coluna: "telefoneCifrado", contexto: CONTEXTOS_CONTATO.campaignRecipientTelefone },
] as const;

async function processarContatosCifrados() {
  for (const { tabela, coluna, contexto } of COLUNAS_DE_CONTATO) {
    const t = Prisma.raw(`"${tabela}"`);
    const c = Prisma.raw(`"${coluna}"`);
    let total = 0;
    let aRecifrar = 0;
    let falhas = 0;
    let cursor = "";
    for (;;) {
      const lote = await basePrisma.$queryRaw<{ id: string; valor: string }[]>`
        SELECT "id", ${c} AS "valor" FROM ${t} WHERE ${c} IS NOT NULL AND "id" > ${cursor} ORDER BY "id" LIMIT 500`;
      if (lote.length === 0) break;
      cursor = lote[lote.length - 1]!.id;
      for (const l of lote) {
        total++;
        try {
          if (!textoPrecisaRecifrar(anel, l.valor)) continue;
          const claro = decifrarTextoCom(anel, l.valor, contexto);
          aRecifrar++;
          if (aplicar) {
            const novo = cifrarTextoCom(anel, claro, contexto);
            await basePrisma.$executeRaw`UPDATE ${t} SET ${c} = ${novo} WHERE "id" = ${l.id}`;
          }
        } catch (e) {
          falhas++;
          console.error(`${tabela}.${coluna} ${l.id}: não decifrou (${e instanceof Error ? e.name : "erro"})`);
        }
      }
    }
    console.log(`${tabela}.${coluna}: ${total} linha(s) · chave antiga a recifrar: ${aRecifrar}${aplicar ? " (regravadas)" : ""} · falhas: ${falhas}`);
  }
}

async function main() {
  console.log(`chave atual: ${anel.atual.kid} · anel: ${[...anel.porKid.keys()].join(", ")}`);
  await processar(
    "Integration",
    await basePrisma.integration.findMany({ select: { id: true, credentials: true } }),
    (id, credentials) => basePrisma.integration.update({ where: { id }, data: { credentials } }),
  );
  // Senha do ramal e token por pessoa das linhas de ligação (F1B-05): sem isto, a rotação deixaria as
  // credenciais das linhas ilegíveis e todo vendedor teria de ser ligado de novo ao provedor.
  await processar(
    "LinhaDeLigacao",
    await basePrisma.linhaDeLigacao.findMany({ select: { id: true, credentials: true } }),
    (id, credentials) => basePrisma.linhaDeLigacao.update({ where: { id }, data: { credentials } }),
  );
  await processar(
    "ChannelAccount",
    await basePrisma.channelAccount.findMany({ select: { id: true, credentials: true } }),
    (id, credentials) => basePrisma.channelAccount.update({ where: { id }, data: { credentials } }),
  );
  // Tokens do Google Agenda por pessoa (28/09): sem isto, a rotação deixaria
  // os refresh tokens ilegíveis e todo mundo teria de reconectar.
  await processar(
    "OAuthConnection",
    await basePrisma.oAuthConnection.findMany({ select: { id: true, credentials: true } }),
    (id, credentials) => basePrisma.oAuthConnection.update({ where: { id }, data: { credentials } }),
  );
  await processar(
    "OAuthRevogacaoPendente",
    await basePrisma.oAuthRevogacaoPendente.findMany({ select: { id: true, credentials: true } }),
    (id, credentials) => basePrisma.oAuthRevogacaoPendente.update({ where: { id }, data: { credentials } }),
  );
  // Endereço de encaminhamento (#178): sem isto, a rotação deixaria os endereços
  // e os links de confirmação do Google ilegíveis. `confirmacaoLink` pode ser
  // null: o `processar` já pula.
  await processar(
    "EmailEncaminhamento.tokenCifrado",
    (await basePrisma.emailEncaminhamento.findMany({ select: { id: true, tokenCifrado: true } })).map((r) => ({
      id: r.id,
      credentials: r.tokenCifrado,
    })),
    (id, v) => basePrisma.emailEncaminhamento.update({ where: { id }, data: { tokenCifrado: v } }),
  );
  await processar(
    "EmailEncaminhamento.confirmacaoLink",
    (await basePrisma.emailEncaminhamento.findMany({ select: { id: true, confirmacaoLink: true } })).map((r) => ({
      id: r.id,
      credentials: r.confirmacaoLink,
    })),
    (id, v) => basePrisma.emailEncaminhamento.update({ where: { id }, data: { confirmacaoLink: v } }),
  );
  await processarCpf();
  await processarContatosCifrados();
  if (!aplicar) console.log("Só contei. Rode com --aplicar para regravar.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => basePrisma.$disconnect());
