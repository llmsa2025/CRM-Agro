export {
  fetchCnpj,
  fetchViaCnpja,
  fetchViaBrasilApi,
  CNPJ_TIMEOUT_MS,
  type CnpjResult,
  type SocioItem,
  type FonteCnpj,
} from "./cnpj/fetch";
export { fetchViaOpenCnpj, resultadoDoOpenCnpj } from "./cnpj/opencnpj";
export {
  buscarPaginaMinhaReceita,
  aprovaRegistro,
  resultadoDoRegistro,
  urlDaBusca,
  porteDoRegistro,
  ehPessoaFisica,
  registroAtivo,
  telefoneValido,
  FILTROS_LOCAIS_PADRAO,
  MINHA_RECEITA_POR_PAGINA,
  MINHA_RECEITA_TIMEOUT_MS,
  NATUREZA_EMPRESARIO_INDIVIDUAL,
  type FiltrosDaFonte,
  type FiltrosLocais,
  type PorteEmpresa,
  type RegistroMinhaReceita,
  type PaginaDeBusca,
} from "./cnpj/busca";
export {
  cpfDigitos,
  cpfValido,
  cpfParaExibir,
  mascaraDeBusca,
  mascaraValida,
  palavrasDoNome,
  compararNome,
  socioDoRegistro,
  type AlvoDeSocio,
  type SocioAchado,
  type ConfiancaDoSocio,
  type ComparacaoDeNome,
} from "./cnpj/socio";
export { cpfMascaradoDe, type CnaeItem, type IeItem } from "./cnpj/fetch";
export { normalizeCnpj } from "./cnpj/normalize";
export { brasilApiCnpjSchema, type BrasilApiCnpj } from "./cnpj/schema";
export { CnpjInvalid, CnpjNotFound, CnpjLookupFailed, CnpjaLimite, OpenCnpjLimite } from "./cnpj/errors";
// Instagram: só fetch (sem Playwright) — seguro no barrel.
export {
  coletarSeguidoresInstagram,
  classificarRecusaInstagram,
  buscarBioInstagram,
  InstagramSessaoInvalida,
  InstagramLimite,
  InstagramPerfilNaoEncontrado,
  INSTAGRAM_TIMEOUT_MS,
  type SeguidorInstagram,
  type ResultadoSeguidores,
  type InterrupcaoInstagram,
} from "./instagram/seguidores";
export { normalizarPerfilInstagram } from "./instagram/perfil";
// Maps: leitura PURA da avaliação (o worker junta os textos no navegador).
export { parseAvaliacaoMaps, extrairAvaliacaoMaps, type AvaliacaoMaps } from "./maps/avaliacao";
// Utilitários PUROS do navegador (prazos, bloqueio do Google, Chromium órfão).
// Nenhum importa Playwright; o worker os importa por caminho relativo.
export * from "./navegador/index";
// Fonte paga de pessoas (CNPJá comercial): só roda com a chave do time, nunca nos testes.
export {
  buscarPessoasCnpja,
  candidatosDaResposta,
  creditosDaPesquisa,
  CNPJA_REGISTROS_POR_CREDITO,
  FonteSemAcesso,
  FonteSemCredito,
  FonteFalhou,
  type CandidatoDePessoa,
  type EmpresaDoCandidato,
  type PaginaDeCandidatos,
} from "./pessoas/cnpja";
export {
  consultarIeProdutorCnpja,
  resultadoDoCcc,
  ProdutorSemInscricao,
  CNPJA_CREDITOS_POR_CONSULTA_CCC,
  CNPJA_CCC_IDADE_MAXIMA_DIAS,
  type IeDoProdutor,
  type ResultadoCcc,
} from "./pessoas/ccc";
// Leitor do site público da empresa (e-mail, telefone, WhatsApp, redes): direto do servidor, com proteção contra SSRF.
// Usa node:dns e node:http, então só entra por código de servidor (core/worker), nunca no navegador.
export {
  lerSiteDaEmpresa,
  validarUrlPublica,
  ipEhPublico,
  extrairContatosDoHtml,
  SiteIndisponivel,
  SITE_MAX_BYTES,
  SITE_TIMEOUT_MS,
  type SiteLido,
  type ContatosDoSite,
  type EmailDoSite,
  type TelefoneDoSite,
} from "./web/leitor";
