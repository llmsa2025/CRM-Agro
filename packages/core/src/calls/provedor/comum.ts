import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Peças comuns dos provedores de ligação: tipos do contexto e do webhook cru, comparação de segredo em tempo
 * constante, id de evento fabricado, sigilo de segredos em log e máscara de credencial.
 *
 * Sem rede, sem banco e sem estado: tudo aqui é puro, para o contrato dos provedores poder usar sem montar nada.
 */

// ---------------------------------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------------------------------

export type Ambiente = "teste" | "producao";

/** Resultado de "testar a conexão" de um provedor: só leitura, nunca cria nada. */
export type ResultadoDoTeste = { ok: true; ambienteDetectado?: Ambiente };

export interface ContextoDoProvedor {
  ambiente: Ambiente;
  /** Já decifradas e validadas pelo descritor. NUNCA logar nem devolver à tela. */
  credenciais: Readonly<Record<string, string>>;
  /** O segredo do webhook. `anterior` vale durante a janela de rotação (1 hora). */
  segredoWebhook: { atual: string; anterior?: string } | null;
}

/** O que o webhook entrega ao adaptador: o corpo CRU (texto) e os cabeçalhos em minúsculas. */
export interface WebhookCru {
  metodo: string;
  cabecalhos: Readonly<Record<string, string>>;
  corpo: string;
}

// ---------------------------------------------------------------------------------------------------
// Verificação de webhook
// ---------------------------------------------------------------------------------------------------

/** Compara dois textos em TEMPO CONSTANTE (compara o hash dos dois: o tamanho do segredo também não vaza). */
export function iguaisEmTempoConstante(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** O valor recebido bate com o segredo atual OU com o anterior (janela de rotação)? */
export function confereComSegredo(recebido: string | undefined, segredo: { atual: string; anterior?: string } | null): boolean {
  if (!recebido || !segredo) return false;
  // Os dois são sempre comparados (sem curto-circuito) para o tempo não revelar qual casou.
  const atual = iguaisEmTempoConstante(recebido, segredo.atual);
  const anterior = segredo.anterior ? iguaisEmTempoConstante(recebido, segredo.anterior) : false;
  return atual || anterior;
}

/**
 * Provedor sem id de evento: o adaptador FABRICA o id com um hash das partes que identificam o fato
 * (ex.: token, status, data). Mesmo fato, mesmo id.
 */
export function fabricarIdDeEvento(...partes: readonly string[]): string {
  const h = createHash("sha256");
  for (const p of partes) {
    h.update(String(p.length), "utf8");
    h.update(":", "utf8");
    h.update(p, "utf8");
  }
  return `h_${h.digest("hex").slice(0, 40)}`;
}

// ---------------------------------------------------------------------------------------------------
// Sigilo: nada de segredo em log, em erro, em resposta nem em trilha
// ---------------------------------------------------------------------------------------------------

export const SEGREDO_REDIGIDO = "[segredo]";

/** Segredos curtos demais confundiriam qualquer texto: abaixo disto não se procura por trecho. */
const TAMANHO_MINIMO_DO_SEGREDO = 6;

/** Troca cada segredo achado no texto por `[segredo]`. Também apanha a versão codificada para URL e base64. */
export function redigirSegredos(texto: string, segredos: readonly string[]): string {
  let saida = texto;
  for (const s of segredos) {
    if (s.length < TAMANHO_MINIMO_DO_SEGREDO) continue;
    for (const forma of formasDoSegredo(s)) saida = saida.split(forma).join(SEGREDO_REDIGIDO);
  }
  return saida;
}

function formasDoSegredo(s: string): string[] {
  const formas = new Set<string>([s, encodeURIComponent(s), Buffer.from(s, "utf8").toString("base64")]);
  // base64 sem preenchimento (aparece em cabeçalhos Basic cortados)
  formas.add(Buffer.from(s, "utf8").toString("base64").replace(/=+$/, ""));
  return [...formas].filter((f) => f.length >= TAMANHO_MINIMO_DO_SEGREDO);
}

/** O valor (texto, objeto, lista, erro) contém algum segredo, em qualquer profundidade? */
export function contemSegredo(valor: unknown, segredos: readonly string[]): boolean {
  const alvos = segredos.filter((s) => s.length >= TAMANHO_MINIMO_DO_SEGREDO).flatMap(formasDoSegredo);
  if (alvos.length === 0) return false;
  const vistos = new WeakSet<object>();
  const varre = (v: unknown): boolean => {
    if (typeof v === "string") return alvos.some((a) => v.includes(a));
    if (v === null || typeof v !== "object") return typeof v === "number" || typeof v === "boolean" ? alvos.some((a) => String(v).includes(a)) : false;
    if (vistos.has(v)) return false;
    vistos.add(v);
    if (v instanceof Error) {
      // Erro: mensagem, nome, pilha e qualquer campo próprio (incluindo `cause`).
      if (varre(v.message) || varre(v.name) || varre(v.stack ?? "")) return true;
      if ("cause" in v && varre((v as { cause?: unknown }).cause)) return true;
    }
    for (const chave of Object.keys(v)) {
      if (alvos.some((a) => chave.includes(a))) return true;
      if (varre((v as Record<string, unknown>)[chave])) return true;
    }
    if (typeof (v as { toJSON?: unknown }).toJSON === "function") {
      try {
        if (varre((v as { toJSON: () => unknown }).toJSON())) return true;
      } catch {
        // toJSON que falha não esconde segredo: o resto da varredura já valeu.
      }
    }
    return false;
  };
  return varre(valor);
}

// ---------------------------------------------------------------------------------------------------
// Máscara de credencial para a tela
// ---------------------------------------------------------------------------------------------------

const TAMANHO_MINIMO_PARA_MOSTRAR_FINAL = 12;

/** Máscara de um segredo: só diz se está preenchido e, se for longo, como termina. */
export function mascararSegredo(valor: string | null | undefined): { preenchido: boolean; ultimos4: string | null } {
  if (!valor) return { preenchido: false, ultimos4: null };
  return { preenchido: true, ultimos4: valor.length >= TAMANHO_MINIMO_PARA_MOSTRAR_FINAL ? valor.slice(-4) : null };
}
