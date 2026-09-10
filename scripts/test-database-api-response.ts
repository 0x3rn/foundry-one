import assert from "node:assert/strict";
import test from "node:test";
import { fetchDatabaseApi, parseDatabaseApiResponse } from "../apps/web/src/lib/database-api";

test("database API response parser returns a successful payload", () => {
  assert.deepEqual(parseDatabaseApiResponse(200, JSON.stringify({ data: { tables: 2 } })), {
    tables: 2,
  });
});

test("database API response parser preserves structured server errors", () => {
  assert.throws(
    () =>
      parseDatabaseApiResponse(502, JSON.stringify({ error: { message: "Database unavailable" } })),
    (error: unknown) => error instanceof Error && error.message === "Database unavailable",
  );
});

test("database API response parser gives a safe message for malformed responses", () => {
  assert.throws(
    () => parseDatabaseApiResponse(500, ""),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "The database request failed." &&
      !error.message.includes("password"),
  );
});

test("database API fetcher turns an aborted request into a retryable message", async () => {
  const fetcher = async (_url: string, init?: RequestInit) =>
    await new Promise<never>((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });

  await assert.rejects(
    () => fetchDatabaseApi("/api/database", fetcher, 1),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "The database request timed out. Check the connection and try again.",
  );
});
