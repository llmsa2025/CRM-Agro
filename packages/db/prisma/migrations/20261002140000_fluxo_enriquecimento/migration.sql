-- Passo "Registrar conversa no histórico" e tipo de fluxo "Enriquecimento". Aditiva: só valores novos nos enums.
ALTER TYPE "FlowNodeType" ADD VALUE IF NOT EXISTS 'save_history';
ALTER TYPE "FlowTipo" ADD VALUE IF NOT EXISTS 'enriquecimento';
