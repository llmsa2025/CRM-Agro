import { auth } from "@/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A extensão de navegador não faz parte desta versão pública do CRM Agro. */
export async function GET() {
  const session = await auth();
  if (!session?.user?.teamId) return new Response("unauthorized", { status: 401 });
  return new Response("A extensão de navegador não faz parte desta versão pública do CRM Agro.", { status: 404 });
}
