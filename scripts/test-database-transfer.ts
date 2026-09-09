import assert from "node:assert/strict";
import test from "node:test";
import {
  asProviderRecord,
  encodeCsv,
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
