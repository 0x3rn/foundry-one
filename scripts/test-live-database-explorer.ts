import assert from "node:assert/strict";
import { loadEnvFile } from "node:process";
import {
  createDatabaseClient,
  PrismaProviderConnectionStore,
  PrismaSavedQueryStore,
} from "@foundry/database";
import { createKeyringFromEnvironment, CredentialVault } from "@foundry/encryption";
import { ProviderLifecycle } from "@foundry/providers-core";
import { createSupabaseProvider } from "@foundry/providers-supabase";

loadEnvFile(".env.local");

const database = createDatabaseClient();
let lifecycle: ProviderLifecycle | undefined;
try {
  const project = await database.project.findFirst({
    where: { providerConnections: { some: { provider: "supabase" } } },
    select: {
      id: true,
      workspaceId: true,
      workspace: {
        select: {
          members: {
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { userId: true },
          },
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
  if (!project?.providerConnections[0] || !project.workspace.members[0])
    throw new Error("No Supabase project connection was found.");

  const stored = await new PrismaProviderConnectionStore(database).findById(
    project.providerConnections[0].id,
  );
  if (!stored) throw new Error("The stored provider connection could not be loaded.");

  const credentials = new CredentialVault(createKeyringFromEnvironment()).decrypt(
    stored.credential,
  );
  const provider = createSupabaseProvider(credentials);
  lifecycle = new ProviderLifecycle(provider);
  const connection = await lifecycle.connect();

  const service = provider.services.database;
  if (
    !service?.listTables ||
    !service.describeCatalog ||
    !service.executeQuery ||
    !service.estimateQueryRows
  ) {
    throw new Error(
      "The connected provider does not expose the database explorer and SQL contract.",
    );
  }
  const projectHost = new URL(credentials.projectUrl).hostname;
  const databaseHost = credentials.databaseUrl ? new URL(credentials.databaseUrl).hostname : null;
  if (connection.state === "disconnected") {
    console.log(
      JSON.stringify({
        projectId: project.id,
        connectionState: connection.state,
        reason: connection.reason ?? "unavailable",
        projectHost,
        databaseHost,
        hasManagementApiToken: Boolean(credentials.managementApiToken),
        hasDatabaseUrl: Boolean(credentials.databaseUrl),
      }),
    );
  }
  const tables = await service.listTables();
  const catalog = await service.describeCatalog();
  const sqlResult = await service.executeQuery(
    "SELECT current_schema() AS schema_name, 1 AS health_check;",
    { maxRows: 10 },
  );
  assert.equal(sqlResult.rowCount, 1);
  assert.equal(sqlResult.truncated, false);
  const estimatedRows = await service.estimateQueryRows("SELECT 1;");

  const savedQueryStore = new PrismaSavedQueryStore(database);
  const createdQuery = await savedQueryStore.create({
    workspaceId: project.workspaceId,
    projectId: project.id,
    createdById: project.workspace.members[0].userId,
    name: "Live schema check",
    folder: "Diagnostics",
    sqlText: "SELECT current_schema() AS schema_name;",
  });
  const listedQueries = await savedQueryStore.listByProject(project.workspaceId, project.id);
  assert.ok(
    listedQueries.some((item) => item.id === createdQuery.id && item.folder === "Diagnostics"),
  );
  await savedQueryStore.delete({
    id: createdQuery.id,
    workspaceId: project.workspaceId,
    projectId: project.id,
  });

  console.log(
    JSON.stringify({
      projectId: project.id,
      connectionState: connection.state,
      projectHost,
      databaseHost,
      tables: tables.length,
      views: tables.filter((table) => table.isView && !table.isMaterializedView).length,
      materializedViews: tables.filter((table) => table.isMaterializedView).length,
      schemas: catalog.schemas.length,
      functions: catalog.functions.length,
      extensions: catalog.extensions.length,
      sqlStudioVerified: true,
      sqlDurationMs: sqlResult.durationMs,
      estimatedRows: estimatedRows ?? null,
      savedQueryRoundtrip: "ok",
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.name : "UnknownError",
      message:
        error instanceof Error && error.name === "PostgresError"
          ? "Supabase rejected the saved database connection."
          : "Live database verification failed.",
    }),
  );
  process.exitCode = 1;
} finally {
  await lifecycle?.close();
  await database.$disconnect();
}
