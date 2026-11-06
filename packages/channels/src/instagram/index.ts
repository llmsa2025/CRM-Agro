import type { Channel, SendInput, SendOutput } from "../types";

/**
 * Provider Instagram (Graph API oficial) — PLACEHOLDER.
 *
 * Implementa a interface `Channel`, mas `send` ainda lança: a integração com a
 * Graph API do Instagram está pendente. O motor de fluxos e o inbox tratam o
 * erro como "canal indisponível". Quando a Graph API entrar, só o corpo de
 * `send` muda — a interface (e quem a consome) continua igual (§3/§7).
 */
const NOT_IMPLEMENTED = "Instagram provider ainda não implementado: Graph API pendente";

export class InstagramProvider implements Channel {
  async send(_input: SendInput): Promise<SendOutput> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
