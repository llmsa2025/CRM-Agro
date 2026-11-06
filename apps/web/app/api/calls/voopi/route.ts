import { ligarPelaVoopi, ligarPelaVoopiSchema, statusVoopi } from "@crmagro/core";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/calls/voopi — a Voopi está pronta para ligar? `{ pronta, falta[] }`
 * (a tela decide entre "Ligar pela Voopi" e o discador manual). Sem a senha.
 */
export async function GET() {
  return withTeam(async () => {
    const s = await statusVoopi();
    return { pronta: s.pronta, falta: s.falta };
  });
}

/**
 * POST /api/calls/voopi — liga pela Voopi (click-to-call).
 *   { contactId: uuid, phoneNumber?: string }  → liga para um contato
 *   { callId: uuid }                             → origina a ligação do discador
 * Resposta: { callId, providerCallId, contactId, phoneNumber }.
 * Erros: VoopiNaoConfigurada → 409 (a tela cai no discador manual);
 * VoopiFalhou → 502; ContatoSemTelefoneValido/CallValidationError → 400;
 * contato/ligação de outro time → 404.
 */
export async function POST(req: Request) {
  const body = await readJson(req);
  return withTeam(async () => ligarPelaVoopi(ligarPelaVoopiSchema.parse(body)));
}
