import { z } from "zod";
import { normalizePhone } from "@crmagro/channels";

/**
 * Corpo do webhook de fluxo (POST /api/webhooks/flow/:token) — auditoria S5.
 *
 * Rota pública (qualquer um com o token chama), então tudo é limitado: no
 * máximo 20 campos, texto até 200 caracteres (nome até 120), só texto ou
 * número, e precisa de telefone VÁLIDO ou e-mail VÁLIDO. Antes aceitava
 * qualquer coisa de qualquer tamanho e criava contato sem limite.
 *
 * Aceita os apelidos comuns de formulário/landing page (name, phone, whatsapp…).
 */

export const WEBHOOK_MAX_CAMPOS = 20;
export const WEBHOOK_MAX_TEXTO = 200;
export const WEBHOOK_MAX_NOME = 120;

export type WebhookLead = {
  nome?: string;
  telefone?: string;
  email?: string;
  empresa?: string;
  cidade?: string;
  cargo?: string;
  origem?: string;
};

const valorSchema = z.union([z.string().max(WEBHOOK_MAX_TEXTO), z.number().finite(), z.boolean(), z.null()]);
const corpoSchema = z
  .record(z.string().max(60), valorSchema)
  .refine((o) => Object.keys(o).length <= WEBHOOK_MAX_CAMPOS, `no máximo ${WEBHOOK_MAX_CAMPOS} campos`);
const emailSchema = z.string().email().max(WEBHOOK_MAX_TEXTO);

type Corpo = z.infer<typeof corpoSchema>;

function campo(b: Corpo, ...chaves: string[]): string | undefined {
  for (const k of chaves) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

export function parseWebhookLead(body: unknown): { ok: true; data: WebhookLead } | { ok: false; error: string } {
  const r = corpoSchema.safeParse(body ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, error: `corpo inválido: ${i?.path.join(".") || "(raiz)"} ${i?.message ?? ""}`.trim() };
  }
  const b = r.data;
  const nome = campo(b, "nome", "name", "nome_completo", "fullName");
  if (nome && nome.length > WEBHOOK_MAX_NOME) return { ok: false, error: `nome acima de ${WEBHOOK_MAX_NOME} caracteres` };

  const telefoneBruto = campo(b, "telefone", "phone", "whatsapp", "celular", "telefone_celular");
  const emailBruto = campo(b, "email", "e-mail", "mail");
  const telefone = telefoneBruto ? (normalizePhone(telefoneBruto) ?? undefined) : undefined;
  const email = emailBruto && emailSchema.safeParse(emailBruto).success ? emailBruto.toLowerCase() : undefined;
  if (!telefone && !email) return { ok: false, error: "envie um telefone válido ou um e-mail válido" };

  const data: WebhookLead = {
    ...(nome ? { nome } : {}),
    ...(telefone ? { telefone } : {}),
    ...(email ? { email } : {}),
  };
  const empresa = campo(b, "empresa", "company", "empresa_nome");
  const cidade = campo(b, "cidade", "city");
  const cargo = campo(b, "cargo", "role", "job_title");
  const origem = campo(b, "origem", "source", "utm_source");
  if (empresa) data.empresa = empresa;
  if (cidade) data.cidade = cidade;
  if (cargo) data.cargo = cargo;
  if (origem) data.origem = origem;
  return { ok: true, data };
}
