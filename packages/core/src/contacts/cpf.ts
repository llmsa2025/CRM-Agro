import { basePrisma, db, getCurrentTeamId, impressaoDeTexto, CONTEXTO_CPF, cifrarTexto, decifrarTexto, TextoCifradoIlegivel, ChaveDeCredencialAusente } from "@crmagro/db";

/**
 * CPF do contato, cifrado no banco (coluna `Contact.cpfCifrado`, AES-256-GCM, a mesma chave das
 * credenciais). TODA leitura e escrita do CPF passa por aqui: o resto do código só vê o CPF em texto,
 * e a coluna nunca recebe texto puro. O teste `contacts/cpf.test.ts` varre o código e cobra isso.
 *
 * Por que só o CPF e não nome, e-mail e telefone: esses entram em busca, deduplicação e filtro
 * (ILIKE, trigram, índice único), que não funcionam sobre texto cifrado. O CPF só é guardado e mostrado.
 * Detalhes e o que protege o resto: a documentação interna.
 */
export { CONTEXTO_CPF };

/** Texto do CPF para gravar em `cpfCifrado`. Vazio ou ausente vira null. */
export function cifrarCpf(cpf: string | null | undefined): string | null {
  const limpo = cpf?.trim();
  return limpo ? cifrarTexto(limpo, CONTEXTO_CPF) : null;
}

let avisouIlegivel = 0;

/**
 * CPF em texto a partir do valor da coluna `cpfCifrado`. Texto puro legado volta como está. Se o
 * valor não abrir (chave errada, dado adulterado), devolve null e registra o erro: uma tela de contato
 * não pode cair por causa de um campo, mas o sumiço do CPF não pode passar em silêncio.
 */
export function lerCpf(cifrado: string | null | undefined): string | null {
  if (!cifrado) return null;
  try {
    return decifrarTexto(cifrado, CONTEXTO_CPF);
  } catch (e) {
    if (e instanceof TextoCifradoIlegivel || e instanceof ChaveDeCredencialAusente) {
      // Avisa nas 5 primeiras vezes por processo (um erro de chave afeta todo contato com CPF).
      if (avisouIlegivel++ < 5) console.error(`[cpf] não consegui abrir um CPF cifrado: ${e.message}`);
      return null;
    }
    throw e;
  }
}

/**
 * Impressão do CPF para achar "o mesmo CPF" sem abrir o cifrado (`Contact.cpfHash`). Só vale com 11 dígitos;
 * texto livre antigo que não é CPF fica sem impressão. O time entra na conta (o mesmo CPF em dois times difere).
 */
export function hashDoCpf(teamId: string | null | undefined, cpf: string | null | undefined): string | null {
  const digitos = (cpf ?? "").replace(/\D/g, "");
  if (!teamId || digitos.length !== 11) return null;
  return impressaoDeTexto(digitos, teamId, CONTEXTO_CPF);
}

/** Impressão do CPF no time do contexto atual (a mesma que as escritas gravam). */
export function hashDoCpfDoTime(cpf: string | null | undefined): string | null {
  return hashDoCpf(getCurrentTeamId(), cpf);
}

/** Grava o CPF só nos contatos que ainda não têm um (importação). Nunca troca o que já está lá. */
export async function completarCpfSeVazio(itens: { contactId: string; cpf: string }[]): Promise<void> {
  const prisma = db(); // antes de qualquer await (AGENTS.md §12)
  const teamId = getCurrentTeamId();
  for (const { contactId, cpf } of itens) {
    await prisma.contact.updateMany({ where: { id: contactId, cpfCifrado: null }, data: { cpfCifrado: cifrarCpf(cpf), cpfHash: hashDoCpf(teamId, cpf) } });
  }
}

/**
 * Preenche `cpfHash` de quem já tem CPF cifrado e ainda não tem a impressão (todos os times). Idempotente e em
 * blocos; roda no boot do worker. `refazer` recalcula todas (depois de trocar a chave). Devolve quantos gravou.
 */
export async function preencherHashDoCpf(opts: { refazer?: boolean } = {}): Promise<number> {
  let ultimo = "";
  let gravados = 0;
  for (;;) {
    const lote = await basePrisma.contact.findMany({
      where: { id: { gt: ultimo }, cpfCifrado: { not: null }, ...(opts.refazer ? {} : { cpfHash: null }) },
      select: { id: true, teamId: true, cpfCifrado: true },
      orderBy: { id: "asc" },
      take: 500,
    });
    if (lote.length === 0) return gravados;
    for (const c of lote) {
      const hash = hashDoCpf(c.teamId, lerCpf(c.cpfCifrado));
      if (hash) {
        await basePrisma.contact.update({ where: { id: c.id }, data: { cpfHash: hash } });
        gravados++;
      }
    }
    ultimo = lote[lote.length - 1]!.id;
  }
}
