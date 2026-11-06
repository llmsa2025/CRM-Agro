/**
 * Homologação do Nectar na CONTA DE TESTE (ficha N5 do grupo Nectar).
 *
 * Roda pela API os itens da homologação (plano §3.0) que dá para medir e grava
 * um relatório em JSON sem token, sem corpo de resposta e sem dado de cliente.
 * SÓ o dono roda, com o token da conta de teste. O script recusa rodar sem a
 * variável de homologação, e pede duas confirmações "SIM".
 *
 * ANTES: desligue, na conta de teste, as automações e integrações que mandam
 * mensagem (WhatsApp, e-mail marketing, RD Station, fluxos de cadência). O
 * roteiro cria contatos lá, e o Nectar poderia disparar mensagem para eles.
 *
 * Uso (o `read -rs` não deixa o token no histórico do terminal):
 *   cd /srv/crmagro/packages/db
 *   read -rs NECTAR_HOMOLOGACAO_TOKEN && export NECTAR_HOMOLOGACAO_TOKEN
 *   export NECTAR_HOMOLOGACAO_TELEFONE=+55<DDD><seu número>   # opcional, um número SEU, em E.164
 *   NECTAR_HOMOLOGACAO=conta-de-teste pnpm exec tsx ../core/scripts/nectar-homologacao.ts
 *   unset NECTAR_HOMOLOGACAO_TOKEN NECTAR_HOMOLOGACAO_TELEFONE
 *
 * Arquivos de teste (opcional): ponha em /tmp/crmagro-teste/nectar-arquivos/
 * (ou em NECTAR_HOMOLOGACAO_ARQUIVOS) arquivos FEITOS PELA EQUIPE, nunca de
 * cliente: teste.pdf, teste.jpg, teste.png, teste.ogg, teste.mp3, teste.m4a,
 * teste.wav e teste.mp4. Sem a pasta, os casos de arquivo ficam "nao_testado".
 *
 * Importa por caminho RELATIVO, nunca pelo `@crmagro/core`: o barril carrega o
 * `@crmagro/config`, que exige o `.env` e faria o script sair com erro antes da
 * checagem da variável de homologação.
 *
 * Códigos de saída: 0 = rodou; 2 = falta a variável ou o token (não chamou
 * nada); 3 = uma das confirmações não foi "SIM" (não chamou nada).
 */
import { existsSync, mkdirSync, openAsBlob, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  permitidoRodarHomologacao,
  rodarHomologacao,
  type ArquivoDeTeste,
} from "../src/integrations/crm/providers/nectarcrm/homologacao";

const TIPOS: Record<string, string> = {
  "teste.pdf": "application/pdf",
  "teste.jpg": "image/jpeg",
  "teste.png": "image/png",
  "teste.ogg": "audio/ogg",
  "teste.mp3": "audio/mpeg",
  "teste.m4a": "audio/mp4",
  "teste.wav": "audio/wav",
  "teste.mp4": "video/mp4",
};

/**
 * Uma interface de leitura só para as duas perguntas. Só vale "SIM" digitado na
 * hora: fim da entrada (pipe, Ctrl+D) conta como "não".
 */
function criarPerguntador() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let fechado = false;
  rl.on("close", () => {
    fechado = true;
  });
  return {
    async confirmar(pergunta: string): Promise<boolean> {
      if (fechado) return false;
      const resposta = await Promise.race([
        rl.question(pergunta),
        new Promise<string>((resolve) => rl.once("close", () => resolve(""))),
      ]);
      return resposta.trim() === "SIM";
    },
    fechar: () => rl.close(),
  };
}

/** AAAAMMDD-HHMM em UTC (o mesmo carimbo que o prefixo dos registros de teste). */
function carimbo(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
}

async function main(): Promise<number> {
  const permitido = permitidoRodarHomologacao(process.env);
  if (!permitido.ok) {
    console.error(`Não rodei: ${permitido.motivo}.`);
    return 2;
  }

  const pergunta = criarPerguntador();
  const confirmouConta = await pergunta.confirmar("Este token é da CONTA DE TESTE do Nectar (não de cliente)? Digite SIM: ");
  const confirmouAutomacoes = confirmouConta && (await pergunta.confirmar("Você desligou as automações de mensagem da conta de teste? Digite SIM: "));
  pergunta.fechar();
  if (!confirmouConta || !confirmouAutomacoes) {
    console.error("\nNão rodei: a confirmação não foi SIM.");
    return 3;
  }

  // Os arquivos são lidos com `openAsBlob` (sem carregar tudo na memória de uma vez).
  const pasta = process.env.NECTAR_HOMOLOGACAO_ARQUIVOS || "/tmp/crmagro-teste/nectar-arquivos";
  const arquivos: ArquivoDeTeste[] = [];
  for (const [nome, tipo] of Object.entries(TIPOS)) {
    const caminho = join(pasta, nome);
    if (existsSync(caminho)) arquivos.push({ nome, tipo, blob: await openAsBlob(caminho, { type: tipo }) });
  }
  console.log(`Arquivos de teste lidos: ${arquivos.length ? arquivos.map((a) => a.nome).join(", ") : "nenhum (os casos de arquivo ficam nao_testado)"}`);
  console.log(permitido.telefone ? "Telefone de teste informado (não vai para o relatório)." : "Sem telefone: os casos de telefone ficam nao_testado.");
  console.log("Rodando (1 chamada por segundo, no máximo 500)...\n");

  const agora = new Date();
  const { casos, chamadas, checklistVisual } = await rodarHomologacao({ token: permitido.token, telefone: permitido.telefone, arquivos, agora: () => agora });

  const dir = process.env.NECTAR_HOMOLOGACAO_SAIDA || "/tmp/crmagro-teste";
  mkdirSync(dir, { recursive: true });
  const arquivo = join(dir, `nectar-homologacao-${carimbo(agora)}.json`);
  const relatorio = {
    geradoEm: agora.toISOString(),
    chamadas,
    telefoneInformado: permitido.telefone !== null,
    arquivosLidos: arquivos.map((a) => a.nome),
    casos,
    checklistVisual,
  };
  writeFileSync(arquivo, JSON.stringify(relatorio, null, 2), { mode: 0o600 });

  const contagem = (r: string) => casos.filter((c) => c.resultado === r).length;
  console.log("## Resumo\n");
  console.log(`- ${chamadas} chamadas; ok ${contagem("ok")}, observar ${contagem("observar")}, falhou ${contagem("falhou")}, nao_testado ${contagem("nao_testado")}\n`);
  console.log("| Caso | Resultado |\n|---|---|");
  for (const c of casos) console.log(`| ${c.id} | ${c.resultado} |`);
  console.log("\n## Conferências visuais (na tela do Nectar)\n");
  checklistVisual.forEach((item, i) => console.log(`${i + 1}. ${item}`));
  console.log(`\nRelatório gravado em ${arquivo} (permissão 600, sem token e sem dado de cliente).`);
  console.log("Abra a sessão do N20 com esse arquivo e as respostas do suporte do Nectar.");
  return 0;
}

main().then(
  (codigo) => process.exit(codigo),
  (e: unknown) => {
    // Nunca imprime o erro inteiro: só o nome e a mensagem (as mensagens do cliente não levam token nem corpo).
    console.error(`Erro inesperado: ${e instanceof Error ? `${e.name}: ${e.message}` : "desconhecido"}`);
    process.exit(1);
  },
);
