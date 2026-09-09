import type { EncryptedEnvelope, CredentialVault } from "@foundry/encryption";
import type { ProviderCapabilities, ProviderConnectionState, ProviderName } from "@foundry/types";
import { ProviderError, ProviderLifecycle, type BackendProvider } from "./index";

export interface StoredProviderConnection {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly provider: ProviderName;
  readonly status: ProviderConnectionState;
  readonly capabilities?: ProviderCapabilities;
  readonly lastCheckedAt?: string;
  readonly credential: EncryptedEnvelope;
}

export interface PublicProviderConnection {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly provider: ProviderName;
  readonly status: ProviderConnectionState;
  readonly capabilities?: ProviderCapabilities;
  readonly lastCheckedAt?: string;
}

export interface ProviderConnectionStore {
  create(input: Omit<StoredProviderConnection, "id">): Promise<StoredProviderConnection>;
  findById(id: string): Promise<StoredProviderConnection | null>;
  findByProjectAndName(projectId: string, name: string): Promise<StoredProviderConnection | null>;
  update(
    id: string,
    input: Partial<
      Pick<
        StoredProviderConnection,
        "name" | "status" | "capabilities" | "lastCheckedAt" | "credential"
      >
    >,
  ): Promise<StoredProviderConnection>;
  delete(id: string): Promise<void>;
}

export interface CreateProviderConnectionInput {
  readonly projectId: string;
  readonly name: string;
  readonly provider: ProviderName;
  readonly credentials: Readonly<Record<string, string>>;
}

export interface UpdateProviderConnectionInput {
  readonly name?: string;
  readonly credentials?: Readonly<Record<string, string>>;
}

export class ConnectionNotFoundError extends Error {
  readonly code = "CONNECTION_NOT_FOUND" as const;

  constructor(connectionId: string) {
    super(`Provider connection ${connectionId} was not found.`);
    this.name = "ConnectionNotFoundError";
  }
}

function toPublicConnection(connection: StoredProviderConnection): PublicProviderConnection {
  return {
    id: connection.id,
    projectId: connection.projectId,
    name: connection.name,
    provider: connection.provider,
    status: connection.status,
    ...(connection.capabilities ? { capabilities: connection.capabilities } : {}),
    ...(connection.lastCheckedAt ? { lastCheckedAt: connection.lastCheckedAt } : {}),
  };
}

export class ProviderConnectionService {
  constructor(
    private readonly store: ProviderConnectionStore,
    private readonly vault: CredentialVault,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async create(input: CreateProviderConnectionInput): Promise<PublicProviderConnection> {
    const name = input.name.trim();
    if (!input.projectId || !name || Object.keys(input.credentials).length === 0) {
      throw new ProviderError(
        "invalid_configuration",
        "A project, connection name, and credentials are required.",
        {
          provider: input.provider,
          operation: "create provider connection",
        },
      );
    }

    const existing = await this.store.findByProjectAndName(input.projectId, name);
    if (existing) {
      throw new ProviderError(
        "invalid_configuration",
        "A connection with this name already exists in the project.",
        {
          provider: input.provider,
          operation: "create provider connection",
        },
      );
    }

    const credential = this.vault.encrypt(input.credentials, {
      provider: input.provider,
      connectionId: `${input.projectId}:${name}`,
    });
    const connection = await this.store.create({
      projectId: input.projectId,
      name,
      provider: input.provider,
      status: "pending",
      credential,
    });
    return toPublicConnection(connection);
  }

  async get(connectionId: string): Promise<PublicProviderConnection> {
    return toPublicConnection(await this.requireStored(connectionId));
  }

  async update(
    connectionId: string,
    input: UpdateProviderConnectionInput,
  ): Promise<PublicProviderConnection> {
    const existing = await this.requireStored(connectionId);
    const name = input.name?.trim();
    if (input.name !== undefined && !name) {
      throw new ProviderError(
        "invalid_configuration",
        "A provider connection name cannot be empty.",
        {
          provider: existing.provider,
          operation: "update provider connection",
        },
      );
    }

    const credential = input.credentials
      ? this.vault.encrypt(input.credentials, {
          provider: existing.provider,
          connectionId: existing.credential.connectionId,
        })
      : undefined;
    const updated = await this.store.update(connectionId, {
      ...(name ? { name } : {}),
      ...(credential ? { credential, status: "pending" } : {}),
    });
    return toPublicConnection(updated);
  }

  async rotate(connectionId: string): Promise<PublicProviderConnection> {
    const existing = await this.requireStored(connectionId);
    const credential = this.vault.rotate(existing.credential);
    const updated = await this.store.update(connectionId, { credential, status: "pending" });
    return toPublicConnection(updated);
  }

  async checkConnection(
    connectionId: string,
    createProvider: (input: {
      readonly provider: ProviderName;
      readonly credentials: Readonly<Record<string, string>>;
    }) => Promise<BackendProvider>,
  ): Promise<PublicProviderConnection> {
    const existing = await this.requireStored(connectionId);
    let lifecycle: ProviderLifecycle | undefined;

    try {
      const credentials = this.vault.decrypt(existing.credential);
      const provider = await createProvider({ provider: existing.provider, credentials });
      lifecycle = new ProviderLifecycle(provider);
      const result = await lifecycle.connect();
      const capabilities = await provider.getCapabilities();
      return toPublicConnection(
        await this.store.update(connectionId, {
          status: result.state,
          capabilities,
          lastCheckedAt: result.checkedAt,
        }),
      );
    } catch (error) {
      const status: ProviderConnectionState =
        error instanceof ProviderError && error.code === "permission_missing"
          ? "permission_missing"
          : error instanceof ProviderError && error.code === "connection_failed"
            ? "degraded"
            : "disconnected";
      const updated = await this.store.update(connectionId, { status, lastCheckedAt: this.now() });
      if (error instanceof ProviderError) {
        return toPublicConnection(updated);
      }
      throw error;
    } finally {
      await lifecycle?.close();
    }
  }

  async remove(connectionId: string): Promise<void> {
    await this.requireStored(connectionId);
    await this.store.delete(connectionId);
  }

  private async requireStored(connectionId: string): Promise<StoredProviderConnection> {
    const connection = await this.store.findById(connectionId);
    if (!connection) {
      throw new ConnectionNotFoundError(connectionId);
    }
    return connection;
  }
}
