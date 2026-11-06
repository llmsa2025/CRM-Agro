import { valorDe } from "./identificadores-cifra";

/**
 * Contato como vai para o NAVEGADOR (rotas REST). O `list`, o `getById` e o `update` devolvem a linha inteira do
 * Prisma, e ela traz colunas que o navegador não precisa e não deve receber: o CPF cifrado e o índice dele
 * (`cpfCifrado`, `cpfHash`) e, com a cifra de e-mail e telefone (CONTATOS_CIFRA), o valor cifrado e os índices
 * cegos de cada identificador. Aqui eles saem, e `valor` de cada identificador já vai legível.
 */
const CAMPOS_INTERNOS_DO_CONTATO = ["cpfCifrado", "cpfHash"] as const;
const CAMPOS_INTERNOS_DO_IDENTIFICADOR = ["valorCifrado", "valorHash", "valorSufixoHash"] as const;

export function contatoParaNavegador<T extends object>(contato: T): T {
  const c: Record<string, unknown> = { ...(contato as Record<string, unknown>) };
  for (const k of CAMPOS_INTERNOS_DO_CONTATO) delete c[k];
  if (Array.isArray(c.identifiers)) {
    c.identifiers = c.identifiers.map((i: Record<string, unknown>) => {
      const limpo: Record<string, unknown> = { ...i, valor: valorDe(i as { valor?: string | null; valorCifrado?: string | null }) ?? i.valor };
      for (const k of CAMPOS_INTERNOS_DO_IDENTIFICADOR) delete limpo[k];
      return limpo;
    });
  }
  return c as T;
}
