import assert from "node:assert/strict";
import test from "node:test";
import { CredentialVault, VaultError, createKeyring } from "../packages/encryption/src/index.ts";
import {
  ConnectionNotFoundError,
  ProviderConnectionService,
  type ProviderConnectionStore,
  type StoredProviderConnection,
} from "../packages/providers/core/src/connection-service.ts";
import { permissionMissing as providerPermissionMissing } from "../packages/providers/core/src/index.ts";

function key(fill: number) {
  return new Uint8Array(32).fill(fill);
}

class MemoryConnectionStore implements ProviderConnectionStore {
  readonly records = new Map<string, StoredProviderConnection>();
  private nextId = 1;

  async create(input: Omit<StoredProviderConnection, "id">): Promise<StoredProviderConnection> {
    const record = { id: `connection-${this.nextId++}`, ...input };
    this.records.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<StoredProviderConnection | null> {
    return this.records.get(id) ?? null;
  }

  async findByProjectAndName(
    projectId: string,
    name: string,
  ): Promise<StoredProviderConnection | null> {
    return (
      [...this.records.values()].find(
        (record) => record.projectId === projectId && record.name === name,
      ) ?? null
    );
  }

  async update(
    id: string,
    input: Partial<
      Pick<StoredProviderConnection, "name" | "status" | "lastCheckedAt" | "credential">
    >,
  ): Promise<StoredProviderConnection> {
    const existing = this.records.get(id);
    if (!existing) throw new ConnectionNotFoundError(id);
    const updated = { ...existing, ...input };
    this.records.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

test("AES-256-GCM envelope hides plaintext and rejects tampering", () => {
  const vault = new CredentialVault(createKeyring({ version: 1, key: key(1) }));
  const envelope = vault.encrypt(
    { token: "secret-token" },
    { provider: "supabase", connectionId: "connection-1" },
  );

  assert.equal(envelope.algorithm, "aes-256-gcm");
  assert.equal(envelope.keyVersion, 1);
  assert.ok(!JSON.stringify(envelope).includes("secret-token"));
  assert.deepEqual(vault.decrypt(envelope), { token: "secret-token" });

  const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}A` };
  assert.throws(
    () => vault.decrypt(tampered),
    (error: unknown) => error instanceof VaultError && error.code === "tampered_ciphertext",
  );
});

test("key rotation decrypts old data and re-encrypts with the current version", () => {
  const oldVault = new CredentialVault(createKeyring({ version: 1, key: key(1) }));
  const oldEnvelope = oldVault.encrypt(
    { serviceRoleKey: "old-secret" },
    { provider: "supabase", connectionId: "connection-2" },
  );
  const rotatingVault = new CredentialVault(
    createKeyring({ version: 2, key: key(2) }, [{ version: 1, key: key(1) }]),
  );
  const rotated = rotatingVault.rotate(oldEnvelope);
  const currentVault = new CredentialVault(createKeyring({ version: 2, key: key(2) }));

  assert.equal(rotated.keyVersion, 2);
  assert.notEqual(rotated.ciphertext, oldEnvelope.ciphertext);
  assert.deepEqual(currentVault.decrypt(rotated), { serviceRoleKey: "old-secret" });
  assert.throws(
    () => currentVault.decrypt(oldEnvelope),
    (error: unknown) => error instanceof VaultError && error.code === "key_version_unavailable",
  );
});

test("connection service stores ciphertext and never returns credentials", async () => {
  const store = new MemoryConnectionStore();
  const vault = new CredentialVault(createKeyring({ version: 1, key: key(3) }));
  const service = new ProviderConnectionService(store, vault, () => "2026-09-09T00:00:00.000Z");
  const created = await service.create({
    projectId: "project-1",
    name: "Primary",
    provider: "supabase",
    credentials: { serviceRoleKey: "do-not-return" },
  });
  const stored = store.records.get(created.id);

  assert.equal(created.status, "pending");
  assert.equal("credential" in created, false);
  assert.ok(stored);
  assert.ok(!JSON.stringify(stored?.credential).includes("do-not-return"));

  const duplicate = service.create({
    projectId: "project-1",
    name: "Primary",
    provider: "supabase",
    credentials: { serviceRoleKey: "another" },
  });
  await assert.rejects(duplicate, { code: "invalid_configuration" });

  const healthy = await service.checkConnection(created.id, async ({ credentials }) => {
    assert.deepEqual(credentials, { serviceRoleKey: "do-not-return" });
    return {
      name: "supabase",
      services: {},
      async connect() {
        return { state: "healthy", checkedAt: "2026-09-09T00:00:00.000Z" };
      },
      async disconnect() {},
      async testConnection() {
        return { ok: true };
      },
      async getProjectMetadata() {
        return { id: "project-1", name: "Project", provider: "supabase" };
      },
      async getCapabilities() {
        return {
          projectMetadata: true,
          relationalDatabase: true,
          documentDatabase: false,
          realtimeDatabase: false,
          sql: true,
          auth: false,
          storage: false,
          functions: false,
          logs: false,
          metrics: false,
          security: false,
        };
      },
    };
  });
  assert.equal(healthy.status, "healthy");
  assert.equal(store.records.get(created.id)?.status, "healthy");

  const permissionState = await service.checkConnection(created.id, async () => {
    throw providerPermissionMissing({ provider: "supabase", operation: "test connection" });
  });
  assert.equal(permissionState.status, "permission_missing");

  await service.remove(created.id);
  await assert.rejects(() => service.get(created.id), ConnectionNotFoundError);
});

test("invalid key configuration fails before encryption begins", () => {
  assert.throws(() => createKeyring({ version: 1, key: new Uint8Array(31) }), {
    code: "invalid_key",
  });
});

test("expired management tokens degrade metadata without blocking the provider", async () => {
  const store = new MemoryConnectionStore();
  const vault = new CredentialVault(createKeyring({ version: 1, key: key(4) }));
  const service = new ProviderConnectionService(store, vault, () => "2026-09-10T00:00:00.000Z");
  const connection = await service.create({
    projectId: "project-expiry",
    name: "Primary",
    provider: "supabase",
    credentials: { serviceRoleKey: "service-role" },
    managementApiTokenExpiresAt: "2026-09-09T23:59:59.000Z",
  });

  let providerCalled = false;
  const checked = await service.checkConnection(connection.id, async () => {
    providerCalled = true;
    return {
      name: "supabase",
      services: {},
      async connect() {
        return { state: "degraded", checkedAt: "2026-09-10T00:00:00.000Z" };
      },
      async disconnect() {},
      async testConnection() {
        return { ok: true };
      },
      async getProjectMetadata() {
        return { id: "project-expiry", name: "Project", provider: "supabase" };
      },
      async getCapabilities() {
        return {
          projectMetadata: false,
          relationalDatabase: true,
          documentDatabase: false,
          realtimeDatabase: false,
          sql: true,
          auth: true,
          storage: true,
          functions: false,
          logs: false,
          metrics: false,
          security: false,
        };
      },
    };
  });

  assert.equal(checked.status, "degraded");
  assert.equal(providerCalled, true);
  assert.equal(store.records.get(connection.id)?.status, "degraded");
});
