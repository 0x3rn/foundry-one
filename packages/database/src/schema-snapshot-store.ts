import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  normalizeSchemaSnapshot,
  type DatabaseSchemaSnapshot,
  type DatabaseSchemaSnapshotCounts,
} from "@foundry/providers-core";

const SNAPSHOT_PROVIDER_KEY = "schema_snapshot";
const SCHEDULE_PROVIDER_KEY = "schema_snapshot_schedule";
const MAX_LABEL_LENGTH = 90;
const MIN_SCHEDULE_INTERVAL_HOURS = 1;
const MAX_SCHEDULE_INTERVAL_HOURS = 168;
const DEFAULT_SCHEDULE_INTERVAL_HOURS = 24;

export type SchemaSnapshotTrigger = "manual" | "scheduled";
export type ProjectEnvironmentName = "production" | "staging" | "development";

export interface StoredSchemaSnapshotSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly environment: ProjectEnvironmentName;
  readonly provider: "supabase" | "firebase";
  readonly label: string;
  readonly trigger: SchemaSnapshotTrigger;
  readonly createdById?: string;
  readonly fingerprint: string;
  readonly counts: DatabaseSchemaSnapshotCounts;
  readonly capturedAt: string;
  readonly createdAt: string;
}

export interface StoredSchemaSnapshot extends StoredSchemaSnapshotSummary {
  readonly snapshot: DatabaseSchemaSnapshot;
}

export interface CreateSchemaSnapshotInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectName?: string;
  readonly environment?: ProjectEnvironmentName;
  readonly label?: string;
  readonly trigger?: SchemaSnapshotTrigger;
  readonly createdById?: string;
  readonly snapshot: DatabaseSchemaSnapshot;
}

export interface DeleteSchemaSnapshotInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
}

export interface StoredSchemaSnapshotSchedule {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly lastCapturedAt?: string;
  readonly nextDueAt?: string;
  readonly isDue: boolean;
  readonly updatedAt?: string;
}

export interface UpsertSchemaSnapshotScheduleInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly lastCapturedAt?: string;
}

export class SchemaSnapshotError extends Error {
  constructor(
    readonly code: "INVALID_SCHEMA_SNAPSHOT" | "SCHEMA_SNAPSHOT_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SchemaSnapshotError";
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function normalizeSnapshotLabel(
  label: string | undefined,
  trigger: SchemaSnapshotTrigger,
  capturedAtIso: string,
): string {
  if (label === undefined || !label.trim()) {
    const timestamp = capturedAtIso.replace("T", " ").slice(0, 19);
    return trigger === "scheduled"
      ? `Scheduled snapshot (${timestamp} UTC)`
      : `Manual snapshot (${timestamp} UTC)`;
  }

  const trimmed = label.trim().replace(/\s+/g, " ");
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new SchemaSnapshotError(
      "INVALID_SCHEMA_SNAPSHOT",
      `Snapshot labels must be ${MAX_LABEL_LENGTH} characters or fewer.`,
    );
  }
  if (hasControlCharacters(trimmed)) {
    throw new SchemaSnapshotError(
      "INVALID_SCHEMA_SNAPSHOT",
      "Snapshot labels cannot contain control characters.",
    );
  }
  return trimmed;
}

export function normalizeScheduleIntervalHours(intervalHours: number): number {
  if (
    typeof intervalHours !== "number" ||
    !Number.isInteger(intervalHours) ||
    intervalHours < MIN_SCHEDULE_INTERVAL_HOURS ||
    intervalHours > MAX_SCHEDULE_INTERVAL_HOURS
  ) {
    throw new SchemaSnapshotError(
      "INVALID_SCHEMA_SNAPSHOT",
      `Snapshot schedule interval must be an integer between ${MIN_SCHEDULE_INTERVAL_HOURS} and ${MAX_SCHEDULE_INTERVAL_HOURS} hours.`,
    );
  }
  return intervalHours;
}

interface StoredSnapshotConfigPayload {
  readonly label?: string;
  readonly trigger?: SchemaSnapshotTrigger;
  readonly createdById?: string;
  readonly projectName?: string;
  readonly environment?: ProjectEnvironmentName;
  readonly snapshot?: DatabaseSchemaSnapshot;
}

interface StoredScheduleConfigPayload {
  readonly intervalHours?: number;
  readonly lastCapturedAt?: string;
}

interface IntegrationRecordWithProject {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly provider: string;
  readonly status: "active" | "paused" | "disconnected";
  readonly config: Prisma.JsonValue;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly project?: {
    readonly id: string;
    readonly name: string;
    readonly environment: ProjectEnvironmentName;
  } | null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredSnapshotRecord(
  record: IntegrationRecordWithProject,
): StoredSchemaSnapshot | null {
  if (!isObjectRecord(record.config)) return null;
  const payload = record.config as unknown as StoredSnapshotConfigPayload;
  if (!payload.snapshot || !isObjectRecord(payload.snapshot)) return null;

  const normalized = normalizeSchemaSnapshot(payload.snapshot);
  const trigger: SchemaSnapshotTrigger = payload.trigger === "scheduled" ? "scheduled" : "manual";
  const projectId = record.projectId ?? record.project?.id ?? "";
  const projectName = record.project?.name ?? payload.projectName ?? "Connected Project";
  const environment: ProjectEnvironmentName =
    record.project?.environment ?? payload.environment ?? "development";
  const label =
    typeof payload.label === "string" && payload.label.trim()
      ? payload.label.trim()
      : normalizeSnapshotLabel(undefined, trigger, normalized.capturedAt);

  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId,
    projectName,
    environment,
    provider: normalized.provider,
    label,
    trigger,
    ...(typeof payload.createdById === "string" && payload.createdById
      ? { createdById: payload.createdById }
      : {}),
    fingerprint: normalized.fingerprint,
    counts: normalized.counts,
    capturedAt: normalized.capturedAt,
    createdAt: record.createdAt.toISOString(),
    snapshot: normalized,
  };
}

function toSummary(stored: StoredSchemaSnapshot): StoredSchemaSnapshotSummary {
  return {
    id: stored.id,
    workspaceId: stored.workspaceId,
    projectId: stored.projectId,
    projectName: stored.projectName,
    environment: stored.environment,
    provider: stored.provider,
    label: stored.label,
    trigger: stored.trigger,
    ...(stored.createdById ? { createdById: stored.createdById } : {}),
    fingerprint: stored.fingerprint,
    counts: stored.counts,
    capturedAt: stored.capturedAt,
    createdAt: stored.createdAt,
  };
}

export function computeScheduleState(
  input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly enabled: boolean;
    readonly intervalHours: number;
    readonly lastCapturedAt?: string;
    readonly updatedAt?: string;
  },
  now = new Date(),
): StoredSchemaSnapshotSchedule {
  if (!input.enabled) {
    return {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      enabled: false,
      intervalHours: input.intervalHours,
      ...(input.lastCapturedAt ? { lastCapturedAt: input.lastCapturedAt } : {}),
      isDue: false,
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    };
  }

  if (!input.lastCapturedAt) {
    return {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      enabled: true,
      intervalHours: input.intervalHours,
      nextDueAt: now.toISOString(),
      isDue: true,
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    };
  }

  const lastDate = new Date(input.lastCapturedAt);
  if (Number.isNaN(lastDate.getTime())) {
    return {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      enabled: true,
      intervalHours: input.intervalHours,
      nextDueAt: now.toISOString(),
      isDue: true,
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    };
  }

  const nextDueMs = lastDate.getTime() + input.intervalHours * 60 * 60 * 1000;
  const nextDueAt = new Date(nextDueMs).toISOString();
  return {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    enabled: true,
    intervalHours: input.intervalHours,
    lastCapturedAt: lastDate.toISOString(),
    nextDueAt,
    isDue: now.getTime() >= nextDueMs,
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
}

function buildScheduleIntegrationName(projectId: string): string {
  return `${SCHEDULE_PROVIDER_KEY}:${projectId}`;
}

export class PrismaSchemaSnapshotStore {
  constructor(private readonly client: PrismaClient) {}

  async create(input: CreateSchemaSnapshotInput): Promise<StoredSchemaSnapshot> {
    if (!input.workspaceId.trim() || !input.projectId.trim()) {
      throw new SchemaSnapshotError(
        "INVALID_SCHEMA_SNAPSHOT",
        "workspaceId and projectId are required to persist a schema snapshot.",
      );
    }

    const trigger: SchemaSnapshotTrigger = input.trigger === "scheduled" ? "scheduled" : "manual";
    const normalized = normalizeSchemaSnapshot(input.snapshot);
    const label = normalizeSnapshotLabel(input.label, trigger, normalized.capturedAt);
    const uniqueName = `${SNAPSHOT_PROVIDER_KEY}:${input.projectId}:${Date.now()}:${randomUUID().slice(0, 8)}`;

    const payload: StoredSnapshotConfigPayload = {
      label,
      trigger,
      ...(input.createdById ? { createdById: input.createdById } : {}),
      ...(input.projectName ? { projectName: input.projectName } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      snapshot: normalized,
    };

    const record = await this.client.integration.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        name: uniqueName,
        provider: SNAPSHOT_PROVIDER_KEY,
        status: "active",
        config: payload as unknown as Prisma.InputJsonValue,
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            environment: true,
          },
        },
      },
    });

    const parsed = parseStoredSnapshotRecord(record);
    if (!parsed) {
      throw new SchemaSnapshotError(
        "INVALID_SCHEMA_SNAPSHOT",
        "Failed to parse stored schema snapshot record.",
      );
    }
    return parsed;
  }

  async listByProject(
    workspaceId: string,
    projectId: string,
  ): Promise<readonly StoredSchemaSnapshotSummary[]> {
    const records = await this.client.integration.findMany({
      where: {
        workspaceId,
        projectId,
        provider: SNAPSHOT_PROVIDER_KEY,
      },
      orderBy: [{ createdAt: "desc" }],
      include: {
        project: {
          select: {
            id: true,
            name: true,
            environment: true,
          },
        },
      },
    });

    return records
      .map(parseStoredSnapshotRecord)
      .filter((item): item is StoredSchemaSnapshot => item !== null)
      .map(toSummary);
  }

  async listByWorkspace(workspaceId: string): Promise<readonly StoredSchemaSnapshotSummary[]> {
    const records = await this.client.integration.findMany({
      where: {
        workspaceId,
        provider: SNAPSHOT_PROVIDER_KEY,
      },
      orderBy: [{ createdAt: "desc" }],
      include: {
        project: {
          select: {
            id: true,
            name: true,
            environment: true,
          },
        },
      },
    });

    return records
      .map(parseStoredSnapshotRecord)
      .filter((item): item is StoredSchemaSnapshot => item !== null)
      .map(toSummary);
  }

  async findById(workspaceId: string, id: string): Promise<StoredSchemaSnapshot | null> {
    const record = await this.client.integration.findFirst({
      where: {
        id,
        workspaceId,
        provider: SNAPSHOT_PROVIDER_KEY,
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            environment: true,
          },
        },
      },
    });

    if (!record) return null;
    return parseStoredSnapshotRecord(record);
  }

  async delete(input: DeleteSchemaSnapshotInput): Promise<void> {
    const deleted = await this.client.integration.deleteMany({
      where: {
        id: input.id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        provider: SNAPSHOT_PROVIDER_KEY,
      },
    });

    if (deleted.count !== 1) {
      throw new SchemaSnapshotError(
        "SCHEMA_SNAPSHOT_NOT_FOUND",
        "The schema snapshot was not found in this project.",
      );
    }
  }

  async getSchedule(
    workspaceId: string,
    projectId: string,
    now = new Date(),
  ): Promise<StoredSchemaSnapshotSchedule> {
    const name = buildScheduleIntegrationName(projectId);
    const record = await this.client.integration.findUnique({
      where: {
        workspaceId_name: {
          workspaceId,
          name,
        },
      },
    });

    if (!record || record.provider !== SCHEDULE_PROVIDER_KEY) {
      return computeScheduleState(
        {
          workspaceId,
          projectId,
          enabled: false,
          intervalHours: DEFAULT_SCHEDULE_INTERVAL_HOURS,
        },
        now,
      );
    }

    const config = isObjectRecord(record.config)
      ? (record.config as unknown as StoredScheduleConfigPayload)
      : {};
    const intervalHours =
      typeof config.intervalHours === "number" &&
      Number.isInteger(config.intervalHours) &&
      config.intervalHours >= MIN_SCHEDULE_INTERVAL_HOURS &&
      config.intervalHours <= MAX_SCHEDULE_INTERVAL_HOURS
        ? config.intervalHours
        : DEFAULT_SCHEDULE_INTERVAL_HOURS;

    return computeScheduleState(
      {
        workspaceId,
        projectId,
        enabled: record.status === "active",
        intervalHours,
        ...(typeof config.lastCapturedAt === "string" && config.lastCapturedAt
          ? { lastCapturedAt: config.lastCapturedAt }
          : {}),
        updatedAt: record.updatedAt.toISOString(),
      },
      now,
    );
  }

  async upsertSchedule(
    input: UpsertSchemaSnapshotScheduleInput,
    now = new Date(),
  ): Promise<StoredSchemaSnapshotSchedule> {
    if (!input.workspaceId.trim() || !input.projectId.trim()) {
      throw new SchemaSnapshotError(
        "INVALID_SCHEMA_SNAPSHOT",
        "workspaceId and projectId are required to configure a snapshot schedule.",
      );
    }

    const intervalHours = normalizeScheduleIntervalHours(input.intervalHours);
    const name = buildScheduleIntegrationName(input.projectId);
    const existing = await this.client.integration.findUnique({
      where: {
        workspaceId_name: {
          workspaceId: input.workspaceId,
          name,
        },
      },
    });

    const existingConfig =
      existing && isObjectRecord(existing.config)
        ? (existing.config as unknown as StoredScheduleConfigPayload)
        : {};
    const lastCapturedAt =
      input.lastCapturedAt !== undefined ? input.lastCapturedAt : existingConfig.lastCapturedAt;

    const payload: StoredScheduleConfigPayload = {
      intervalHours,
      ...(lastCapturedAt ? { lastCapturedAt } : {}),
    };

    const saved = await this.client.integration.upsert({
      where: {
        workspaceId_name: {
          workspaceId: input.workspaceId,
          name,
        },
      },
      update: {
        projectId: input.projectId,
        provider: SCHEDULE_PROVIDER_KEY,
        status: input.enabled ? "active" : "paused",
        config: payload as unknown as Prisma.InputJsonValue,
      },
      create: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        name,
        provider: SCHEDULE_PROVIDER_KEY,
        status: input.enabled ? "active" : "paused",
        config: payload as unknown as Prisma.InputJsonValue,
      },
    });

    return computeScheduleState(
      {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        enabled: saved.status === "active",
        intervalHours,
        ...(lastCapturedAt ? { lastCapturedAt } : {}),
        updatedAt: saved.updatedAt.toISOString(),
      },
      now,
    );
  }
}
