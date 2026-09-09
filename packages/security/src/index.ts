import type { WorkspaceRole } from "@foundry/types";

export type Permission =
  | "workspace.view"
  | "workspace.manage"
  | "member.view"
  | "member.manage"
  | "project.view"
  | "project.manage"
  | "database.read"
  | "database.write"
  | "sql.execute"
  | "auth.read"
  | "auth.manage"
  | "storage.read"
  | "storage.write"
  | "functions.read"
  | "functions.manage"
  | "credentials.manage"
  | "security.read"
  | "security.manage"
  | "analytics.read"
  | "audit.read"
  | "destructive.execute";

const allPermissions: readonly Permission[] = [
  "workspace.view",
  "workspace.manage",
  "member.view",
  "member.manage",
  "project.view",
  "project.manage",
  "database.read",
  "database.write",
  "sql.execute",
  "auth.read",
  "auth.manage",
  "storage.read",
  "storage.write",
  "functions.read",
  "functions.manage",
  "credentials.manage",
  "security.read",
  "security.manage",
  "analytics.read",
  "audit.read",
  "destructive.execute",
];

const rolePermissions: Record<WorkspaceRole, readonly Permission[]> = {
  owner: allPermissions,
  admin: allPermissions,
  developer: [
    "workspace.view",
    "project.view",
    "project.manage",
    "database.read",
    "database.write",
    "sql.execute",
    "auth.read",
    "auth.manage",
    "storage.read",
    "storage.write",
    "functions.read",
    "functions.manage",
    "security.read",
    "analytics.read",
  ],
  analyst: [
    "workspace.view",
    "project.view",
    "database.read",
    "auth.read",
    "storage.read",
    "functions.read",
    "security.read",
    "analytics.read",
    "audit.read",
  ],
  viewer: [
    "workspace.view",
    "project.view",
    "database.read",
    "auth.read",
    "storage.read",
    "functions.read",
    "security.read",
    "analytics.read",
  ],
};

export class AuthorizationError extends Error {
  readonly code = "FORBIDDEN" as const;

  constructor(
    readonly role: WorkspaceRole,
    readonly permission: Permission,
  ) {
    super(`Role ${role} does not have permission ${permission}.`);
    this.name = "AuthorizationError";
  }
}

export function permissionsForRole(role: WorkspaceRole): readonly Permission[] {
  return rolePermissions[role];
}

export function hasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return rolePermissions[role].includes(permission);
}

export function assertPermission(role: WorkspaceRole, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new AuthorizationError(role, permission);
  }
}

export function allKnownPermissions(): readonly Permission[] {
  return allPermissions;
}
