/**
 * CONFERE (só leitura) a cifra de e-mail e telefone dos contatos: o cifrado abre e é igual ao texto, o
 * índice cego é o recalculado com o time da linha (pega cifrado/índice transplantado entre times) e nenhuma
 * linha que deveria ter índice está sem ele. Rode depois do `cifrar-contatos.ts --aplicar` e antes de
 * trocar `CONTATOS_CIFRA` para `indice`. Não imprime dado pessoal (só contagens e ids de linha).
 *
 *   cd /srv/crmagro/packages/db
 *   pnpm exec dotenv -e ../../.env -- tsx scripts/conferir-contatos.ts
 *
 * Opções: --tabela=<nome> (repetível)  --time=<id>  --lote=500  --limite=<linhas por tabela>
 * Sai com código 1 se achar qualquer problema.
 */
import { basePrisma } from "../src/client";
import { TABELAS_CONTATO, conferirContatosCifrados, type TabelaContato } from "../src/contatos-cifra-lotes";

function valorDe(nome: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${nome}=`))?.slice(nome.length + 3);
}

async function main() {
  const tabelas = process.argv
    .filter((a) => a.startsWith("--tabela="))
    .map((a) => a.slice("--tabela=".length)) as TabelaContato[];
  for (const t of tabelas) if (!TABELAS_CONTATO.includes(t)) throw new Error(`--tabela inválida: ${t}`);
  const teamId = valorDe("time");
  const resultado = await conferirContatosCifrados({
    ...(tabelas.length ? { tabelas } : {}),
    ...(teamId ? { teamId } : {}),
    lote: Number(valorDe("lote") ?? 500),
    ...(valorDe("limite") ? { limite: Number(valorDe("limite")) } : {}),
  });
  let problema = false;
  for (const c of resultado) {
    console.log(
      `${c.tabela}: ${c.total} linha(s) · sem cifrado: ${c.semCifrado} · não abre: ${c.naoAbre} · diferente do texto: ${c.diferenteDoTexto}` +
        ` · sem índice: ${c.semIndice} · índice errado: ${c.indiceErrado}`,
    );
    if (c.ids.length) console.log(`  linhas com problema: ${c.ids.join(", ")}`);
    if (c.semCifrado + c.naoAbre + c.diferenteDoTexto + c.semIndice + c.indiceErrado > 0) problema = true;
  }
  console.log(problema ? "Há linhas a corrigir (rode o cifrar-contatos.ts --aplicar de novo ou investigue os ids)." : "Tudo certo.");
  if (problema) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => basePrisma.$disconnect());
