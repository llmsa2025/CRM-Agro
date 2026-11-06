import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Lista FECHADA dos arquivos de código que usam o `basePrisma` (o client do papel dono, que NÃO sente o RLS).
 *
 * Por que existe: com a camada 3 do RLS ligada, só o que passa por `db()` é protegido pelo Postgres. Tudo que
 * usa o `basePrisma` continua protegido só pelo filtro `teamId` escrito no código. Esses usos são poucos e
 * têm motivo (login e cadastro acontecem antes de existir time, o webhook precisa descobrir o time pela
 * instância ou pelo token, a varredura do worker anda por todos os times). Um uso NOVO precisa de revisão
 * consciente: este teste quebra, e quem o criou escolhe entre (1) usar `db()` com `runWithTeam` ou
 * `runAsSystem(teamId, ...)`, que é o padrão, ou (2) acrescentar o arquivo aqui, com o motivo, e filtrar
 * `teamId` na própria consulta. Docs: a documentação interna, "O que o RLS não cobre".
 */

const PRE_SESSAO = "login, cadastro, convite, troca de senha e conta: acontecem antes de existir time (tabelas fora do alcance do crmagro_app)";
const RESOLVE_TIME = "resolve o time por instância, token, id externo ou webhook, para só depois abrir o contexto do time";
const VARREDURA = "varredura do worker ou do motor entre todos os times (cada item roda depois no contexto do próprio time)";
const WORKER = "worker: carrega o job entre times e abre runAsSystem/runWithTeam com o time resolvido";
const SCRIPT = "script de operação ou de manutenção (papel dono, fora do app)";
const SO_FILTRO = "caminho de usuário que filtra teamId só no código (candidato a migrar para db(); ver rls-ligar-passo-a-passo.md)";
const INFRA = "infraestrutura do client (define o basePrisma e as extensões)";
const SAUDE = "health check e métricas do motor: leitura entre times";
const GLOBAL_LEITURA = "tabela global sem teamId (Municipio, lista do IBGE): só leitura, sem dado de time, então não há o que o RLS proteger";
const ALERTAS = "alertas do sistema: tabelas AlertaConfig e AlertaEnviado são do sistema todo, sem teamId (RLS ligado, sem política; só o papel dono lê)";
const CIFRA_LOTE = "cifra de contatos em lote: percorre todos os times por contato, em script de operação (papel dono) ou no auxiliar dos lotes, sempre com teamId no dado";

const PERMITIDOS: Record<string, string> = {
  "apps/web/auth.ts": PRE_SESSAO,
  "apps/worker/src/capture-handler.ts": WORKER,
  "apps/worker/src/handler.ts": WORKER,
  "apps/worker/src/index.ts": WORKER,
  "apps/worker/src/social.ts": WORKER,
  "packages/core/src/health/alertas-config.ts": ALERTAS,
  "packages/db/scripts/cifrar-contatos.ts": CIFRA_LOTE,
  "packages/db/scripts/conferir-contatos.ts": CIFRA_LOTE,
  "packages/db/scripts/reverter-contatos-cifrados.ts": CIFRA_LOTE,
  "packages/db/src/contatos-cifra-lotes.ts": CIFRA_LOTE,
  "packages/core/src/agenda/google/conexao.ts": RESOLVE_TIME,
  "packages/core/src/agenda/google/envio.ts": VARREDURA,
  "packages/core/src/agenda/google/sincronizacao.ts": RESOLVE_TIME,
  "packages/core/src/agenda/google/trabalho.ts": VARREDURA,
  "packages/core/src/agenda/lembrete.ts": VARREDURA,
  "packages/core/src/auth/cadastro-com-senha.ts": PRE_SESSAO,
  "packages/core/src/auth/empresa.ts": PRE_SESSAO,
  "packages/core/src/auth/equipe.ts": PRE_SESSAO,
  "packages/core/src/auth/invites.ts": PRE_SESSAO,
  "packages/core/src/auth/login-senha.ts": PRE_SESSAO,
  "packages/core/src/auth/master-operacao.ts": PRE_SESSAO,
  "packages/core/src/auth/master.ts": PRE_SESSAO,
  "packages/core/src/auth/password-reset.ts": PRE_SESSAO,
  "packages/core/src/auth/provisioning.ts": PRE_SESSAO,
  "packages/core/src/auth/seed-time.ts": PRE_SESSAO,
  "packages/core/src/auth/session.ts": PRE_SESSAO,
  "packages/core/src/calls/service.ts": RESOLVE_TIME,
  "packages/core/src/calls/transcription-service.ts": RESOLVE_TIME,
  "packages/core/src/campaigns/varredura.ts": VARREDURA,
  "packages/core/src/contacts/cpf.ts": VARREDURA,
  "packages/core/src/contacts/responsavel.ts": SO_FILTRO,
  "packages/core/src/captacao/busca-filtros.ts": GLOBAL_LEITURA,
  "packages/core/src/conversations/lid-revisao.ts": SCRIPT,
  "packages/core/src/conversations/service.ts": RESOLVE_TIME,
  "packages/core/src/conversations/unificar-lid.ts": SO_FILTRO,
  "packages/core/src/dono/service.ts": SO_FILTRO,
  "packages/core/src/email/encaminhamento.ts": RESOLVE_TIME,
  "packages/core/src/email/leitura-imap.ts": VARREDURA,
  "packages/core/src/email/service.ts": RESOLVE_TIME,
  "packages/core/src/events/destino.ts": RESOLVE_TIME,
  "packages/core/src/flows/avanco.ts": VARREDURA,
  "packages/core/src/flows/controle.ts": VARREDURA,
  "packages/core/src/flows/service.ts": RESOLVE_TIME,
  "packages/core/src/geo/geocode.ts": VARREDURA,
  "packages/core/src/geo/mapa.ts": SO_FILTRO,
  "packages/core/src/health/check.ts": SAUDE,
  "packages/core/src/health/motor.ts": SAUDE,
  "packages/core/src/integrations/meta-da-conta.ts": SO_FILTRO,
  "packages/core/src/integrations/whatsapp-conexao.ts": VARREDURA,
  "packages/core/src/integrations/whatsapp-historico.ts": VARREDURA,
  "packages/core/src/integrations/whatsapp-nomes.ts": VARREDURA,
  "packages/core/src/integrations/whatsapp-onboarding.ts": RESOLVE_TIME,
  "packages/core/src/push/service.ts": SO_FILTRO,
  "packages/core/src/relay/tokens.ts": RESOLVE_TIME,
  "packages/core/src/retencao/service.ts": VARREDURA,
  "packages/core/src/social/verificacao.ts": VARREDURA,
  "packages/core/src/storage/limpeza.ts": VARREDURA,
  "packages/core/src/tenancy/escopo.ts": SO_FILTRO,
  "packages/db/scripts/recifrar-credenciais.ts": SCRIPT,
  "packages/db/src/client.ts": INFRA,
  "packages/db/src/index.ts": INFRA,
};

/** Quem pode criar um PrismaClient próprio (todos fora do app: o client do app e os scripts de operação). */
const PODE_CRIAR_PRISMA_CLIENT = new Set([
  "packages/db/src/client.ts",
  "packages/db/prisma/seed.ts",
  "packages/db/scripts/criar-usuario.mjs",
  "packages/db/scripts/reaplicar-coordenadas-maps.mjs",
  "packages/db/scripts/seed-demo.mjs",
  "packages/db/scripts/seed-municipios.ts",
  "packages/db/scripts/dedup-inbound.mjs",
  "packages/db/scripts/dedup-enrollments.mjs",
  "packages/db/scripts/backfill-ultima-mensagem.mjs",
]);

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const IGNORAR = new Set(["node_modules", ".next", "dist", ".turbo", "coverage"]);

function arquivos(dir: string, saida: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.has(e.name)) continue;
    const cheio = join(dir, e.name);
    if (e.isDirectory()) arquivos(cheio, saida);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) saida.push(relative(RAIZ, cheio));
  }
  return saida;
}

/** Tira os comentários: só o USO do basePrisma conta, não uma menção na explicação. */
function semComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}
const usaBasePrisma = (f: string) => /\bbasePrisma\b/.test(semComentarios(readFileSync(join(RAIZ, f), "utf8")));

const codigo = [...arquivos(join(RAIZ, "packages")), ...arquivos(join(RAIZ, "apps"))].sort();

describe("lista fechada do basePrisma (o que o RLS não protege)", () => {
  it("só os arquivos da lista usam o basePrisma; uso novo exige revisão", () => {
    const usam = codigo.filter(usaBasePrisma);
    const novos = usam.filter((f) => !(f in PERMITIDOS));
    expect(
      novos,
      "Arquivo novo usando basePrisma (o RLS não protege o que passa por ele). Prefira db() com runWithTeam ou runAsSystem(teamId, ...). " +
        "Se for mesmo cross-tenant (login, resolver time por token ou instância, varredura), acrescente em PERMITIDOS com o motivo e filtre teamId na consulta.",
    ).toEqual([]);
  });

  it("a lista não tem arquivo que deixou de usar o basePrisma (lista enxuta)", () => {
    const usam = new Set(codigo.filter(usaBasePrisma));
    const obsoletos = Object.keys(PERMITIDOS).filter((f) => !usam.has(f));
    expect(obsoletos, "tire da lista os arquivos que não usam mais o basePrisma").toEqual([]);
  });

  it("todo item da lista tem motivo", () => {
    for (const [arquivo, motivo] of Object.entries(PERMITIDOS)) expect(motivo.length, arquivo).toBeGreaterThan(20);
  });

  it("ninguém cria um PrismaClient próprio fora do client do db e dos scripts (um client novo escaparia do RLS e do pool)", () => {
    const criam = codigo.filter((f) => /new PrismaClient\(/.test(readFileSync(join(RAIZ, f), "utf8")));
    const fora = criam.filter((f) => !PODE_CRIAR_PRISMA_CLIENT.has(f));
    expect(fora, "PrismaClient novo: use basePrisma ou db(); client próprio só em script de operação (acrescente em PODE_CRIAR_PRISMA_CLIENT)").toEqual([]);
  });
});
