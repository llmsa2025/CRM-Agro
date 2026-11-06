/**
 * Metodologias e modelos prontos. Sem banco e sem importar valor de fora: a tela (cliente) usa este arquivo
 * para os rótulos e para "começar de um modelo".
 *
 * Uma metodologia diz COMO o agente conduz a abordagem (a ordem das perguntas, o que evitar). O que dizer
 * (objetivo, orientação do passo) e os fatos da empresa (base de conhecimento) vêm de outros lugares. O
 * texto vai para o prompt da IA, então é escrito como instrução curta e direta, pensada para WhatsApp.
 */

export const FINALIDADES = ["agente_fluxo", "assistente_chat"] as const;
export type FinalidadeDaMetodologia = (typeof FINALIDADES)[number];

export const NOME_DA_FINALIDADE: Record<FinalidadeDaMetodologia, string> = {
  agente_fluxo: "Agente IA no fluxo",
  assistente_chat: "Assistente (chat)",
};

export const DESCRICAO_DA_FINALIDADE: Record<FinalidadeDaMetodologia, string> = {
  agente_fluxo: "Como o agente conduz a abordagem e a conversa com o contato nos fluxos.",
  assistente_chat: "Como o Assistente da barra superior aconselha a equipe e sugere os próximos passos.",
};

export const LIMITES_DA_METODOLOGIA = { nome: 80, descricao: 200, conteudo: 6000, porTime: 30 } as const;

export type ModeloDeMetodologia = {
  slug: string;
  nome: string;
  finalidade: FinalidadeDaMetodologia;
  descricao: string;
  conteudo: string;
};

const SPIN = `Conduza a abordagem pelo SPIN Selling, em ritmo de WhatsApp: uma pergunta por mensagem, sem despejar as quatro fases de uma vez.

1. Situação: entenda o contexto do contato com perguntas curtas e fáceis de responder (o que produz, o tamanho da operação, como faz hoje). Use o que já sabe pelo cadastro e pelo histórico em vez de perguntar de novo.
2. Problema: descubra uma dificuldade real. Pergunte o que está pesando, onde perde tempo ou dinheiro.
3. Implicação: mostre o custo do problema com uma pergunta, sem dramatizar. Ex.: o que acontece com a safra quando isso se repete?
4. Necessidade de solução: faça o próprio contato dizer o valor de resolver. Ex.: ajudaria se isso ficasse resolvido antes do plantio?

Regras:
- Só apresente a solução depois que o contato reconhecer o problema. Antes disso, escute.
- Na primeira mensagem, abra com um contexto relevante e UMA pergunta leve de Situação. Não venda na abertura.
- Avance de fase conforme a resposta. Se o contato não responder à pergunta, reformule de outro jeito, sem insistir.
- Quando houver interesse claro (pediu preço, proposta, prazo ou reunião), passe para uma pessoa.
- Nunca cite o nome da técnica ao contato.`;

const BANT = `Conduza a abordagem para qualificar o contato pelo BANT, de forma natural, sem parecer questionário.

Descubra aos poucos, na ordem que a conversa permitir:
- Necessidade: qual problema ou meta ele tem e se o que oferecemos serve.
- Autoridade: se ele decide ou quem mais participa da decisão.
- Orçamento: se há verba ou faixa para isso, sem perguntar valor de forma seca. Ex.: já têm algo separado para esta safra?
- Prazo: quando pretende resolver.

Regras:
- Uma pergunta por mensagem e sempre ligada ao que ele acabou de dizer.
- Comece pela Necessidade. Deixe Orçamento por último, e só se a conversa já tiver confiança.
- Quando três dos quatro pontos estiverem claros, ou o contato pedir proposta, valor ou reunião, passe para uma pessoa.
- Se faltar Autoridade, peça com educação para incluir quem decide.
- Nunca cite a sigla BANT ao contato.`;

const CONSULTIVA = `Conduza uma abordagem consultiva: entenda antes de oferecer.

1. Abra com algo específico do contato (a atividade, a região, um fato do cadastro) e mostre por que está falando com ele.
2. Faça UMA pergunta aberta sobre como ele trabalha hoje no assunto.
3. Escute e responda ao que ele disse, sem repetir o que já foi dito.
4. Só então ofereça ajuda concreta, ligada ao que ele contou, em poucas palavras.
5. Feche com um próximo passo pequeno e fácil de aceitar, como uma conversa rápida de 15 minutos.

Regras:
- Mensagens curtas, tom de conversa, sem lista nem texto de propaganda.
- Se ele disser que não tem interesse, agradeça e encerre.
- Se pedir preço, proposta ou prazo, passe para uma pessoa.`;

export const MODELOS_PRONTOS: readonly ModeloDeMetodologia[] = [
  {
    slug: "spin_selling",
    nome: "SPIN Selling",
    finalidade: "agente_fluxo",
    descricao: "Situação, Problema, Implicação e Necessidade: o contato chega sozinho à conclusão.",
    conteudo: SPIN,
  },
  {
    slug: "bant",
    nome: "BANT",
    finalidade: "agente_fluxo",
    descricao: "Qualifica por Necessidade, Autoridade, Orçamento e Prazo.",
    conteudo: BANT,
  },
  {
    slug: "consultiva",
    nome: "Consultiva",
    finalidade: "agente_fluxo",
    descricao: "Entende antes de oferecer e fecha com um próximo passo pequeno.",
    conteudo: CONSULTIVA,
  },
];

/** O modelo que nasce como padrão para cada finalidade. */
export const MODELO_PADRAO: Partial<Record<FinalidadeDaMetodologia, string>> = { agente_fluxo: "spin_selling" };

export const ehFinalidade = (x: unknown): x is FinalidadeDaMetodologia => (FINALIDADES as readonly unknown[]).includes(x);
