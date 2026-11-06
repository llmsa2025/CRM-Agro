-- Passo "Enriquecer dados" e condição com vários destinos na mesma saída (destinos pendentes da inscrição). Aditiva.
ALTER TYPE "FlowNodeType" ADD VALUE IF NOT EXISTS 'enrich_data';
ALTER TABLE "Enrollment" ADD COLUMN "pendentes" JSONB;
