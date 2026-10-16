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
      if (query.includes("c.relkind IN")) {
        return [
          {
            schema_name: "public",
            table_name: "orders",
            table_type: "BASE TABLE",
            row_count: "50",
          },
        ];
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
      if (query.includes("information_schema.schemata")) {
        return [{ schema_name: "public" }];
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
      if (query.includes("FROM pg_policies")) {
        return [
          {
            policyname: "orders_read",
            cmd: "SELECT",
            roles: ["authenticated"],
            qual: "(tenant_id = auth.uid())",
            with_check: null,
          },
        ];
      }
      if (query.includes("pg_stat_user_tables")) {
        return [
          {
            estimated_row_count: "50",
            live_row_count: "48",
            dead_row_count: "2",
            total_bytes: "8192",
            last_vacuum: "2026-09-10 06:00:00+00",
            last_analyze: null,
          },
        ];
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
    isMaterializedView: false,
    rowCount: 50,
  });
  const queryResult = await provider.services.database?.executeQuery?.(
    "SELECT id, label FROM public.orders",
    { maxRows: 1 },
  );
  assert.deepEqual(queryResult && { ...queryResult, durationMs: 0 }, {
    columns: ["id", "label"],
    rows: [{ id: 1, label: "row-1" }],
    rowCount: 51,
    truncated: true,
    durationMs: 0,
  });
  assert.ok((queryResult?.durationMs ?? -1) >= 0);
  assert.deepEqual(await provider.services.database?.describeCatalog?.(), {
    schemas: [{ name: "public" }],
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
    policies: [
      {
        name: "orders_read",
        command: "SELECT",
        roles: ["authenticated"],
        usingExpression: "(tenant_id = auth.uid())",
      },
    ],
    statistics: {
      estimatedRowCount: 50,
      liveRowCount: 48,
      deadRowCount: 2,
      totalBytes: 8192,
      lastVacuum: "2026-09-10 06:00:00+00",
    },
  });
  await provider.services.database?.createTable?.("public", "invoices", [
    {
      name: "id",
      dataType: "uuid",
      nullable: false,
      isPrimaryKey: true,
      defaultValue: "gen_random_uuid()",
    },
    {
      name: "total",
      dataType: "numeric",
      nullable: false,
      isUnique: true,
      references: { schema: "public", table: "accounts", column: "id" },
    },
  ]);
  await provider.services.database?.addColumn?.("public.orders", {
    name: "notes",
    dataType: "text",
    nullable: true,
  });
  await provider.services.database?.alterColumn?.("public.orders", "notes", {
    dataType: "varchar(120)",
    nullable: false,
    defaultValue: "'n/a'",
  });
  assert.ok(
    executedQueries.some((query) =>
      query.includes(
        'ALTER TABLE "public"."orders" ALTER COLUMN "notes" TYPE varchar(120), ALTER COLUMN "notes" SET NOT NULL, ALTER COLUMN "notes" SET DEFAULT \'n/a\'',
      ),
    ),
  );
  const createdIndex = await provider.services.database?.createIndex?.("public.orders", {
    name: "orders_label_idx",
    column: "label",
    isUnique: false,
  });
  assert.deepEqual(createdIndex, {
    name: "orders_label_idx",
    definition: 'CREATE INDEX "orders_label_idx" ON "public"."orders" ("label")',
    isUnique: false,
    isPrimary: false,
  });
  assert.ok(executedQueries.some((query) => query.includes('CREATE TABLE "public"."invoices"')));
  assert.ok(
    executedQueries.some((query) =>
      query.includes('"total" numeric UNIQUE REFERENCES "public"."accounts" ("id") NOT NULL'),
    ),
  );
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
      provider.services.database?.alterColumn?.("public.orders", "notes", {
        defaultValue: "now(); DROP TABLE users",
      }),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_configuration",
  );
  await assert.rejects(
    () =>
      provider.services.database?.createIndex?.("public.orders", {
        name: "orders_label_idx; DROP TABLE users",
        column: "label",
        isUnique: true,
      }),
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
      provider.services.database?.addColumn?.("public.orders", {
        name: "unsafe_reference",
        dataType: "integer",
        nullable: true,
        references: { schema: "public", table: "accounts; DROP TABLE users", column: "id" },
      }),
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

test("Supabase catalog introspection serializes reads for single-connection clients", async () => {
  let activeQueries = 0;
  const database: SupabaseDatabaseClient = {
    async query(query) {
      assert.equal(activeQueries, 0);
      activeQueries += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (query.includes("information_schema.schemata")) {
          return [{ schema_name: "public" }];
        }
        if (query.includes("FROM pg_proc")) {
          return [
            {
              oid: 7,
              schema_name: "public",
              function_name: "health",
              return_type: "boolean",
              language_name: "sql",
            },
          ];
        }
        if (query.includes("FROM pg_extension")) {
          return [{ extname: "pgcrypto", extversion: "1.3" }];
        }
        throw new Error(`unexpected query: ${query}`);
      } finally {
        activeQueries -= 1;
      }
    },
    async end() {},
  };
  const provider = new SupabaseProvider(
    parseSupabaseCredentials({ ...credentials, databaseUrl: "postgresql://db.example/foundry" }),
    clientFor({}),
    database,
  );

  await assert.doesNotReject(async () => {
    assert.deepEqual(await provider.services.database?.describeCatalog(), {
      schemas: [{ name: "public" }],
      functions: [
        {
          id: "public.health.7",
          schema: "public",
          name: "health",
          returnType: "boolean",
          language: "sql",
        },
      ],
      extensions: [{ name: "pgcrypto", version: "1.3" }],
    });
  });
});

test("Supabase database adapter estimates affected rows and sanitizes query errors without leaking credentials", async () => {
  const database: SupabaseDatabaseClient = {
    async query(query) {
      if (query.startsWith("EXPLAIN (FORMAT JSON)")) {
        return [{ "QUERY PLAN": [{ Plan: { "Plan Rows": 42 } }] } as never];
      }
      if (query.includes("BROKEN")) {
        throw new Error(
          'syntax error near "BROKEN" on postgresql://postgres:supersecret@db.example/foundry',
        );
      }
      return [];
    },
    async end() {},
  };
  const provider = new SupabaseProvider(
    parseSupabaseCredentials({ ...credentials, databaseUrl: "postgresql://db.example/foundry" }),
    clientFor({}),
    database,
  );

  const estimated = await provider.services.database?.estimateQueryRows?.(
    "DELETE FROM public.orders;",
  );
  assert.equal(estimated, 42);
  assert.equal(
    await provider.services.database?.estimateQueryRows?.("SELECT 1; DELETE FROM public.orders;"),
    undefined,
  );

  await assert.rejects(
    async () => {
      await provider.services.database?.executeQuery?.("SELECT BROKEN FROM public.orders");
    },
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /syntax error near "BROKEN"/);
      assert.doesNotMatch(error.message, /supersecret/);
      return true;
    },
  );
});

test("Supabase database adapter captures normalized schema snapshots and operational maintenance telemetry with graceful degradation", async () => {
  let activeQueries = 0;
  const database: SupabaseDatabaseClient = {
    async query(query) {
      assert.equal(activeQueries, 0);
      activeQueries += 1;
      try {
        if (query.includes("information_schema.schemata")) {
          return [{ schema_name: "public" }];
        }
        if (query.includes("FROM pg_proc")) {
          return [
            {
              oid: 10,
              schema_name: "public",
              function_name: "touch_updated_at",
              return_type: "trigger",
              language_name: "plpgsql",
            },
          ];
        }
        if (query.includes("FROM pg_extension")) {
          return [{ extname: "pgcrypto", extversion: "1.3" }];
        }
        if (query.includes("c.relkind IN")) {
          return [
            {
              schema_name: "public",
              table_name: "orders",
              table_type: "BASE TABLE",
              row_count: "100",
            },
          ];
        }
        if (query.includes("information_schema.columns")) {
          return [
            {
              table_schema: "public",
              table_name: "orders",
              column_name: "id",
              data_type: "uuid",
              is_nullable: "NO",
              column_default: "gen_random_uuid()",
              is_identity: "NO",
              is_primary_key: true,
            },
            {
              table_schema: "public",
              table_name: "orders",
              column_name: "customer_id",
              data_type: "uuid",
              is_nullable: "NO",
              column_default: null,
              is_identity: "NO",
              is_primary_key: false,
            },
          ];
        }
        if (query.includes("FROM pg_indexes")) {
          return [
            {
              schemaname: "public",
              tablename: "orders",
              indexname: "orders_pkey",
              indexdef: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
            },
          ];
        }
        if (query.includes("FROM pg_constraint")) {
          return [
            {
              schema_name: "public",
              table_name: "orders",
              name: "orders_pkey",
              contype: "p",
              definition: "PRIMARY KEY (id)",
            },
            {
              schema_name: "public",
              table_name: "orders",
              name: "orders_customer_id_fkey",
              contype: "f",
              definition: "FOREIGN KEY (customer_id) REFERENCES auth.users(id)",
            },
          ];
        }
        if (query.includes("information_schema.referential_constraints")) {
          return [];
        }
        if (query.includes("information_schema.triggers")) {
          return [
            {
              event_object_schema: "public",
              event_object_table: "orders",
              trigger_name: "orders_touch_updated_at",
            },
          ];
        }
        if (query.includes("FROM pg_policies")) {
          return [
            {
              schemaname: "public",
              tablename: "orders",
              policyname: "orders_select_own",
              cmd: "SELECT",
              roles: ["authenticated"],
              qual: "(auth.uid() = customer_id)",
              with_check: null,
            },
          ];
        }
        if (query.includes("COUNT(*)::int AS total_connections")) {
          return [
            {
              total_connections: 12,
              active_connections: 3,
              idle_connections: 8,
              idle_in_transaction_connections: 1,
              waiting_connections: 0,
              max_connections: 100,
            },
          ];
        }
        if (query.includes("FROM pg_stat_activity") && query.includes("query_preview")) {
          return [
            {
              pid: 401,
              username: "postgres",
              application_name: "foundry",
              state: "active",
              wait_event_type: null,
              wait_event: null,
              duration_ms: 2500,
              query_preview: "SELECT * FROM orders WHERE password=supersecret",
            },
          ];
        }
        if (query.includes("FROM pg_locks")) {
          throw new Error("permission denied for pg_locks");
        }
        if (query.includes("FROM pg_stat_user_tables")) {
          return [
            {
              schema_name: "public",
              table_name: "orders",
              table_bytes: 16384,
              index_bytes: 8192,
              total_bytes: 24576,
              estimated_rows: 100,
              live_rows: 100,
              dead_rows: 40,
              seq_scans: 20,
              index_scans: 80,
              last_vacuum: "2026-10-16 01:00:00+00",
              last_autovacuum: null,
              last_analyze: "2026-10-16 01:00:00+00",
              last_autoanalyze: null,
            },
          ];
        }
        if (query.includes("FROM pg_stat_user_indexes")) {
          return [
            {
              schema_name: "public",
              table_name: "orders",
              index_name: "orders_pkey",
              definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
              size_bytes: 8192,
              scans: 80,
              tuples_read: 80,
              tuples_fetched: 80,
              is_unique: true,
              is_primary: true,
            },
          ];
        }
        return [];
      } finally {
        activeQueries -= 1;
      }
    },
    async end() {},
  };

  const provider = new SupabaseProvider(
    parseSupabaseCredentials({ ...credentials, databaseUrl: "postgresql://db.example/foundry" }),
    clientFor({
      "https://api.supabase.com/v1/projects/foundry/database/backups": {
        status: 200,
        body: {
          pitr_enabled: true,
          walg_enabled: true,
          backups: [
            {
              status: "COMPLETED",
              inserted_at: "2026-10-16T00:00:00.000Z",
              is_physical_backup: true,
            },
          ],
        },
      },
    }),
    database,
  );

  const snapshot = await provider.services.database?.captureSchemaSnapshot?.();
  assert.ok(snapshot);
  assert.equal(snapshot.tables.length, 1);
  assert.equal(snapshot.tables[0]?.relations.length, 1);
  assert.equal(snapshot.tables[0]?.relations[0]?.referencedTable, "auth.users");
  assert.equal(snapshot.counts.columns, 2);

  const operations = await provider.services.database?.inspectOperations?.();
  assert.ok(operations);
  assert.equal(operations.connections.totalConnections, 12);
  assert.equal(operations.connections.utilizationPercent, 12);
  assert.equal(operations.longRunningActivities[0]?.queryPreview.includes("supersecret"), false);
  assert.deepEqual(operations.degradedMetrics, ["locks"]);
  assert.equal(operations.backup.status, "available");
  assert.equal(operations.backup.pitrEnabled, true);
  assert.equal(operations.backup.backupCount, 1);
});
