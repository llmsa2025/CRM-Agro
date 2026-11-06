/**
 * Limites do "Compartilhar" (encaminhar mensagem) das Conversas. Arquivo puro
 * (sem imports) para a tela espelhar os mesmos números; o teste do web confere
 * que os dois lados não se afastam. O servidor é quem manda: a tela só avisa antes.
 */

/** Conversas de destino por vez (freio controle de ritmo: cada destino é um envio a mais). */
export const MAX_DESTINOS_ENCAMINHAR = 5;

/** Mensagens por encaminhamento. */
export const MAX_MENSAGENS_ENCAMINHAR = 10;

/** Quantas conversas a lista de destinos devolve por busca. */
export const MAX_DESTINOS_NA_LISTA = 30;

/** Pausa entre um envio e o seguinte (ms), com uma sobra aleatória de até 50%: cadência humana. */
export const ESPACO_ENTRE_ENVIOS_MS = 1000;
