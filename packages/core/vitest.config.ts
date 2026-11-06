import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Aborta a suíte se DATABASE_URL_APP apontar para outro banco que DATABASE_URL (vazamento da URL do
    // papel crmagro_app para o teste). Ver vitest.guarda.ts.
    globalSetup: ["./vitest.guarda.ts"],
    // forks: cada arquivo de teste num processo isolado (singleton do Prisma).
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Janela de envio (item 1.3) desligada por padrão: os testes não podem
    // depender da hora em que rodam. Os testes da janela ligam explicitamente.
    env: {
      FLOW_JANELA_ENVIO: "off",
      // Token do webhook de fluxo: "só hash" DESLIGADO por padrão nos testes, mesmo que o .env do VPS o ligue.
      // Quem testa o modo liga no próprio arquivo (flows/webhook-hash.test.ts põe "on" no beforeEach).
      FLOW_WEBHOOK_TOKEN_HASH: "",
      // Remetente da plataforma DESLIGADO nos testes, mesmo que o .env (o de
      // produção, no VPS) o tenha: convite e reset de teste nunca mandam
      // e-mail de verdade. Quem testa o remetente liga no próprio arquivo, com
      // o envio MOCKADO (email/plataforma.test.ts).
      PLATFORM_SMTP_HOST: "",
      PLATFORM_SMTP_PORT: "",
      PLATFORM_SMTP_USER: "",
      PLATFORM_SMTP_PASS: "",
      PLATFORM_SMTP_SECURE: "",
      PLATFORM_EMAIL_FROM: "",
      PLATFORM_EMAIL_REPLY_TO: "",
      PLATFORM_EMAIL_LIMITE_DIA: "",
      // Google Agenda DESLIGADO nos testes: criar evento com convidado manda
      // convite de verdade. Quem testa a integração liga no próprio arquivo,
      // com o cliente do Google MOCKADO (agenda/google/google-agenda.test.ts).
      GOOGLE_INTEGRACOES_CLIENT_ID: "",
      GOOGLE_INTEGRACOES_CLIENT_SECRET: "",
      GOOGLE_INTEGRACOES_REDIRECT_URI: "",
      GOOGLE_AGENDA_PUSH: "off",
      // Lista de liberados VAZIA nos testes (= ninguém conecta, fail-closed),
      // mesmo que o .env do VPS tenha uma. Quem testa a integração liga no
      // próprio arquivo (google-agenda.test.ts põe "todos" no beforeAll).
      GOOGLE_AGENDA_LIBERADOS: "",
      // Envio pelo Gmail DESLIGADO nos testes, mesmo que o .env do VPS o ligue. Quem
      // testa liga no próprio arquivo (email/gmail-envio.test.ts põe "on" no beforeAll).
      GOOGLE_GMAIL_ENVIO: "",
      // Entrada de e-mail por encaminhamento DESLIGADA nos testes, mesmo que o .env
      // do VPS a ligue. Quem testa liga no próprio arquivo
      // (email/encaminhamento.test.ts põe domínio e segredo no beforeAll).
      EMAIL_ENTRADA_DOMINIO: "",
      EMAIL_ENTRADA_SEGREDO: "",
      // Nectar DESLIGADO nos testes: nenhuma chamada sai do VPS, mesmo se alguém
      // esquecer o transporte falso (127.0.0.1:9 não responde).
      NECTAR_API_BASE: "http://127.0.0.1:9",
      // Nectar fora do beta nos testes (fail-closed), mesmo que o .env do VPS
      // tenha a lista. Quem testa liga no próprio arquivo.
      CRM_BETA_TEAM_IDS: "",
      // Vigia do backup fora do servidor DESLIGADO nos testes, mesmo que o .env do VPS o ligue (ele leria
      // /var/backups/crmagro/status de verdade e deixaria o health degraded). Quem testa liga no próprio arquivo
      // (health/backup.test.ts), com uma pasta temporária.
      BACKUP_FORA_VIGIAR: "",
      // Cifra de e-mail e telefone dos contatos: DESLIGADA por padrão nos testes (mesmo que o .env do VPS a ligue).
      // Quem testa um modo liga no próprio arquivo (process.env.CONTATOS_CIFRA). A chave do índice é fictícia.
      // `CONTATOS_CIFRA_NOS_TESTES=indice` repete a suíte inteira com a cifra ligada (rodada extra do CI e do dono).
      CONTATOS_CIFRA: process.env.CONTATOS_CIFRA_NOS_TESTES || "off",
      CONTATOS_INDICE_KEY: "teste-chave-do-indice-dos-contatos-32-caracteres",
      CONTATOS_INDICE_KEY_ANTERIOR: "",
      // Chave privada do selo do token da telefonia (F2-25): VAZIA nos testes, mesmo que o ambiente do worker a tenha. Quem
      // testa passa o ambiente à mão (opção `env`) com um par gerado na hora.
      TELEFONIA_CHAVE_PRIVADA: "",
      TELEFONIA_CHAVE_PRIVADA_ANTERIOR: "",
    },
  },
});
