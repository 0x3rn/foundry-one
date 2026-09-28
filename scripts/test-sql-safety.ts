import assert from "node:assert/strict";
import test from "node:test";
import { classifySql, SqlValidationError } from "@foundry/security";

test("SQL safety classifies read-only queries", () => {
  const result = classifySql("-- inspect rows\nSELECT * FROM public.orders WHERE id = 7;");
  assert.equal(result.kind, "read_only");
  assert.equal(result.requiresConfirmation, false);
  assert.equal(result.statementCount, 1);
});

test("SQL safety distinguishes scoped mutations from broad mutations", () => {
  assert.equal(classifySql("UPDATE public.orders SET label = 'x' WHERE id = 7").kind, "mutation");
  assert.equal(classifySql("DELETE FROM public.orders WHERE id = 7").requiresConfirmation, false);
  assert.equal(classifySql("DELETE FROM public.orders").kind, "destructive");
  assert.equal(classifySql("UPDATE public.orders SET label = 'x'").requiresConfirmation, true);
});

test("SQL safety holds critical and multi-statement input", () => {
  assert.equal(classifySql("DROP TABLE public.orders").kind, "critical");
  assert.equal(classifySql("SELECT 1; DELETE FROM public.orders WHERE id = 7").statementCount, 2);
  assert.equal(
    classifySql("SELECT 1; DELETE FROM public.orders WHERE id = 7").requiresConfirmation,
    true,
  );
  assert.equal(classifySql("SELECT 'DROP TABLE users'").kind, "read_only");
});

test("SQL safety rejects empty input", () => {
  assert.throws(() => classifySql(" /* only a comment */ "), SqlValidationError);
});
