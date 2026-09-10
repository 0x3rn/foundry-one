import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureUniqueSchemaColumnNames,
  parseSchemaReference,
  prepareSchemaColumnDraft,
} from "../apps/web/src/lib/database-schema-editor.ts";

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

test("schema column drafts normalize constraints and defaults", () => {
  assert.deepEqual(
    prepareSchemaColumnDraft({
      name: " account_id ",
      dataType: "uuid",
      nullable: true,
      isUnique: true,
      defaultValue: "  ",
      reference: "public.accounts.id",
    }),
    {
      name: "account_id",
      dataType: "uuid",
      nullable: true,
      isUnique: true,
      references: { schema: "public", table: "accounts", column: "id" },
    },
  );
});

test("schema column names are unique case-insensitively", () => {
  assert.doesNotThrow(() => ensureUniqueSchemaColumnNames([{ name: "id" }, { name: "label" }]));
  assert.throws(
    () => ensureUniqueSchemaColumnNames([{ name: "id" }, { name: "ID" }]),
    /must be unique/,
  );
});
