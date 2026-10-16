import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@foundry/database";
import {
  PrismaSchemaSnapshotStore,
  SchemaSnapshotError,
  computeScheduleState,
  normalizeScheduleIntervalHours,
  normalizeSnapshotLabel,
} from "@foundry/database";
import { ScheduledSchemaSnapshotJob } from "../packages/jobs/src/index";
import {
  analyzeDatabaseMaintenance,
  buildDatabaseRelationshipGraph,
  buildSchemaSnapshotFromParts,
  diffSchemaSnapshots,
  extractIndexColumnsFromDefinition,
  normalizeSchemaSnapshot,
  type DatabaseSchemaSnapshot,
} from "@foundry/providers-core";
import {
  DatabaseInsightsInputError,
  filterDiffEntries,
  filterErdGraphBySchema,
  formatBytes,
  formatDurationMs,
  parseDatabaseInsightsMutationBody,
  parseDatabaseInsightsQuery,
} from "../apps/web/src/lib/database-insights";

function createSampleSnapshot(): DatabaseSchemaSnapshot {
  return buildSchemaSnapshotFromParts({
    provider: "supabase",
    capturedAt: "2026-10-16T08:00:00.000Z",
    catalog: {
      schemas: [{ name: "public" }, { name: "audit" }],
      extensions: [
        { name: "pgcrypto", version: "1.3" },
        { name: "uuid-ossp", version: "1.1" },
      ],
      functions: [
        {
          id: "public.touch_updated_at.100",
          schema: "public",
          name: "touch_updated_at",
          returnType: "trigger",
          language: "plpgsql",
        },
      ],
    },
    tables: [
      {
        id: "public.customers",
        schema: "public",
        name: "customers",
        isView: false,
        columns: [
          {
            id: "public.customers.id",
            name: "id",
            dataType: "uuid",
            nullable: false,
            defaultValue: "gen_random_uuid()",
            isPrimaryKey: true,
            isIdentity: false,
          },
          {
            id: "public.customers.email",
            name: "email",
            dataType: "text",
            nullable: false,
            isPrimaryKey: false,
            isIdentity: false,
          },
        ],
        indexes: [
          {
            name: "customers_pkey",
            definition: "CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)",
            isUnique: true,
            isPrimary: true,
          },
          {
            name: "customers_email_key",
            definition:
              "CREATE UNIQUE INDEX customers_email_key ON public.customers USING btree (email)",
            isUnique: true,
            isPrimary: false,
          },
        ],
        constraints: [
          {
            name: "customers_pkey",
            type: "primary_key",
            definition: "PRIMARY KEY (id)",
          },
        ],
        relations: [],
        policies: [
          {
            name: "customers_select_own",
            command: "SELECT",
            roles: ["authenticated", "service_role"],
            usingExpression: "(auth.uid() = id)",
          },
        ],
        triggers: ["customers_touch_updated_at"],
      },
      {
        id: "public.orders",
        schema: "public",
        name: "orders",
        isView: false,
        columns: [
          {
            id: "public.orders.id",
            name: "id",
            dataType: "uuid",
            nullable: false,
            defaultValue: "gen_random_uuid()",
            isPrimaryKey: true,
            isIdentity: false,
          },
          {
            id: "public.orders.customer_id",
            name: "customer_id",
            dataType: "uuid",
            nullable: false,
            isPrimaryKey: false,
            isIdentity: false,
          },
          {
            id: "public.orders.total_cents",
            name: "total_cents",
            dataType: "integer",
            nullable: false,
            defaultValue: "0",
            isPrimaryKey: false,
            isIdentity: false,
          },
        ],
        indexes: [
          {
            name: "orders_pkey",
            definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
            isUnique: true,
            isPrimary: true,
          },
        ],
        constraints: [
          {
            name: "orders_pkey",
            type: "primary_key",
            definition: "PRIMARY KEY (id)",
          },
          {
            name: "orders_customer_id_fkey",
            type: "foreign_key",
            definition: "FOREIGN KEY (customer_id) REFERENCES public.customers(id)",
          },
        ],
        relations: [
          {
            name: "orders_customer_id_fkey",
            columns: ["customer_id"],
            referencedTable: "public.customers",
            referencedColumns: ["id"],
          },
        ],
        policies: [],
        triggers: [],
      },
      {
        id: "audit.events",
        schema: "audit",
        name: "events",
        isView: false,
        columns: [
          {
            id: "audit.events.id",
            name: "id",
            dataType: "bigint",
            nullable: false,
            isPrimaryKey: true,
            isIdentity: true,
          },
        ],
        indexes: [],
        constraints: [],
        relations: [],
        policies: [],
        triggers: [],
      },
    ],
  });
}

test("Normalized schema snapshots produce identical fingerprints and zero false diffs regardless of input ordering", () => {
  const baseline = createSampleSnapshot();
  const reordered = normalizeSchemaSnapshot({
    provider: "supabase",
    capturedAt: "2026-10-16T09:30:00.000Z",
    schemas: [...baseline.schemas].reverse(),
    extensions: [...baseline.extensions].reverse(),
    functions: baseline.functions,
    tables: [...baseline.tables].reverse().map((table) => ({
      ...table,
      columns: [...table.columns].reverse().map((col) => ({
        ...col,
        dataType: `  ${col.dataType.toUpperCase()}  `,
        ...(col.defaultValue ? { defaultValue: `  ${col.defaultValue}  ` } : {}),
      })),
      indexes: [...table.indexes].reverse().map((idx) => ({
        ...idx,
        definition: idx.definition.replace(/\s+/g, "   "),
      })),
      policies: table.policies.map((pol) => ({
        ...pol,
        roles: [...pol.roles].reverse(),
      })),
    })),
  });

  assert.equal(baseline.fingerprint, reordered.fingerprint);
  const diff = diffSchemaSnapshots(baseline, reordered);
  assert.equal(diff.identical, true);
  assert.equal(diff.summary.totalChanges, 0);
  assert.equal(diff.entries.length, 0);
  assert.equal(diff.tableDiffs.length, 0);
});

test("diffSchemaSnapshots accurately identifies additions, removals, and modifications across all catalog object types", () => {
  const staging = createSampleSnapshot();
  const production = buildSchemaSnapshotFromParts({
    provider: "supabase",
    capturedAt: "2026-10-16T10:00:00.000Z",
    catalog: {
      schemas: [{ name: "public" }, { name: "analytics" }],
      extensions: [
        { name: "pgcrypto", version: "1.4" },
        { name: "pg_stat_statements", version: "1.10" },
      ],
      functions: [
        {
          id: "public.touch_updated_at.100",
          schema: "public",
          name: "touch_updated_at",
          returnType: "void",
          language: "sql",
        },
        {
          id: "public.calculate_mrr.101",
          schema: "public",
          name: "calculate_mrr",
          returnType: "numeric",
          language: "sql",
        },
      ],
    },
    tables: [
      {
        ...staging.tables.find((t) => t.id === "public.customers")!,
        columns: [
          {
            id: "public.customers.id",
            name: "id",
            dataType: "uuid",
            nullable: false,
            defaultValue: "gen_random_uuid()",
            isPrimaryKey: true,
            isIdentity: false,
          },
          {
            id: "public.customers.email",
            name: "email",
            dataType: "varchar(320)",
            nullable: true,
            defaultValue: "'pending@example.com'",
            isPrimaryKey: false,
            isIdentity: false,
          },
          {
            id: "public.customers.tier",
            name: "tier",
            dataType: "text",
            nullable: false,
            defaultValue: "'free'",
            isPrimaryKey: false,
            isIdentity: false,
          },
        ],
        policies: [
          {
            name: "customers_select_own",
            command: "ALL",
            roles: ["authenticated"],
            usingExpression: "(auth.uid() = id)",
            checkExpression: "(auth.uid() = id)",
          },
        ],
        triggers: [],
      },
      {
        ...staging.tables.find((t) => t.id === "public.orders")!,
        indexes: [
          ...staging.tables.find((t) => t.id === "public.orders")!.indexes,
          {
            name: "orders_customer_id_idx",
            definition:
              "CREATE INDEX orders_customer_id_idx ON public.orders USING btree (customer_id)",
            isUnique: false,
            isPrimary: false,
          },
        ],
      },
    ],
  });

  const diff = diffSchemaSnapshots(staging, production);
  assert.equal(diff.identical, false);
  assert.ok(diff.summary.addedCount > 0);
  assert.ok(diff.summary.removedCount > 0);
  assert.ok(diff.summary.modifiedCount > 0);

  // Verify specific changes are captured
  assert.ok(
    diff.entries.some(
      (e) => e.category === "schema" && e.target === "analytics" && e.changeType === "added",
    ),
  );
  assert.ok(
    diff.entries.some(
      (e) => e.category === "schema" && e.target === "audit" && e.changeType === "removed",
    ),
  );
  assert.ok(
    diff.entries.some(
      (e) => e.category === "extension" && e.target === "pgcrypto" && e.changeType === "modified",
    ),
  );
  assert.ok(
    diff.entries.some(
      (e) =>
        e.category === "function" &&
        e.target === "public.touch_updated_at" &&
        e.changeType === "modified",
    ),
  );
  assert.ok(
    diff.entries.some(
      (e) => e.category === "table" && e.target === "audit.events" && e.changeType === "removed",
    ),
  );
  assert.ok(
    diff.entries.some(
      (e) =>
        e.category === "column" &&
        e.target === "public.customers.email" &&
        e.changeType === "modified",
    ),
  );
  assert.ok(
    diff.entries.some(
      (e) =>
        e.category === "column" && e.target === "public.customers.tier" && e.changeType === "added",
    ),
  );
  assert.ok(
    diff.entries.some(
      (e) =>
        e.category === "index" &&
        e.target === "public.orders.orders_customer_id_idx" &&
        e.changeType === "added",
    ),
  );
  assert.ok(
    diff.entries.some(
      (e) =>
        e.category === "policy" &&
        e.target === "public.customers.customers_select_own" &&
        e.changeType === "modified",
    ),
  );
  assert.ok(
    diff.entries.some(
      (e) =>
        e.category === "trigger" &&
        e.target === "public.customers.customers_touch_updated_at" &&
        e.changeType === "removed",
    ),
  );

  // Verify filterDiffEntries helper
  const onlyColumns = filterDiffEntries(diff.entries, {
    changeType: "modified",
    category: "column",
    search: "email",
  });
  assert.equal(onlyColumns.length, 1);
  assert.equal(onlyColumns[0]?.target, "public.customers.email");
});

test("buildDatabaseRelationshipGraph constructs ERD nodes, foreign-key edges, and isolated table sets", () => {
  const snapshot = createSampleSnapshot();
  const erd = buildDatabaseRelationshipGraph(snapshot);

  assert.deepEqual(erd.schemas, ["audit", "public"]);
  assert.equal(erd.nodes.length, 3);
  assert.equal(erd.edges.length, 1);
  assert.equal(erd.edges[0]?.sourceTable, "public.orders");
  assert.equal(erd.edges[0]?.targetTable, "public.customers");
  assert.deepEqual(erd.edges[0]?.sourceColumns, ["customer_id"]);
  assert.deepEqual(erd.edges[0]?.targetColumns, ["id"]);
  assert.deepEqual(erd.isolatedTables, ["audit.events"]);

  const ordersNode = erd.nodes.find((n) => n.id === "public.orders");
  const customersNode = erd.nodes.find((n) => n.id === "public.customers");
  assert.equal(ordersNode?.outboundCount, 1);
  assert.equal(ordersNode?.inboundCount, 0);
  assert.equal(customersNode?.inboundCount, 1);
  assert.equal(customersNode?.outboundCount, 0);

  const publicOnly = filterErdGraphBySchema(erd, "public");
  assert.equal(publicOnly.nodes.length, 2);
  assert.equal(publicOnly.edges.length, 1);
});

test("analyzeDatabaseMaintenance produces strictly advisory recommendations for missing FK indexes, duplicates, unused indexes, and bloat", () => {
  assert.deepEqual(
    extractIndexColumnsFromDefinition(
      'CREATE UNIQUE INDEX orders_customer_created_idx ON public.orders USING btree ("customer_id" ASC, created_at DESC)',
    ),
    ["customer_id", "created_at"],
  );

  const snapshot = createSampleSnapshot();
  const recommendations = analyzeDatabaseMaintenance({
    tables: snapshot.tables,
    tableMaintenance: [
      {
        tableId: "public.orders",
        schema: "public",
        table: "orders",
        tableBytes: 16 * 1024 * 1024,
        indexBytes: 4 * 1024 * 1024,
        totalBytes: 20 * 1024 * 1024,
        estimatedRows: 50_000,
        liveRows: 40_000,
        deadRows: 22_000,
        deadRowRatio: 0.355,
        seqScans: 1_500,
        indexScans: 100,
        bloatLevel: "high",
        needsVacuum: true,
        needsAnalyze: true,
      },
    ],
    indexUsage: [
      {
        tableId: "public.orders",
        schema: "public",
        table: "orders",
        indexName: "orders_pkey",
        definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
        columns: ["id"],
        sizeBytes: 1024 * 1024,
        scans: 450,
        tuplesRead: 450,
        tuplesFetched: 450,
        isUnique: true,
        isPrimary: true,
      },
      {
        tableId: "public.orders",
        schema: "public",
        table: "orders",
        indexName: "orders_total_cents_idx",
        definition:
          "CREATE INDEX orders_total_cents_idx ON public.orders USING btree (total_cents)",
        columns: ["total_cents"],
        sizeBytes: 2 * 1024 * 1024,
        scans: 0,
        tuplesRead: 0,
        tuplesFetched: 0,
        isUnique: false,
        isPrimary: false,
      },
      {
        tableId: "public.orders",
        schema: "public",
        table: "orders",
        indexName: "orders_total_cents_dup_idx",
        definition:
          "CREATE INDEX orders_total_cents_dup_idx ON public.orders USING btree (total_cents, id)",
        columns: ["total_cents", "id"],
        sizeBytes: 3 * 1024 * 1024,
        scans: 12,
        tuplesRead: 12,
        tuplesFetched: 12,
        isUnique: false,
        isPrimary: false,
      },
    ],
  });

  const kinds = new Set(recommendations.map((rec) => rec.kind));
  assert.equal(kinds.has("missing_fk_index"), true);
  assert.equal(kinds.has("duplicate_index"), true);
  assert.equal(kinds.has("unused_index"), true);
  assert.equal(kinds.has("high_seq_scan"), true);
  assert.equal(kinds.has("vacuum_recommended"), true);
  assert.equal(kinds.has("analyze_recommended"), true);
  assert.equal(
    recommendations.every((rec) => rec.advisoryOnly === true),
    true,
  );
});

test("PrismaSchemaSnapshotStore and ScheduledSchemaSnapshotJob persist snapshots and schedules with validation", async () => {
  interface MockIntegrationRow {
    id: string;
    workspaceId: string;
    projectId: string | null;
    name: string;
    provider: string;
    status: "active" | "paused" | "disconnected";
    config: unknown;
    createdAt: Date;
    updatedAt: Date;
  }

  const rows: MockIntegrationRow[] = [];
  let counter = 1;

  const mockClient = {
    integration: {
      async create({
        data,
      }: {
        data: {
          workspaceId: string;
          projectId: string;
          name: string;
          provider: string;
          status: "active" | "paused" | "disconnected";
          config: unknown;
        };
      }) {
        const now = new Date("2026-10-16T08:00:00.000Z");
        const created: MockIntegrationRow = {
          id: `snap-${counter++}`,
          workspaceId: data.workspaceId,
          projectId: data.projectId,
          name: data.name,
          provider: data.provider,
          status: data.status,
          config: data.config,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(created);
        return {
          ...created,
          project: {
            id: data.projectId,
            name: data.projectId === "proj-prod" ? "Foundry Prod" : "Foundry Staging",
            environment: data.projectId === "proj-prod" ? "production" : "staging",
          },
        };
      },
      async findMany({
        where,
      }: {
        where: { workspaceId: string; projectId?: string; provider: string };
      }) {
        return rows
          .filter(
            (r) =>
              r.workspaceId === where.workspaceId &&
              r.provider === where.provider &&
              (where.projectId === undefined || r.projectId === where.projectId),
          )
          .map((r) => ({
            ...r,
            project: {
              id: r.projectId ?? "",
              name: r.projectId === "proj-prod" ? "Foundry Prod" : "Foundry Staging",
              environment:
                r.projectId === "proj-prod" ? ("production" as const) : ("staging" as const),
            },
          }));
      },
      async findFirst({ where }: { where: { id: string; workspaceId: string; provider: string } }) {
        const match = rows.find(
          (r) =>
            r.id === where.id &&
            r.workspaceId === where.workspaceId &&
            r.provider === where.provider,
        );
        if (!match) return null;
        return {
          ...match,
          project: {
            id: match.projectId ?? "",
            name: match.projectId === "proj-prod" ? "Foundry Prod" : "Foundry Staging",
            environment:
              match.projectId === "proj-prod" ? ("production" as const) : ("staging" as const),
          },
        };
      },
      async deleteMany({
        where,
      }: {
        where: { id: string; workspaceId: string; projectId: string; provider: string };
      }) {
        const index = rows.findIndex(
          (r) =>
            r.id === where.id &&
            r.workspaceId === where.workspaceId &&
            r.projectId === where.projectId &&
            r.provider === where.provider,
        );
        if (index === -1) return { count: 0 };
        rows.splice(index, 1);
        return { count: 1 };
      },
      async findUnique({
        where,
      }: {
        where: { workspaceId_name: { workspaceId: string; name: string } };
      }) {
        return (
          rows.find(
            (r) =>
              r.workspaceId === where.workspaceId_name.workspaceId &&
              r.name === where.workspaceId_name.name,
          ) ?? null
        );
      },
      async upsert({
        where,
        update,
        create,
      }: {
        where: { workspaceId_name: { workspaceId: string; name: string } };
        update: Partial<MockIntegrationRow>;
        create: Omit<MockIntegrationRow, "id" | "createdAt" | "updatedAt">;
      }) {
        const existing = rows.find(
          (r) =>
            r.workspaceId === where.workspaceId_name.workspaceId &&
            r.name === where.workspaceId_name.name,
        );
        const now = new Date("2026-10-16T08:05:00.000Z");
        if (existing) {
          Object.assign(existing, update, { updatedAt: now });
          return existing;
        }
        const created: MockIntegrationRow = {
          id: `sched-${counter++}`,
          ...create,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(created);
        return created;
      },
    },
  } as unknown as PrismaClient;

  const store = new PrismaSchemaSnapshotStore(mockClient);
  const sample = createSampleSnapshot();

  const createdStaging = await store.create({
    workspaceId: "ws-1",
    projectId: "proj-staging",
    projectName: "Foundry Staging",
    environment: "staging",
    label: "Staging v1",
    snapshot: sample,
  });
  assert.equal(createdStaging.label, "Staging v1");
  assert.equal(createdStaging.environment, "staging");

  const createdProd = await store.create({
    workspaceId: "ws-1",
    projectId: "proj-prod",
    projectName: "Foundry Prod",
    environment: "production",
    label: "Prod v1",
    snapshot: sample,
  });
  assert.equal(createdProd.environment, "production");

  const projectSnapshots = await store.listByProject("ws-1", "proj-staging");
  assert.equal(projectSnapshots.length, 1);
  const workspaceSnapshots = await store.listByWorkspace("ws-1");
  assert.equal(workspaceSnapshots.length, 2);

  // Test ScheduledSchemaSnapshotJob
  const job = new ScheduledSchemaSnapshotJob({
    store,
    captureSnapshot: async () => sample,
  });

  const disabledRun = await job.execute({
    workspaceId: "ws-1",
    projectId: "proj-staging",
    now: new Date("2026-10-16T09:00:00.000Z"),
  });
  assert.equal(disabledRun.executed, false);
  assert.equal(disabledRun.reason, "schedule_disabled");

  await store.upsertSchedule(
    {
      workspaceId: "ws-1",
      projectId: "proj-staging",
      enabled: true,
      intervalHours: 6,
    },
    new Date("2026-10-16T09:00:00.000Z"),
  );

  const dueRun = await job.execute({
    workspaceId: "ws-1",
    projectId: "proj-staging",
    now: new Date("2026-10-16T09:00:00.000Z"),
  });
  assert.equal(dueRun.executed, true);
  assert.equal(dueRun.reason, "captured");

  const notDueRun = await job.execute({
    workspaceId: "ws-1",
    projectId: "proj-staging",
    now: new Date("2026-10-16T10:00:00.000Z"),
  });
  assert.equal(notDueRun.executed, false);
  assert.equal(notDueRun.reason, "not_due");

  // Delete and verify 404 boundary
  await store.delete({
    id: createdStaging.id,
    workspaceId: "ws-1",
    projectId: "proj-staging",
  });
  await assert.rejects(
    () =>
      store.delete({
        id: createdStaging.id,
        workspaceId: "ws-1",
        projectId: "proj-staging",
      }),
    (error: unknown) =>
      error instanceof SchemaSnapshotError && error.code === "SCHEMA_SNAPSHOT_NOT_FOUND",
  );
});

test("Database insights input validators and helpers reject invalid inputs and format metrics cleanly", () => {
  assert.throws(
    () => normalizeSnapshotLabel("bad\u0000label", "manual", "2026-10-16T08:00:00.000Z"),
    (error: unknown) => error instanceof SchemaSnapshotError,
  );
  assert.throws(
    () => normalizeScheduleIntervalHours(0),
    (error: unknown) => error instanceof SchemaSnapshotError,
  );
  assert.throws(
    () =>
      parseDatabaseInsightsQuery(
        new Request("https://foundry.local/api/projects/p1/database/insights?resource=diff"),
      ),
    (error: unknown) => error instanceof DatabaseInsightsInputError,
  );
  assert.throws(
    () =>
      parseDatabaseInsightsMutationBody({
        action: "update-schedule",
        enabled: true,
        intervalHours: 999,
      }),
    (error: unknown) => error instanceof DatabaseInsightsInputError,
  );

  const scheduleDue = computeScheduleState(
    {
      workspaceId: "ws-1",
      projectId: "p-1",
      enabled: true,
      intervalHours: 12,
      lastCapturedAt: "2026-10-15T00:00:00.000Z",
    },
    new Date("2026-10-16T00:00:00.000Z"),
  );
  assert.equal(scheduleDue.isDue, true);

  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatDurationMs(1500), "1.5 s");
});
