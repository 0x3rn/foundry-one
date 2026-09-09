import type { PrismaClient } from "@foundry/database";
import type { WorkspaceRole } from "@foundry/types";

export interface CreateWorkspaceInput {
  organizationName: string;
  organizationSlug: string;
  workspaceName: string;
  workspaceSlug: string;
}

export interface ProvisionedWorkspace {
  organizationId: string;
  workspaceId: string;
  ownerUserId: string;
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface AddWorkspaceMemberInput {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface WorkspaceRepository {
  provisionWorkspace(input: {
    organizationName: string;
    organizationSlug: string;
    workspaceName: string;
    workspaceSlug: string;
    ownerUserId: string;
  }): Promise<ProvisionedWorkspace>;
  upsertMembership(input: WorkspaceMembership): Promise<WorkspaceMembership>;
}

export class WorkspaceInputError extends Error {
  readonly code = "INVALID_WORKSPACE_INPUT" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceInputError";
  }
}

function normalizeName(value: string, field: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new WorkspaceInputError(`${field} is required.`);
  }

  if (normalized.length > 80) {
    throw new WorkspaceInputError(`${field} must be 80 characters or fewer.`);
  }

  return normalized;
}

function normalizeSlug(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new WorkspaceInputError(
      `${field} must use lowercase letters, numbers, and single hyphens between words.`,
    );
  }

  if (normalized.length > 63) {
    throw new WorkspaceInputError(`${field} must be 63 characters or fewer.`);
  }

  return normalized;
}

export async function createWorkspace(
  repository: WorkspaceRepository,
  ownerUserId: string,
  input: CreateWorkspaceInput,
): Promise<ProvisionedWorkspace> {
  if (!ownerUserId.trim()) {
    throw new WorkspaceInputError("ownerUserId is required.");
  }

  return repository.provisionWorkspace({
    organizationName: normalizeName(input.organizationName, "organizationName"),
    organizationSlug: normalizeSlug(input.organizationSlug, "organizationSlug"),
    workspaceName: normalizeName(input.workspaceName, "workspaceName"),
    workspaceSlug: normalizeSlug(input.workspaceSlug, "workspaceSlug"),
    ownerUserId: ownerUserId.trim(),
  });
}

export async function addWorkspaceMember(
  repository: WorkspaceRepository,
  input: AddWorkspaceMemberInput,
): Promise<WorkspaceMembership> {
  if (!input.workspaceId.trim() || !input.userId.trim()) {
    throw new WorkspaceInputError("workspaceId and userId are required.");
  }

  if (input.role === "owner") {
    throw new WorkspaceInputError("Owner membership is reserved for workspace creation.");
  }

  return repository.upsertMembership({
    workspaceId: input.workspaceId.trim(),
    userId: input.userId.trim(),
    role: input.role,
  });
}

export function createPrismaWorkspaceRepository(client: PrismaClient): WorkspaceRepository {
  return {
    async provisionWorkspace(input) {
      return client.$transaction(async (transaction) => {
        const organization = await transaction.organization.create({
          data: {
            name: input.organizationName,
            slug: input.organizationSlug,
            members: {
              create: {
                userId: input.ownerUserId,
                role: "owner",
              },
            },
          },
        });

        const workspace = await transaction.workspace.create({
          data: {
            organizationId: organization.id,
            name: input.workspaceName,
            slug: input.workspaceSlug,
            members: {
              create: {
                userId: input.ownerUserId,
                role: "owner",
                joinedAt: new Date(),
              },
            },
          },
        });

        return {
          organizationId: organization.id,
          workspaceId: workspace.id,
          ownerUserId: input.ownerUserId,
        };
      });
    },
    async upsertMembership(input) {
      const membership = await client.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: input.userId,
          },
        },
        create: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          role: input.role,
          joinedAt: new Date(),
        },
        update: {
          role: input.role,
          joinedAt: new Date(),
        },
      });

      return {
        workspaceId: membership.workspaceId,
        userId: membership.userId,
        role: membership.role,
      };
    },
  };
}
