import { Prisma, PrismaClient } from "@prisma/client";

export { Prisma, PrismaClient };
export { PrismaAuditLogWriter } from "./audit-log-writer";
export { PrismaProviderConnectionStore } from "./provider-connection-store";

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

  return new PrismaClient({
    datasources: {
      db: {
        url: connectionString,
      },
    },
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
