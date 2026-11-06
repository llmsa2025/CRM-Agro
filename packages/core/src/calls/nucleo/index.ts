// Núcleo de prova da ligação (F1B). Cada arquivo entra aqui quando nasce.
// Os arquivos de cálculo (desfecho, fase, linha do tempo, texto) são funções puras: nada de banco, fila nem efeito.
// Os de serviço (linhas) falam com o banco pelo db() do time.
// Nomes exportados levam "Ligacao": o barrel do core faz `export *` e nome repetido dá TS2308.
export * from "./desfecho";
export * from "./fase";
export * from "./linha-do-tempo";
export * from "./linhas";
export * from "./texto";
