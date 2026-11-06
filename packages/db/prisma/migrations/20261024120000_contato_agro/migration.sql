-- Verificador do agro: o que o contato é no agro (produtor, fazenda, armazém, algodoeira) e o detalhe da verificação
-- (evidências, foto na fila para o Claude). Aditiva: duas colunas em Contact, ambas com padrão constante ou opcionais;
-- nada existente muda e nenhuma linha antiga é reescrita. Sem índice: ainda não há filtro por tipo.
--
-- Contact é tabela que já existe: o lock_timeout faz esta migration desistir em 5 s, sem alterar nada, se a
-- tabela estiver ocupada (o pooler do Supabase ignora o lock_timeout da conexão).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE "Contact"
  ADD COLUMN IF NOT EXISTS "agroTipos" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "agroDetalhe" JSONB;
