import assert from "node:assert/strict";
import test from "node:test";
import {
  createSupabaseProvider,
  parseSupabaseCredentials,
  SupabaseCredentialError,
  type SupabaseHttpClient,
} from "@foundry/providers-supabase";
import { ProviderError } from "@foundry/providers-core";

function clientFor(
  responses: Readonly<Record<string, { status: number; body?: unknown }>>,
): SupabaseHttpClient {
  return {
    async request(url) {
      const response = responses[url] ?? { status: 404 };
      return {
        status: response.status,
        json: async () => response.body ?? {},
      };
    },
  };
}

const credentials = {
  projectUrl: "https://foundry.supabase.co",
  serviceRoleKey: "service-role-secret",
  managementApiToken: "management-secret",
};

test("Supabase credential parsing rejects unsafe or incomplete input", () => {
  assert.throws(
    () => parseSupabaseCredentials({ projectUrl: "http://foundry.supabase.co" }),
    (error: unknown) => error instanceof SupabaseCredentialError,
  );
  assert.throws(
    () => parseSupabaseCredentials({ projectUrl: "https://foundry.supabase.co" }),
    (error: unknown) => error instanceof SupabaseCredentialError,
  );

  assert.deepEqual(parseSupabaseCredentials(credentials), credentials);
});

test("Supabase adapter reports partial permissions as degraded capabilities", async () => {
  const provider = createSupabaseProvider(
    credentials,
    clientFor({
      "https://foundry.supabase.co/auth/v1/health": { status: 200 },
      "https://foundry.supabase.co/storage/v1/bucket": { status: 403 },
      "https://api.supabase.com/v1/projects/foundry": {
        status: 200,
        body: { name: "Foundry Sandbox", region: "us-east-1" },
      },
    }),
  );

  const connection = await provider.connect();
  assert.equal(connection.state, "degraded");
  assert.equal(provider.services.auth !== undefined, true);
  assert.equal(provider.services.storage !== undefined, true);

  const capabilities = await provider.getCapabilities();
  assert.equal(capabilities.projectMetadata, true);
  assert.equal(capabilities.auth, true);
  assert.equal(capabilities.storage, false);

  assert.deepEqual(await provider.getProjectMetadata(), {
    id: "foundry",
    name: "Foundry Sandbox",
    provider: "supabase",
    region: "us-east-1",
    environment: "production",
  });
});

test("Supabase adapter normalizes auth and storage resources without returning credentials", async () => {
  const provider = createSupabaseProvider(
    { ...credentials, managementApiToken: undefined },
    clientFor({
      "https://foundry.supabase.co/auth/v1/admin/users?page=1": {
        status: 200,
        body: {
          users: [
            {
              id: "user-1",
              email: "person@example.com",
              user_metadata: { name: "Person" },
              created_at: "2026-09-09T00:00:00.000Z",
            },
          ],
        },
      },
      "https://foundry.supabase.co/storage/v1/bucket": {
        status: 200,
        body: [{ id: "bucket-1", name: "uploads" }],
      },
    }),
  );

  const users = await provider.services.auth?.listUsers();
  assert.deepEqual(users?.items[0], {
    id: "user-1",
    email: "person@example.com",
    name: "Person",
    status: "active",
    createdAt: "2026-09-09T00:00:00.000Z",
  });
  assert.deepEqual(await provider.services.storage?.listFiles(), {
    items: [{ id: "bucket-1", name: "uploads", bucket: "default" }],
  });
  assert.equal(
    JSON.stringify(await provider.getProjectMetadata()).includes("service-role-secret"),
    false,
  );
});

test("Supabase adapter normalizes permission and unavailable errors without secret leakage", async () => {
  const provider = createSupabaseProvider(
    credentials,
    clientFor({
      "https://foundry.supabase.co/auth/v1/admin/users?page=1": { status: 403 },
    }),
  );

  await assert.rejects(
    () => provider.services.auth?.listUsers(),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "permission_missing");
      assert.equal(error.message.includes("service-role-secret"), false);
      return true;
    },
  );

  const disconnected = createSupabaseProvider(
    credentials,
    clientFor({
      "https://foundry.supabase.co/auth/v1/health": { status: 503 },
      "https://foundry.supabase.co/storage/v1/bucket": { status: 503 },
      "https://api.supabase.com/v1/projects/foundry": { status: 503 },
    }),
  );
  assert.equal((await disconnected.connect()).state, "disconnected");
});
