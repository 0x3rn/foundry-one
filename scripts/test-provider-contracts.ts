import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderError,
  ProviderRegistry,
  permissionMissing,
  requireCapability,
  type BackendProvider,
  type ProviderFactoryContext,
} from "../packages/providers/core/src/index.ts";
import type { ProviderCapabilities } from "../packages/types/src/index.ts";

const capabilities: ProviderCapabilities = {
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

const context: ProviderFactoryContext = {
  connectionId: "connection-test",
  projectId: "project-test",
  credentials: { token: "test-only" },
};

function createMockProvider(): BackendProvider {
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
      return { id: "project-test", name: "Foundry Test", provider: "supabase" };
    },
    async getCapabilities() {
      return capabilities;
    },
  };
}

test("a partial provider can satisfy the normalized contract", async () => {
  const provider = createMockProvider();
  const metadata = await provider.getProjectMetadata();

  assert.equal(metadata.provider, "supabase");
  assert.equal((await provider.getCapabilities()).documentDatabase, false);
  assert.deepEqual(provider.services, {});
});

test("registry creates a provider and lifecycle closes it exactly once", async () => {
  let disconnects = 0;
  const provider = createMockProvider();
  provider.disconnect = async () => {
    disconnects += 1;
  };

  const registry = new ProviderRegistry();
  registry.register({ name: "supabase", create: async () => provider });
  const lifecycle = await registry.create("supabase", context);

  assert.deepEqual(registry.list(), ["supabase"]);
  assert.equal(lifecycle.status, "created");
  await lifecycle.connect();
  assert.equal(lifecycle.status, "connected");
  await lifecycle.close();
  await lifecycle.close();
  assert.equal(lifecycle.status, "closed");
  assert.equal(disconnects, 1);
});

test("capability and permission failures are standardized", () => {
  assert.doesNotThrow(() =>
    requireCapability(capabilities, "relationalDatabase", {
      provider: "supabase",
      operation: "list tables",
    }),
  );

  assert.throws(
    () =>
      requireCapability(capabilities, "documentDatabase", {
        provider: "supabase",
        operation: "list collections",
      }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "capability_unsupported" && !error.retryable,
  );

  const error = permissionMissing({ provider: "supabase", operation: "read auth users" });
  assert.equal(error.code, "permission_missing");
  assert.match(error.message, /permission/);
});

test("registry rejects duplicate, unknown, mismatched, and closed providers", async () => {
  const registry = new ProviderRegistry();
  registry.register({ name: "supabase", create: async () => createMockProvider() });

  assert.throws(
    () => registry.register({ name: "supabase", create: async () => createMockProvider() }),
    {
      code: "invalid_configuration",
    },
  );
  await assert.rejects(() => registry.create("firebase", context), {
    code: "provider_not_registered",
  });

  const mismatch = new ProviderRegistry();
  mismatch.register({
    name: "supabase",
    create: async () => ({ ...createMockProvider(), name: "firebase" }),
  });
  await assert.rejects(() => mismatch.create("supabase", context), {
    code: "invalid_configuration",
  });

  const lifecycle = await registry.create("supabase", context);
  await lifecycle.close();
  await assert.rejects(() => lifecycle.connect(), { code: "provider_unavailable" });
});
