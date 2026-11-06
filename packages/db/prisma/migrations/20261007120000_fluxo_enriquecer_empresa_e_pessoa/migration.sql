-- O passo "Enriquecer dados" (enrich_data) foi separado em dois: "Enriquecer empresa" e "Enriquecer pessoa".
-- Aditiva: dois valores novos no enum. O valor antigo continua valendo (fluxos existentes seguem rodando).
ALTER TYPE "FlowNodeType" ADD VALUE IF NOT EXISTS 'enrich_company';
ALTER TYPE "FlowNodeType" ADD VALUE IF NOT EXISTS 'enrich_person';
