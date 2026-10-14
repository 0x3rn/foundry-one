import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeSavedQueryTitle,
  parseSavedQueryTitle,
  PrismaSavedQueryStore,
  SavedQueryError,
} from "@foundry/database";
import {
  buildSqlAutocompleteSuggestions,
  groupSavedQueriesByFolder,
  normalizeSqlHistoryRecord,
  parseSqlStudioRequest,
  sanitizeSqlPreview,
  SqlStudioInputError,
  tokenizeSqlForHighlight,
} from "../apps/web/src/lib/sql-studio.ts";

interface FakeSavedQueryRow {
  id: string;
  workspaceId: string;
  projectId: string;
  createdById: string;
  name: string;
  sqlText: string;
  createdAt: Date;
  updatedAt: Date;
}

function createFakeSavedQueryClient() {
  const rows: FakeSavedQueryRow[] = [];
  let seq = 1;
  return {
    savedQuery: {
      async findMany(args: { where: { workspaceId: string; projectId: string } }) {
        return rows
          .filter(
            (row) =>
              row.workspaceId === args.where.workspaceId && row.projectId === args.where.projectId,
          )
          .slice()
          .reverse();
      },
      async findFirst(args: { where: { id: string; workspaceId: string; projectId: string } }) {
        return (
          rows.find(
            (row) =>
              row.id === args.where.id &&
              row.workspaceId === args.where.workspaceId &&
              row.projectId === args.where.projectId,
          ) ?? null
        );
      },
      async create(args: {
        data: {
          workspaceId: string;
          projectId: string;
          createdById: string;
          name: string;
          sqlText: string;
        };
      }) {
        const now = new Date();
        const created: FakeSavedQueryRow = {
          id: `sq_${seq++}`,
          ...args.data,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(created);
        return created;
      },
      async update(args: { where: { id: string }; data: { name?: string; sqlText?: string } }) {
        const found = rows.find((row) => row.id === args.where.id);
        if (!found) throw new Error("Not found");
        if (args.data.name !== undefined) found.name = args.data.name;
        if (args.data.sqlText !== undefined) found.sqlText = args.data.sqlText;
        found.updatedAt = new Date(found.updatedAt.getTime() + 1000);
        return { ...found };
      },
      async deleteMany(args: { where: { id: string; workspaceId: string; projectId: string } }) {
        const index = rows.findIndex(
          (row) =>
            row.id === args.where.id &&
            row.workspaceId === args.where.workspaceId &&
            row.projectId === args.where.projectId,
        );
        if (index === -1) return { count: 0 };
        rows.splice(index, 1);
        return { count: 1 };
      },
    },
  };
}

test("Saved query store persists queries with folder encoding, updates, and project isolation", async () => {
  const store = new PrismaSavedQueryStore(createFakeSavedQueryClient());

  assert.equal(
    encodeSavedQueryTitle("Daily active users", "Analytics"),
    "Analytics / Daily active users",
  );
  assert.deepEqual(parseSavedQueryTitle("Analytics / Daily active users"), {
    folder: "Analytics",
    name: "Daily active users",
  });

  const created = await store.create({
    workspaceId: "ws_1",
    projectId: "proj_1",
    createdById: "user_1",
    name: "Recent orders",
    folder: "Operations",
    sqlText: "SELECT * FROM public.orders LIMIT 25;",
  });

  assert.equal(created.name, "Recent orders");
  assert.equal(created.folder, "Operations");
  assert.equal(created.createdById, "user_1");

  const updated = await store.update({
    id: created.id,
    workspaceId: "ws_1",
    projectId: "proj_1",
    name: "Recent paid orders",
    folder: "Finance",
    sqlText: "SELECT * FROM public.orders WHERE paid = true LIMIT 25;",
  });
  assert.equal(updated.name, "Recent paid orders");
  assert.equal(updated.folder, "Finance");

  const list = await store.listByProject("ws_1", "proj_1");
  assert.equal(list.length, 1);
  assert.equal((await store.listByProject("ws_1", "proj_other")).length, 0);

  await assert.rejects(
    async () => {
      await store.delete({ id: created.id, workspaceId: "ws_1", projectId: "proj_other" });
    },
    (error: unknown) => error instanceof SavedQueryError && error.code === "SAVED_QUERY_NOT_FOUND",
  );

  await store.delete({ id: created.id, workspaceId: "ws_1", projectId: "proj_1" });
  assert.equal((await store.listByProject("ws_1", "proj_1")).length, 0);
});

test("SQL Studio request parser validates operations and bounds", () => {
  const executeReq = parseSqlStudioRequest({
    operation: "execute",
    sql: "SELECT 1;",
    maxRows: 250,
  });
  assert.equal(executeReq.operation, "execute");
  assert.equal(executeReq.maxRows, 250);

  const saveReq = parseSqlStudioRequest({
    operation: "save-query",
    name: "Health check",
    folder: "Diagnostics",
    sqlText: "SELECT 1;",
  });
  assert.equal(saveReq.operation, "save-query");
  assert.equal(saveReq.folder, "Diagnostics");

  assert.throws(
    () => parseSqlStudioRequest({ operation: "execute", sql: "SELECT 1;", maxRows: 5000 }),
    SqlStudioInputError,
  );
  assert.throws(() => parseSqlStudioRequest({ operation: "delete-query" }), SqlStudioInputError);
});

test("SQL Studio sanitizes SQL previews, normalizes history, and builds schema autocomplete", () => {
  const redacted = sanitizeSqlPreview(
    "SELECT 'postgresql://postgres:supersecret@db.example/app', 'Bearer tok_live_1234567890'",
  );
  assert.doesNotMatch(redacted, /supersecret/);
  assert.doesNotMatch(redacted, /tok_live_1234567890/);
  assert.match(redacted, /\[redacted\]/);

  const history = normalizeSqlHistoryRecord({
    id: "aud_1",
    action: "database.sql.execute",
    status: "succeeded",
    createdAt: new Date("2026-10-14T18:00:00.000Z"),
    actorName: "Owner",
    metadata: {
      kind: "read_only",
      statementCount: 1,
      sqlPreview: "SELECT * FROM public.users LIMIT 10;",
      rowCount: 10,
      durationMs: 14,
      truncated: false,
    },
  });
  assert.ok(history);
  assert.equal(history.kind, "read_only");
  assert.equal(history.rowCount, 10);
  assert.equal(history.durationMs, 14);

  const grouped = groupSavedQueriesByFolder([
    { id: "1", name: "B", folder: "Ops" },
    { id: "2", name: "A", folder: "Analytics" },
    { id: "3", name: "C" },
  ]);
  assert.deepEqual(
    grouped.map((group) => group.folder),
    ["Analytics", "Ops", "General"],
  );

  const tokens = tokenizeSqlForHighlight("SELECT id, 'ok' FROM public.users WHERE id = 42 -- note");
  assert.ok(tokens.some((token) => token.type === "keyword" && token.value === "SELECT"));
  assert.ok(tokens.some((token) => token.type === "string" && token.value === "'ok'"));
  assert.ok(tokens.some((token) => token.type === "number" && token.value === "42"));
  assert.ok(tokens.some((token) => token.type === "comment"));

  const suggestions = buildSqlAutocompleteSuggestions({
    prefix: "ord",
    schemas: ["public"],
    tables: [{ id: "public.orders", name: "orders", schema: "public" }],
    columns: [{ name: "order_total", table: "public.orders", dataType: "numeric" }],
  });
  assert.ok(suggestions.some((item) => item.label === "public.orders"));
  assert.ok(suggestions.some((item) => item.label === "order_total"));
});
