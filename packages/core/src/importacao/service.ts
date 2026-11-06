import { db, getCurrentTeamId, type TenantPrismaClient } from "@crmagro/db";
import { ondeIdentificadorExato, valorDe } from "../contacts/identificadores-cifra";
import { requireCan } from "../auth/authz";
import { hashDoCpfDoTime } from "../contacts/cpf";
import { lerPlanilha, montarRegistros, sugerirMapeamento, validarMapeamento, type Registro } from "./planilha";
import { previewImportInputSchema, type Mapeamento } from "./schema";

/**
 * Importação de contatos em 4 passos (produto §C) — prévia.
 *
 * `previewImport` NÃO escreve nada: lê a planilha, sugere para onde vai cada
 * coluna e classifica cada linha como a importação vai tratá-la — novo, já
 * existe (será completado), repetido na planilha (unido à 1ª) ou inválido. As
 * regras são as de `planilha.ts`, as mesmas do worker.
 */

export type SituacaoLinha = "novo" | "ja_existe" | "repetido" | "invalido";

export type LinhaPrevia = {
  /** Número da linha na planilha (cabeçalho = 1). */
  linha: number;
  /** Células da linha, na ordem das colunas. */
  valores: string[];
  situacao: SituacaoLinha;
  /** Por que foi recusada (inválida). */
  motivo?: string;
  /** Linha à qual esta repetida será unida. */
  repeteLinha?: number;
};

export type PreviewImportacao = {
  colunas: string[];
  /** Mapeamento usado nesta prévia (o pedido ou, sem pedido, o sugerido). */
  mapeamento: Mapeamento;
  mapeamentoSugerido: Mapeamento;
  /** Colunas fora da importação ("Não importar"). */
  ignoradas: string[];
  /** Linhas de dados (sem o cabeçalho e sem linha vazia). */
  total: number;
  contagens: { novos: number; jaExistem: number; repetidos: number; invalidos: number };
  /** As primeiras linhas da planilha. */
  amostra: LinhaPrevia[];
  /** Até `EXEMPLOS_POR_SITUACAO` linhas de cada situação (filtro da prévia). */
  exemplos: Record<SituacaoLinha, LinhaPrevia[]>;
  avisos: string[];
};

const LINHAS_NA_AMOSTRA = 10;
export const EXEMPLOS_POR_SITUACAO = 10;
/** Identificadores por consulta de "já existe" (bem abaixo do limite de bind). */
const LOTE_BUSCA = 1000;

/**
 * Contatos do time que já têm o CPF, o WhatsApp ou o e-mail de algum registro: chave (`c:<cpf>` / `w:<e164>` /
 * `e:<email>`) → contactId. WhatsApp e e-mail em blocos de 1.000 por canal; o CPF pela impressão (`cpfHash`),
 * porque o CPF é cifrado no banco.
 */
export async function acharExistentes(
  prisma: TenantPrismaClient,
  registros: readonly Pick<Registro, "whatsapps" | "emails" | "cpf">[],
): Promise<Map<string, string>> {
  const donos = new Map<string, string>();
  const porCanal = {
    whatsapp: [...new Set(registros.flatMap((r) => r.whatsapps))],
    email: [...new Set(registros.flatMap((r) => r.emails))],
  };
  for (const canal of ["whatsapp", "email"] as const) {
    const valores = porCanal[canal];
    for (let i = 0; i < valores.length; i += LOTE_BUSCA) {
      const achados = await prisma.channelIdentifier.findMany({
        where: ondeIdentificadorExato(getCurrentTeamId() ?? "", canal, valores.slice(i, i + LOTE_BUSCA)),
        select: { valor: true, valorCifrado: true, contactId: true },
      });
      for (const a of achados) {
        const valor = valorDe(a);
        if (valor) donos.set(`${canal === "whatsapp" ? "w" : "e"}:${valor}`, a.contactId);
      }
    }
  }
  const cpfDaImpressao = new Map<string, string>();
  for (const cpf of new Set(registros.flatMap((r) => (r.cpf ? [r.cpf] : [])))) {
    const h = hashDoCpfDoTime(cpf);
    if (h) cpfDaImpressao.set(h, cpf);
  }
  const impressoes = [...cpfDaImpressao.keys()];
  for (let i = 0; i < impressoes.length; i += LOTE_BUSCA) {
    const achados = await prisma.contact.findMany({
      where: { cpfHash: { in: impressoes.slice(i, i + LOTE_BUSCA) } },
      select: { id: true, cpfHash: true },
    });
    for (const a of achados) if (a.cpfHash && !donos.has(`c:${cpfDaImpressao.get(a.cpfHash)}`)) donos.set(`c:${cpfDaImpressao.get(a.cpfHash)}`, a.id);
  }
  return donos;
}

/** Contato existente do registro: pelo CPF primeiro, depois pelo WhatsApp e pelo e-mail. */
export function existenteDe(r: Pick<Registro, "whatsapps" | "emails" | "cpf">, donos: Map<string, string>): string | undefined {
  return (
    (r.cpf && donos.get(`c:${r.cpf}`)) ||
    r.whatsapps.map((w) => donos.get(`w:${w}`)).find((id) => id) ||
    r.emails.map((e) => donos.get(`e:${e}`)).find((id) => id) ||
    undefined
  );
}

/** `mapeamento` chega da borda como veio (JSON do cliente): o zod valida aqui. */
export async function previewImport(input: { texto: string; mapeamento?: unknown }): Promise<PreviewImportacao> {
  requireCan("contacts.import");
  const prisma = db();
  const { texto, mapeamento: pedido } = previewImportInputSchema.parse(input);
  const planilha = lerPlanilha(texto);
  const mapeamentoSugerido = sugerirMapeamento(planilha.colunas);
  const mapeamento = pedido ?? mapeamentoSugerido;
  validarMapeamento(planilha.colunas, mapeamento);

  const { registros, invalidas, repetidas } = montarRegistros(planilha, mapeamento);
  const donos = await acharExistentes(prisma, registros);

  const situacao = new Map<number, Pick<LinhaPrevia, "situacao" | "motivo" | "repeteLinha">>();
  let jaExistem = 0;
  for (const r of registros) {
    const existe = existenteDe(r, donos) !== undefined;
    if (existe) jaExistem++;
    situacao.set(r.linha, { situacao: existe ? "ja_existe" : "novo" });
  }
  for (const r of repetidas) situacao.set(r.linha, { situacao: "repetido", repeteLinha: r.de });
  for (const r of invalidas) situacao.set(r.linha, { situacao: "invalido", motivo: r.motivo });

  const amostra: LinhaPrevia[] = [];
  const exemplos: Record<SituacaoLinha, LinhaPrevia[]> = { novo: [], ja_existe: [], repetido: [], invalido: [] };
  for (const { linha, celulas } of planilha.linhas) {
    const s = situacao.get(linha)!;
    const item: LinhaPrevia = { linha, valores: planilha.colunas.map((_, i) => celulas[i] ?? ""), ...s };
    if (amostra.length < LINHAS_NA_AMOSTRA) amostra.push(item);
    if (exemplos[s.situacao].length < EXEMPLOS_POR_SITUACAO) exemplos[s.situacao].push(item);
  }

  const avisos: string[] = [];
  if (!mapeamento.includes("nome")) avisos.push("Nenhuma coluna vai para Nome: sem nome, a linha fica de fora.");
  if (!mapeamento.includes("whatsapp") && !mapeamento.includes("email")) {
    avisos.push("Sem coluna de WhatsApp nem de e-mail: não dá para achar quem já existe nem unir repetidos.");
  }

  return {
    colunas: planilha.colunas,
    mapeamento,
    mapeamentoSugerido,
    ignoradas: planilha.colunas.filter((_, i) => !mapeamento[i]),
    total: planilha.linhas.length,
    contagens: {
      novos: registros.length - jaExistem,
      jaExistem,
      repetidos: repetidas.length,
      invalidos: invalidas.length,
    },
    amostra,
    exemplos,
    avisos,
  };
}
