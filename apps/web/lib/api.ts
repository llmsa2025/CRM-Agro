import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { runWithTeam } from "@crmagro/db";
import { currentUser, identidade } from "./tenant";

/**
 * Helpers das rotas de API (BFF). Toda rota autenticada segue o mesmo esqueleto:
 *
 *  1. Resolve o `teamId` da sessão (NextAuth) — sem sessão → 401 JSON.
 *  2. Roda o handler DENTRO de `runWithTeam(teamId, ...)`, para que `db()`
 *     (leitura eager do ALS nos serviços de @crmagro/core) enxergue o time. O
 *     teamId NUNCA é passado manual — regra de tenancy da PARTE 0 (§12).
 *  3. Mapeia erros de domínio/validação para status HTTP (nunca vaza stack).
 *
 * FAIL-CLOSED: sem time no contexto, o handler nem roda.
 */

/** Erros de "não encontrado" do domínio → 404 (identificados pelo `name`). */
const NOT_FOUND_ERRORS = new Set([
  "ContactNotFound",
  "CallNotFound",
  "FunnelNotFound",
  "FlowNotFound",
  "StageNotFound",
  "DealNotFound",
  "TagNotFound",
  "EnrollmentNotFound",
  // S1: id que não é do time (ou não existe) — mesma resposta para os dois casos.
  "OwnedNotFound",
]);

/** Erros de validação nomeados do domínio → 400. */
const VALIDATION_ERRORS = new Set([
  "ContactValidationError",
  "CallValidationError",
  "MediaNotAllowed",
  "CursorInvalido",
  "ContatoSemTelefoneValido",
]);

/**
 * Integração não pronta (409 — a tela cai no fluxo manual) e provedor externo
 * que recusou/não respondeu (502). A mensagem é do domínio, sem resposta crua.
 */
const STATUS_POR_ERRO: Record<string, number> = {
  VoopiNaoConfigurada: 409,
  ContatoPediuParaSair: 409,
  VoopiFalhou: 502,
};

function errorToResponse(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: "ValidationError", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      { status: 400 },
    );
  }
  if (err instanceof Error) {
    // RBAC: papel insuficiente → 403 (não vaza detalhe além do nome).
    if (err.name === "ForbiddenError") {
      return NextResponse.json({ error: "ForbiddenError" }, { status: 403 });
    }
    if (NOT_FOUND_ERRORS.has(err.name)) {
      return NextResponse.json({ error: err.name, message: err.message }, { status: 404 });
    }
    if (VALIDATION_ERRORS.has(err.name)) {
      return NextResponse.json({ error: err.name, message: err.message }, { status: 400 });
    }
    const status = STATUS_POR_ERRO[err.name];
    if (status) {
      return NextResponse.json({ error: err.name, message: err.message }, { status });
    }
  }
  // Não vaza detalhes internos.
  return NextResponse.json({ error: "InternalError" }, { status: 500 });
}

/**
 * Executa `fn` no contexto do time da sessão e devolve JSON. `fn` retorna o
 * corpo (serializável) da resposta; `status` default 200. Sem sessão → 401.
 */
export async function withTeam(
  fn: () => Promise<unknown>,
  init: { status?: number } = {},
): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "NaoAutenticado" }, { status: 401 });
  }
  try {
    // RBAC (R1): desce identidade (userId+role) ao contexto para as checagens de
    // autorização das rotas (ex.: requireRole no PUT de business-hours).
    const data = await runWithTeam(user.teamId, fn, identidade(user));
    return NextResponse.json(data ?? null, { status: init.status ?? 200 });
  } catch (err) {
    return errorToResponse(err);
  }
}

/** Lê e faz o parse do corpo JSON da request; `{}` se vazio/ilegível. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
