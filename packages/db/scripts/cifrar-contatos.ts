/**
 * Preenche, em lotes, o valor CIFRADO e o ÍNDICE CEGO de e-mail e telefone dos contatos
 *. Roda DEPOIS de ligar `CONTATOS_CIFRA=dupla`
 * (as linhas novas já nascem preenchidas; este script cuida das que já existiam).
 *
 *   cd /srv/crmagro/packages/db
 *   pnpm exec dotenv -e ../../.env -- tsx scripts/cifrar-contatos.ts --simular            # só conta (padrão)
 *   pnpm exec dotenv -e ../../.env -- tsx scripts/cifrar-contatos.ts --aplicar            # grava
 *
 * Opções: --tabela=ChannelIdentifier|Conversation|WhatsAppLid|Call|CampaignRecipient (repetível)
 *         --time=<id>  --lote=500  --pausa-ms=50  --limite=<linhas por tabela>
 *
 * - NÃO imprime telefone, e-mail nem valor cifrado: só contagens e ids de linha;
 * - não toca o texto puro nem `updatedAt`; idempotente e retomável (pode ser interrompido e rodado de novo);
 * - não sobrescreve campo já preenchido; se o texto mudar no meio do caminho, a linha fica para o próximo passe;
 * - duas linhas do mesmo time e canal com o mesmo índice: a segunda fica só com o cifrado e vai para o relatório;
 * - sai com código 1 se alguma linha falhar ou houver colisão;
 * - para desfazer: scripts/reverter-contatos-cifrados.ts (o texto puro nunca foi tocado, nada se perde).
 *
 * Em produção, SEMPRE com pg_dump antes, em janela calma e sem build nem agente pesado em paralelo
 * (o OOM de 29/09 veio daí). Exige CONTATOS_INDICE_KEY no ambiente.
 */
import { basePrisma } from "../src/client";
import { TABELAS_CONTATO, contarNomesQueSaoTelefone, preencherContatosCifrados, type TabelaContato } from "../src/contatos-cifra-lotes";

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
  console.log(aplicar ? "MODO: gravando (--aplicar)" : "MODO: simulação (nada é gravado; use --aplicar para gravar)");

  const resumos = await preencherContatosCifrados({
    aplicar,
    ...(tabelas.length ? { tabelas } : {}),
    ...(teamId ? { teamId } : {}),
    lote: Number(valorDe("lote") ?? 500),
    pausaMs: Number(valorDe("pausa-ms") ?? 50),
    ...(valorDe("limite") ? { limite: Number(valorDe("limite")) } : {}),
    log: (m) => console.log(m),
  });

  let problema = false;
  for (const r of resumos) {
    console.log(
      `${r.tabela}: ${r.total} linha(s) · faltavam: ${r.faltavam} · ${aplicar ? "gravadas" : "a gravar"}: ${r.preenchidas}` +
        ` · sem índice (valor fora do padrão): ${r.semIndice} · e-mail fora da forma minúscula: ${r.naoNormalizadas}` +
        ` · colisões${aplicar ? "" : " previstas"}: ${r.colisoes} · mudaram no caminho: ${r.mudaramNoCaminho} · falhas: ${r.falhas}`,
    );
    if (r.colisaoIds.length) console.log(`  linhas em colisão (unificar à mão): ${r.colisaoIds.join(", ")}`);
    if (r.falhas > 0 || r.colisoes > 0) problema = true;
  }
  console.log(`Contatos cujo NOME parece um telefone (limpeza do histórico, decisão à parte): ${await contarNomesQueSaoTelefone(teamId)}`);
  if (!aplicar) console.log("Só simulei. Rode com --aplicar para gravar.");
  if (problema) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => basePrisma.$disconnect());
