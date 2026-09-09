import assert from "node:assert/strict";
import test from "node:test";
import { capabilityIsAvailable, filterItems, paginateItems } from "../packages/ui/src/index.ts";

test("filterItems keeps all rows for empty input and matches case-insensitively", () => {
  const rows = [{ name: "Alpha" }, { name: "Beta" }];

  assert.deepEqual(
    filterItems(rows, "", (row) => row.name),
    rows,
  );
  assert.deepEqual(
    filterItems(rows, "ALP", (row) => row.name),
    [{ name: "Alpha" }],
  );
  assert.deepEqual(
    filterItems(rows, "missing", (row) => row.name),
    [],
  );
});

test("paginateItems clamps oversized pages and preserves totals", () => {
  const result = paginateItems([1, 2, 3], 9, 2);

  assert.deepEqual(result.items, [3]);
  assert.deepEqual(result.state, { page: 2, pageSize: 2, total: 3, pageCount: 2 });
});

test("paginateItems rejects invalid boundaries", () => {
  assert.throws(() => paginateItems([], 0, 10), RangeError);
  assert.throws(() => paginateItems([], 1, 0), RangeError);
});

test("capabilityIsAvailable defaults unsupported features to unavailable", () => {
  assert.equal(capabilityIsAvailable({ database: true }, "database"), true);
  assert.equal(capabilityIsAvailable({}, "security"), false);
});
