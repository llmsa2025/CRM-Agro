-- CreateIndex
CREATE INDEX "Activity_teamId_tipo_createdAt_idx" ON "Activity"("teamId", "tipo", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_contactId_direcao_createdAt_idx" ON "Activity"("contactId", "direcao", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_channelAccountId_lastMessageAt_idx" ON "Conversation"("channelAccountId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Deal_teamId_status_enteredStageAt_idx" ON "Deal"("teamId", "status", "enteredStageAt");
