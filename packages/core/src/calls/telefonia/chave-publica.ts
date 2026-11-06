/**
 * Chaves PÚBLICAS do selo do token de administrador da telefonia (F2-25).
 *
 * A pública NÃO é segredo e fica no repositório. Quem sela é o site (`selarParaOWorker`); quem abre é só o worker, que
 * tem a privada correspondente. Trocar a chave é um PR.
 *
 * Formato de cada item: o SPKI em DER, em base64 de uma linha só (é o que o `telefonia-gerar-chaves.sh` escreve).
 * A ATUAL vem primeiro: o site sela sempre com `CHAVES_PUBLICAS[0]`. As anteriores ficam na lista para o workflow
 * "Configurar serviços do worker" conferir a chave privada anterior na rotação.
 *
 * Quem mexe entre as duas marcas é o `script de operação`. Não edite à mão, não apague as marcas e
 * não ponha outra coisa entre elas: o workflow e o script leem este arquivo pelas marcas.
 *
 * A lista nasce VAZIA de propósito. Sem uma pública aqui, `selarParaOWorker` recusa (`ChavePublicaAusente`) e nenhum
 * token de telefonia é guardado. O dono gera o par no terminal dele (decisão 20 da F2); nenhuma chave de teste mora aqui.
 */
export const CHAVES_PUBLICAS: readonly string[] = [
  // CHAVES-PUBLICAS-INICIO
  // CHAVES-PUBLICAS-FIM
];
