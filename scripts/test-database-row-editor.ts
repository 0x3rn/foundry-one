import assert from "node:assert/strict";
import test from "node:test";
import { duplicateRowValues, prepareRowInputValues } from "../apps/web/src/lib/database-row-editor";

const columns = [
  { name: "id", dataType: "integer", nullable: false, defaultValue: "identity", isIdentity: true },
  { name: "title", dataType: "text", nullable: false, isIdentity: false },
  { name: "count", dataType: "integer", nullable: false, isIdentity: false },
  { name: "published", dataType: "boolean", nullable: true, isIdentity: false },
  { name: "note", dataType: "text", nullable: true, isIdentity: false },
  {
    name: "created_at",
    dataType: "timestamp with time zone",
    nullable: false,
    defaultValue: "now()",
    isIdentity: false,
  },
] as const;

test("row editor prepares typed values and omits identity/default columns", () => {
  assert.deepEqual(
    prepareRowInputValues(columns, {
      id: "999",
      title: "  Foundry  ",
      count: "4",
      published: "true",
      note: "",
      created_at: "",
    }),
    { title: "Foundry", count: 4, published: true, note: null },
  );
});

test("row editor rejects invalid and incomplete input", () => {
  assert.throws(
    () => prepareRowInputValues(columns, { title: "", count: "2" }),
    /title is required/,
  );
  assert.throws(
    () => prepareRowInputValues(columns, { title: "Foundry", count: "not-a-number" }),
    /count must be a number/,
  );
  assert.throws(
    () => prepareRowInputValues(columns, { title: "Foundry", count: "2", published: "yes" }),
    /published must be true or false/,
  );
  assert.throws(
    () =>
      prepareRowInputValues(
        [
          {
            name: "generated",
            dataType: "text",
            nullable: false,
            defaultValue: "now()",
            isIdentity: false,
          },
        ],
        { generated: "" },
      ),
    /Enter at least one row value/,
  );
});

test("row duplication preserves values but never copies the identity", () => {
  assert.deepEqual(
    duplicateRowValues(columns, {
      id: 12,
      title: "Existing",
      count: 2,
      published: false,
      note: null,
    }),
    {
      title: "Existing",
      count: 2,
      published: false,
      note: null,
    },
  );
});
