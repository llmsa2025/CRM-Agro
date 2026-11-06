// Contrato do provedor de ligação (F1B-03). Só tipos e funções puras: nada de adaptador, HTTP, banco nem fila.
// O Fake (`./fake`) e a suíte de contrato (`./contrato`, que importa o vitest) ficam FORA daqui, de propósito.
export * from "./capacidades";
export * from "./erros";
export * from "./fato";
export * from "./descritor";
export * from "./interface";
export * from "./registro";
