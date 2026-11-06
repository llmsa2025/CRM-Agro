import { z } from "zod";
import { definirCapacidadesDeLigacao, type CapacidadesDeLigacao } from "./capacidades";
import type { DescritorDeLigacao } from "./descritor";
import type { ContextoDaLigacao, ProvedorDeLigacao } from "./interface";
import { flagDoProvedorDeLigacao, type ProvedorRegistradoDeLigacao } from "./registro";

/**
 * Apoio SÓ dos testes do contrato (F1B-03): uma matriz válida, um descritor, um adaptador mínimo e uma entrada
 * de registro coerentes entre si. O Fake com perfis e a suíte de contrato (F1B-04) fazem o trabalho de verdade;
 * isto aqui existe para os testes do contrato não dependerem delas. Nada daqui entra no barrel.
 */

export const matrizDeTeste = (troca: Partial<CapacidadesDeLigacao> = {}): CapacidadesDeLigacao => ({
  originar: ["navegador"],
  originacaoSincrona: false,
  provisionarLinha: "linha",
  consulta: { porId: true, porMinuto: 15, trazAtendimento: false },
  causaDoFimGarantida: false,
  duracaoDesdeAtendimento: false,
  eventosAoVivo: false,
  pontasNoAviso: { destino: true, origem: true },
  gravacao: { entrega: "webhook", prazoHoras: null, aviso: "crmagro", apagavel: false },
  ligaAFrio: true,
  webhook: "url_assinada",
  sandbox: false,
  ...troca,
});

export const descritorDeTeste = (chave = "teste_um", troca: Partial<DescritorDeLigacao> = {}): DescritorDeLigacao => ({
  chave,
  nome: "Provedor de teste",
  ambientes: ["producao"],
  campos: [
    { chave: "dominio", rotulo: "Domínio da conta", ajuda: "Aparece no endereço do painel do provedor.", escopo: "conta", obrigatorio: true, secreto: false, schema: z.string().min(3).max(80) },
    { chave: "tokenDaConta", rotulo: "Token da conta", ajuda: "Gere em Configurações, Tokens.", escopo: "conta", obrigatorio: true, secreto: true, schema: z.string().min(12).max(200) },
    { chave: "ramal", rotulo: "Ramal", ajuda: "O número do ramal do vendedor.", escopo: "linha", obrigatorio: true, secreto: false, schema: z.string().regex(/^\d{3,8}$/) },
    { chave: "senhaDoRamal", rotulo: "Senha do ramal", ajuda: "A senha do ramal no painel.", escopo: "linha", obrigatorio: true, secreto: true, schema: z.string().min(8).max(100) },
  ],
  segredoDoWebhook: { rotulo: "Segredo do aviso", ajuda: "O CRM Agro gera este valor.", obrigatorio: true, schema: z.string().min(16).max(200) },
  webhook: { modo: "url_assinada", instrucao: "Cadastre o endereço de aviso no painel do provedor.", eventosNecessarios: ["fim da ligação"] },
  testeDeConexao: "Lê os dados da conta, sem criar nada.",
  avisosDeSetup: [],
  urlDaDocumentacao: "https://exemplo.invalid/docs",
  ...troca,
});

export const contextoDeTeste = (troca: Partial<ContextoDaLigacao> = {}): ContextoDaLigacao => ({
  ambiente: "producao",
  credenciais: { dominio: "empresa", tokenDaConta: "token-da-conta-123456" },
  segredoWebhook: { atual: "segredo-do-aviso-1234567890" },
  linha: { contaExterna: "empresa", idExterno: "1001", credenciais: { ramal: "1001", senhaDoRamal: "senha-do-ramal-123" } },
  ...troca,
});

/** Um adaptador mínimo cujos métodos opcionais batem com a matriz recebida. */
export function adaptadorDeTeste(chave = "teste_um", capacidades: CapacidadesDeLigacao = matrizDeTeste()): ProvedorDeLigacao {
  const c = definirCapacidadesDeLigacao(capacidades);
  const naoFaz = async () => {
    throw new Error("não usado nos testes do contrato");
  };
  return {
    chave,
    capacidades: c,
    testarConexao: async () => ({ ok: true }),
    originar: async () => ({ providerCallId: "pc_1" }),
    encerrar: async () => {},
    verificarWebhook: () => ({ autentico: true }),
    normalizarWebhook: () => ({ fatos: [], sinais: [], pontas: [] }),
    ...(c.consulta.porId ? { consultar: async () => ({ fatos: [], pontas: [] }) } : {}),
    ...(c.provisionarLinha !== "manual" ? { provisionarLinha: async () => ({ idExterno: "1002", credenciais: {} }) } : {}),
    ...(c.originacaoSincrona ? { responderOriginacao: () => ({ contentType: "text/xml", corpo: "<Response/>" }) } : {}),
    ...(c.gravacao.entrega !== "nenhuma" ? { obterGravacao: naoFaz as ProvedorDeLigacao["obterGravacao"] } : {}),
    ...(c.gravacao.apagavel ? { apagarGravacao: async () => {} } : {}),
  };
}

/** Uma entrada de registro coerente (matriz, descritor, adaptador e flag concordam). */
export function entradaDeTeste(chave = "teste_um", troca: Partial<CapacidadesDeLigacao> = {}): ProvedorRegistradoDeLigacao {
  const capacidades = definirCapacidadesDeLigacao(matrizDeTeste(troca));
  return {
    chave,
    rotulo: "Provedor de teste",
    capacidades,
    descritor: descritorDeTeste(chave),
    fabrica: () => adaptadorDeTeste(chave, capacidades),
    flag: flagDoProvedorDeLigacao(chave),
  };
}
