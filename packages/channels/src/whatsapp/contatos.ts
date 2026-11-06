import { z } from "zod";
import { evolutionHeaders, evolutionFetch, exigirOk } from "./http";
import { normalizePhone } from "../phone";

/**
 * Leitura (SÓ leitura) dos dados da instância na Evolution usados para dar
 * nome às conversas do WhatsApp:
 *
 * - `GET /instance/fetchInstances` → `profileName` (o nome do PRÓPRIO dono da
 *   conta) e `ownerJid` (o número dele). Serve para achar e limpar conversas
 *   que ficaram com o nome do dono (pushName de mensagem ENVIADA).
 * - `POST /chat/findContacts/{instância}` → os contatos da instância. O campo
 *   `pushName` da tabela Contact da Evolution 2.3.7 é o nome salvo na AGENDA do
 *   celular (`contact.name` do Baileys, vindo da sincronização da agenda); na
 *   falta dele a Evolution põe o pushName do perfil ou o próprio número. Só
 *   existe com `DATABASE_SAVE_DATA_CONTACTS=true` na Evolution — desligado, a
 *   lista volta vazia.
 */

const TIMEOUT_MS = 20_000;

const instanciaSchema = z
  .object({
    name: z.string(),
    connectionStatus: z.string().nullish(),
    profileName: z.string().nullish(),
    ownerJid: z.string().nullish(),
  })
  .passthrough();

export type InstanciaEvolution = {
  nome: string;
  /** "open" | "close" | "connecting" (null = a Evolution não disse). */
  estado: string | null;
  /** Nome do perfil do DONO da conta (o pushName que ele mostra). */
  nomeDoPerfil: string | null;
  /** Número do dono em E.164 (do `ownerJid`), ou null. */
  numeroDoDono: string | null;
};

function numeroDoJid(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith("@s.whatsapp.net")) return null;
  return normalizePhone(jid.replace(/@.+$/, "").replace(/:\d+$/, ""));
}

function paraInstancia(i: z.infer<typeof instanciaSchema>): InstanciaEvolution {
  return {
    nome: i.name,
    estado: i.connectionStatus ?? null,
    nomeDoPerfil: i.profileName?.trim() || null,
    numeroDoDono: numeroDoJid(i.ownerJid),
  };
}

/**
 * Todas as instâncias da Evolution (uma chamada só — o health check usa para
 * conferir TODAS as contas conectadas sem N requisições).
 */
export async function fetchEvolutionInstances(input: { apiUrl: string; apiKey: string }): Promise<InstanciaEvolution[]> {
  const res = await evolutionFetch(
    `${input.apiUrl.replace(/\/$/, "")}/instance/fetchInstances`,
    { method: "GET", headers: evolutionHeaders(input.apiKey), cache: "no-store" },
    TIMEOUT_MS,
    "Evolution fetchInstances",
  );
  await exigirOk(res, "Evolution fetchInstances");
  const lido = z.array(z.unknown()).parse(await res.json());
  // Uma instância com formato estranho não derruba a lista inteira.
  return lido.flatMap((i) => {
    const p = instanciaSchema.safeParse(i);
    return p.success ? [paraInstancia(p.data)] : [];
  });
}

/** Uma instância pelo nome; null se ela não existe na Evolution (404). */
export async function fetchEvolutionInstance(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
}): Promise<InstanciaEvolution | null> {
  const res = await evolutionFetch(
    `${input.apiUrl.replace(/\/$/, "")}/instance/fetchInstances?instanceName=${encodeURIComponent(input.instance)}`,
    { method: "GET", headers: evolutionHeaders(input.apiKey), cache: "no-store" },
    TIMEOUT_MS,
    "Evolution fetchInstances",
  );
  if (res.status === 404) return null;
  await exigirOk(res, "Evolution fetchInstances");
  const lido = z.array(instanciaSchema).parse(await res.json());
  const i = lido.find((x) => x.name === input.instance);
  return i ? paraInstancia(i) : null;
}

const contatoSchema = z
  .object({
    remoteJid: z.string(),
    pushName: z.string().nullish(),
  })
  .passthrough();

export type ContatoDaAgenda = {
  /** jid como a Evolution guarda: `…@s.whatsapp.net`, `…@lid` (grupos ficam de fora). */
  jid: string;
  /** Telefone em E.164 quando o jid é de número; null para `@lid`. */
  numero: string | null;
  /** Nome como a Evolution guarda (ainda sem filtro — quem usa valida). */
  nome: string | null;
};

/** Contatos da instância (agenda do celular). Erro de rede/HTTP lança. */
export async function fetchEvolutionContacts(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
}): Promise<ContatoDaAgenda[]> {
  const res = await evolutionFetch(
    `${input.apiUrl.replace(/\/$/, "")}/chat/findContacts/${encodeURIComponent(input.instance)}`,
    {
      method: "POST",
      headers: evolutionHeaders(input.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({}),
      cache: "no-store",
    },
    TIMEOUT_MS,
    "Evolution findContacts",
  );
  await exigirOk(res, "Evolution findContacts");
  const lido = z.array(z.unknown()).parse(await res.json());
  const out: ContatoDaAgenda[] = [];
  for (const c of lido) {
    const p = contatoSchema.safeParse(c);
    if (!p.success) continue;
    const jid = p.data.remoteJid;
    const lid = /^\d+@lid$/.test(jid);
    const numero = numeroDoJid(jid);
    // Grupo, broadcast, newsletter etc. não são pessoa da agenda.
    if (!lid && !numero) continue;
    out.push({ jid, numero, nome: p.data.pushName?.trim() || null });
  }
  return out;
}
