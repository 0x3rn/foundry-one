import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorizationError,
  allKnownPermissions,
  assertPermission,
  hasPermission,
} from "@foundry/security";
import {
  authorizeWorkspaceAction,
  WorkspaceScopeError,
  type AuthenticatedPrincipal,
} from "@foundry/auth";

const owner: AuthenticatedPrincipal = {
  userId: "user-owner",
  organizationId: "org-1",
  workspaceId: "workspace-1",
  role: "owner",
};

test("owner and admin roles can perform every known permission", () => {
  for (const role of ["owner", "admin"] as const) {
    for (const permission of allKnownPermissions()) {
      assert.equal(hasPermission(role, permission), true, `${role} should allow ${permission}`);
    }
  }
});

test("developer can operate product resources but cannot manage credentials or destructive actions", () => {
  assert.equal(hasPermission("developer", "sql.execute"), true);
  assert.equal(hasPermission("developer", "database.write"), true);
  assert.equal(hasPermission("developer", "credentials.manage"), false);
  assert.equal(hasPermission("developer", "destructive.execute"), false);
  assert.equal(hasPermission("developer", "member.manage"), false);
});

test("analyst and viewer roles are read-oriented", () => {
  assert.equal(hasPermission("analyst", "audit.read"), true);
  assert.equal(hasPermission("analyst", "database.write"), false);
  assert.equal(hasPermission("viewer", "database.read"), true);
  assert.equal(hasPermission("viewer", "database.write"), false);
  assert.equal(hasPermission("viewer", "sql.execute"), false);
});

test("forbidden permissions fail with a structured authorization error", () => {
  assert.throws(
    () => assertPermission("viewer", "credentials.manage"),
    (error: unknown) => {
      assert.ok(error instanceof AuthorizationError);
      assert.equal(error.code, "FORBIDDEN");
      assert.equal(error.role, "viewer");
      assert.equal(error.permission, "credentials.manage");
      return true;
    },
  );
});

test("workspace authorization checks scope before role permissions", () => {
  authorizeWorkspaceAction(owner, "workspace-1", "destructive.execute");

  assert.throws(
    () => authorizeWorkspaceAction(owner, "workspace-2", "workspace.view"),
    (error: unknown) => error instanceof WorkspaceScopeError,
  );
});
