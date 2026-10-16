import { randomUUID } from "node:crypto";
import { AuthConfigurationError, getAuth, type AuthenticatedPrincipal } from "@foundry/auth";
import {
  createDatabaseClient,
  PrismaAuditLogWriter,
  PrismaProviderConnectionStore,
  PrismaSchemaSnapshotStore,
  SchemaSnapshotError,
  type StoredSchemaSnapshotSummary,
} from "@foundry/database";
import { createKeyringFromEnvironment, CredentialVault, VaultError } from "@foundry/encryption";
import {
  buildDatabaseRelationshipGraph,
  diffSchemaSnapshots,
  ProviderError,
  ProviderLifecycle,
  type DatabaseSchemaSnapshot,
} from "@foundry/providers-core";
import { createSupabaseProvider, SupabaseCredentialError } from "@foundry/providers-supabase";
import {
  AuthorizationError,
  executeAuthorizedProjectAction,
  FixedWindowRateLimiter,
  ProjectScopeError,
  RateLimitError,
} from "@foundry/security";
import {
  DatabaseInsightsInputError,
  filterErdGraphBySchema,
  parseDatabaseInsightsMutationBody,
  parseDatabaseInsightsQuery,
} from "@/lib/database-insights";

const insightsRateLimiter = new FixedWindowRateLimiter(60, 60_000);

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
  let lifecycle: ProviderLifecycle | undefined;

  try {
    const session = await getAuth().api.getSession({ headers: request.headers });
    if (!session) return errorResponse("UNAUTHENTICATED", "A valid session is required.", 401);

    const { projectId } = await context.params;
    if (!projectId.trim()) return errorResponse("INVALID_PROJECT", "A project is required.", 400);
    const query = parseDatabaseInsightsQuery(request);

    const client = createDatabaseClient();
    database = client;
    const project = await client.project.findFirst({
      where: {
        id: projectId,
        workspace: { members: { some: { userId: session.user.id } } },
      },
      select: {
        id: true,
        name: true,
        environment: true,
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
        "Connect a Supabase database before inspecting database insights.",
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
    const connectionStore = new PrismaProviderConnectionStore(client);
    const storedConnection = await connectionStore.findById(connection.id);
    if (!storedConnection) {
      return errorResponse("DATABASE_UNAVAILABLE", "The provider connection is unavailable.", 409);
    }
    const snapshotStore = new PrismaSchemaSnapshotStore(client);
    const vault = new CredentialVault(createKeyringFromEnvironment());

    const connectDatabaseService = async () => {
      const credentials = vault.decrypt(storedConnection.credential);
      const provider = createSupabaseProvider(credentials);
      lifecycle = new ProviderLifecycle(provider);
      const connectionState = await lifecycle.connect();
      if (connectionState.state === "disconnected") {
        throw new ProviderError(
          "provider_unavailable",
          "The connected database is currently unavailable.",
          {
            provider: "supabase",
            operation: `database.insights.${query.resource}.read`,
            retryable: true,
          },
        );
      }
      const capabilities = await provider.getCapabilities();
      if (!capabilities.relationalDatabase) {
        throw new ProviderError(
          "provider_unavailable",
          "The connected database is currently unavailable.",
          {
            provider: "supabase",
            operation: `database.insights.${query.resource}.read`,
            retryable: true,
          },
        );
      }
      const service = provider.services.database;
      if (!service || !service.captureSchemaSnapshot || !service.inspectOperations) {
        throw new ProviderError(
          "capability_unsupported",
          "Relational insights are not supported for this connection.",
          {
            provider: "supabase",
            operation: `database.insights.${query.resource}.read`,
          },
        );
      }
      return service;
    };

    const data = await executeAuthorizedProjectAction(
      {
        principal,
        workspaceId: project.workspaceId,
        projectId: project.id,
        permission: "database.read",
        action: `database.insights.${query.resource}.read`,
        provider: "supabase",
        resourceType: "database_insights",
        resourceId: query.sourceSnapshotId ?? query.schema,
        requestId: requestId(request),
        rateLimiter: insightsRateLimiter,
        rateLimitKey: `${project.workspaceId}:${session.user.id}`,
        execute: async () => {
          if (query.resource === "snapshots") {
            const [snapshots, workspaceSnapshots, schedule] = await Promise.all([
              snapshotStore.listByProject(project.workspaceId, project.id),
              snapshotStore.listByWorkspace(project.workspaceId),
              snapshotStore.getSchedule(project.workspaceId, project.id),
            ]);
            return {
              project: {
                id: project.id,
                name: project.name,
                environment: project.environment,
              },
              snapshots,
              workspaceSnapshots,
              schedule,
            };
          }

          if (query.resource === "erd") {
            const service = await connectDatabaseService();
            const liveSnapshot = await service.captureSchemaSnapshot!();
            const erd = filterErdGraphBySchema(
              buildDatabaseRelationshipGraph(liveSnapshot),
              query.schema ?? "all",
            );
            return {
              erd,
              liveSnapshotSummary: {
                capturedAt: liveSnapshot.capturedAt,
                fingerprint: liveSnapshot.fingerprint,
                counts: liveSnapshot.counts,
              },
            };
          }

          if (query.resource === "maintenance") {
            const service = await connectDatabaseService();
            const operations = await service.inspectOperations!();
            return { operations };
          }

          if (query.resource === "diff") {
            const sourceId = query.sourceSnapshotId as string;
            const targetId = query.targetSnapshotId as string;
            let cachedLiveSnapshot: DatabaseSchemaSnapshot | undefined;

            const resolveEndpoint = async (
              endpointId: string,
            ): Promise<{
              readonly summary: StoredSchemaSnapshotSummary;
              readonly snapshot: DatabaseSchemaSnapshot;
            }> => {
              if (endpointId === "live") {
                if (!cachedLiveSnapshot) {
                  const service = await connectDatabaseService();
                  cachedLiveSnapshot = await service.captureSchemaSnapshot!();
                }
                return {
                  summary: {
                    id: "live",
                    workspaceId: project.workspaceId,
                    projectId: project.id,
                    projectName: project.name,
                    environment: project.environment,
                    provider: cachedLiveSnapshot.provider,
                    label: `Live schema (${project.name} · ${project.environment})`,
                    trigger: "manual",
                    fingerprint: cachedLiveSnapshot.fingerprint,
                    counts: cachedLiveSnapshot.counts,
                    capturedAt: cachedLiveSnapshot.capturedAt,
                    createdAt: cachedLiveSnapshot.capturedAt,
                  },
                  snapshot: cachedLiveSnapshot,
                };
              }

              const stored = await snapshotStore.findById(project.workspaceId, endpointId);
              if (!stored) {
                throw new SchemaSnapshotError(
                  "SCHEMA_SNAPSHOT_NOT_FOUND",
                  `Schema snapshot "${endpointId}" was not found in this workspace.`,
                );
              }
              return {
                summary: {
                  id: stored.id,
                  workspaceId: stored.workspaceId,
                  projectId: stored.projectId,
                  projectName: stored.projectName,
                  environment: stored.environment,
                  provider: stored.provider,
                  label: stored.label,
                  trigger: stored.trigger,
                  ...(stored.createdById ? { createdById: stored.createdById } : {}),
                  fingerprint: stored.fingerprint,
                  counts: stored.counts,
                  capturedAt: stored.capturedAt,
                  createdAt: stored.createdAt,
                },
                snapshot: stored.snapshot,
              };
            };

            const source = await resolveEndpoint(sourceId);
            const target = await resolveEndpoint(targetId);
            const diff = diffSchemaSnapshots(source.snapshot, target.snapshot);

            return {
              source: source.summary,
              target: target.summary,
              diff,
            };
          }

          const service = await connectDatabaseService();
          const liveSnapshot = await service.captureSchemaSnapshot!();
          const operations = await service.inspectOperations!();
          const [snapshots, workspaceSnapshots, schedule] = await Promise.all([
            snapshotStore.listByProject(project.workspaceId, project.id),
            snapshotStore.listByWorkspace(project.workspaceId),
            snapshotStore.getSchedule(project.workspaceId, project.id),
          ]);
          const erd = filterErdGraphBySchema(
            buildDatabaseRelationshipGraph(liveSnapshot),
            query.schema ?? "all",
          );

          return {
            project: {
              id: project.id,
              name: project.name,
              environment: project.environment,
            },
            liveSnapshotSummary: {
              capturedAt: liveSnapshot.capturedAt,
              fingerprint: liveSnapshot.fingerprint,
              counts: liveSnapshot.counts,
            },
            erd,
            snapshots,
            workspaceSnapshots,
            schedule,
            operations,
          };
        },
      },
      scopeResolver,
      audit,
    );

    return Response.json({ data });
  } catch (error) {
    if (error instanceof AuthConfigurationError)
      return errorResponse(error.code, error.message, 503);
    if (error instanceof DatabaseInsightsInputError || error instanceof SupabaseCredentialError) {
      return errorResponse(error.code, error.message, 400);
    }
    if (error instanceof SchemaSnapshotError) {
      return errorResponse(
        error.code,
        error.message,
        error.code === "SCHEMA_SNAPSHOT_NOT_FOUND" ? 404 : 400,
      );
    }
    if (error instanceof VaultError)
      return errorResponse(error.code, "Credential encryption is not configured.", 503);
    if (error instanceof AuthorizationError || error instanceof ProjectScopeError) {
      return errorResponse("FORBIDDEN", "You are not allowed to read database insights.", 403);
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
    if (!projectId.trim()) return errorResponse("INVALID_PROJECT", "A project is required.", 400);

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return errorResponse("INVALID_JSON", "Request body must be valid JSON.", 400);
    }
    const input = parseDatabaseInsightsMutationBody(rawBody);

    const client = createDatabaseClient();
    database = client;
    const project = await client.project.findFirst({
      where: {
        id: projectId,
        workspace: { members: { some: { userId: session.user.id } } },
      },
      select: {
        id: true,
        name: true,
        environment: true,
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
        "Connect a Supabase database before managing schema snapshots.",
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
    const connectionStore = new PrismaProviderConnectionStore(client);
    const storedConnection = await connectionStore.findById(connection.id);
    if (!storedConnection) {
      return errorResponse("DATABASE_UNAVAILABLE", "The provider connection is unavailable.", 409);
    }
    const snapshotStore = new PrismaSchemaSnapshotStore(client);
    const vault = new CredentialVault(createKeyringFromEnvironment());

    const captureLiveSnapshot = async (): Promise<DatabaseSchemaSnapshot> => {
      const credentials = vault.decrypt(storedConnection.credential);
      const provider = createSupabaseProvider(credentials);
      lifecycle = new ProviderLifecycle(provider);
      const connectionState = await lifecycle.connect();
      if (connectionState.state === "disconnected") {
        throw new ProviderError(
          "provider_unavailable",
          "The connected database is currently unavailable.",
          {
            provider: "supabase",
            operation: `database.insights.${input.action}`,
            retryable: true,
          },
        );
      }
      const capabilities = await provider.getCapabilities();
      if (!capabilities.relationalDatabase || !provider.services.database?.captureSchemaSnapshot) {
        throw new ProviderError(
          "capability_unsupported",
          "Schema snapshot capture is not available for this connection.",
          {
            provider: "supabase",
            operation: `database.insights.${input.action}`,
          },
        );
      }
      return provider.services.database.captureSchemaSnapshot();
    };

    const data = await executeAuthorizedProjectAction(
      {
        principal,
        workspaceId: project.workspaceId,
        projectId: project.id,
        permission: "database.write",
        action: `database.insights.${input.action}`,
        provider: "supabase",
        resourceType: "database_schema_snapshot",
        resourceId: input.action === "delete-snapshot" ? input.snapshotId : project.id,
        requestId: requestId(request),
        rateLimiter: insightsRateLimiter,
        rateLimitKey: `${project.workspaceId}:${session.user.id}`,
        execute: async () => {
          if (input.action === "capture-snapshot") {
            const snapshot = await captureLiveSnapshot();
            const created = await snapshotStore.create({
              workspaceId: project.workspaceId,
              projectId: project.id,
              projectName: project.name,
              environment: project.environment,
              ...(input.label ? { label: input.label } : {}),
              trigger: "manual",
              createdById: session.user.id,
              snapshot,
            });
            const [snapshots, workspaceSnapshots, schedule] = await Promise.all([
              snapshotStore.listByProject(project.workspaceId, project.id),
              snapshotStore.listByWorkspace(project.workspaceId),
              snapshotStore.getSchedule(project.workspaceId, project.id),
            ]);
            return {
              created: {
                id: created.id,
                workspaceId: created.workspaceId,
                projectId: created.projectId,
                projectName: created.projectName,
                environment: created.environment,
                provider: created.provider,
                label: created.label,
                trigger: created.trigger,
                ...(created.createdById ? { createdById: created.createdById } : {}),
                fingerprint: created.fingerprint,
                counts: created.counts,
                capturedAt: created.capturedAt,
                createdAt: created.createdAt,
              },
              snapshots,
              workspaceSnapshots,
              schedule,
            };
          }

          if (input.action === "delete-snapshot") {
            await snapshotStore.delete({
              id: input.snapshotId,
              workspaceId: project.workspaceId,
              projectId: project.id,
            });
            const [snapshots, workspaceSnapshots] = await Promise.all([
              snapshotStore.listByProject(project.workspaceId, project.id),
              snapshotStore.listByWorkspace(project.workspaceId),
            ]);
            return {
              deletedId: input.snapshotId,
              snapshots,
              workspaceSnapshots,
            };
          }

          if (input.action === "update-schedule") {
            const schedule = await snapshotStore.upsertSchedule({
              workspaceId: project.workspaceId,
              projectId: project.id,
              enabled: input.enabled,
              intervalHours: input.intervalHours,
            });
            return { schedule };
          }

          const currentSchedule = await snapshotStore.getSchedule(project.workspaceId, project.id);
          const snapshot = await captureLiveSnapshot();
          const created = await snapshotStore.create({
            workspaceId: project.workspaceId,
            projectId: project.id,
            projectName: project.name,
            environment: project.environment,
            trigger: "scheduled",
            createdById: session.user.id,
            snapshot,
          });
          const schedule = await snapshotStore.upsertSchedule({
            workspaceId: project.workspaceId,
            projectId: project.id,
            enabled: currentSchedule.enabled,
            intervalHours: currentSchedule.intervalHours,
            lastCapturedAt: created.capturedAt,
          });
          const [snapshots, workspaceSnapshots] = await Promise.all([
            snapshotStore.listByProject(project.workspaceId, project.id),
            snapshotStore.listByWorkspace(project.workspaceId),
          ]);
          return {
            created: {
              id: created.id,
              workspaceId: created.workspaceId,
              projectId: created.projectId,
              projectName: created.projectName,
              environment: created.environment,
              provider: created.provider,
              label: created.label,
              trigger: created.trigger,
              ...(created.createdById ? { createdById: created.createdById } : {}),
              fingerprint: created.fingerprint,
              counts: created.counts,
              capturedAt: created.capturedAt,
              createdAt: created.createdAt,
            },
            schedule,
            snapshots,
            workspaceSnapshots,
          };
        },
      },
      scopeResolver,
      audit,
    );

    return Response.json({ data });
  } catch (error) {
    if (error instanceof AuthConfigurationError)
      return errorResponse(error.code, error.message, 503);
    if (error instanceof DatabaseInsightsInputError || error instanceof SupabaseCredentialError) {
      return errorResponse(error.code, error.message, 400);
    }
    if (error instanceof SchemaSnapshotError) {
      return errorResponse(
        error.code,
        error.message,
        error.code === "SCHEMA_SNAPSHOT_NOT_FOUND" ? 404 : 400,
      );
    }
    if (error instanceof VaultError)
      return errorResponse(error.code, "Credential encryption is not configured.", 503);
    if (error instanceof AuthorizationError || error instanceof ProjectScopeError) {
      return errorResponse("FORBIDDEN", "You are not allowed to modify schema snapshots.", 403);
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
