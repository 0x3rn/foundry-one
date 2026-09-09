-- CreateTable
CREATE TABLE "DatabaseConfirmationChallenge" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatabaseConfirmationChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DatabaseConfirmationChallenge_tokenHash_key" ON "DatabaseConfirmationChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "DatabaseConfirmationChallenge_workspaceId_projectId_actorUs_idx" ON "DatabaseConfirmationChallenge"("workspaceId", "projectId", "actorUserId", "action", "expiresAt");
