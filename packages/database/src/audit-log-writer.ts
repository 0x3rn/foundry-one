import { Prisma, type PrismaClient } from "@prisma/client";
import type { AuditLogEntry, AuditLogWriter } from "@foundry/observability";
import { redactSensitiveMetadata } from "@foundry/observability";

export class PrismaAuditLogWriter implements AuditLogWriter {
  constructor(private readonly database: PrismaClient) {}

  async write(entry: AuditLogEntry): Promise<void> {
    await this.database.auditLog.create({
      data: {
        workspaceId: entry.workspaceId,
        projectId: entry.projectId,
        actorUserId: entry.actorUserId,
        provider: entry.provider,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        result: entry.result,
        requestId: entry.requestId,
        metadata: entry.metadata
          ? (JSON.parse(
              JSON.stringify(redactSensitiveMetadata(entry.metadata)),
            ) as Prisma.InputJsonValue)
          : undefined,
      },
    });
  }
}
