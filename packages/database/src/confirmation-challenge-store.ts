import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface CreateConfirmationChallengeInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly actorUserId: string;
  readonly action: string;
}

export interface ConfirmationChallengeToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export class ConfirmationChallengeError extends Error {
  readonly code = "INVALID_CONFIRMATION" as const;

  constructor() {
    super("The confirmation is invalid, expired, or has already been used.");
    this.name = "ConfirmationChallengeError";
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class PrismaConfirmationChallengeStore {
  constructor(
    private readonly client: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreateConfirmationChallengeInput): Promise<ConfirmationChallengeToken> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + CHALLENGE_TTL_MS);
    await this.client.databaseConfirmationChallenge.create({
      data: {
        ...input,
        tokenHash: hashToken(token),
        expiresAt,
      },
    });
    return { token, expiresAt };
  }

  async claim(input: CreateConfirmationChallengeInput & { readonly token: string }): Promise<void> {
    const currentTime = this.now();
    const challenge = await this.client.databaseConfirmationChallenge.findFirst({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actorUserId: input.actorUserId,
        action: input.action,
        tokenHash: hashToken(input.token),
        consumedAt: null,
        expiresAt: { gt: currentTime },
      },
      select: { id: true },
    });
    if (!challenge) throw new ConfirmationChallengeError();

    const claimed = await this.client.databaseConfirmationChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        expiresAt: { gt: currentTime },
      },
      data: { consumedAt: currentTime },
    });
    if (claimed.count !== 1) throw new ConfirmationChallengeError();
  }
}
