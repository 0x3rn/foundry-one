import assert from "node:assert/strict";
import test from "node:test";
import {
  asProviderRecord,
  encodeCsv,
  mapTransferRecordToColumns,
  parseTransferFile,
} from "../apps/web/src/lib/database-transfer.ts";

test("database transfer round-trips quoted CSV cells", () => {
  const csv = encodeCsv(
    ["name", "note"],
    [
      { name: "Ada", note: "hello, world" },
      { name: "Grace", note: "line\nbreak" },
    ],
  );
  assert.deepEqual(parseTransferFile(csv, "csv"), [
    { name: "Ada", note: "hello, world" },
    { name: "Grace", note: "line\nbreak" },
  ]);
});

test("database transfer accepts scalar JSON rows and rejects malformed input", () => {
  const rows = parseTransferFile('[{"id":1,"active":true,"tags":["a","b"]}]', "json");
  assert.deepEqual(asProviderRecord(rows[0] ?? {}), { id: 1, active: true, tags: ["a", "b"] });
  assert.throws(() => parseTransferFile("{not-json}", "json"), /not valid JSON/);
  assert.throws(() => parseTransferFile("a,b\n1", "csv"), /match the header width/);
});

test("transfer mapping types values and omits generated identities/defaults", () => {
  assert.deepEqual(
    mapTransferRecordToColumns(
      [
        { name: "id", dataType: "integer", nullable: false, isIdentity: true },
        { name: "amount", dataType: "numeric", nullable: false, isIdentity: false },
        { name: "active", dataType: "boolean", nullable: false, isIdentity: false },
        {
          name: "created_at",
          dataType: "timestamp with time zone",
          nullable: false,
          isIdentity: false,
          defaultValue: "CURRENT_TIMESTAMP",
        },
      ],
      { id: "7", amount: "12.5", active: "true", created_at: "" },
    ),
    { amount: 12.5, active: true },
  );
});

test("transfer mapping rejects unknown, missing, and invalid typed values", () => {
  const columns = [{ name: "amount", dataType: "numeric", nullable: false, isIdentity: false }];
  assert.throws(() => mapTransferRecordToColumns(columns, { other: "1" }), /does not exist/);
  assert.throws(() => mapTransferRecordToColumns(columns, {}), /required column/);
  assert.throws(
    () => mapTransferRecordToColumns(columns, { amount: "nope" }),
    /must contain a number/,
  );
});
