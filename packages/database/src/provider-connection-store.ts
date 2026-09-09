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
    return toStoredConnection(record as ProviderConnectionWithCredential);
  }

  async findById(id: string): Promise<StoredProviderConnection | null> {
    const record = await this.database.providerConnection.findUnique({
      where: { id },
      include: { credential: true },
    });
    return record ? toStoredConnection(record as ProviderConnectionWithCredential) : null;
  }

  async findByProjectAndName(
    projectId: string,
    name: string,
  ): Promise<StoredProviderConnection | null> {
    const record = await this.database.providerConnection.findUnique({
      where: { projectId_name: { projectId, name } },
      include: { credential: true },
    });
    return record ? toStoredConnection(record as ProviderConnectionWithCredential) : null;
  }

  async update(
    id: string,
    input: Partial<
      Pick<
        StoredProviderConnection,
        "name" | "status" | "capabilities" | "lastCheckedAt" | "credential"
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
    return toStoredConnection(record as ProviderConnectionWithCredential);
  }

  async delete(id: string): Promise<void> {
    await this.database.providerConnection.delete({ where: { id } });
  }
}
