import { randomUUID } from "node:crypto";
import { AuthConfigurationError, getAuth, type AuthenticatedPrincipal } from "@foundry/auth";
import {
  createDatabaseClient,
  PrismaAuditLogWriter,
  PrismaProviderConnectionStore,
} from "@foundry/database";
import { createKeyringFromEnvironment, CredentialVault, VaultError } from "@foundry/encryption";
import { ProviderConnectionService } from "@foundry/providers-core/connection-service";
import { ProviderError } from "@foundry/providers-core";
import {
  executeAuthorizedProjectAction,
  executeAuthorizedWorkspaceAction,
  FixedWindowRateLimiter,
  ProjectScopeError,
  RateLimitError,
  AuthorizationError,
  WorkspaceScopeError,
} from "@foundry/security";
import { createSupabaseProvider, SupabaseCredentialError } from "@foundry/providers-supabase";

const connectionRateLimiter = new FixedWindowRateLimiter(10, 60_000);

interface SupabaseConnectionRequest {
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly connectionId?: string;
  readonly projectName?: string;
  readonly name: string;
  readonly projectUrl: string;
  readonly serviceRoleKey: string;
  readonly managementApiToken?: string;
  readonly managementApiTokenExpiresAt?: string;
  readonly databaseUrl?: string;
}

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function requestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && supplied.length <= 128 ? supplied : randomUUID();
}

function parseBody(value: unknown): SupabaseConnectionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SupabaseCredentialError("Connection input must be a JSON object.");
  }

  const body = value as Record<string, unknown>;
  const requiredFields = ["workspaceId", "name", "projectUrl", "serviceRoleKey"] as const;
  for (const field of requiredFields) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      throw new SupabaseCredentialError(`${field} is required.`);
    }
  }
  if (
    (body.projectId !== undefined && typeof body.projectId !== "string") ||
    (body.connectionId !== undefined && typeof body.connectionId !== "string") ||
    (body.projectName !== undefined && typeof body.projectName !== "string") ||
    (!body.projectId && typeof body.projectName !== "string")
  ) {
    throw new SupabaseCredentialError(
      "Provide an existing projectId or a projectName for a new project.",
    );
  }

  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : undefined;
  const projectName = typeof body.projectName === "string" ? body.projectName.trim() : undefined;
  if (!projectId && !projectName) {
    throw new SupabaseCredentialError(
      "Provide an existing projectId or a projectName for a new project.",
    );
  }

  for (const field of [
    "managementApiToken",
    "managementApiTokenExpiresAt",
    "databaseUrl",
  ] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      throw new SupabaseCredentialError(`${field} must be a string when provided.`);
    }
  }

  const managementApiToken =
    typeof body.managementApiToken === "string" ? body.managementApiToken.trim() : undefined;
  const expiryInput =
    typeof body.managementApiTokenExpiresAt === "string"
      ? body.managementApiTokenExpiresAt.trim()
      : undefined;
  if (managementApiToken && !expiryInput) {
    throw new SupabaseCredentialError(
      "Set the management API token expiry so Foundry can warn you before it expires.",
    );
  }
  if (expiryInput && !managementApiToken && !body.connectionId) {
    throw new SupabaseCredentialError(
      "The management API token expiry can only be set when a management token is provided.",
    );
  }
  if (expiryInput) {
    const expiry = new Date(expiryInput);
    if (Number.isNaN(expiry.getTime())) {
      throw new SupabaseCredentialError("managementApiTokenExpiresAt must be a valid date.");
    }
    if (expiry.getTime() <= Date.now()) {
      throw new SupabaseCredentialError("The management API token expiry must be in the future.");
    }
  }

  return {
    workspaceId: body.workspaceId as string,
    ...(projectId ? { projectId } : {}),
    ...(typeof body.connectionId === "string" && body.connectionId.trim()
      ? { connectionId: body.connectionId.trim() }
      : {}),
    ...(projectName ? { projectName } : {}),
    name: body.name as string,
    projectUrl: body.projectUrl as string,
    serviceRoleKey: body.serviceRoleKey as string,
    ...(managementApiToken ? { managementApiToken } : {}),
    ...(expiryInput ? { managementApiTokenExpiresAt: new Date(expiryInput).toISOString() } : {}),
    databaseUrl: body.databaseUrl as string | undefined,
  };
}

function projectSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug) {
    throw new SupabaseCredentialError("projectName must contain letters or numbers.");
  }
  return slug;
}

async function sessionFor(request: Request) {
  return getAuth().api.getSession({ headers: request.headers });
}

export async function POST(request: Request): Promise<Response> {
  let database: ReturnType<typeof createDatabaseClient> | undefined;

  try {
    const session = await sessionFor(request);
    if (!session) {
      return errorResponse("UNAUTHENTICATED", "A valid session is required.", 401);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("INVALID_JSON", "Request body must be valid JSON.", 400);
    }

    const input = parseBody(body);
    const client = createDatabaseClient();
    database = client;
    const membership = await client.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: input.workspaceId, userId: session.user.id },
      },
      select: { role: true, workspace: { select: { organizationId: true } } },
    });
    if (!membership) {
      return errorResponse("FORBIDDEN", "You are not a member of this workspace.", 403);
    }

    const principal: AuthenticatedPrincipal = {
      userId: session.user.id,
      organizationId: membership.workspace.organizationId,
      workspaceId: input.workspaceId,
      role: membership.role,
    };
    const scopeResolver = {
      projectBelongsToWorkspace: async (projectId: string, workspaceId: string) => {
        const project = await client.project.findFirst({
          where: { id: projectId, workspaceId },
          select: { id: true },
        });
        return Boolean(project);
      },
    };
    const audit = new PrismaAuditLogWriter(client);
    const actionRequestId = requestId(request);
    let projectId = input.projectId;
    if (!projectId) {
      const project = await executeAuthorizedWorkspaceAction(
        {
          principal,
          workspaceId: input.workspaceId,
          permission: "project.manage",
          action: "project.create",
          resourceType: "project",
          requestId: actionRequestId,
          rateLimiter: connectionRateLimiter,
          rateLimitKey: `${input.workspaceId}:${session.user.id}`,
          execute: () =>
            client.project.create({
              data: {
                workspaceId: input.workspaceId,
                name: input.projectName as string,
                slug: projectSlug(input.projectName as string),
              },
              select: { id: true },
            }),
        },
        audit,
      );
      projectId = project.id;
    }

    const vault = new CredentialVault(createKeyringFromEnvironment());
    const service = new ProviderConnectionService(new PrismaProviderConnectionStore(client), vault);

    if (input.connectionId) {
      const existing = await client.providerConnection.findFirst({
        where: { id: input.connectionId, projectId },
        select: { id: true },
      });
      if (!existing) {
        return errorResponse(
          "NOT_FOUND",
          "The provider connection was not found in this project.",
          404,
        );
      }
    }

    const connection = await executeAuthorizedProjectAction(
      {
        principal,
        workspaceId: input.workspaceId,
        projectId,
        permission: "credentials.manage",
        action: "provider.connection.create",
        provider: "supabase",
        resourceType: "provider_connection",
        requestId: actionRequestId,
        rateLimiter: connectionRateLimiter,
        rateLimitKey: `${input.workspaceId}:${session.user.id}`,
        execute: async () => {
          if (input.connectionId) {
            const updated = await service.update(input.connectionId, {
              name: input.name,
              credentials: {
                projectUrl: input.projectUrl,
                serviceRoleKey: input.serviceRoleKey,
                ...(input.managementApiToken
                  ? { managementApiToken: input.managementApiToken }
                  : {}),
                ...(input.databaseUrl ? { databaseUrl: input.databaseUrl } : {}),
              },
              ...(input.managementApiTokenExpiresAt
                ? { managementApiTokenExpiresAt: input.managementApiTokenExpiresAt }
                : {}),
            });

            return service.checkConnection(updated.id, async ({ credentials }) =>
              createSupabaseProvider(credentials),
            );
          }

          const created = await service.create({
            projectId,
            name: input.name,
            provider: "supabase",
            credentials: {
              projectUrl: input.projectUrl,
              serviceRoleKey: input.serviceRoleKey,
              ...(input.managementApiToken ? { managementApiToken: input.managementApiToken } : {}),
              ...(input.databaseUrl ? { databaseUrl: input.databaseUrl } : {}),
            },
            ...(input.managementApiTokenExpiresAt
              ? { managementApiTokenExpiresAt: input.managementApiTokenExpiresAt }
              : {}),
          });

          return service.checkConnection(created.id, async ({ credentials }) =>
            createSupabaseProvider(credentials),
          );
        },
      },
      scopeResolver,
      audit,
    );

    return Response.json({ data: connection }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return errorResponse(error.code, error.message, 503);
    }
    if (error instanceof SupabaseCredentialError) {
      return errorResponse(error.code, error.message, 400);
    }
    if (error instanceof VaultError) {
      return errorResponse(error.code, "Credential encryption is not configured.", 503);
    }
    if (
      error instanceof AuthorizationError ||
      error instanceof ProjectScopeError ||
      error instanceof WorkspaceScopeError
    ) {
      return errorResponse("FORBIDDEN", "You are not allowed to manage this project.", 403);
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
      return errorResponse(error.code.toUpperCase(), error.message, error.retryable ? 503 : 422);
    }
    throw error;
  } finally {
    await database?.$disconnect();
  }
}
