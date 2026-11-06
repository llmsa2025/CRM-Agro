import { z } from "zod";
import { env } from "@crmagro/config";
import { basePrisma, getCurrentTeamId } from "@crmagro/db";
import { requireCan } from "./authz";

/**
 * Empresa (plano-equipe-permissoes, F1): criar a conta da empresa e editar os
 * dados dela.
 *
 * "Criar a conta da minha empresa" (/criar-empresa) é uma porta EXPLÍCITA de
 * cadastro — o login com Google continua recusando e-mail desconhecido (item G),
 * mas agora aponta para cá. Nasce: Team (nome da empresa) + User dono + padrões
 * (funil "Vendas" com 5 etapas e meta do mês), numa transação. Dois caminhos,
 * os dois com o e-mail COMPROVADO antes de a conta existir:
 * - Google (`provisionUserFromGoogle` com a empresa): o Google prova o e-mail;
 * - e-mail e senha (`cadastro-com-senha.ts`): a conta só nasce quando o dono
 *   da caixa abre o link de confirmação e digita a senha do cadastro.
 * Conta com senha sem confirmação NÃO existe mais (auditoria do #148).
 */

/** CNPJ: só os dígitos, 14; vazio = sem CNPJ. */
const cnpjSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, ""))
  .refine((v) => v === "" || v.length === 14, "CNPJ precisa de 14 dígitos")
  .transform((v) => v || null)
  .optional();
const ufSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => v === "" || /^[A-Z]{2}$/.test(v), "UF com 2 letras")
  .transform((v) => v || null)
  .optional();
const cidadeSchema = z
  .string()
  .trim()
  .max(80)
  .transform((v) => v || null)
  .optional();

export const dadosEmpresaSchema = z.object({
  nome: z.string().trim().min(2, "informe o nome da empresa").max(120),
  cnpj: cnpjSchema,
  cidade: cidadeSchema,
  estado: ufSchema,
});
export type DadosEmpresaInput = z.input<typeof dadosEmpresaSchema>;

export type EmpresaDTO = { id: string; nome: string; cnpj: string | null; cidade: string | null; estado: string | null };

/** A porta "Criar a conta da minha empresa" está aberta? (`CADASTRO_EMPRESA=off` fecha). */
export function cadastroEmpresaAberto(): boolean {
  return env.CADASTRO_EMPRESA !== "off";
}

function timeDoContexto(): string {
  const t = getCurrentTeamId();
  if (!t) throw new Error("sem time no contexto");
  return t;
}

/** Dados da empresa do time atual (qualquer papel lê). */
export async function getEmpresa(): Promise<EmpresaDTO> {
  // Team não é tabela tenant (é o próprio tenant): o id vem SEMPRE do contexto.
  const t = await basePrisma.team.findUniqueOrThrow({
    where: { id: timeDoContexto() },
    select: { id: true, name: true, cnpj: true, cidade: true, estado: true },
  });
  return { id: t.id, nome: t.name, cnpj: t.cnpj, cidade: t.cidade, estado: t.estado };
}

/** Edita os dados da empresa (Configurações → Empresa): dono e administradores. */
export async function atualizarEmpresa(input: DadosEmpresaInput): Promise<EmpresaDTO> {
  requireCan("settings.write");
  const d = dadosEmpresaSchema.parse(input);
  const t = await basePrisma.team.update({
    where: { id: timeDoContexto() },
    data: { name: d.nome, cnpj: d.cnpj ?? null, cidade: d.cidade ?? null, estado: d.estado ?? null },
    select: { id: true, name: true, cnpj: true, cidade: true, estado: true },
  });
  return { id: t.id, nome: t.name, cnpj: t.cnpj, cidade: t.cidade, estado: t.estado };
}
