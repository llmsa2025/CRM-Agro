-- Google Agenda + Meet (fase 1, decisões do dono de 28/09 —
-- a documentação interna).
--
-- 1. Convidados múltiplos (decisão 8): tabela `AppointmentAttendee`. O antigo
--    `Appointment.convidadoEmail` (um só) é COPIADO para ela; a coluna fica
--    uma versão (app antigo durante o deploy) e sai na próxima migration.
-- 2. Conexão OAuth POR PESSOA (`OAuthConnection`, tokens cifrados), estado da
--    sincronização por agenda (`CalendarSync`), vínculo compromisso ↔ evento
--    (`AppointmentLink`) e o bloco "Ocupado" (`CalendarBusyBlock`, SÓ início,
--    fim e id externo — decisão 4).
-- 3. Appointment ganha origem, dia inteiro, link da reunião e o carimbo dos
--    campos comuns com o Google (régua do conflito, decisão 5).
--
-- Tudo aditivo: nenhuma coluna existente muda nem é apagada.

-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('google');

-- CreateEnum
CREATE TYPE "OAuthConnectionStatus" AS ENUM ('connected', 'reauth_required', 'error');

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "camposComunsEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "diaInteiro" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "origem" TEXT NOT NULL DEFAULT 'crmagro',
ADD COLUMN     "reuniaoLink" TEXT,
ADD COLUMN     "reuniaoProvedor" TEXT;

-- CreateTable
CREATE TABLE "AppointmentAttendee" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "nome" TEXT,
    "userId" TEXT,
    "contactId" TEXT,
    "resposta" TEXT NOT NULL DEFAULT 'needsAction',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentAttendee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthConnection" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "scopes" TEXT[],
    "credentials" JSONB NOT NULL,
    "accessTokenExpiraEm" TIMESTAMP(3),
    "status" "OAuthConnectionStatus" NOT NULL DEFAULT 'connected',
    "falhas" INTEGER NOT NULL DEFAULT 0,
    "ultimoErro" TEXT,
    "ultimoErroEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarSync" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL DEFAULT 'primary',
    "syncToken" TEXT,
    "fusoHorario" TEXT,
    "canalId" TEXT,
    "canalResourceId" TEXT,
    "canalExpiraEm" TIMESTAMP(3),
    "ultimaSincronizacaoEm" TIMESTAMP(3),
    "proximaSincronizacaoEm" TIMESTAMP(3),
    "falhas" INTEGER NOT NULL DEFAULT 0,
    "ultimoErro" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentLink" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL DEFAULT 'primary',
    "externalEventId" TEXT NOT NULL,
    "iCalUID" TEXT,
    "etag" TEXT,
    "externalUpdatedAt" TIMESTAMP(3),
    "origem" TEXT NOT NULL DEFAULT 'crmagro',
    "pendenteDesde" TIMESTAMP(3),
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "ultimoErro" TEXT,
    "sincronizadoEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarBusyBlock" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fim" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarBusyBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppointmentAttendee_teamId_email_idx" ON "AppointmentAttendee"("teamId", "email");

-- CreateIndex
CREATE INDEX "AppointmentAttendee_userId_idx" ON "AppointmentAttendee"("userId");

-- CreateIndex
CREATE INDEX "AppointmentAttendee_contactId_idx" ON "AppointmentAttendee"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentAttendee_appointmentId_email_key" ON "AppointmentAttendee"("appointmentId", "email");

-- CreateIndex
CREATE INDEX "OAuthConnection_teamId_userId_idx" ON "OAuthConnection"("teamId", "userId");

-- CreateIndex
CREATE INDEX "OAuthConnection_status_idx" ON "OAuthConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthConnection_provider_externalAccountId_key" ON "OAuthConnection"("provider", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthConnection_userId_provider_key" ON "OAuthConnection"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarSync_canalId_key" ON "CalendarSync"("canalId");

-- CreateIndex
CREATE INDEX "CalendarSync_proximaSincronizacaoEm_idx" ON "CalendarSync"("proximaSincronizacaoEm");

-- CreateIndex
CREATE INDEX "CalendarSync_canalExpiraEm_idx" ON "CalendarSync"("canalExpiraEm");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarSync_connectionId_calendarId_key" ON "CalendarSync"("connectionId", "calendarId");

-- CreateIndex
CREATE INDEX "AppointmentLink_teamId_externalEventId_idx" ON "AppointmentLink"("teamId", "externalEventId");

-- CreateIndex
CREATE INDEX "AppointmentLink_pendenteDesde_idx" ON "AppointmentLink"("pendenteDesde");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentLink_connectionId_calendarId_externalEventId_key" ON "AppointmentLink"("connectionId", "calendarId", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentLink_appointmentId_connectionId_key" ON "AppointmentLink"("appointmentId", "connectionId");

-- CreateIndex
CREATE INDEX "CalendarBusyBlock_teamId_userId_inicio_idx" ON "CalendarBusyBlock"("teamId", "userId", "inicio");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarBusyBlock_connectionId_externalEventId_key" ON "CalendarBusyBlock"("connectionId", "externalEventId");

-- AddForeignKey
ALTER TABLE "AppointmentAttendee" ADD CONSTRAINT "AppointmentAttendee_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentAttendee" ADD CONSTRAINT "AppointmentAttendee_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentAttendee" ADD CONSTRAINT "AppointmentAttendee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentAttendee" ADD CONSTRAINT "AppointmentAttendee_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthConnection" ADD CONSTRAINT "OAuthConnection_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthConnection" ADD CONSTRAINT "OAuthConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarSync" ADD CONSTRAINT "CalendarSync_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarSync" ADD CONSTRAINT "CalendarSync_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "OAuthConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentLink" ADD CONSTRAINT "AppointmentLink_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentLink" ADD CONSTRAINT "AppointmentLink_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentLink" ADD CONSTRAINT "AppointmentLink_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "OAuthConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBusyBlock" ADD CONSTRAINT "CalendarBusyBlock_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBusyBlock" ADD CONSTRAINT "CalendarBusyBlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBusyBlock" ADD CONSTRAINT "CalendarBusyBlock_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "OAuthConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

-- Carimbo dos campos comuns: a última alteração conhecida de cada compromisso.
-- (O trigger do lembrete só dispara com `inicio`/`lembreteMin` no SET.)
UPDATE "Appointment" SET "camposComunsEm" = "updatedAt";

-- Convidado único → tabela de convidados, em minúsculas e sem espaços. Só
-- endereço com cara de e-mail entra (o Google recusa o resto); o valor
-- original continua em `convidadoEmail` até a próxima migration.
INSERT INTO "AppointmentAttendee" ("id", "teamId", "appointmentId", "email", "createdAt")
SELECT gen_random_uuid()::text, a."teamId", a."id", lower(btrim(a."convidadoEmail")), a."createdAt"
FROM "Appointment" a
WHERE a."convidadoEmail" IS NOT NULL
  AND lower(btrim(a."convidadoEmail")) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
ON CONFLICT ("appointmentId", "email") DO NOTHING;

-- Convidado que é colega do MESMO time (o join leva o teamId da linha).
UPDATE "AppointmentAttendee" at
SET "userId" = u."id"
FROM "User" u
WHERE u."teamId" = at."teamId" AND lower(u."email") = at."email" AND at."userId" IS NULL;

-- Convidado que é contato do MESMO time (e-mail no ChannelIdentifier, já em minúsculas).
UPDATE "AppointmentAttendee" at
SET "contactId" = ci."contactId"
FROM "ChannelIdentifier" ci
WHERE ci."teamId" = at."teamId" AND ci."canal" = 'email' AND ci."valor" = at."email" AND at."contactId" IS NULL;
