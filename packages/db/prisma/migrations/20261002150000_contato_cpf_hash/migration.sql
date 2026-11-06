-- Impressão do CPF (HMAC por time) para a importação achar contato pelo mesmo CPF sem abrir o valor cifrado.
-- Aditiva. Quem já tem CPF é preenchido pelo worker no boot (contacts/cpf.ts, preencherHashDoCpf).
ALTER TABLE "Contact" ADD COLUMN "cpfHash" TEXT;
CREATE INDEX "Contact_teamId_cpfHash_idx" ON "Contact"("teamId", "cpfHash");
