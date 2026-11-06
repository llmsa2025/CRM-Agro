import type { Channel, SendInput, SendOutput } from "../types";

/**
 * Provider LinkedIn (Sales Navigator API) — PLACEHOLDER.
 *
 * Implementa a interface `Channel`, mas `send` ainda lança: a integração com a
 * API do LinkedIn (Sales Navigator) está pendente. Quando a API entrar, só o
 * corpo de `send` muda — a interface (e quem a consome) continua igual (§3/§7).
 */
const NOT_IMPLEMENTED = "LinkedIn provider ainda não implementado: Sales Navigator API pendente";

export class LinkedInProvider implements Channel {
  async send(_input: SendInput): Promise<SendOutput> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
