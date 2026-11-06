export * from "./schema";
export * from "./service";
export * from "./write";
export * from "./errors";
export * from "./phone";
export * from "./csv";
export * from "./identifiers";
export { contatoParaNavegador } from "./dto";
// Cifra em repouso de e-mail e telefone (CONTATOS_CIFRA): leitura, busca exata e dedupe.
export {
  modoCifraContatos,
  buscaExataDeContatos,
  canalCifravel,
  valorDe,
  numeroDe,
  valorLegivel,
  hashesDeBusca,
  hashesDeNumeros,
  hashDeIdentificador,
  ondeIdentificadorExato,
  ondeIdentificadoresExatos,
  ondeConversaPorNumero,
  ondeLidPorTelefone,
  ondeBuscaDeIdentificador,
  ondeBuscaDeConversaPorNumero,
  classificarTermoDeBusca,
  termoPareceTelefoneOuEmailParcial,
  type TipoDeTermo,
} from "./identificadores-cifra";
export * from "./export";
// Busca da tela de Contatos (campos do contato e da empresa): a documentação interna.
export { BUSCA_MIN_CARACTERES, BUSCA_TETO, interpretarBusca, normalizarBusca, type Achado } from "./busca";
export { escopoDoContato } from "./escopo";
export { responsavelObrigatorio, responsavelEscolhido, opcoesDeResponsavel } from "./responsavel";

export { cifrarCpf, lerCpf, hashDoCpf, preencherHashDoCpf, CONTEXTO_CPF } from "./cpf";
export * from "./complemento";
