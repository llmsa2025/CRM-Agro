/**
 * DESFAZ o preenchimento da cifra de e-mail e telefone dos contatos: zera as colunas novas
 * (`valorCifrado`, `valorHash`, `valorSufixoHash`, `externalNumberCifrado`, `externalNumberHash`,
 * `telefoneCifrado`, `telefoneHash`, `phoneNumberCifrado`). O TEXTO PURO nunca foi tocado pelo
 * preenchimento, então nada se perde. Rode DEPOIS de voltar `CONTATOS_CIFRA=off` e reiniciar
 * (senão a escrita dupla preenche de novo).
 *
 *   cd /srv/crmagro/packages/db
 *   pnpm exec dotenv -e ../../.env -- tsx scripts/reverter-contatos-cifrados.ts --simular   # só conta (padrão)
 *   pnpm exec dotenv -e ../../.env -- tsx scripts/reverter-contatos-cifrados.ts --aplicar
 *
 * Opções: --tabela=<nome> (repetível)  --time=<id>  --lote=1000  --pausa-ms=50
 * Em lotes, sem mexer em `updatedAt`, idempotente. Não imprime dado pessoal.
 */
import { basePrisma } from "../src/client";
import { TABELAS_CONTATO, reverterContatosCifrados, type TabelaContato } from "../src/contatos-cifra-lotes";

function valorDe(nome: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${nome}=`))?.slice(nome.length + 3);
}

async function main() {
  const aplicar = process.argv.includes("--aplicar") && !process.argv.includes("--simular");
  const tabelas = process.argv
    .filter((a) => a.startsWith("--tabela="))
    .map((a) => a.slice("--tabela=".length)) as TabelaContato[];
  for (const t of tabelas) if (!TABELAS_CONTATO.includes(t)) throw new Error(`--tabela inválida: ${t}`);
  const teamId = valorDe("time");
  console.log(aplicar ? "MODO: zerando (--aplicar)" : "MODO: simulação (nada é gravado; use --aplicar)");
  const resumos = await reverterContatosCifrados({
    aplicar,
    ...(tabelas.length ? { tabelas } : {}),
    ...(teamId ? { teamId } : {}),
    lote: Number(valorDe("lote") ?? 1000),
    pausaMs: Number(valorDe("pausa-ms") ?? 50),
    log: (m) => console.log(m),
  });
  for (const r of resumos) console.log(`${r.tabela}: com campos novos: ${r.comCamposNovos}${aplicar ? ` · zeradas: ${r.zeradas}` : ""}`);
  if (!aplicar) console.log("Só simulei. Rode com --aplicar para zerar.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => basePrisma.$disconnect());
