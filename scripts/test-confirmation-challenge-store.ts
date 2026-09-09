import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { ConfirmationChallengeError, PrismaConfirmationChallengeStore } from "@foundry/database";

test("confirmation challenges expire and cannot be replayed", async () => {
  let now = new Date("2026-09-09T13:00:00.000Z");
  const records = new Map<
    string,
    {
      id: string;
      workspaceId: string;
      projectId: string;
      actorUserId: string;
      action: string;
      tokenHash: string;
      expiresAt: Date;
      consumedAt: Date | null;
    }
  >();
  const client = {
    databaseConfirmationChallenge: {
      async create({
        data,
      }: {
        data: Omit<
          typeof records extends Map<string, infer R> ? R : never,
          "id" | "createdAt" | "consumedAt"
        >;
      }) {
        const id = `challenge-${records.size + 1}`;
        records.set(id, { id, ...data, consumedAt: null });
        return { id };
      },
      async findFirst({ where }: { where: Record<string, unknown> }) {
        return [...records.values()].find(
          (record) =>
            record.workspaceId === where.workspaceId &&
            record.projectId === where.projectId &&
            record.actorUserId === where.actorUserId &&
            record.action === where.action &&
            record.tokenHash === where.tokenHash &&
            record.consumedAt === null &&
            record.expiresAt > (where.expiresAt as { gt: Date }).gt,
        );
      },
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: { consumedAt: Date };
      }) {
        const record = records.get(where.id as string);
        if (
          !record ||
          record.consumedAt !== null ||
          record.expiresAt <= (where.expiresAt as { gt: Date }).gt
        ) {
          return { count: 0 };
        }
        record.consumedAt = data.consumedAt;
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  const store = new PrismaConfirmationChallengeStore(client, () => now);
  const input = {
    workspaceId: "workspace-1",
    projectId: "project-1",
    actorUserId: "user-1",
    action: "row.delete",
  };
  const challenge = await store.create(input);
  await store.claim({ ...input, token: challenge.token });
  await assert.rejects(
    () => store.claim({ ...input, token: challenge.token }),
    ConfirmationChallengeError,
  );
  const scoped = await store.create(input);
  await assert.rejects(
    () => store.claim({ ...input, projectId: "project-2", token: scoped.token }),
    ConfirmationChallengeError,
  );
  await assert.rejects(
    () => store.claim({ ...input, actorUserId: "user-2", token: scoped.token }),
    ConfirmationChallengeError,
  );
  await store.claim({ ...input, token: scoped.token });
  now = new Date("2026-09-09T13:06:00.000Z");
  const expired = await store.create(input);
  now = new Date("2026-09-09T13:12:00.000Z");
  await assert.rejects(
    () => store.claim({ ...input, token: expired.token }),
    ConfirmationChallengeError,
  );
});
