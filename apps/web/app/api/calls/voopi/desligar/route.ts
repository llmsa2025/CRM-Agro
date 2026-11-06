import { z } from "zod";
import { desligarPelaVoopi } from "@crmagro/core";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const desligarSchema = z.object({ callId: z.string().uuid() });

/**
 * POST /api/calls/voopi/desligar — `{ callId }`. Desliga a ligação na Voopi; o
 * fim (status/duração) chega pelo webhook.
 */
export async function POST(req: Request) {
  const body = await readJson(req);
  return withTeam(async () => {
    await desligarPelaVoopi(desligarSchema.parse(body).callId);
    return { ok: true };
  });
}
