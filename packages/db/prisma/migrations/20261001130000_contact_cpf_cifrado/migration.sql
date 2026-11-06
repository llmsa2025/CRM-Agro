-- CPF do contato passa a ficar cifrado no banco (segurança, 01/10/2026).
-- A coluna só troca de nome: o valor novo é gravado cifrado (AES-256-GCM, mesma chave das credenciais)
-- por core/contacts/cpf.ts. O que já estiver em texto puro continua legível (o leitor aceita) e é
-- cifrado pelo script packages/db/scripts/cifrar-cpf.ts. Nenhum índice usava a coluna.
ALTER TABLE "Contact" RENAME COLUMN "cpf" TO "cpfCifrado";
