import { NextResponse } from "next/server";
import { z } from "zod";
import { runWithTeam } from "@crmagro/db";
import { fotoDaConversa, logger, rateLimit } from "@crmagro/core";
import { currentUser, identidade } from "@/lib/tenant";

/**
 * GET /api/conversations/:id/foto
 *
 * Foto de perfil do WhatsApp de quem está na conversa (avatar da lista, do cabeçalho e o pop-up). Devolve os bytes
 * da imagem, buscados na hora: o servidor não grava a foto nem o endereço dela. Quem guarda por um tempo é o
 * navegador (`private`), então a lista inteira não repete a busca a cada carregamento.
 * Sem foto (escondida, não tem, conversa sem telefone) → 404, e a tela cai nas iniciais.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** A lista pede a foto de até 50 conversas de uma vez, e a pessoa navega rápido: folga larga por usuário. */
const LIMITE = { max: 300, janelaMs: 60_000 };

const CACHE_FOTO = "private, max-age=21600"; // 6 h
const CACHE_SEM_FOTO = "private, max-age=3600"; // 1 h
const CACHE_INDISPONIVEL = "private, max-age=60";

const semFoto = (cache: string) => new NextResponse(null, { status: 404, headers: { "Cache-Control": cache, Vary: "Cookie" } });

export async function GET(_req: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "NaoAutenticado" }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return semFoto(CACHE_SEM_FOTO);

  const rl = await rateLimit(`conversa-foto:${user.id}`, LIMITE.max, LIMITE.janelaMs);
  if (!rl.allowed) {
    return new NextResponse(null, { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)), "Cache-Control": "no-store" } });
  }

  try {
    const r = await runWithTeam(user.teamId, () => fotoDaConversa(id), identidade(user));
    if (r.estado === "sem_foto") return semFoto(CACHE_SEM_FOTO);
    if (r.estado === "indisponivel") return semFoto(CACHE_INDISPONIVEL);
    return new NextResponse(new Uint8Array(r.foto.bytes), {
      status: 200,
      headers: {
        "Content-Type": r.foto.tipo,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": CACHE_FOTO,
        Vary: "Cookie",
      },
    });
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[conversas] falha ao servir a foto do contato");
    return semFoto(CACHE_INDISPONIVEL);
  }
}
