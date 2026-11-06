// Google Agenda + Meet (fase 1, decisões do dono de 28/09). Ver
// a documentação interna.
export {
  googleAgendaConfigurada,
  urlDeRetornoGoogle,
  iniciarConexaoGoogle,
  concluirConexaoGoogle,
  minhaConexaoGoogle,
  desconectarGoogle,
  envioPeloGmailParaMim,
  podeConectarGoogle,
  agendaGoogleLiberadaParaMim,
  lerLiberados,
  lerParaEncerrar,
  encerrarConexoes,
  revogarNoGoogle,
  GoogleAgendaIndisponivel,
  EstadoOAuthInvalido,
  PermissaoDaAgendaNegada,
  AgendaGoogleDeOutraPessoa,
  RespostaDoGoogleInvalida,
  AgendaGoogleNaoLiberada,
  AgendaGoogleNecessaria,
  PermissaoDoGmailNegada,
  GmailEmOutraConta,
  EnvioPeloGmailDesligado,
  type EnvioPeloGmail,
  type LiberacaoDaAgenda,
  type ConexaoGoogleDTO,
  type ConexaoParaEncerrar,
  type VoltaDaConexao,
} from "./conexao";
export { CaixaJaConectadaComSenha, caixaComSenhaDoMesmoEndereco } from "./gmail-envio";
export { propagarCompromisso, enviarPendentesAoGoogle, type Mudancas } from "./envio";
export { sincronizarConexaoGoogle, receberAvisoDoGoogle, pushDaAgendaHabilitado, type ResultadoSync, type AvisoDoGoogle } from "./sincronizacao";
export { AGENDA_GOOGLE_QUEUE, enfileirarSyncGoogle, agendarManutencaoAgendaGoogle, type JobAgendaGoogle } from "./fila";
export { processarJobAgendaGoogle, manutencaoAgendaGoogle } from "./trabalho";
export { pedirSincronizacaoGoogle } from "./pedido";
