import { z } from "zod";
import { modoCsp, modoCspReconhecido } from "./csp-modo";

export { modoCsp, modoCspReconhecido, MODOS_CSP, MODO_CSP_PADRAO, type ModoCsp } from "./csp-modo";

/**
 * Env validado por zod no boot. Falha cedo se faltar variável obrigatória.
 * Tipos inferidos do schema — uma fonte de verdade só.
 *
 * O carregamento do .env acontece nos entry points (dotenv-cli no `dev`/`test`,
 * `--env-file` no prisma). Aqui só validamos o que já está em process.env.
 */
/** Variável com valor vazio no .env (`CHAVE=`) conta como ausente. */
const vazioViraAusente = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** Exportado para os testes (o boot usa `env`, abaixo). */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Supabase — projeto DEV
  DATABASE_URL: z.string().url(),
  // Conexão direta, usada SÓ pelo Prisma CLI (migrate) e pelos scripts de backup e operação. O app em
  // execução (web, worker, Vercel) nunca a lê, e é a credencial de dono: por isso é opcional e deve ficar
  // fora do `.env` da VPS e da Vercel. Quem a guarda é o workflow "Migrar banco" (secret do GitHub).
  DIRECT_URL: urlOpcional(),
  // Pool próprio do worker (item 2.5). Opcional: o scripts/run-worker.sh a usa
  // no lugar da DATABASE_URL quando existe. Validada aqui para falhar no boot
  // (e não na 1ª consulta) se vier malformada.
  DATABASE_URL_WORKER: z.string().url().optional(),
  // RLS no Postgres. Conexão do
  // papel `crmagro_app` (sem BYPASSRLS): com ela, o client do time (`db()`) passa a declarar o time em
  // toda transação e o Postgres filtra por conta própria. Opcional e desligada por padrão: sem ela o
  // app roda como antes. Vazia (`DATABASE_URL_APP=`) conta como ausente, em vez de derrubar o boot.
  // Não fica no `.env` compartilhado: o script `rls-papel-app.sh ligar` grava no `.env.rls`, que só o
  // run-web.sh e o run-worker.sh leem (assim teste, seed e script de operação nunca herdam a URL).
  DATABASE_URL_APP: urlOpcional(),
  // Mesma conexão do `crmagro_app` com o pool do WORKER (o run-worker.sh a coloca no lugar de
  // DATABASE_URL_APP, como faz com DATABASE_URL_WORKER). Sem ela, o worker usa a URL do web.
  DATABASE_URL_APP_WORKER: urlOpcional(),

  // Banco de TESTE (suíte do core, scripts `--teste`). Só existe em quem roda testes; produção não precisa.
  DATABASE_URL_TEST: urlOpcional(),
  DIRECT_URL_TEST: urlOpcional(),

  // Redis local (BullMQ)
  REDIS_URL: z.string().url(),

  // Supabase Storage — mídia das Conversas (bucket privado `conversas-midia`).
  // Opcionais: sem eles o app roda normal e o envio/render de mídia fica inerte
  // (fail-soft), sem quebrar o build nem o texto.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // Tenancy. Com o NextAuth ativo o teamId vem da SESSÃO (apps/web/lib/tenant.ts);
  // DEV_TEAM_ID sobrou para seed e para o script de bootstrap de usuário. Opcional: o app em produção
  // não usa (quem precisa, `runAsDev` e o seed, falha com mensagem clara se faltar).
  DEV_TEAM_ID: textoOpcional(),

  // NextAuth — assina o JWT de sessão. Sem isto o login não funciona em produção.
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET deve ter ao menos 32 caracteres"),

  // URL pública canônica do app (ex.: https://app.crmagro.example). Usada para
  // montar os links dos e-mails transacionais (reset de senha, convite). Opcional:
  // sem ela, cai em APP_PUBLIC_URL; sem nenhuma das duas, o link não é montado.
  AUTH_URL: z.string().url().optional(),

  // Google OAuth (login "Entrar com Google"). Opcionais: sem os dois, o provider
  // Google não é registrado no NextAuth e o botão não aparece (fail-soft — o login
  // por e-mail/senha continua funcionando). NUNCA hardcodar: vêm do Google Cloud.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Google Agenda + Meet (integração por pessoa, 28/09): cliente OAuth
  // SEPARADO do login ("CRM Agro — Integrações", no mesmo projeto Google). Sem os
  // dois, o botão "Minha Agenda Google" não aparece e nada sincroniza
  // (fail-soft). Passo a passo na documentação interna.
  GOOGLE_INTEGRACOES_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  GOOGLE_INTEGRACOES_CLIENT_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // URL de retorno do OAuth. Ausente = `<AUTH_URL>/api/integracoes/google/callback`
  // (ou APP_PUBLIC_URL). Tem de ser EXATAMENTE a cadastrada no cliente OAuth.
  GOOGLE_INTEGRACOES_REDIRECT_URI: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  // Aviso de mudança por push (events.watch). "off" desliga e fica só o
  // polling de reserva. Só liga com URL pública https (o Google exige).
  GOOGLE_AGENDA_PUSH: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["on", "off"]).optional()),
  // Quem pode CONECTAR a Agenda Google enquanto o app não é verificado pelo
  // Google (teto vitalício de 100 pessoas, o mesmo projeto do login). Lista
  // separada por vírgula, ponto e vírgula ou espaço: e-mails de login do CRM Agro
  // e/ou ids de time; `todos` libera geral. Vazio ou ausente = ninguém conecta
  // (fail-closed). Lida por `lerLiberados` (core/agenda/google/conexao.ts).
  GOOGLE_AGENDA_LIBERADOS: textoOpcional(),
  // Envio pelo Gmail (E7): só `on` liga; e ainda vale a trava GOOGLE_AGENDA_LIBERADOS
  // (cada conexão gasta uma das 100 vagas do projeto até o Google verificar o app).
  // Ausente ou `off` = ninguém vê nem conecta o envio pelo Gmail.
  GOOGLE_GMAIL_ENVIO: liga("on", "off"),
  // LinkedIn oficial (entrar e publicar no perfil): app criado em developers.linkedin.com com os
  // produtos "Sign In with LinkedIn using OpenID Connect" e "Share on LinkedIn". Sem os dois,
  // o LinkedIn segue "Em breve" nas telas (fail-soft). Passo a passo na documentação interna.
  LINKEDIN_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  LINKEDIN_CLIENT_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // URL de retorno do OAuth. Ausente = `<AUTH_URL>/api/integracoes/linkedin/callback`. Tem de ser
  // EXATAMENTE a cadastrada no app do LinkedIn.
  LINKEDIN_REDIRECT_URI: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  // Cabeçalho `LinkedIn-Version` (AAAAMM) da API de posts. Ausente = o padrão do código.
  LINKEDIN_API_VERSION: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^\d{6}$/).optional()),
  // Cadastro self-service pelo Google (cria time novo). Padrão FECHADO: só entra
  // quem já tem conta ou tem convite pendente (produto, item G). "true" reabre.
  SIGNUP_ABERTO: z.enum(["true", "false"]).optional(),
  // "Criar a conta da minha empresa" (/criar-empresa, plano-equipe-permissoes
  // F1): porta explícita de cadastro, ligada por padrão. "off" fecha. Vazio
  // (`CADASTRO_EMPRESA=`) = ausente: não derruba o boot.
  CADASTRO_EMPRESA: liga("on", "off"),
  // Criar empresa com e-mail e SENHA (sem Google). Sempre com CONFIRMAÇÃO do
  // e-mail pelo remetente da plataforma (o link chega na caixa; sem abrir o
  // link, a conta não nasce). A opção aparece sozinha quando o remetente da
  // plataforma (PLATFORM_*) está ok e há AUTH_URL/APP_PUBLIC_URL para o link;
  // sem ele, some (fail-safe). "off" esconde mesmo com o remetente (trava da
  // operação, ex.: cota de e-mail sob abuso). Nenhum valor dispensa a
  // confirmação (auditoria do #148: senha sem prova do e-mail = sequestro de antemão).
  // Vazio (`CADASTRO_EMPRESA_SENHA=`) = ausente = automático.
  CADASTRO_EMPRESA_SENHA: liga("on", "off"),

  // Evolution API (WhatsApp, Baileys)
  EVOLUTION_API_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_INSTANCE: z.string().min(1),

  // Importação AUTOMÁTICA do histórico do WhatsApp (worker). Chave de segurança:
  // ausente/vazia = DESLIGADO. Valores: "desligado" (alias "off") e "completo"
  // (alias "tudo": o #155, importa todo o histórico de toda conta conectada).
  // Valor desconhecido (ex.: "janela" e "sob_demanda", planejados no #174 e
  // ainda não implementados) NÃO derruba o boot: cai em desligado.
  //
  WA_HISTORICO_MODO: textoOpcional(),

  // Política de segurança de conteúdo (CSP) do app web. "relatorio" (padrão, também quando ausente
  // ou vazia): só avisa o que bloquearia, não quebra nada. "aplicada": bloqueia. "desligada": sem
  // cabeçalho. Valor desconhecido NÃO derruba o boot: cai em relatorio (e o boot avisa no log). O
  // middleware lê `process.env.CSP_MODO` direto (Edge Runtime); trocar exige reiniciar o web, sem
  // rebuild
  CSP_MODO: textoOpcional(),

  // Nectar CRM (fichas N1 a N24). Só para TESTE: aponta o Nectar para outro
  // endereço (o kit de teste usa http://127.0.0.1:9, que não responde). NUNCA
  // defina em produção. O cliente (`providers/nectarcrm/client.ts`) lê
  // `process.env` na hora de cada pedido, então esta chave só documenta o nome.
  NECTAR_API_BASE: textoOpcional(),
  // Nectar CRM em BETA: times que veem a integração (fichas N2 a N24). Mesma
  // sintaxe do GOOGLE_AGENDA_LIBERADOS: ids de time separados por vírgula,
  // ponto e vírgula ou espaço; `todos` (ou `*`) libera geral. Vazio ou ausente
  // = ninguém vê (fail-closed). Lida na hora por `crmLiberadoParaOTime`
  // (core/integrations/crm/sync/beta.ts), que usa `timesDoBetaCrm`.
  CRM_BETA_TEAM_IDS: textoOpcional(),
  // IP público do servidor do CRM Agro, mostrado na tela do Nectar para o cliente
  // liberar no usuário do token (restrição por IP). Ex.: 203.0.113.10.
  CRMAGRO_IP_SAIDA: textoOpcional(),

  // Cloudflare Access service token — presente só quando a Evolution está atrás
  // de um Cloudflare Tunnel (ex.: chamadas do Vercel). Ausente em dev/VPS local,
  // onde o fetch vai direto ao localhost e o tunnel não é usado.
  CF_ACCESS_CLIENT_ID: z.string().optional(),
  CF_ACCESS_CLIENT_SECRET: z.string().optional(),

  // URL pública base do app (SEM SSO) — usada pra configurar o webhook da
  // Evolution nas conexões novas (ex.: https://app.crmagro.example). Ausente
  // = não auto-configura o webhook (conexões novas precisam de webhook manual).
  APP_PUBLIC_URL: z.string().url().optional(),

  // Segredo do webhook de entrada do WhatsApp. Quando setado, o endpoint
  // /api/webhooks/whatsapp exige o header x-webhook-token com o token DA
  // INSTÂNCIA (HMAC deste segredo — ver integrations/whatsapp-webhook-token.ts)
  // e rejeita o resto. Ausente = fail-open só em dev; em produção, fail-closed.
  WHATSAPP_WEBHOOK_TOKEN: z.string().optional(),
  // Transição do token por instância no header (item 3.7, S18): enquanto não
  // for "off", o segredo global em `?token=` (formato antigo) ainda é aceito.
  // Desligar depois de rodar packages/channels/scripts/reaplicar-webhook.mjs.
  WHATSAPP_WEBHOOK_LEGADO: z.enum(["on", "off"]).default("on"),

  // Segredo do webhook de eventos da Voopi (call.answered/ended/recording).
  // Mesma filosofia do WHATSAPP_WEBHOOK_TOKEN: setado → fail-closed (exige
  // ?token=<valor> ou header x-webhook-token, comparado em tempo constante);
  // ausente → fail-open em dev (log warning). Em PRODUÇÃO o token DEVE estar
  // setado — sem ele qualquer POST entra como se viesse da Voopi.
  VOOPI_WEBHOOK_TOKEN: z.string().optional(),

  // Chave de criptografia do campo `credentials` do model Integration (tokens
  // de CRM, Gmail, etc.). 32+ caracteres — derivada via SHA-256 para 256 bits.
  // Gerar com: openssl rand -base64 48
  CREDENTIALS_ENCRYPTION_KEY: z.string().min(32, "CREDENTIALS_ENCRYPTION_KEY deve ter ao menos 32 caracteres"),
  // Rotação (item 3.7, S20): lista de chaves separadas por vírgula; a PRIMEIRA
  // cifra, as outras só decifram. A CREDENTIALS_ENCRYPTION_KEY continua lida
  // (formato antigo, sem id de chave). Ausente = só a CREDENTIALS_ENCRYPTION_KEY.
  // Passo a passo em packages/db/scripts/recifrar-credenciais.ts.
  CREDENTIALS_ENCRYPTION_KEYS: z.string().optional(),

  // Cifra em repouso de e-mail e telefone dos contatos.
  // DESLIGADA por padrão: com "off" o comportamento é exatamente o de antes.
  //   off    = só texto puro (como sempre);
  //   dupla  = grava texto + cifrado + índice cego; lê e busca pelo texto (valida sem risco);
  //   indice = idem, mas as buscas EXATAS passam pelo índice cego (com fallback pelo texto
  //            onde o índice ainda não foi preenchido); a busca por trecho de e-mail e telefone some;
  //   ligada = lê só o cifrado e busca só pelo índice, sem fallback (o apagar do texto puro é uma
  //            etapa seguinte, ainda não feita).
  // Fora do "off" a CONTATOS_INDICE_KEY é obrigatória (o boot recusa sem ela).
  // (texto vazio no .env conta como ausente)
  CONTATOS_CIFRA: z.preprocess(vazioViraAusente, z.enum(["off", "dupla", "indice", "ligada"]).default("off")),
  // Chave do índice cego (HMAC). PRÓPRIA, nunca a das credenciais: girar a do AES não obriga refazer
  // o índice. 32+ caracteres. Gerar com: openssl rand -base64 48. Guardar cópia FORA do VPS.
  CONTATOS_INDICE_KEY: z.preprocess(vazioViraAusente, z.string().min(32, "CONTATOS_INDICE_KEY deve ter ao menos 32 caracteres").optional()),
  // Chave anterior do índice, só durante uma rotação (as buscas aceitam as duas).
  CONTATOS_INDICE_KEY_ANTERIOR: z.preprocess(vazioViraAusente, z.string().min(32, "CONTATOS_INDICE_KEY_ANTERIOR deve ter ao menos 32 caracteres").optional()),

  // Web search do agente de IA (provider-agnóstico) — Tavily. Opcional: sem ela,
  // a tool web_search não é oferecida (o agente ainda tem lookup_cnpj).
  TAVILY_API_KEY: z.string().optional(),

  // Mapa (produto §B.2) — geocodificação pelo OpenStreetMap/Nominatim.
  // NOMINATIM_URL: instância própria quando houver (padrão: o público).
  // GEO_CONTATO: e-mail/URL que vai no User-Agent. A política do Nominatim
  // PÚBLICO exige contato: sem ele, só o centroide da cidade (IBGE) é usado.
  NOMINATIM_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  GEO_CONTATO: z.string().optional(), // vazio = ausente

  // Web Push (avisos no navegador/celular). Opcionais: sem as TRÊS, o push fica
  // desligado (um log no primeiro envio) e o resto segue normal. Gerar o par
  // com `npx web-push generate-vapid-keys`; o SUBJECT é um contato do dono
  // (mailto:... ou https://...), exigido pelos serviços de push.
  VAPID_PUBLIC_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  VAPID_PRIVATE_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  VAPID_SUBJECT: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),

  // Captação Instagram (produto §H.5): bios buscadas por job, 1 requisição
  // cada ao Instagram. 0 desliga. Valor inválido derruba o boot (antes virava 0
  // em silêncio).
  INSTAGRAM_BIO_MAX: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(0).max(500).default(50)),

  // Remetente da PLATAFORMA (auditoria S-05): os e-mails do sistema (redefinir
  // senha, convite de equipe, alerta de saúde) saem daqui, e não da caixa de
  // e-mail de uma pessoa do time. SMTP genérico: Resend, Amazon SES, Brevo ou
  // Postmark mudando só o .env.
  //
  // Aqui entram só como TEXTO: um erro nelas NUNCA derruba o boot (web e worker
  // cairiam no próximo restart por causa de e-mail). A validação fica em
  // `remetenteDaPlataforma()`, abaixo: com erro, o e-mail de sistema é recusado
  // (fail-closed, nunca cai na caixa do time), o /api/health fica `degraded`
  // (check `emailPlataforma`) e o boot registra o problema no log.
  PLATFORM_EMAIL_FROM: textoOpcional(),
  PLATFORM_EMAIL_REPLY_TO: textoOpcional(),
  PLATFORM_SMTP_HOST: textoOpcional(),
  // Sem porta: 465 com SECURE=true (ou sem SECURE), 587 com SECURE=false.
  PLATFORM_SMTP_PORT: textoOpcional(),
  PLATFORM_SMTP_USER: textoOpcional(),
  PLATFORM_SMTP_PASS: textoOpcional(),
  // TLS direto (true/1/yes/sim) ou STARTTLS obrigatório (false/0/no/nao). Sem valor: pela porta.
  PLATFORM_SMTP_SECURE: textoOpcional(),
  // Teto de e-mails POR DIA (dia UTC) da plataforma inteira. Padrão 90 (o Resend
  // Free manda 100/dia). Com o Pro ou o SES, suba (ver o doc, seção 7).
  PLATFORM_EMAIL_LIMITE_DIA: textoOpcional(),
  // Entrada de e-mail por encaminhamento (Gmail → Cloudflare → CRM Agro, ficha E2).
  // Sem as duas, nada aparece (fail-soft): a validação fica em
  // `entradaDeEmailLigada()` (core/email/encaminhamento.ts), nunca no boot.
  // O segredo é o mesmo `CRMAGRO_SEGREDO` do Worker do Cloudflare.
  EMAIL_ENTRADA_DOMINIO: textoOpcional(),
  EMAIL_ENTRADA_SEGREDO: textoOpcional(),
});

/** Chave liga/desliga opcional: `X=` (ou só espaços) conta como ausente, em vez de derrubar o boot. */
function liga<const T extends readonly [string, ...string[]]>(...valores: T) {
  return z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.enum(valores).optional());
}

/** URL opcional: `X=` (ou só espaços) conta como ausente; o resto precisa ser uma URL válida. */
function urlOpcional() {
  return z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().url().optional());
}

/** Texto opcional: `X=` (ou só espaços) conta como ausente; o resto passa sem validar. */
function textoOpcional() {
  return z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().optional());
}

/**
 * Traduz o texto de `CRM_BETA_TEAM_IDS` na lista de times do beta do Nectar.
 * Mesma regra do `lerLiberados` da Agenda Google: separa por vírgula, ponto e
 * vírgula ou espaço; ignora maiúscula; `todos` ou `*` liberam todos. Ausente ou
 * vazio = ninguém (fail-closed). Pura, para testar sem env.
 */
export function timesDoBetaCrm(valor: string | null | undefined): { todos: boolean; ids: Set<string> } {
  const ids = new Set<string>();
  let todos = false;
  for (const bruto of String(valor ?? "").split(/[,;\s]+/)) {
    const item = bruto.trim().toLowerCase();
    if (!item) continue;
    if (item === "todos" || item === "*") todos = true;
    else ids.add(item);
  }
  return { todos, ids };
}

/** Modos da importação automática do histórico do WhatsApp que existem HOJE. */
export type ModoHistoricoWhatsApp = "desligado" | "completo";

/**
 * Traduz o texto de `WA_HISTORICO_MODO` no modo efetivo. Fail-safe: só
 * "completo" (ou o alias "tudo") liga a importação; ausente, vazio, "off",
 * "desligado", erro de digitação ou modo ainda não implementado ("janela",
 * "sob_demanda") = "desligado". Pura, para testar sem env.
 */
export function modoHistoricoWhatsApp(valor: string | undefined | null): ModoHistoricoWhatsApp {
  const v = (valor ?? "").trim().toLowerCase();
  return v === "completo" || v === "tudo" ? "completo" : "desligado";
}

/** Variáveis do remetente da plataforma (a ordem é a do .env.example). */
export const VARIAVEIS_PLATAFORMA = [
  "PLATFORM_EMAIL_FROM",
  "PLATFORM_EMAIL_REPLY_TO",
  "PLATFORM_SMTP_HOST",
  "PLATFORM_SMTP_PORT",
  "PLATFORM_SMTP_USER",
  "PLATFORM_SMTP_PASS",
  "PLATFORM_SMTP_SECURE",
  "PLATFORM_EMAIL_LIMITE_DIA",
] as const;

const OBRIGATORIAS_PLATAFORMA = ["PLATFORM_EMAIL_FROM", "PLATFORM_SMTP_HOST", "PLATFORM_SMTP_USER", "PLATFORM_SMTP_PASS"] as const;

/** Padrão do teto diário: abaixo dos 100/dia do Resend Free (folga para o teste). */
export const PLATAFORMA_LIMITE_DIA_PADRAO = 90;

export type RemetentePlataforma =
  | { estado: "desligado" }
  | { estado: "invalido"; problemas: string[] }
  | {
      estado: "ok";
      host: string;
      port: number;
      secure: boolean;
      user: string;
      pass: string;
      from: string;
      replyTo?: string;
      limiteDia: number;
    };

/** De onde ler (o `env`, ou um objeto no teste). Número é aceito (o teste liga a porta assim). */
export type FontePlataforma = Partial<Record<(typeof VARIAVEIS_PLATAFORMA)[number], string | number | undefined>>;

/** `email@dominio` ou `Nome <email@dominio>` (sem quebra de linha). */
const EMAIL_REMETENTE = "[^<>\\s@]+@[^<>\\s@]+\\.[^<>\\s@]+";
const FORMATO_REMETENTE = new RegExp(`^(?:${EMAIL_REMETENTE}|[^<>\\r\\n]*<${EMAIL_REMETENTE}>)$`);

/** SECURE tolerante a maiúscula e a 1/0/yes/no/sim/nao; `null` = valor que não dá para entender. */
function lerSecure(v: string): boolean | null {
  const t = v.trim().toLowerCase();
  if (["true", "1", "yes", "sim", "on"].includes(t)) return true;
  if (["false", "0", "no", "nao", "não", "off"].includes(t)) return false;
  return null;
}

/**
 * Lê e valida o remetente da plataforma. Nunca lança e nunca devolve o VALOR de
 * uma variável nos `problemas` (só o nome e o que está errado): a lista vai para
 * o log e para o /api/health.
 * - `desligado`: nenhuma PLATFORM_* no .env (legado: caixa do time);
 * - `invalido`: alguma PLATFORM_* presente, mas incompleta ou malformada. O
 *   e-mail de sistema é RECUSADO (nunca cai na caixa do time: S-05);
 * - `ok`: pronto, com porta e TLS resolvidos.
 */
export function remetenteDaPlataforma(fonte: FontePlataforma = env): RemetentePlataforma {
  const ler = (k: (typeof VARIAVEIS_PLATAFORMA)[number]): string | undefined => {
    const v = fonte[k];
    if (v === undefined || v === null) return undefined;
    const t = String(v).trim();
    return t === "" ? undefined : t;
  };
  if (!VARIAVEIS_PLATAFORMA.some((k) => ler(k) !== undefined)) return { estado: "desligado" };

  const problemas: string[] = [];
  for (const k of OBRIGATORIAS_PLATAFORMA) if (!ler(k)) problemas.push(`${k} ausente`);
  const from = ler("PLATFORM_EMAIL_FROM");
  if (from && !FORMATO_REMETENTE.test(from)) problemas.push('PLATFORM_EMAIL_FROM deve ser "email@dominio" ou "Nome <email@dominio>"');
  const replyTo = ler("PLATFORM_EMAIL_REPLY_TO");
  if (replyTo && !FORMATO_REMETENTE.test(replyTo)) problemas.push('PLATFORM_EMAIL_REPLY_TO deve ser "email@dominio" ou "Nome <email@dominio>"');

  const portaTexto = ler("PLATFORM_SMTP_PORT");
  const porta = portaTexto === undefined ? undefined : Number(portaTexto);
  if (porta !== undefined && !(Number.isInteger(porta) && porta >= 1 && porta <= 65535)) problemas.push("PLATFORM_SMTP_PORT deve ser um número de porta (1 a 65535)");

  const secureTexto = ler("PLATFORM_SMTP_SECURE");
  const secureLido = secureTexto === undefined ? undefined : lerSecure(secureTexto);
  if (secureLido === null) problemas.push("PLATFORM_SMTP_SECURE deve ser true ou false");

  const limiteTexto = ler("PLATFORM_EMAIL_LIMITE_DIA");
  const limiteDia = limiteTexto === undefined ? PLATAFORMA_LIMITE_DIA_PADRAO : Number(limiteTexto);
  if (!(Number.isInteger(limiteDia) && limiteDia >= 1)) problemas.push("PLATFORM_EMAIL_LIMITE_DIA deve ser um número inteiro maior que zero");

  if (problemas.length) return { estado: "invalido", problemas };

  // Porta e TLS: sem SECURE, TLS direto nas portas de TLS direto (465 e 2465, a
  // do Resend e do SES); SECURE=false sem porta = 587 com STARTTLS.
  const secure = typeof secureLido === "boolean" ? secureLido : [465, 2465].includes(porta ?? 465);
  const port = porta ?? (secure ? 465 : 587);
  return {
    estado: "ok",
    host: ler("PLATFORM_SMTP_HOST")!,
    port,
    secure,
    user: ler("PLATFORM_SMTP_USER")!,
    pass: ler("PLATFORM_SMTP_PASS")!,
    from: from!,
    ...(replyTo ? { replyTo } : {}),
    limiteDia,
  };
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
   
  console.error("❌ Variáveis de ambiente inválidas:");
   
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error("Env inválido — verifique o .env (veja .env.example).");
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;

// Cifra dos contatos ligada sem a chave do índice: falha cedo, antes de gravar linha sem índice.
if (env.CONTATOS_CIFRA !== "off" && !env.CONTATOS_INDICE_KEY) {
  throw new Error("CONTATOS_CIFRA diferente de off exige CONTATOS_INDICE_KEY (32+ caracteres).");
}

// CSP_MODO com valor que não se reconhece NÃO derruba o boot: vale o padrão (relatorio) e avisa uma vez.
if (!modoCspReconhecido(env.CSP_MODO)) {
  console.error(
    `❌ CSP_MODO="${String(env.CSP_MODO).slice(0, 30)}" não é um modo conhecido (desligada, relatorio, aplicada): vale o padrão "${modoCsp(undefined)}". ` +
      "Corrija o .env.",
  );
}

// Remetente da plataforma com erro NÃO derruba o boot: avisa uma vez aqui (log
// do pm2 de web e worker). O envio recusa e o /api/health mostra o problema.
{
  const remetente = remetenteDaPlataforma(env);
  if (remetente.estado === "invalido") {
    console.error(
      `❌ Remetente da plataforma (PLATFORM_*) inválido: ${remetente.problemas.join("; ")}. ` +
        "E-mails de sistema (reset, convite, alerta) NÃO saem até corrigir o .env.",
    );
  }
}

// Checagem pura "estas duas URLs são do mesmo banco?" (guarda do papel crmagro_app; ver o arquivo).
export { marcasDoBanco, mesmoBanco, problemaDoBancoDoApp } from "./mesmo-banco";
