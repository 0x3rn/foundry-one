import { Prisma, type PrismaClient } from "@prisma/client";
import type { EncryptedEnvelope } from "@foundry/encryption";
import type {
  ProviderConnectionStore,
  StoredProviderConnection,
} from "@foundry/providers-core/connection-service";
import type { ProviderCapabilities, ProviderConnectionState, ProviderName } from "@foundry/types";

type ProviderConnectionWithCredential = Awaited<
  ReturnType<PrismaClient["providerConnection"]["findUnique"]>
> & {
  credential: {
    provider: ProviderName;
    connectionId: string;
    algorithm: string;
    keyVersion: number;
    iv: string;
    authTag: string;
    ciphertext: string;
    managementApiTokenExpiresAt: Date | null;
  } | null;
  capabilities: unknown;
};

function toStoredConnection(record: ProviderConnectionWithCredential): StoredProviderConnection {
  if (!record.credential) {
    throw new Error(`Provider connection ${record.id} has no credential envelope.`);
  }

  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    provider: record.provider as ProviderName,
    status: record.status as ProviderConnectionState,
    ...(record.capabilities
      ? { capabilities: record.capabilities as unknown as ProviderCapabilities }
      : {}),
    ...(record.lastCheckedAt ? { lastCheckedAt: record.lastCheckedAt.toISOString() } : {}),
    ...(record.credential.managementApiTokenExpiresAt
      ? { managementApiTokenExpiresAt: record.credential.managementApiTokenExpiresAt.toISOString() }
      : {}),
    credential: {
      algorithm: record.credential.algorithm as EncryptedEnvelope["algorithm"],
      keyVersion: record.credential.keyVersion,
      iv: record.credential.iv,
      authTag: record.credential.authTag,
      ciphertext: record.credential.ciphertext,
      provider: record.credential.provider,
      connectionId: record.credential.connectionId,
    },
  };
}

async function managementTokenExpiry(
  database: PrismaClient,
  connectionId: string,
): Promise<string | undefined> {
  const rows = await database.$queryRaw<Array<{ expiresAt: Date | null }>>(
    Prisma.sql`
      SELECT "managementApiTokenExpiresAt" AS "expiresAt"
      FROM "Credential"
      WHERE "providerConnectionId" = ${connectionId}
    `,
  );
  return rows[0]?.expiresAt?.toISOString();
}

function withManagementTokenExpiry(
  connection: StoredProviderConnection,
  expiresAt: string | undefined,
): StoredProviderConnection {
  return expiresAt ? { ...connection, managementApiTokenExpiresAt: expiresAt } : connection;
}

export class PrismaProviderConnectionStore implements ProviderConnectionStore {
  constructor(private readonly database: PrismaClient) {}

  async create(input: Omit<StoredProviderConnection, "id">): Promise<StoredProviderConnection> {
    const record = await this.database.providerConnection.create({
      data: {
        projectId: input.projectId,
        name: input.name,
        provider: input.provider,
        status: input.status,
        capabilities: input.capabilities
          ? (input.capabilities as unknown as Prisma.InputJsonValue)
          : undefined,
        lastCheckedAt: input.lastCheckedAt ? new Date(input.lastCheckedAt) : undefined,
        credential: {
          create: {
            provider: input.credential.provider as ProviderName,
            connectionId: input.credential.connectionId,
            algorithm: input.credential.algorithm,
            keyVersion: input.credential.keyVersion,
            iv: input.credential.iv,
            authTag: input.credential.authTag,
            ciphertext: input.credential.ciphertext,
          },
        },
      },
      include: { credential: true },
    });
    if (input.managementApiTokenExpiresAt) {
      await this.database.$executeRaw(
        Prisma.sql`UPDATE "Credential" SET "managementApiTokenExpiresAt" = ${new Date(input.managementApiTokenExpiresAt)} WHERE "providerConnectionId" = ${record.id}`,
      );
    }
    return withManagementTokenExpiry(
      toStoredConnection(record as ProviderConnectionWithCredential),
      await managementTokenExpiry(this.database, record.id),
    );
  }

  async findById(id: string): Promise<StoredProviderConnection | null> {
    const record = await this.database.providerConnection.findUnique({
      where: { id },
      include: { credential: true },
    });
    return record
      ? withManagementTokenExpiry(
          toStoredConnection(record as ProviderConnectionWithCredential),
          await managementTokenExpiry(this.database, record.id),
        )
      : null;
  }

  async findByProjectAndName(
    projectId: string,
    name: string,
  ): Promise<StoredProviderConnection | null> {
    const record = await this.database.providerConnection.findUnique({
      where: { projectId_name: { projectId, name } },
      include: { credential: true },
    });
    return record
      ? withManagementTokenExpiry(
          toStoredConnection(record as ProviderConnectionWithCredential),
          await managementTokenExpiry(this.database, record.id),
        )
      : null;
  }

  async update(
    id: string,
    input: Partial<
      Pick<
        StoredProviderConnection,
        | "name"
        | "status"
        | "capabilities"
        | "lastCheckedAt"
        | "managementApiTokenExpiresAt"
        | "credential"
      >
    >,
  ): Promise<StoredProviderConnection> {
    const record = await this.database.providerConnection.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.capabilities !== undefined
          ? {
              capabilities: input.capabilities
                ? (input.capabilities as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            }
          : {}),
        ...(input.lastCheckedAt !== undefined
          ? { lastCheckedAt: new Date(input.lastCheckedAt) }
          : {}),
        ...(input.credential
          ? {
              credential: {
                update: {
                  provider: input.credential.provider as ProviderName,
                  connectionId: input.credential.connectionId,
                  algorithm: input.credential.algorithm,
                  keyVersion: input.credential.keyVersion,
                  iv: input.credential.iv,
                  authTag: input.credential.authTag,
                  ciphertext: input.credential.ciphertext,
                },
              },
            }
          : {}),
      },
      include: { credential: true },
    });
    if (input.managementApiTokenExpiresAt !== undefined) {
      await this.database.$executeRaw(
        Prisma.sql`UPDATE "Credential" SET "managementApiTokenExpiresAt" = ${input.managementApiTokenExpiresAt ? new Date(input.managementApiTokenExpiresAt) : null} WHERE "providerConnectionId" = ${record.id}`,
      );
    }
    return withManagementTokenExpiry(
      toStoredConnection(record as ProviderConnectionWithCredential),
      await managementTokenExpiry(this.database, record.id),
    );
  }

  async delete(id: string): Promise<void> {
    await this.database.providerConnection.delete({ where: { id } });
  }
}
