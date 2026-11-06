-- Tipo do fluxo: prospecção (fala com contatos) ou marketing (publica postagens). Todo fluxo que já existe
-- é de prospecção. Coluna nova com padrão, sem tabela nova e sem política de RLS nova (a tabela já tem).
CREATE TYPE "FlowTipo" AS ENUM ('prospeccao', 'marketing');
ALTER TABLE "Flow" ADD COLUMN "tipo" "FlowTipo" NOT NULL DEFAULT 'prospeccao';
