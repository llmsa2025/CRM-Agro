/**
 * Rotas que o middleware deixa passar SEM sessão (allow-list: o padrão é NEGAR). Fica num módulo
 * próprio para o teste `lib/rotas-api.test.ts` conferir cada rota de API contra esta lista: toda rota
 * pública precisa declarar lá como se autentica, e toda rota fora daqui precisa exigir sessão.
 * Acrescentar um item aqui é uma decisão de segurança: o teste obriga a justificar.
 */
export const PUBLICO = [
  /^\/login$/,
  // Telas de auth sem sessão (redesign da Fase Auth): reset de senha e signup por
  // convite. Elas mesmas validam o token; não expõem dado do time sem autoridade.
  /^\/esqueci-senha$/,
  /^\/redefinir-senha$/,
  /^\/criar-conta$/,
  // "Criar a conta da minha empresa" (plano-equipe-permissoes F1): cadastro público explícito.
  /^\/criar-empresa$/,
  // Confirmação do e-mail do cadastro com senha: o próprio link (token + senha) é a autoridade.
  /^\/confirmar-email$/,
  /^\/api\/auth(\/|$)/,
  /^\/api\/webhooks(\/|$)/,
  // Health check para monitor externo (uptime). Só devolve status/latência —
  // sem mensagens de erro internas (ver app/api/health/route.ts).
  /^\/api\/health$/,
  // Pixel de abertura de e-mail: carregado pelo cliente do destinatário (sem sessão).
  /^\/api\/email\/track(\/|$)/,
  // Relay da extensão: autentica por Bearer token próprio (RelayAgentToken), não
  // por sessão. A extensão não tem cookie do CRM Agro.
  /^\/api\/relay(\/|$)/,
  // Aviso do Google Agenda (events.watch): o Google não tem sessão. A rota
  // confere o canal e o token (HMAC) antes de tudo e só enfileira a sincronização.
  /^\/api\/integracoes\/google\/notificacao$/,
  // Relatório de violação da CSP: o navegador posta sem cookie (inclusive da tela de login). A rota só
  // loga campos saneados (sem query, sem dado pessoal), limita por IP e o corpo, e não grava no banco.
  /^\/api\/csp-report$/,
];
