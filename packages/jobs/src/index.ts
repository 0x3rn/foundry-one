export interface JobHandler<TInput> {
  run(input: TInput): Promise<void>;
}

export interface ScheduledSchemaSnapshotJobInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectName?: string;
  readonly environment?: "production" | "staging" | "development";
  readonly force?: boolean;
  readonly now?: Date;
}

export interface ScheduledSchemaSnapshotScheduleState {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly lastCapturedAt?: string;
  readonly nextDueAt?: string;
  readonly isDue: boolean;
}

export interface ScheduledSchemaSnapshotStorePort<TSnapshot, TStored> {
  getSchedule(
    workspaceId: string,
    projectId: string,
    now?: Date,
  ): Promise<ScheduledSchemaSnapshotScheduleState>;
  create(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly projectName?: string;
    readonly environment?: "production" | "staging" | "development";
    readonly trigger: "scheduled";
    readonly snapshot: TSnapshot;
  }): Promise<TStored & { readonly capturedAt: string }>;
  upsertSchedule(
    input: {
      readonly workspaceId: string;
      readonly projectId: string;
      readonly enabled: boolean;
      readonly intervalHours: number;
      readonly lastCapturedAt?: string;
    },
    now?: Date,
  ): Promise<ScheduledSchemaSnapshotScheduleState>;
}

export interface ScheduledSchemaSnapshotJobResult<TStored> {
  readonly executed: boolean;
  readonly reason: "captured" | "schedule_disabled" | "not_due";
  readonly schedule: ScheduledSchemaSnapshotScheduleState;
  readonly snapshot?: TStored;
}

export class ScheduledSchemaSnapshotJob<
  TSnapshot,
  TStored,
> implements JobHandler<ScheduledSchemaSnapshotJobInput> {
  constructor(
    private readonly dependencies: {
      readonly store: ScheduledSchemaSnapshotStorePort<TSnapshot, TStored>;
      readonly captureSnapshot: (input: ScheduledSchemaSnapshotJobInput) => Promise<TSnapshot>;
    },
  ) {}

  async execute(
    input: ScheduledSchemaSnapshotJobInput,
  ): Promise<ScheduledSchemaSnapshotJobResult<TStored>> {
    const now = input.now ?? new Date();
    const schedule = await this.dependencies.store.getSchedule(
      input.workspaceId,
      input.projectId,
      now,
    );

    if (!schedule.enabled && !input.force) {
      return {
        executed: false,
        reason: "schedule_disabled",
        schedule,
      };
    }

    if (!schedule.isDue && !input.force) {
      return {
        executed: false,
        reason: "not_due",
        schedule,
      };
    }

    const captured = await this.dependencies.captureSnapshot(input);
    const stored = await this.dependencies.store.create({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ...(input.projectName ? { projectName: input.projectName } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      trigger: "scheduled",
      snapshot: captured,
    });

    const updatedSchedule = await this.dependencies.store.upsertSchedule(
      {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        enabled: schedule.enabled,
        intervalHours: schedule.intervalHours,
        lastCapturedAt: stored.capturedAt,
      },
      now,
    );

    return {
      executed: true,
      reason: "captured",
      schedule: updatedSchedule,
      snapshot: stored,
    };
  }

  async run(input: ScheduledSchemaSnapshotJobInput): Promise<void> {
    await this.execute(input);
  }
}
