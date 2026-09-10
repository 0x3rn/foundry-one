import assert from "node:assert/strict";
import test from "node:test";
import {
  createSupabaseProvider,
  parseSupabaseCredentials,
  SupabaseProvider,
  SupabaseCredentialError,
  type SupabaseDatabaseClient,
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

test("Supabase database adapter introspects safely and paginates rows", async () => {
  const rows = Array.from({ length: 51 }, (_, index) => ({
    id: index + 1,
    label: `row-${index + 1}`,
  }));
  const executedQueries: string[] = [];
  const database: SupabaseDatabaseClient = {
    async query(query) {
      executedQueries.push(query);
      if (query.includes("information_schema.tables")) {
        return [{ schema_name: "public", table_name: "orders", table_type: "BASE TABLE" }];
      }
      if (query.includes("FROM pg_proc")) {
        return [
          {
            oid: 42,
            schema_name: "public",
            function_name: "recalculate_total",
            return_type: "trigger",
            language_name: "plpgsql",
          },
        ];
      }
      if (query.includes("FROM pg_extension")) {
        return [{ extname: "pgcrypto", extversion: "1.3" }];
      }
      if (query.includes("information_schema.columns")) {
        return [
          {
            column_name: "id",
            data_type: "integer",
            is_nullable: "NO",
            column_default: "nextval('orders_id_seq'::regclass)",
            is_identity: "YES",
            is_primary_key: true,
          },
        ];
      }
      if (query.includes("FROM pg_indexes")) {
        return [
          {
            indexname: "orders_pkey",
            indexdef: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
          },
        ];
      }
      if (query.includes("FROM pg_constraint")) {
        return [{ name: "orders_pkey", contype: "p", definition: "PRIMARY KEY (id)" }];
      }
      if (query.includes("information_schema.referential_constraints")) {
        return [];
      }
      if (query.includes("information_schema.triggers")) {
        return [{ trigger_name: "orders_updated_at" }];
      }
      if (query.includes("information_schema.key_column_usage")) {
        return [{ column_name: "id" }];
      }
      if (query.includes("DELETE FROM") && query.includes(" IN (")) {
        return [rows[0], rows[1]];
      }
      if (query.includes("UPDATE") && query.includes(" IN (")) {
        return [rows[0], rows[1]];
      }
      if (query.includes("SELECT 1 AS ok")) return [];
      return rows;
    },
    async end() {},
  };
  const provider = new SupabaseProvider(
    parseSupabaseCredentials({
      ...credentials,
      managementApiToken: undefined,
      databaseUrl: "postgresql://db.example/foundry",
    }),
    clientFor({
      "https://foundry.supabase.co/auth/v1/health": { status: 200 },
      "https://foundry.supabase.co/storage/v1/bucket": { status: 200 },
    }),
    database,
  );

  assert.equal((await provider.connect()).state, "healthy");
  const tables = await provider.services.database?.listTables();
  assert.deepEqual(tables?.[0], {
    id: "public.orders",
    name: "orders",
    schema: "public",
    kind: "table",
    isView: false,
  });
  assert.deepEqual(await provider.services.database?.describeCatalog?.(), {
    functions: [
      {
        id: "public.recalculate_total.42",
        schema: "public",
        name: "recalculate_total",
        returnType: "trigger",
        language: "plpgsql",
      },
    ],
    extensions: [{ name: "pgcrypto", version: "1.3" }],
  });
  assert.deepEqual(await provider.services.database?.listColumns?.("public.orders"), [
    {
      id: "public.orders.id",
      name: "id",
      dataType: "integer",
      nullable: false,
      defaultValue: "nextval('orders_id_seq'::regclass)",
      isPrimaryKey: true,
      isIdentity: true,
    },
  ]);
  assert.deepEqual(await provider.services.database?.describeTable?.("public.orders"), {
    indexes: [
      {
        name: "orders_pkey",
        definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
        isUnique: true,
        isPrimary: true,
      },
    ],
    constraints: [{ name: "orders_pkey", type: "primary_key", definition: "PRIMARY KEY (id)" }],
    relations: [],
    triggers: ["orders_updated_at"],
  });
  await provider.services.database?.createTable?.("public", "invoices", [
    {
      name: "id",
      dataType: "uuid",
      nullable: false,
      isPrimaryKey: true,
      defaultValue: "gen_random_uuid()",
    },
    { name: "total", dataType: "numeric", nullable: false, isUnique: true },
  ]);
  await provider.services.database?.addColumn?.("public.orders", {
    name: "notes",
    dataType: "text",
    nullable: true,
  });
  assert.ok(executedQueries.some((query) => query.includes('CREATE TABLE "public"."invoices"')));
  assert.ok(executedQueries.some((query) => query.includes('"total" numeric UNIQUE NOT NULL')));
  assert.ok(executedQueries.some((query) => query.includes('ALTER TABLE "public"."orders"')));
  await assert.rejects(
    () =>
      provider.services.database?.createTable?.("public", "unsafe", [
        { name: "value", dataType: "money; DROP TABLE users", nullable: true },
      ]),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_configuration",
  );
  await assert.rejects(
    () =>
      provider.services.database?.createTable?.("public", "invalid_unique", [
        { name: "id", dataType: "uuid", nullable: false, isPrimaryKey: true, isUnique: true },
      ]),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_configuration",
  );
  await assert.rejects(
    () =>
      provider.services.database?.createTable?.("public", "unsafe_default", [
        {
          name: "value",
          dataType: "text",
          nullable: false,
          defaultValue: "now(); DROP TABLE users",
        },
      ]),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_configuration",
  );
  await assert.rejects(
    () =>
      provider.services.database?.addColumn?.("public.orders", {
        name: "id2",
        dataType: "uuid",
        nullable: false,
        isPrimaryKey: true,
      }),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_configuration",
  );
  const page = await provider.services.database?.listRows("public.orders");
  assert.equal(page?.items.length, 50);
  assert.equal(page?.nextCursor, "50");
  assert.deepEqual(page?.items[0]?.identity, { column: "id", value: 1 });
  const filtered = await provider.services.database?.listRows("public.orders", {
    search: "row-2",
    sortColumn: "label",
    sortDirection: "desc",
  });
  assert.equal(filtered?.items.length, 50);
  await assert.rejects(
    () =>
      provider.services.database?.listRows("public.orders", { sortDirection: "sideways" as "asc" }),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_configuration",
  );
  const inserted = await provider.services.database?.insertRow?.("public.orders", { label: "new" });
  assert.equal(inserted?.values.label, "row-1");
  const updated = await provider.services.database?.updateRow?.(
    "public.orders",
    { column: "id", value: 1 },
    { label: "updated" },
  );
  assert.equal(updated?.values.id, 1);
  const deleted = await provider.services.database?.deleteRow?.("public.orders", {
    column: "id",
    value: 1,
  });
  assert.equal(deleted?.values.id, 1);
  const bulkDeleted = await provider.services.database?.deleteRows?.("public.orders", [
    { column: "id", value: 2 },
    { column: "id", value: 3 },
  ]);
  assert.equal(bulkDeleted?.length, 2);
  const bulkUpdated = await provider.services.database?.updateRows?.(
    "public.orders",
    [
      { column: "id", value: 2 },
      { column: "id", value: 3 },
    ],
    { label: "bulk-updated" },
  );
  assert.equal(bulkUpdated?.length, 2);
  await assert.rejects(
    () =>
      provider.services.database?.updateRows?.("public.orders", [{ column: "id", value: 2 }], {
        id: 10,
      }),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_configuration",
  );
  await assert.rejects(
    () =>
      provider.services.database?.deleteRows?.("public.orders", [
        { column: "id", value: 2 },
        { column: "other", value: 3 },
      ]),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_configuration",
  );
  await assert.rejects(
    () => provider.services.database?.insertRow?.("public.orders", {}),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_configuration",
  );
  await assert.rejects(
    () => provider.services.database?.listRows("public.orders;DROP TABLE users"),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_configuration",
  );
  await provider.disconnect();
});
