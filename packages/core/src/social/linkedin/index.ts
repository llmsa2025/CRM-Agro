// LinkedIn oficial: entrar com LinkedIn e publicar no perfil da própria pessoa.
// e a documentação interna (§4.5).
export {
  PROVEDOR_LINKEDIN,
  DIAS_DO_AVISO_DE_VENCIMENTO,
  linkedinConfigurado,
  urlDeRetornoLinkedin,
  iniciarConexaoLinkedin,
  concluirConexaoLinkedin,
  desconectarLinkedin,
  podeConectarLinkedin,
  situacaoDaValidade,
  diasParaVencerLinkedin,
  expiracaoDoLinkedin,
  lerTokenDoLinkedin,
  marcarLinkedinParaReconectar,
  souDonoDaConta,
  LinkedinIndisponivel,
  EstadoLinkedinInvalido,
  PermissaoDePublicarNegada,
  LinkedinDeOutraPessoa,
  LinkedinTokenExpirado,
  type VoltaLinkedin,
} from "./conexao";
export { LinkedinApiErro } from "./cliente";
