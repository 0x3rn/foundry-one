import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";

export { Prisma, PrismaClient };
export { PrismaAuditLogWriter } from "./audit-log-writer";
export {
  PrismaConfirmationChallengeStore,
  ConfirmationChallengeError,
} from "./confirmation-challenge-store";
export { PrismaProviderConnectionStore } from "./provider-connection-store";
export {
  PrismaSavedQueryStore,
  SavedQueryError,
  encodeSavedQueryTitle,
  parseSavedQueryTitle,
  type CreateSavedQueryInput,
  type DeleteSavedQueryInput,
  type StoredSavedQuery,
  type UpdateSavedQueryInput,
} from "./saved-query-store";
export {
  PrismaSchemaSnapshotStore,
  SchemaSnapshotError,
  computeScheduleState,
  normalizeScheduleIntervalHours,
  normalizeSnapshotLabel,
  type CreateSchemaSnapshotInput,
  type DeleteSchemaSnapshotInput,
  type ProjectEnvironmentName,
  type SchemaSnapshotTrigger,
  type StoredSchemaSnapshot,
  type StoredSchemaSnapshotSchedule,
  type StoredSchemaSnapshotSummary,
  type UpsertSchemaSnapshotScheduleInput,
} from "./schema-snapshot-store";

export class DatabaseConfigurationError extends Error {
  readonly code = "DATABASE_NOT_CONFIGURED" as const;

  constructor() {
    super("DATABASE_URL is required before the database client can be created.");
    this.name = "DatabaseConfigurationError";
  }
}

export function createDatabaseClient(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) {
    throw new DatabaseConfigurationError();
  }

  const adapter = new PrismaPg({ connectionString });

  return new PrismaClient({
    adapter,
  });
}

const globalForFoundry = globalThis as typeof globalThis & {
  foundryDatabaseClient?: PrismaClient;
};

export function getDatabaseClient(): PrismaClient {
  if (!globalForFoundry.foundryDatabaseClient) {
    globalForFoundry.foundryDatabaseClient = createDatabaseClient();
  }

  return globalForFoundry.foundryDatabaseClient;
}
