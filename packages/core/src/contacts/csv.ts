import Papa from "papaparse";
import { contactCreateSchema, type ContactCreate } from "./schema";
import { normalizePhone } from "./phone";

export type CsvError = { row: number; error: string };
export type CsvParseResult = { valid: ContactCreate[]; errors: CsvError[] };

/** Mapeia header variantes (Nome/nome, telefone/celular/whatsapp...) pra campos. */
function pick(raw: Record<string, string | undefined>, keys: string[]): string {
  for (const k of keys) {
    for (const key of Object.keys(raw)) {
      if (key.toLowerCase() === k.toLowerCase() && raw[key]) return String(raw[key]);
    }
  }
  return "";
}

/**
 * Parseia CSV de contatos: valida cada linha com zod, coleta erros por linha,
 * e deduplica DENTRO do lote por telefone|email. A dedup contra o banco é
 * responsabilidade do service (importCsv), que conhece o contexto de tenancy.
 */
export function parseContactsCsv(text: string): CsvParseResult {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  const valid: ContactCreate[] = [];
  const errors: CsvError[] = [];

  result.data.forEach((raw, i) => {
    const rowNo = i + 2; // linha 1 é o header
    const obj = {
      nome: pick(raw, ["nome", "name"]),
      // Sobrenome opcional: aceita variantes PT/EN. Alimenta {sobrenome}/{primeiro_nome}.
      sobrenome: pick(raw, ["sobrenome", "last name", "lastname", "último nome", "ultimo nome", "surname"]),
      email: pick(raw, ["email", "e-mail"]),
      telefone: pick(raw, ["telefone", "celular", "whatsapp", "fone", "phone"]),
      cidade: pick(raw, ["cidade", "city"]),
      estado: pick(raw, ["estado", "uf", "state"]),
      empresa: pick(raw, ["empresa", "company"]),
      cargo: pick(raw, ["cargo", "position"]),
      origem: pick(raw, ["origem", "source"]) || "csv",
      tags: pick(raw, ["tags", "tag"])
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };

    const parsed = contactCreateSchema.safeParse(obj);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      errors.push({
        row: rowNo,
        error: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
      });
    }
  });

  // Dedup dentro do lote (telefone normalizado | email).
  const seen = new Set<string>();
  const deduped = valid.filter((c) => {
    const tel = c.telefone ? normalizePhone(c.telefone) : undefined;
    const key = [tel, c.email?.toLowerCase()].filter(Boolean).join("|");
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  });

  return { valid: deduped, errors };
}
