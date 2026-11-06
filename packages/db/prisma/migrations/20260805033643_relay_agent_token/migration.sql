-- CreateTable
CREATE TABLE "RelayAgentToken" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RelayAgentToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RelayAgentToken_tokenHash_key" ON "RelayAgentToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RelayAgentToken_teamId_idx" ON "RelayAgentToken"("teamId");

-- AddForeignKey
ALTER TABLE "RelayAgentToken" ADD CONSTRAINT "RelayAgentToken_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelayAgentToken" ADD CONSTRAINT "RelayAgentToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
