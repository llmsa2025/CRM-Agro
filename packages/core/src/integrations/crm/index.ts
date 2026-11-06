/**
 * Conector de CRM (Nectar). Ficha N1: contrato, erros, cliente HTTP e conector
 * de leitura. Nomes com prefixo `Crm`/`Nectar` para não colidir no barril do core.
 */
export * from "./contract";
export * from "./errors";
export { conectorCrm } from "./registry";
export { criarConectorNectar, ETIQUETA_OPT_OUT, temEtiquetaOptOutUtilizavel } from "./providers/nectarcrm/index";
export type { PedidoNectar, RespostaNectar, TransporteNectar } from "./providers/nectarcrm/client";
export * from "./sync/beta";
export * from "./sync/conexao";
