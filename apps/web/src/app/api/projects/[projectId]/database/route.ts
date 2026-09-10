import { randomUUID } from "node:crypto";
import { AuthConfigurationError, getAuth, type AuthenticatedPrincipal } from "@foundry/auth";
import {
  ConfirmationChallengeError,
  createDatabaseClient,
  PrismaAuditLogWriter,
  PrismaConfirmationChallengeStore,
  PrismaProviderConnectionStore,
} from "@foundry/database";
import { createKeyringFromEnvironment, CredentialVault, VaultError } from "@foundry/encryption";
import {
  ProviderError,
  ProviderLifecycle,
  type DatabaseColumnDefinition,
  type DatabaseRowQuery,
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
  readonly resource: "tables" | "columns" | "rows" | "details" | "catalog";
  readonly table?: string;
  readonly query?: DatabaseRowQuery;
} {
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource") ?? "tables";
  if (
    resource !== "tables" &&
    resource !== "columns" &&
    resource !== "rows" &&
    resource !== "details" &&
    resource !== "catalog"
  ) {
    throw new SupabaseCredentialError(
      "resource must be tables, columns, rows, details, or catalog.",
    );
  }
  const table = url.searchParams.get("table")?.trim() || undefined;
  if (resource !== "tables" && resource !== "catalog" && !table) {
    throw new SupabaseCredentialError("table is required for column, detail, and row reads.");
  }
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const search = url.searchParams.get("search")?.trim() || undefined;
  const sortColumn = url.searchParams.get("sortColumn")?.trim() || undefined;
  const sortDirection = url.searchParams.get("sortDirection") ?? undefined;
  if (sortDirection && sortDirection !== "asc" && sortDirection !== "desc") {
    throw new SupabaseCredentialError("sortDirection must be asc or desc.");
  }
  const normalizedSortDirection = sortDirection as "asc" | "desc" | undefined;
  return {
    resource,
    ...(table ? { table } : {}),
    ...(cursor || search || sortColumn || sortDirection
      ? {
          query: {
            ...(cursor ? { cursor } : {}),
            ...(search ? { search } : {}),
            ...(sortColumn ? { sortColumn } : {}),
            ...(normalizedSortDirection ? { sortDirection: normalizedSortDirection } : {}),
          },
        }
      : {}),
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

function parseColumnDefinition(value: unknown): DatabaseColumnDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SupabaseCredentialError("A column definition must be an object.");
  }
  const column = value as Record<string, unknown>;
  if (
    typeof column.name !== "string" ||
    typeof column.dataType !== "string" ||
    typeof column.nullable !== "boolean" ||
    (column.isPrimaryKey !== undefined && typeof column.isPrimaryKey !== "boolean") ||
    (column.isUnique !== undefined && typeof column.isUnique !== "boolean") ||
    (column.defaultValue !== undefined && typeof column.defaultValue !== "string")
  ) {
    throw new SupabaseCredentialError(
      "A column needs a name, dataType, nullable flag, and optional primary-key/unique/default values.",
    );
  }
  return {
    name: column.name,
    dataType: column.dataType,
    nullable: column.nullable,
    ...(column.isPrimaryKey !== undefined ? { isPrimaryKey: column.isPrimaryKey } : {}),
    ...(column.isUnique !== undefined ? { isUnique: column.isUnique } : {}),
    ...(column.defaultValue !== undefined ? { defaultValue: column.defaultValue } : {}),
  };
}

function parseMutationBody(value: unknown): {
  readonly operation:
    | "insert"
    | "update"
    | "bulk-update"
    | "delete"
    | "prepare-delete"
    | "bulk-delete"
    | "prepare-bulk-delete"
    | "create-table"
    | "add-column";
  readonly table: string;
  readonly values?: ProviderRecord;
  readonly identity?: { readonly column: string; readonly value: ProviderScalar };
  readonly identities?: readonly {
    readonly column: string;
    readonly value: ProviderScalar;
  }[];
  readonly confirmationToken?: string;
  readonly schema?: string;
  readonly columns?: readonly DatabaseColumnDefinition[];
  readonly column?: DatabaseColumnDefinition;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SupabaseCredentialError("Database mutation input must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  if (
    !(
      [
        "insert",
        "update",
        "bulk-update",
        "delete",
        "prepare-delete",
        "bulk-delete",
        "prepare-bulk-delete",
        "create-table",
        "add-column",
      ] as readonly unknown[]
    ).includes(body.operation)
  ) {
    throw new SupabaseCredentialError(
      "operation must be insert, update, bulk-update, delete, prepare-delete, bulk-delete, prepare-bulk-delete, create-table, or add-column.",
    );
  }
  if (typeof body.table !== "string" || !body.table.trim()) {
    throw new SupabaseCredentialError("table is required.");
  }
  const schema = body.schema;
  if (
    (body.operation === "create-table" && (typeof schema !== "string" || !schema.trim())) ||
    (body.operation === "add-column" && schema !== undefined)
  ) {
    throw new SupabaseCredentialError(
      "create-table requires a schema and add-column does not accept one.",
    );
  }
  const columns =
    body.operation === "create-table"
      ? (() => {
          if (!Array.isArray(body.columns)) {
            throw new SupabaseCredentialError("create-table requires a columns array.");
          }
          return body.columns.map(parseColumnDefinition);
        })()
      : undefined;
  const column = body.operation === "add-column" ? parseColumnDefinition(body.column) : undefined;
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
  const identities = body.identities;
  if (
    identities !== undefined &&
    (!Array.isArray(identities) ||
      identities.length === 0 ||
      identities.length > 50 ||
      identities.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          typeof (item as Record<string, unknown>).column !== "string" ||
          !("value" in (item as Record<string, unknown>)) ||
          !isProviderScalar((item as Record<string, unknown>).value),
      ))
  ) {
    throw new SupabaseCredentialError(
      "identities must contain between 1 and 50 row identities with supported values.",
    );
  }
  const normalizedIdentities = identities as readonly Record<string, unknown>[] | undefined;
  const confirmationToken = body.confirmationToken;
  if (
    confirmationToken !== undefined &&
    (typeof confirmationToken !== "string" || confirmationToken.length > 256)
  ) {
    throw new SupabaseCredentialError("confirmationToken must be a short string when provided.");
  }
  return {
    operation: body.operation as
      | "insert"
      | "update"
      | "bulk-update"
      | "delete"
      | "prepare-delete"
      | "bulk-delete"
      | "prepare-bulk-delete"
      | "create-table"
      | "add-column",
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
    ...(normalizedIdentities
      ? {
          identities: normalizedIdentities.map((item) => ({
            column: item.column as string,
            value: item.value as ProviderScalar,
          })),
        }
      : {}),
    ...(confirmationToken ? { confirmationToken } : {}),
    ...(typeof schema === "string" ? { schema: schema.trim() } : {}),
    ...(columns ? { columns } : {}),
    ...(column ? { column } : {}),
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
          if (resource.resource === "catalog")
            return service.describeCatalog?.() ?? { functions: [], extensions: [] };
          if (resource.resource === "columns")
            return service.listColumns?.(resource.table as string) ?? [];
          if (resource.resource === "details")
            return (
              service.describeTable?.(resource.table as string) ?? {
                indexes: [],
                constraints: [],
                relations: [],
                triggers: [],
              }
            );
          return service.listRows(resource.table as string, resource.query);
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
    if (
      (input.operation === "update" ||
        input.operation === "delete" ||
        input.operation === "prepare-delete") &&
      !input.identity
    ) {
      return errorResponse("IDENTITY_REQUIRED", "Updates require a stable row identity.", 400);
    }
    if (
      (input.operation === "insert" || input.operation === "update") &&
      (!input.values || Object.keys(input.values).length === 0)
    ) {
      return errorResponse("VALUES_REQUIRED", "At least one value is required.", 400);
    }
    if (input.operation === "bulk-update" && (!input.identities || !input.values)) {
      return errorResponse(
        "BULK_UPDATE_INPUT_REQUIRED",
        "Bulk updates require selected row identities and values.",
        400,
      );
    }
    if (input.operation === "delete" && !input.confirmationToken) {
      return errorResponse(
        "CONFIRMATION_REQUIRED",
        "A fresh deletion confirmation is required.",
        409,
      );
    }
    if (
      (input.operation === "bulk-delete" || input.operation === "prepare-bulk-delete") &&
      !input.identities
    ) {
      return errorResponse(
        "IDENTITIES_REQUIRED",
        "Bulk database actions require selected row identities.",
        400,
      );
    }
    if (input.operation === "bulk-delete" && !input.confirmationToken) {
      return errorResponse(
        "CONFIRMATION_REQUIRED",
        "A fresh bulk deletion confirmation is required.",
        409,
      );
    }
    if (input.operation === "create-table" && (!input.schema || !input.columns)) {
      return errorResponse(
        "SCHEMA_REQUIRED",
        "A schema and columns are required to create a table.",
        400,
      );
    }
    if (input.operation === "add-column" && !input.column) {
      return errorResponse("COLUMN_REQUIRED", "A column is required to alter a table.", 400);
    }
    const values = input.values ?? {};

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
    const confirmationStore = new PrismaConfirmationChallengeStore(client);
    const action =
      input.operation === "delete" || input.operation === "bulk-delete"
        ? "row.delete"
        : input.operation === "create-table" || input.operation === "add-column"
          ? `database.schema.${input.operation}`
          : `database.row.${input.operation}`;

    const data = await executeAuthorizedProjectAction(
      {
        principal,
        workspaceId: project.workspaceId,
        projectId: project.id,
        permission: "database.write",
        action,
        ...(input.operation === "delete" || input.operation === "bulk-delete"
          ? {
              expectedConfirmation: {
                action: "row.delete" as const,
                token: input.confirmationToken as string,
              },
              providedConfirmation: {
                action: "row.delete" as const,
                token: input.confirmationToken as string,
              },
            }
          : {}),
        provider: "supabase",
        resourceType:
          input.operation === "create-table" || input.operation === "add-column"
            ? "database_schema"
            : "database_row",
        resourceId: input.identity?.column ?? input.table,
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
          if (input.operation === "prepare-delete" || input.operation === "prepare-bulk-delete") {
            return confirmationStore.create({
              workspaceId: project.workspaceId,
              projectId: project.id,
              actorUserId: session.user.id,
              action: "row.delete",
            });
          }
          if (input.operation === "bulk-delete") {
            if (!service.deleteRows) {
              throw new ProviderError(
                "capability_unsupported",
                "This connection does not support bulk row deletion.",
                { provider: "supabase", operation: "database.row.bulk-delete" },
              );
            }
            await confirmationStore.claim({
              workspaceId: project.workspaceId,
              projectId: project.id,
              actorUserId: session.user.id,
              action: "row.delete",
              token: input.confirmationToken as string,
            });
            return service.deleteRows(
              input.table,
              input.identities as NonNullable<typeof input.identities>,
            );
          }
          if (input.operation === "bulk-update") {
            if (!service.updateRows) {
              throw new ProviderError(
                "capability_unsupported",
                "This connection does not support bulk row updates.",
                { provider: "supabase", operation: "database.row.bulk-update" },
              );
            }
            return service.updateRows(
              input.table,
              input.identities as NonNullable<typeof input.identities>,
              values,
            );
          }
          if (input.operation === "create-table") {
            if (!service.createTable) {
              throw new ProviderError(
                "capability_unsupported",
                "This connection does not support table creation.",
                { provider: "supabase", operation: "database.schema.create-table" },
              );
            }
            return service.createTable(
              input.schema as string,
              input.table,
              input.columns as NonNullable<typeof input.columns>,
            );
          }
          if (input.operation === "add-column") {
            if (!service.addColumn) {
              throw new ProviderError(
                "capability_unsupported",
                "This connection does not support adding columns.",
                { provider: "supabase", operation: "database.schema.add-column" },
              );
            }
            return service.addColumn(input.table, input.column as NonNullable<typeof input.column>);
          }
          if (input.operation === "insert") {
            if (!service.insertRow) {
              throw new ProviderError(
                "capability_unsupported",
                "This connection does not support row inserts.",
                { provider: "supabase", operation: "database.row.insert" },
              );
            }
            return service.insertRow(input.table, values);
          }
          if (input.operation === "delete") {
            if (!service.deleteRow) {
              throw new ProviderError(
                "capability_unsupported",
                "This connection does not support row deletion.",
                { provider: "supabase", operation: "database.row.delete" },
              );
            }
            await confirmationStore.claim({
              workspaceId: project.workspaceId,
              projectId: project.id,
              actorUserId: session.user.id,
              action: "row.delete",
              token: input.confirmationToken as string,
            });
            return service.deleteRow(
              input.table,
              input.identity as NonNullable<typeof input.identity>,
            );
          }
          if (!service.updateRow) {
            throw new ProviderError(
              "capability_unsupported",
              "This connection does not support row updates.",
              { provider: "supabase", operation: "database.row.update" },
            );
          }
          return service.updateRow(
            input.table,
            input.identity as NonNullable<typeof input.identity>,
            values,
          );
        },
      },
      scopeResolver,
      audit,
    );

    return Response.json(
      { data },
      { status: input.operation === "insert" || input.operation === "create-table" ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof AuthConfigurationError)
      return errorResponse(error.code, error.message, 503);
    if (error instanceof SupabaseCredentialError)
      return errorResponse(error.code, error.message, 400);
    if (error instanceof VaultError)
      return errorResponse(error.code, "Credential encryption is not configured.", 503);
    if (error instanceof ConfirmationChallengeError)
      return errorResponse(error.code, error.message, 409);
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
