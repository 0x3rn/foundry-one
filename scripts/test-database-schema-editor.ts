import assert from "node:assert/strict";
import test from "node:test";
import { parseSchemaReference } from "../apps/web/src/lib/database-schema-editor.ts";

test("schema reference parser accepts a qualified PostgreSQL reference", () => {
  assert.deepEqual(parseSchemaReference(" public.accounts.id "), {
    schema: "public",
    table: "accounts",
    column: "id",
  });
});

test("schema reference parser treats blank input as no reference", () => {
  assert.equal(parseSchemaReference("   "), undefined);
});

test("schema reference parser rejects incomplete and unsafe references", () => {
  assert.throws(() => parseSchemaReference("accounts.id"), /schema\.table\.column/);
  assert.throws(
    () => parseSchemaReference("public.accounts.id; DROP TABLE users"),
    /schema\.table\.column/,
  );
});
