import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { nextCookies } from "better-auth/next-js";
import { getDatabaseClient } from "@foundry/database";
import { assertPermission, type Permission } from "@foundry/security";
import type { WorkspaceRole } from "@foundry/types";

export {
  addWorkspaceMember,
  createPrismaWorkspaceRepository,
  createWorkspace,
  WorkspaceInputError,
  type AddWorkspaceMemberInput,
  type CreateWorkspaceInput,
  type ProvisionedWorkspace,
  type WorkspaceMembership,
  type WorkspaceRepository,
} from "./workspace-service";

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
}

export class AuthConfigurationError extends Error {
  readonly code = "AUTH_NOT_CONFIGURED" as const;

  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

export class WorkspaceScopeError extends Error {
  readonly code = "WORKSPACE_SCOPE_MISMATCH" as const;

  constructor() {
    super("The authenticated principal is outside this workspace scope.");
    this.name = "WorkspaceScopeError";
  }
}

export function getAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;

  if (!secret) {
    throw new AuthConfigurationError(
      "BETTER_AUTH_SECRET is required before authentication can be initialized.",
    );
  }

  if (secret.length < 32) {
    throw new AuthConfigurationError("BETTER_AUTH_SECRET must be at least 32 characters.");
  }

  const trustedOrigins = (
    process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "http://localhost:3000,http://localhost:3100"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

  return betterAuth({
    database: prismaAdapter(getDatabaseClient(), {
      provider: "postgresql",
    }),
    emailAndPassword: {
      enabled: true,
    },
    advanced: {
      database: {
        joins: true,
      },
    },
    baseURL,
    plugins: [nextCookies()],
    secret,
    trustedOrigins,
  });
}

export function authorizeWorkspaceAction(
  principal: AuthenticatedPrincipal,
  workspaceId: string,
  permission: Permission,
): void {
  if (principal.workspaceId !== workspaceId) {
    throw new WorkspaceScopeError();
  }

  assertPermission(principal.role, permission);
}
