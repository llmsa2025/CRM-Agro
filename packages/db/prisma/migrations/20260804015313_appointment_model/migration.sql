-- CreateEnum
CREATE TYPE "AppointmentType" AS ENUM ('reuniao', 'ligacao', 'follow_up', 'tarefa', 'outro');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('pendente', 'concluido', 'cancelado');

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "contactId" TEXT,
    "titulo" TEXT NOT NULL,
    "descricao" TEXT,
    "tipo" "AppointmentType" NOT NULL DEFAULT 'tarefa',
    "inicio" TIMESTAMP(3) NOT NULL,
    "fim" TIMESTAMP(3),
    "status" "AppointmentStatus" NOT NULL DEFAULT 'pendente',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Appointment_teamId_idx" ON "Appointment"("teamId");

-- CreateIndex
CREATE INDEX "Appointment_teamId_inicio_idx" ON "Appointment"("teamId", "inicio");

-- CreateIndex
CREATE INDEX "Appointment_contactId_idx" ON "Appointment"("contactId");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
