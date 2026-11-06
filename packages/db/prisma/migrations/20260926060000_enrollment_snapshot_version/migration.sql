-- Item 1.9 (MF-18): versão do formato do flowSnapshot. Default constante =
-- só metadado no Postgres 11+ (não reescreve a tabela).
ALTER TABLE "Enrollment" ADD COLUMN "snapshotVersion" INTEGER NOT NULL DEFAULT 1;
