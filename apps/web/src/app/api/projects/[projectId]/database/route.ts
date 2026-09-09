import { randomUUID } from "node:crypto";
import { AuthConfigurationError, getAuth, type AuthenticatedPrincipal } from "@foundry/auth";
import {
  createDatabaseClient,
  PrismaAuditLogWriter,
  PrismaProviderConnectionStore,
} from "@foundry/database";
import { createKeyringFromEnvironment, CredentialVault, VaultError } from "@foundry/encryption";
import {
  ProviderError,
  ProviderLifecycle,
  type ProviderRecord,
  type ProviderScalar,
} from "@foundry/providers-core";
import { createSupabaseProvider, SupabaseCredentialError } from "@foundry/providers-supabase";
import {
  AuthorizationError,
  executeAuthorizedProjectAction,
  FixedWindowRateLimiter,
  ProjectScopeError,
  RateLimitError,
} from "@foundry/security";

const databaseRateLimiter = new FixedWindowRateLimiter(60, 60_000);

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function requestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && supplied.length <= 128 ? supplied : randomUUID();
}

function parseResource(request: Request): {
  readonly resource: "tables" | "columns" | "rows";
  readonly table?: string;
  readonly cursor?: string;
} {
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource") ?? "tables";
  if (resource !== "tables" && resource !== "columns" && resource !== "rows") {
    throw new SupabaseCredentialError("resource must be tables, columns, or rows.");
  }
  const table = url.searchParams.get("table")?.trim() || undefined;
  if (resource !== "tables" && !table) {
    throw new SupabaseCredentialError("table is required for column and row reads.");
  }
  return {
    resource,
    ...(table ? { table } : {}),
    cursor: url.searchParams.get("cursor") ?? undefined,
  };
}

function isProviderScalar(value: unknown): value is ProviderScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string" || item === null))
  );
}

function parseMutationBody(value: unknown): {
  readonly operation: "insert" | "update" | "delete";
  readonly table: string;
  readonly values?: ProviderRecord;
  readonly identity?: { readonly column: string; readonly value: ProviderScalar };
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SupabaseCredentialError("Database mutation input must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  if (!(["insert", "update", "delete"] as readonly unknown[]).includes(body.operation)) {
    throw new SupabaseCredentialError("operation must be insert, update, or delete.");
  }
  if (typeof body.table !== "string" || !body.table.trim()) {
    throw new SupabaseCredentialError("table is required.");
  }
  const values = body.values;
  if (values !== undefined && (!values || typeof values !== "object" || Array.isArray(values))) {
    throw new SupabaseCredentialError("values must be an object when provided.");
  }
  const normalizedValues = values
    ? Object.fromEntries(
        Object.entries(values as Record<string, unknown>).map(([key, item]) => {
          if (!key.trim() || !isProviderScalar(item)) {
            throw new SupabaseCredentialError("values must contain only supported scalar values.");
          }
          return [key, item];
        }),
      )
    : undefined;
  const identity = body.identity;
  if (
    identity !== undefined &&
    (!identity ||
      typeof identity !== "object" ||
      Array.isArray(identity) ||
      typeof (identity as Record<string, unknown>).column !== "string" ||
      !isProviderScalar((identity as Record<string, unknown>).value))
  ) {
    throw new SupabaseCredentialError("identity must include a column and supported value.");
  }
  const normalizedIdentity = identity as Record<string, unknown> | undefined;
  return {
    operation: body.operation as "insert" | "update" | "delete",
    table: body.table.trim(),
    ...(normalizedValues ? { values: normalizedValues } : {}),
    ...(normalizedIdentity
      ? {
          identity: {
            column: normalizedIdentity.column as string,
            value: normalizedIdentity.value as ProviderScalar,
          },
        }
      : {}),
  };
}

export async function GET(
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
    const resource = parseResource(request);
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
        "Connect a Supabase database before browsing it.",
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
    const store = new PrismaProviderConnectionStore(client);
    const storedConnection = await store.findById(connection.id);
    if (!storedConnection)
      return errorResponse("DATABASE_UNAVAILABLE", "The provider connection is unavailable.", 409);
    const vault = new CredentialVault(createKeyringFromEnvironment());

    const data = await executeAuthorizedProjectAction(
      {
        principal,
        workspaceId: project.workspaceId,
        projectId: project.id,
        permission: "database.read",
        action: `database.${resource.resource}.read`,
        provider: "supabase",
        resourceType: "database",
        resourceId: resource.table,
        requestId: requestId(request),
        rateLimiter: databaseRateLimiter,
        rateLimitKey: `${project.workspaceId}:${session.user.id}`,
        execute: async () => {
          const credentials = vault.decrypt(storedConnection.credential);
          const provider = createSupabaseProvider(credentials);
          lifecycle = new ProviderLifecycle(provider);
          await lifecycle.connect();
          const service = provider.services.database;
          if (!service) {
            throw new ProviderError(
              "capability_unsupported",
              "Database access is not available for this connection.",
              {
                provider: "supabase",
                operation: `database.${resource.resource}.read`,
              },
            );
          }
          if (resource.resource === "tables") return service.listTables();
          if (resource.resource === "columns")
            return service.listColumns?.(resource.table as string) ?? [];
          return service.listRows(resource.table as string, resource.cursor);
        },
      },
      scopeResolver,
      audit,
    );

    return Response.json({ data });
  } catch (error) {
    if (error instanceof AuthConfigurationError)
      return errorResponse(error.code, error.message, 503);
    if (error instanceof SupabaseCredentialError)
      return errorResponse(error.code, error.message, 400);
    if (error instanceof VaultError)
      return errorResponse(error.code, "Credential encryption is not configured.", 503);
    if (error instanceof AuthorizationError || error instanceof ProjectScopeError) {
      return errorResponse("FORBIDDEN", "You are not allowed to read this database.", 403);
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
        error.code === "capability_unsupported" ? 409 : 502,
      );
    }
    throw error;
  } finally {
    await lifecycle?.close();
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
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("INVALID_JSON", "Request body must be valid JSON.", 400);
    }
    const input = parseMutationBody(body);
    if (input.operation === "delete") {
      return errorResponse(
        "CONFIRMATION_REQUIRED",
        "Row deletion requires an explicit confirmation flow and is not enabled from this endpoint yet.",
        409,
      );
    }
    if (input.operation === "update" && !input.identity) {
      return errorResponse("IDENTITY_REQUIRED", "Updates require a stable row identity.", 400);
    }
    if (!input.values || Object.keys(input.values).length === 0) {
      return errorResponse("VALUES_REQUIRED", "At least one value is required.", 400);
    }
    const values = input.values;

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
        "Connect a Supabase database before editing it.",
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
    const store = new PrismaProviderConnectionStore(client);
    const storedConnection = await store.findById(connection.id);
    if (!storedConnection)
      return errorResponse("DATABASE_UNAVAILABLE", "The provider connection is unavailable.", 409);
    const vault = new CredentialVault(createKeyringFromEnvironment());

    const data = await executeAuthorizedProjectAction(
      {
        principal,
        workspaceId: project.workspaceId,
        projectId: project.id,
        permission: "database.write",
        action: `database.row.${input.operation}`,
        provider: "supabase",
        resourceType: "database_row",
        resourceId: input.identity?.column,
        requestId: requestId(request),
        rateLimiter: databaseRateLimiter,
        rateLimitKey: `${project.workspaceId}:${session.user.id}`,
        execute: async () => {
          const credentials = vault.decrypt(storedConnection.credential);
          const provider = createSupabaseProvider(credentials);
          lifecycle = new ProviderLifecycle(provider);
          await lifecycle.connect();
          const service = provider.services.database;
          if (!service) {
            throw new ProviderError(
              "capability_unsupported",
              "Database access is not available for this connection.",
              {
                provider: "supabase",
                operation: `database.row.${input.operation}`,
              },
            );
          }
          if (input.operation === "insert") return service.insertRow?.(input.table, values) ?? null;
          return (
            service.updateRow?.(
              input.table,
              input.identity as NonNullable<typeof input.identity>,
              values,
            ) ?? null
          );
        },
      },
      scopeResolver,
      audit,
    );

    return Response.json({ data }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthConfigurationError)
      return errorResponse(error.code, error.message, 503);
    if (error instanceof SupabaseCredentialError)
      return errorResponse(error.code, error.message, 400);
    if (error instanceof VaultError)
      return errorResponse(error.code, "Credential encryption is not configured.", 503);
    if (error instanceof AuthorizationError || error instanceof ProjectScopeError) {
      return errorResponse("FORBIDDEN", "You are not allowed to write this database.", 403);
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
        error.code === "capability_unsupported" ? 409 : 502,
      );
    }
    throw error;
  } finally {
    await lifecycle?.close();
    await database?.$disconnect();
  }
}
