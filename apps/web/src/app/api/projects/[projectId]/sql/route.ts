import { randomUUID } from "node:crypto";
import { AuthConfigurationError, getAuth, type AuthenticatedPrincipal } from "@foundry/auth";
import {
  ConfirmationChallengeError,
  createDatabaseClient,
  PrismaAuditLogWriter,
  PrismaConfirmationChallengeStore,
  PrismaProviderConnectionStore,
  PrismaSavedQueryStore,
  SavedQueryError,
} from "@foundry/database";
import { createKeyringFromEnvironment, CredentialVault, VaultError } from "@foundry/encryption";
import { ProviderError, ProviderLifecycle } from "@foundry/providers-core";
import { createSupabaseProvider, SupabaseCredentialError } from "@foundry/providers-supabase";
import {
  AuthorizationError,
  classifySql,
  ConfirmationRequiredError,
  executeAuthorizedProjectAction,
  FixedWindowRateLimiter,
  InvalidConfirmationError,
  ProjectScopeError,
  RateLimitError,
  sqlConfirmationAction,
  SqlValidationError,
} from "@foundry/security";
import {
  normalizeSqlHistoryRecord,
  parseSqlStudioRequest,
  sanitizeSqlPreview,
  SqlStudioInputError,
} from "@/lib/sql-studio";

const sqlRateLimiter = new FixedWindowRateLimiter(30, 60_000);

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function requestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && supplied.length <= 128 ? supplied : randomUUID();
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  let database: ReturnType<typeof createDatabaseClient> | undefined;

  try {
    const session = await getAuth().api.getSession({ headers: request.headers });
    if (!session) return errorResponse("UNAUTHENTICATED", "A valid session is required.", 401);

    const { projectId } = await context.params;
    if (!projectId.trim()) return errorResponse("INVALID_PROJECT", "A project is required.", 400);

    const client = createDatabaseClient();
    database = client;
    const project = await client.project.findFirst({
      where: {
        id: projectId,
        workspace: { members: { some: { userId: session.user.id } } },
      },
      select: {
        id: true,
        workspaceId: true,
        workspace: {
          select: {
            organizationId: true,
            members: { where: { userId: session.user.id }, select: { role: true }, take: 1 },
          },
        },
        providerConnections: {
          where: { provider: "supabase" },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!project) return errorResponse("FORBIDDEN", "You cannot access this project.", 403);
    const membership = project.workspace.members[0];
    const connection = project.providerConnections[0];
    if (!membership || !connection) {
      return errorResponse(
        "DATABASE_UNAVAILABLE",
        "Connect a Supabase database before using SQL Studio.",
        409,
      );
    }

    const principal: AuthenticatedPrincipal = {
      userId: session.user.id,
      organizationId: project.workspace.organizationId,
      workspaceId: project.workspaceId,
      role: membership.role,
    };
    const audit = new PrismaAuditLogWriter(client);
    const scopeResolver = {
      projectBelongsToWorkspace: async (candidateProjectId: string, workspaceId: string) =>
        candidateProjectId === project.id && workspaceId === project.workspaceId,
    };
    const savedQueryStore = new PrismaSavedQueryStore(client);

    const data = await executeAuthorizedProjectAction(
      {
        principal,
        workspaceId: project.workspaceId,
        projectId: project.id,
        permission: "sql.execute",
        action: "database.sql.workspace.read",
        provider: "supabase",
        resourceType: "sql_workspace",
        requestId: requestId(request),
        rateLimiter: sqlRateLimiter,
        rateLimitKey: `${project.workspaceId}:${session.user.id}`,
        execute: async () => {
          const [savedQueries, auditRows] = await Promise.all([
            savedQueryStore.listByProject(project.workspaceId, project.id),
            client.auditLog.findMany({
              where: {
                workspaceId: project.workspaceId,
                projectId: project.id,
                resourceType: "sql_query",
              },
              orderBy: { createdAt: "desc" },
              take: 30,
              select: {
                id: true,
                action: true,
                result: true,
                createdAt: true,
                metadata: true,
                actor: { select: { name: true } },
              },
            }),
          ]);

          const history = auditRows
            .map((row) =>
              normalizeSqlHistoryRecord({
                id: row.id,
                action: row.action,
                result: row.result,
                createdAt: row.createdAt,
                actorName: row.actor?.name ?? null,
                metadata: row.metadata,
              }),
            )
            .filter((item): item is NonNullable<typeof item> => item !== null)
            .slice(0, 20);

          return { savedQueries, history };
        },
      },
      scopeResolver,
      audit,
    );

    return Response.json({ data });
  } catch (error) {
    if (error instanceof AuthConfigurationError)
      return errorResponse(error.code, error.message, 503);
    if (error instanceof AuthorizationError || error instanceof ProjectScopeError) {
      return errorResponse("FORBIDDEN", "You are not allowed to run SQL on this project.", 403);
    }
    if (error instanceof RateLimitError) {
      return new Response(JSON.stringify({ error: { code: error.code, message: error.message } }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)),
        },
      });
    }
    throw error;
  } finally {
    await database?.$disconnect();
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  let database: ReturnType<typeof createDatabaseClient> | undefined;
  let lifecycle: ProviderLifecycle | undefined;

  try {
    const session = await getAuth().api.getSession({ headers: request.headers });
    if (!session) return errorResponse("UNAUTHENTICATED", "A valid session is required.", 401);

    const { projectId } = await context.params;
    if (!projectId.trim()) return errorResponse("INVALID_PROJECT", "A project is required.", 400);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("INVALID_JSON", "Request body must be valid JSON.", 400);
    }

    const input = parseSqlStudioRequest(body);
    const client = createDatabaseClient();
    database = client;

    const project = await client.project.findFirst({
      where: {
        id: projectId,
        workspace: { members: { some: { userId: session.user.id } } },
      },
      select: {
        id: true,
        workspaceId: true,
        workspace: {
          select: {
            organizationId: true,
            members: { where: { userId: session.user.id }, select: { role: true }, take: 1 },
          },
        },
        providerConnections: {
          where: { provider: "supabase" },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!project) return errorResponse("FORBIDDEN", "You cannot access this project.", 403);
    const membership = project.workspace.members[0];
    const connection = project.providerConnections[0];
    if (!membership || !connection) {
      return errorResponse(
        "DATABASE_UNAVAILABLE",
        "Connect a Supabase database before using SQL Studio.",
        409,
      );
    }

    const principal: AuthenticatedPrincipal = {
      userId: session.user.id,
      organizationId: project.workspace.organizationId,
      workspaceId: project.workspaceId,
      role: membership.role,
    };
    const audit = new PrismaAuditLogWriter(client);
    const scopeResolver = {
      projectBelongsToWorkspace: async (candidateProjectId: string, workspaceId: string) =>
        candidateProjectId === project.id && workspaceId === project.workspaceId,
    };
    const savedQueryStore = new PrismaSavedQueryStore(client);

    if (input.operation === "save-query") {
      const savedQuery = await executeAuthorizedProjectAction(
        {
          principal,
          workspaceId: project.workspaceId,
          projectId: project.id,
          permission: "sql.execute",
          action: input.queryId
            ? "database.sql.saved_query.update"
            : "database.sql.saved_query.create",
          provider: "supabase",
          resourceType: "saved_query",
          resourceId: input.queryId ?? input.name,
          requestId: requestId(request),
          rateLimiter: sqlRateLimiter,
          rateLimitKey: `${project.workspaceId}:${session.user.id}`,
          metadata: {
            name: input.name,
            folder: input.folder ?? null,
          },
          execute: async () => {
            if (input.queryId) {
              return savedQueryStore.update({
                id: input.queryId,
                workspaceId: project.workspaceId,
                projectId: project.id,
                name: input.name,
                ...(input.folder !== undefined ? { folder: input.folder } : {}),
                sqlText: input.sqlText,
              });
            }
            return savedQueryStore.create({
              workspaceId: project.workspaceId,
              projectId: project.id,
              createdById: session.user.id,
              name: input.name,
              ...(input.folder ? { folder: input.folder } : {}),
              sqlText: input.sqlText,
            });
          },
        },
        scopeResolver,
        audit,
      );

      return Response.json({ data: savedQuery }, { status: input.queryId ? 200 : 201 });
    }

    if (input.operation === "delete-query") {
      const deleted = await executeAuthorizedProjectAction(
        {
          principal,
          workspaceId: project.workspaceId,
          projectId: project.id,
          permission: "sql.execute",
          action: "database.sql.saved_query.delete",
          provider: "supabase",
          resourceType: "saved_query",
          resourceId: input.queryId,
          requestId: requestId(request),
          rateLimiter: sqlRateLimiter,
          rateLimitKey: `${project.workspaceId}:${session.user.id}`,
          execute: async () => {
            await savedQueryStore.delete({
              id: input.queryId,
              workspaceId: project.workspaceId,
              projectId: project.id,
            });
            return { deleted: true, id: input.queryId };
          },
        },
        scopeResolver,
        audit,
      );

      return Response.json({ data: deleted });
    }

    const store = new PrismaProviderConnectionStore(client);
    const storedConnection = await store.findById(connection.id);
    if (!storedConnection) {
      return errorResponse("DATABASE_UNAVAILABLE", "The provider connection is unavailable.", 409);
    }
    const vault = new CredentialVault(createKeyringFromEnvironment());
    const confirmationStore = new PrismaConfirmationChallengeStore(client);
    const classification = classifySql(input.sql);

    if (input.operation === "prepare") {
      const prepared = await executeAuthorizedProjectAction(
        {
          principal,
          workspaceId: project.workspaceId,
          projectId: project.id,
          permission: "sql.execute",
          action: "database.sql.prepare",
          provider: "supabase",
          resourceType: "sql_prepare",
          resourceId: classification.kind,
          requestId: requestId(request),
          rateLimiter: sqlRateLimiter,
          rateLimitKey: `${project.workspaceId}:${session.user.id}`,
          metadata: {
            kind: classification.kind,
            statementCount: classification.statementCount,
            requiresConfirmation: classification.requiresConfirmation,
            sqlPreview: sanitizeSqlPreview(input.sql),
          },
          execute: async () => {
            let estimatedRows: number | undefined;
            if (classification.statementCount === 1) {
              const credentials = vault.decrypt(storedConnection.credential);
              const provider = createSupabaseProvider(credentials);
              lifecycle = new ProviderLifecycle(provider);
              const connectionState = await lifecycle.connect();
              if (connectionState.state !== "disconnected") {
                const service = provider.services.database;
                estimatedRows = await service?.estimateQueryRows?.(input.sql);
              }
            }

            const confirmation = classification.requiresConfirmation
              ? await confirmationStore.create({
                  workspaceId: project.workspaceId,
                  projectId: project.id,
                  actorUserId: session.user.id,
                  action: sqlConfirmationAction(classification),
                })
              : undefined;

            return {
              classification,
              ...(estimatedRows !== undefined ? { estimatedRows } : {}),
              ...(confirmation ? { confirmation } : {}),
            };
          },
        },
        scopeResolver,
        audit,
      );

      return Response.json({ data: prepared });
    }

    if (classification.requiresConfirmation && !input.confirmationToken) {
      return errorResponse("CONFIRMATION_REQUIRED", classification.reason, 409);
    }

    const executed = await executeAuthorizedProjectAction(
      {
        principal,
        workspaceId: project.workspaceId,
        projectId: project.id,
        permission: "sql.execute",
        action: classification.requiresConfirmation ? "sql.destructive" : "database.sql.execute",
        ...(classification.requiresConfirmation
          ? {
              expectedConfirmation: {
                action: "sql.destructive" as const,
                token: input.confirmationToken as string,
              },
              providedConfirmation: {
                action: "sql.destructive" as const,
                token: input.confirmationToken as string,
              },
            }
          : {}),
        provider: "supabase",
        resourceType: "sql_query",
        resourceId: classification.kind,
        requestId: requestId(request),
        rateLimiter: sqlRateLimiter,
        rateLimitKey: `${project.workspaceId}:${session.user.id}`,
        metadata: {
          kind: classification.kind,
          statementCount: classification.statementCount,
          requiresConfirmation: classification.requiresConfirmation,
          maxRows: input.maxRows ?? 100,
          sqlPreview: sanitizeSqlPreview(input.sql),
        },
        resultMetadata: (outcome: {
          readonly result: {
            readonly rowCount: number;
            readonly durationMs: number;
            readonly truncated: boolean;
          };
          readonly estimatedRows?: number;
        }) => ({
          rowCount: outcome.result.rowCount,
          durationMs: outcome.result.durationMs,
          truncated: outcome.result.truncated,
          ...(outcome.estimatedRows !== undefined ? { estimatedRows: outcome.estimatedRows } : {}),
        }),
        execute: async () => {
          const credentials = vault.decrypt(storedConnection.credential);
          const provider = createSupabaseProvider(credentials);
          lifecycle = new ProviderLifecycle(provider);
          const connectionState = await lifecycle.connect();
          if (connectionState.state === "disconnected") {
            throw new ProviderError(
              "provider_unavailable",
              "The connected database is currently unavailable.",
              { provider: "supabase", operation: "database.sql.execute", retryable: true },
            );
          }
          const capabilities = await provider.getCapabilities();
          if (!capabilities.relationalDatabase) {
            throw new ProviderError(
              "provider_unavailable",
              "The connected database is currently unavailable.",
              { provider: "supabase", operation: "database.sql.execute", retryable: true },
            );
          }
          const service = provider.services.database;
          if (!service?.executeQuery) {
            throw new ProviderError(
              "capability_unsupported",
              "SQL query execution is not available for this connection.",
              { provider: "supabase", operation: "database.sql.execute" },
            );
          }

          if (classification.requiresConfirmation) {
            await confirmationStore.claim({
              workspaceId: project.workspaceId,
              projectId: project.id,
              actorUserId: session.user.id,
              action: sqlConfirmationAction(classification),
              token: input.confirmationToken as string,
            });
          }

          const estimatedRows =
            classification.kind !== "read_only" && classification.statementCount === 1
              ? await service.estimateQueryRows?.(input.sql)
              : undefined;

          const result = await service.executeQuery(input.sql, {
            ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
          });

          return {
            classification,
            result,
            ...(estimatedRows !== undefined ? { estimatedRows } : {}),
          };
        },
      },
      scopeResolver,
      audit,
    );

    return Response.json({ data: executed });
  } catch (error) {
    if (error instanceof AuthConfigurationError)
      return errorResponse(error.code, error.message, 503);
    if (
      error instanceof SqlStudioInputError ||
      error instanceof SqlValidationError ||
      error instanceof SupabaseCredentialError
    ) {
      return errorResponse(error.code, error.message, 400);
    }
    if (error instanceof SavedQueryError) {
      return errorResponse(
        error.code,
        error.message,
        error.code === "SAVED_QUERY_NOT_FOUND" ? 404 : 400,
      );
    }
    if (
      error instanceof ConfirmationChallengeError ||
      error instanceof ConfirmationRequiredError ||
      error instanceof InvalidConfirmationError
    ) {
      return errorResponse(error.code, error.message, 409);
    }
    if (error instanceof VaultError)
      return errorResponse(error.code, "Credential encryption is not configured.", 503);
    if (error instanceof AuthorizationError || error instanceof ProjectScopeError) {
      return errorResponse("FORBIDDEN", "You are not allowed to run SQL on this project.", 403);
    }
    if (error instanceof RateLimitError) {
      return new Response(JSON.stringify({ error: { code: error.code, message: error.message } }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)),
        },
      });
    }
    if (error instanceof ProviderError) {
      return errorResponse(
        error.code,
        error.message,
        error.code === "capability_unsupported"
          ? 409
          : error.code === "invalid_configuration"
            ? 400
            : 502,
      );
    }
    throw error;
  } finally {
    await lifecycle?.close();
    await database?.$disconnect();
  }
}
