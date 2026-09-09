import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import test from "node:test";
import { createDatabaseClient, PrismaAuditLogWriter } from "@foundry/database";
import {
  assertConfirmation,
  AuthorizationError,
  createConfirmationChallenge,
  executeAuthorizedProjectAction,
  executeAuthorizedWorkspaceAction,
  FixedWindowRateLimiter,
  InvalidConfirmationError,
  ProjectScopeError,
  RateLimitError,
  type ProjectScopeResolver,
} from "@foundry/security";
import {
  redactSensitiveMetadata,
  SecretSafeLogger,
  type AuditLogEntry,
  type AuditLogWriter,
  type StructuredLogEvent,
} from "@foundry/observability";

if (existsSync(".env.local")) {
  loadEnvFile(".env.local");
}

class MemoryAuditLog implements AuditLogWriter {
  readonly entries: AuditLogEntry[] = [];

  async write(entry: AuditLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

class MemoryProjectScope implements ProjectScopeResolver {
  constructor(private readonly projectIds: readonly string[]) {}

  async projectBelongsToWorkspace(projectId: string): Promise<boolean> {
    return this.projectIds.includes(projectId);
  }
}

const principal = {
  userId: "user-1",
  workspaceId: "workspace-1",
  role: "developer" as const,
};
const scope = new MemoryProjectScope(["project-1"]);

test("authorization denies wrong workspace and project scope before execution", async () => {
  const audit = new MemoryAuditLog();
  let executed = false;

  await assert.rejects(
    () =>
      executeAuthorizedProjectAction(
        {
          principal,
          workspaceId: "workspace-2",
          projectId: "project-1",
          permission: "database.read",
          action: "database.read",
          resourceType: "table",
          requestId: "request-scope",
          execute: async () => {
            executed = true;
            return "should-not-run";
          },
        },
        scope,
        audit,
      ),
    (error: unknown) => error instanceof ProjectScopeError,
  );

  assert.equal(executed, false);
  assert.equal(audit.entries[0]?.result, "denied");
});

test("workspace-scoped project creation is permission checked and audited", async () => {
  const audit = new MemoryAuditLog();
  let created = false;

  const result = await executeAuthorizedWorkspaceAction(
    {
      principal: { ...principal, role: "developer" },
      workspaceId: "workspace-1",
      permission: "project.manage",
      action: "project.create",
      resourceType: "project",
      requestId: "request-project-create",
      execute: async () => {
        created = true;
        return { id: "project-2" };
      },
    },
    audit,
  );

  assert.deepEqual(result, { id: "project-2" });
  assert.equal(created, true);
  assert.equal(audit.entries[0]?.result, "success");
  assert.equal(audit.entries[0]?.projectId, undefined);
});

test("underprivileged requests are denied and dangerous actions require exact confirmation", async () => {
  const audit = new MemoryAuditLog();
  let executed = false;

  await assert.rejects(
    () =>
      executeAuthorizedProjectAction(
        {
          principal: { ...principal, role: "viewer" },
          workspaceId: "workspace-1",
          projectId: "project-1",
          permission: "database.write",
          action: "database.write",
          resourceType: "table",
          requestId: "request-permission",
          execute: async () => {
            executed = true;
            return "should-not-run";
          },
        },
        scope,
        audit,
      ),
    (error: unknown) => error instanceof AuthorizationError,
  );

  const challenge = createConfirmationChallenge("table.delete");
  assert.throws(
    () => assertConfirmation("table.delete", challenge, undefined),
    (error: unknown) => error instanceof Error && error.name === "ConfirmationRequiredError",
  );
  assert.throws(
    () =>
      assertConfirmation("table.delete", challenge, {
        action: "table.delete",
        token: "wrong-token",
      }),
    (error: unknown) => error instanceof InvalidConfirmationError,
  );
  assert.equal(executed, false);
});

test("confirmed actions are rate limited before provider execution", async () => {
  const audit = new MemoryAuditLog();
  const challenge = createConfirmationChallenge("sql.destructive");
  const limiter = new FixedWindowRateLimiter(1, 60_000, () => 1_000);
  let executions = 0;
  const input = {
    principal: { ...principal, role: "admin" as const },
    workspaceId: "workspace-1",
    projectId: "project-1",
    permission: "destructive.execute" as const,
    action: "sql.destructive",
    expectedConfirmation: challenge,
    providedConfirmation: challenge,
    resourceType: "sql",
    requestId: "request-rate",
    rateLimiter: limiter,
    rateLimitKey: "workspace-1:user-1",
    execute: async () => {
      executions += 1;
      return "ok";
    },
  };

  await executeAuthorizedProjectAction(input, scope, audit);
  await assert.rejects(
    () => executeAuthorizedProjectAction({ ...input, requestId: "request-rate-2" }, scope, audit),
    (error: unknown) => error instanceof RateLimitError,
  );

  assert.equal(executions, 1);
  assert.equal(audit.entries.filter((entry) => entry.result === "success").length, 1);
  assert.equal(audit.entries.at(-1)?.result, "denied");
});

test("provider failures are audited without leaking error payloads", async () => {
  const audit = new MemoryAuditLog();

  await assert.rejects(
    () =>
      executeAuthorizedProjectAction(
        {
          principal: { ...principal, role: "admin" },
          workspaceId: "workspace-1",
          projectId: "project-1",
          permission: "database.write",
          action: "database.write",
          provider: "supabase",
          resourceType: "table",
          resourceId: "table-1",
          requestId: "request-failure",
          execute: async () => {
            const error = new Error("provider failed");
            Object.assign(error, { code: "PROVIDER_UNAVAILABLE", accessToken: "do-not-log" });
            throw error;
          },
        },
        scope,
        audit,
      ),
    /provider failed/,
  );

  assert.deepEqual(audit.entries[0], {
    actorUserId: "user-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    provider: "supabase",
    resourceType: "table",
    resourceId: "table-1",
    action: "database.write",
    requestId: "request-failure",
    result: "failure",
    metadata: { errorCode: "PROVIDER_UNAVAILABLE" },
  });
});

test("secret-safe metadata redacts nested credentials in logs", () => {
  const events: StructuredLogEvent[] = [];
  const logger = new SecretSafeLogger({ write: (event) => events.push(event) });
  logger.write({
    event: "provider.check",
    metadata: {
      provider: "supabase",
      accessToken: "hidden",
      nested: { api_key: "hidden-too", attempt: 1 },
    },
  });

  assert.deepEqual(events[0]?.metadata, {
    provider: "supabase",
    accessToken: "[REDACTED]",
    nested: { api_key: "[REDACTED]", attempt: 1 },
  });
  assert.deepEqual(redactSensitiveMetadata({ password: "hidden" }), {
    password: "[REDACTED]",
  });
});

test("Prisma audit writer persists the boundary record with redacted metadata", async () => {
  const database = createDatabaseClient();
  const suffix = randomUUID().slice(0, 8);
  const userId = `audit-test-user-${suffix}`;
  let organizationId: string | undefined;

  try {
    const user = await database.user.create({
      data: { id: userId, name: "Audit Test", email: `${userId}@example.test` },
    });
    const organization = await database.organization.create({
      data: { name: "Audit Test", slug: `audit-test-${suffix}` },
    });
    organizationId = organization.id;
    const workspace = await database.workspace.create({
      data: { organizationId: organization.id, name: "Audit Test", slug: "audit" },
    });
    const project = await database.project.create({
      data: { workspaceId: workspace.id, name: "Audit Test", slug: "audit" },
    });

    await new PrismaAuditLogWriter(database).write({
      actorUserId: user.id,
      workspaceId: workspace.id,
      projectId: project.id,
      provider: "supabase",
      resourceType: "table",
      resourceId: "table-1",
      action: "table.delete",
      requestId: `request-${suffix}`,
      result: "denied",
      metadata: { accessToken: "do-not-persist", reason: "confirmation_required" },
    });

    const record = await database.auditLog.findFirst({
      where: { workspaceId: workspace.id },
    });
    assert.ok(record);
    assert.equal(record.provider, "supabase");
    assert.deepEqual(record.metadata, {
      accessToken: "[REDACTED]",
      reason: "confirmation_required",
    });
  } finally {
    if (organizationId) {
      await database.organization.delete({ where: { id: organizationId } });
    }
    await database.user.delete({ where: { id: userId } });
    await database.$disconnect();
  }
});
