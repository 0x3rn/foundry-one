import assert from "node:assert/strict";
import test from "node:test";
import { AuthConfigurationError, getAuth } from "@foundry/auth";

test("auth initialization fails clearly when the required secret is missing", () => {
  const previousSecret = process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_SECRET;

  try {
    assert.throws(
      () => getAuth(),
      (error: unknown) => {
        assert.ok(error instanceof AuthConfigurationError);
        assert.equal(error.code, "AUTH_NOT_CONFIGURED");
        return true;
      },
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.BETTER_AUTH_SECRET;
    } else {
      process.env.BETTER_AUTH_SECRET = previousSecret;
    }
  }
});

test("the auth route returns a safe configuration response instead of exposing a stack trace", async () => {
  const previousSecret = process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_SECRET;

  try {
    const route = await import("../apps/web/src/app/api/auth/[...all]/route.ts");
    const response = await route.GET(new Request("http://localhost/api/auth/get-session"));
    const body = (await response.json()) as { error: { code: string; message: string } };

    assert.equal(response.status, 503);
    assert.deepEqual(body.error, {
      code: "AUTH_NOT_CONFIGURED",
      message: "BETTER_AUTH_SECRET is required before authentication can be initialized.",
    });
  } finally {
    if (previousSecret === undefined) {
      delete process.env.BETTER_AUTH_SECRET;
    } else {
      process.env.BETTER_AUTH_SECRET = previousSecret;
    }
  }
});
