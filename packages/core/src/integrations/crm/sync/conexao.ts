/**
 * Conexão do time com o Nectar (ficha N2): guardar o token da API, testar,
 * remover e abrir a conexão só na hora da chamada. Segue o padrão da Voopi
 * (`calls/voopi.ts`): o serviço grava `credentials` como objeto comum e a
 * extensão do Prisma (`packages/db/src/client.ts`) cifra UMA vez na escrita e
 * decifra na leitura. NÃO chame `encryptCredentials` aqui (cifra dupla).
 *
 * O token nunca sai daqui para a tela, para job nem para log: a tela recebe só
 * o `NectarStatusDTO` (com os 4 últimos caracteres).
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, tenantData } from "@crmagro/db";
import { requireCan } from "../../../auth/authz";
import { logger } from "../../../logger/index";
import type { ConexaoAberta, DiagnosticoConexao } from "../contract";
import { CrmNaoConfigurado } from "../errors";
import type { TransporteNectar } from "../providers/nectarcrm/client";
import { criarConectorNectar } from "../providers/nectarcrm/index";
import { aquecerBetaCrm, exigirBetaCrm, crmLiberadoParaOTime } from "./beta";

/** Borda da tela: o token colado pelo admin. */
export const salvarTokenNectarSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20, "o token parece incompleto")
    .max(4000)
    .regex(/^\S+$/, "o token não tem espaços"),
});
export type SalvarTokenNectarInput = z.input<typeof salvarTokenNectarSchema>;

/** O que fica cifrado em `Integration.credentials`. */
export const credencialNectarSchema = z.object({ token: z.string().min(1) });

/** Estado da conexão para a tela (nunca o token). */
export type NectarStatusDTO = {
  /** O time está no beta (`CRM_BETA_TEAM_IDS`). */
  liberado: boolean;
  /** Existe uma linha com um token válido. Depois do "Desconectar" (`credentials = {}`) fica `false`. */
  configurado: boolean;
  status: "connected" | "error" | "disconnected";
  /** "••••" + os 4 últimos caracteres do token. */
  finalDoToken: string | null;
  atualizadoEm: string | null;
  /** IP público do servidor (`CRMAGRO_IP_SAIDA`), para o cliente liberar no usuário do token. */
  ipSaida: string | null;
};

/** Pode haver mais de uma linha (o `Integration` não tem trava de uma por time antes do N6): vale a mais recente. */
async function linhaDoNectar() {
  return db().integration.findFirst({
    where: { tipo: "nectarcrm" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, credentials: true, status: true, updatedAt: true },
  });
}

/**
 * Conexão já decifrada, montada só na hora da chamada (servidor). O token não
 * entra em payload de job, em log nem em DTO. Sem linha ou sem token válido:
 * `CrmNaoConfigurado`.
 */
export async function abrirConexaoNectar(): Promise<ConexaoAberta> {
  const row = await linhaDoNectar();
  const cred = credencialNectarSchema.safeParse(row?.credentials);
  if (!row || !cred.success) throw new CrmNaoConfigurado();
  return { integrationId: row.id, token: cred.data.token };
}

function statusDaLinha(status: string | undefined): NectarStatusDTO["status"] {
  return status === "connected" || status === "error" ? status : "disconnected";
}

/** Só leitura: a página é de admin, mas o DTO nunca leva o token. */
export async function statusNectar(): Promise<NectarStatusDTO> {
  await aquecerBetaCrm();
  const row = await linhaDoNectar();
  const cred = credencialNectarSchema.safeParse(row?.credentials);
  return {
    liberado: crmLiberadoParaOTime(),
    configurado: Boolean(row) && cred.success,
    status: statusDaLinha(row?.status),
    finalDoToken: cred.success ? `••••${cred.data.token.slice(-4)}` : null,
    atualizadoEm: row?.updatedAt ? row.updatedAt.toISOString() : null,
    ipSaida: process.env.CRMAGRO_IP_SAIDA?.trim() || null,
  };
}

/**
 * Guarda o token (cifrado pela extensão) e já testa. Atualiza a linha que
 * existe ou cria uma. Termina com o resultado do "Testar", que devolve a
 * credencial (não lança erro por token recusado).
 */
export async function salvarTokenNectar(
  input: SalvarTokenNectarInput,
  deps: { transporte?: TransporteNectar } = {},
): Promise<{ status: NectarStatusDTO; diagnostico: DiagnosticoConexao }> {
  requireCan("integrations.manage");
  await exigirBetaCrm();
  const { token } = salvarTokenNectarSchema.parse(input);
  const existente = await linhaDoNectar();
  // Objeto comum: a extensão do Prisma cifra `credentials` na escrita.
  const credentials = { token } satisfies z.infer<typeof credencialNectarSchema>;
  if (existente) {
    await db().integration.update({ where: { id: existente.id }, data: { credentials, status: "disconnected" } });
  } else {
    await db().integration.create({
      data: tenantData<Prisma.IntegrationUncheckedCreateInput>({ tipo: "nectarcrm", credentials, status: "disconnected" }),
    });
  }
  return testarConexaoNectar(deps);
}

/**
 * "Testar": lê funis, Leadboard, usuários, filas, etiquetas, campos e formatos
 * de telefone. Grava `connected` quando o token vale e `error` quando não.
 */
export async function testarConexaoNectar(
  deps: { transporte?: TransporteNectar } = {},
): Promise<{ status: NectarStatusDTO; diagnostico: DiagnosticoConexao }> {
  requireCan("integrations.manage");
  await exigirBetaCrm();
  const conexao = await abrirConexaoNectar();
  const diagnostico = await criarConectorNectar(deps).testConnection(conexao);
  await db().integration.update({
    where: { id: conexao.integrationId },
    data: { status: diagnostico.credencial === "ok" ? "connected" : "error" },
  });
  // Log só com ids e o resultado: nunca o token nem o corpo das respostas.
  logger.info(
    { integrationId: conexao.integrationId, credencial: diagnostico.credencial, leadboard: diagnostico.leadboard },
    "[nectar] conexão testada",
  );
  return { status: await statusNectar(), diagnostico };
}

/** Remove a conexão do time: o token é apagado do CRM Agro. Nada é apagado no Nectar. */
export async function removerNectar(): Promise<void> {
  requireCan("integrations.manage");
  await db().integration.deleteMany({ where: { tipo: "nectarcrm" } });
}
