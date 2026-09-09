import assert from "node:assert/strict";
import test from "node:test";
import {
  addWorkspaceMember,
  createWorkspace,
  WorkspaceInputError,
  type ProvisionedWorkspace,
  type WorkspaceMembership,
  type WorkspaceRepository,
} from "@foundry/auth";

class InMemoryWorkspaceRepository implements WorkspaceRepository {
  readonly provisions: ProvisionedWorkspace[] = [];
  readonly memberships: WorkspaceMembership[] = [];

  async provisionWorkspace(input: {
    organizationName: string;
    organizationSlug: string;
    workspaceName: string;
    workspaceSlug: string;
    ownerUserId: string;
  }): Promise<ProvisionedWorkspace> {
    if (this.provisions.some((item) => item.organizationId === input.organizationSlug)) {
      throw new Error("organization already exists");
    }

    const provisioned = {
      organizationId: input.organizationSlug,
      workspaceId: input.workspaceSlug,
      ownerUserId: input.ownerUserId,
    };

    this.provisions.push(provisioned);
    this.memberships.push({
      workspaceId: provisioned.workspaceId,
      userId: input.ownerUserId,
      role: "owner",
    });
    return provisioned;
  }

  async upsertMembership(input: WorkspaceMembership): Promise<WorkspaceMembership> {
    const existingIndex = this.memberships.findIndex(
      (membership) =>
        membership.workspaceId === input.workspaceId && membership.userId === input.userId,
    );

    if (existingIndex >= 0) {
      this.memberships[existingIndex] = input;
    } else {
      this.memberships.push(input);
    }

    return input;
  }
}

test("workspace creation normalizes names and bootstraps an owner membership", async () => {
  const repository = new InMemoryWorkspaceRepository();
  const workspace = await createWorkspace(repository, " user-1 ", {
    organizationName: " Acme Platform ",
    organizationSlug: "Acme-Platform",
    workspaceName: " Production ",
    workspaceSlug: "production",
  });

  assert.deepEqual(workspace, {
    organizationId: "acme-platform",
    workspaceId: "production",
    ownerUserId: "user-1",
  });
  assert.deepEqual(repository.memberships[0], {
    workspaceId: "production",
    userId: "user-1",
    role: "owner",
  });
});

test("workspace input rejects blank names and unsafe slugs", async () => {
  const repository = new InMemoryWorkspaceRepository();

  await assert.rejects(
    () =>
      createWorkspace(repository, "user-1", {
        organizationName: "",
        organizationSlug: "acme",
        workspaceName: "Production",
        workspaceSlug: "production",
      }),
    (error: unknown) => error instanceof WorkspaceInputError,
  );

  await assert.rejects(
    () =>
      createWorkspace(repository, "user-1", {
        organizationName: "Acme",
        organizationSlug: "acme_platform",
        workspaceName: "Production",
        workspaceSlug: "production",
      }),
    (error: unknown) => error instanceof WorkspaceInputError,
  );
});

test("membership assignment is idempotent and cannot create a second owner", async () => {
  const repository = new InMemoryWorkspaceRepository();
  await createWorkspace(repository, "owner-1", {
    organizationName: "Acme",
    organizationSlug: "acme",
    workspaceName: "Production",
    workspaceSlug: "production",
  });

  await addWorkspaceMember(repository, {
    workspaceId: "production",
    userId: "developer-1",
    role: "developer",
  });
  await addWorkspaceMember(repository, {
    workspaceId: "production",
    userId: "developer-1",
    role: "analyst",
  });

  assert.equal(repository.memberships.length, 2);
  assert.equal(repository.memberships[1]?.role, "analyst");

  await assert.rejects(
    () =>
      addWorkspaceMember(repository, {
        workspaceId: "production",
        userId: "developer-2",
        role: "owner",
      }),
    (error: unknown) => error instanceof WorkspaceInputError,
  );
});
