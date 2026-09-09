import type { WorkspaceRole } from "@foundry/types";

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
}
