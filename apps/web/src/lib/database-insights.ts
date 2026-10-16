import type {
  DatabaseRelationshipGraph,
  DatabaseSchemaDiffEntry,
  SchemaDiffChangeType,
} from "@foundry/providers-core";

export type DatabaseInsightsResource = "overview" | "erd" | "snapshots" | "diff" | "maintenance";

export interface ParsedDatabaseInsightsQuery {
  readonly resource: DatabaseInsightsResource;
  readonly sourceSnapshotId?: string;
  readonly targetSnapshotId?: string;
  readonly schema?: string;
}

export type DatabaseInsightsMutationInput =
  | {
      readonly action: "capture-snapshot";
      readonly label?: string;
    }
  | {
      readonly action: "delete-snapshot";
      readonly snapshotId: string;
    }
  | {
      readonly action: "update-schedule";
      readonly enabled: boolean;
      readonly intervalHours: number;
    }
  | {
      readonly action: "run-scheduled-snapshot";
    };

export class DatabaseInsightsInputError extends Error {
  readonly code = "INVALID_DATABASE_INSIGHTS_INPUT" as const;

  constructor(message: string) {
    super(message);
    this.name = "DatabaseInsightsInputError";
  }
}

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function parseDatabaseInsightsQuery(request: Request): ParsedDatabaseInsightsQuery {
  const url = new URL(request.url);
  const rawResource = url.searchParams.get("resource") ?? "overview";
  if (
    rawResource !== "overview" &&
    rawResource !== "erd" &&
    rawResource !== "snapshots" &&
    rawResource !== "diff" &&
    rawResource !== "maintenance"
  ) {
    throw new DatabaseInsightsInputError(
      "resource must be overview, erd, snapshots, diff, or maintenance.",
    );
  }

  const sourceSnapshotId = url.searchParams.get("sourceSnapshotId")?.trim() || undefined;
  const targetSnapshotId = url.searchParams.get("targetSnapshotId")?.trim() || undefined;
  const schema = url.searchParams.get("schema")?.trim() || undefined;

  if (rawResource === "diff" && (!sourceSnapshotId || !targetSnapshotId)) {
    throw new DatabaseInsightsInputError(
      "sourceSnapshotId and targetSnapshotId are required when resource is diff.",
    );
  }
  if (sourceSnapshotId && (sourceSnapshotId.length > 128 || hasControlChars(sourceSnapshotId))) {
    throw new DatabaseInsightsInputError("sourceSnapshotId is invalid.");
  }
  if (targetSnapshotId && (targetSnapshotId.length > 128 || hasControlChars(targetSnapshotId))) {
    throw new DatabaseInsightsInputError("targetSnapshotId is invalid.");
  }
  if (schema && (schema.length > 63 || hasControlChars(schema))) {
    throw new DatabaseInsightsInputError("schema filter must be 63 characters or fewer.");
  }

  return {
    resource: rawResource,
    ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
    ...(targetSnapshotId ? { targetSnapshotId } : {}),
    ...(schema ? { schema } : {}),
  };
}

export function parseDatabaseInsightsMutationBody(value: unknown): DatabaseInsightsMutationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DatabaseInsightsInputError("Database insights request body must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  const action = body.action;

  if (action === "capture-snapshot") {
    if (body.label !== undefined && typeof body.label !== "string") {
      throw new DatabaseInsightsInputError("label must be a string when provided.");
    }
    const label = typeof body.label === "string" ? body.label.trim() : undefined;
    if (label && (label.length > 90 || hasControlChars(label))) {
      throw new DatabaseInsightsInputError(
        "Snapshot label must be 90 characters or fewer without control characters.",
      );
    }
    return {
      action: "capture-snapshot",
      ...(label ? { label } : {}),
    };
  }

  if (action === "delete-snapshot") {
    if (typeof body.snapshotId !== "string" || !body.snapshotId.trim()) {
      throw new DatabaseInsightsInputError("snapshotId is required to delete a schema snapshot.");
    }
    return {
      action: "delete-snapshot",
      snapshotId: body.snapshotId.trim(),
    };
  }

  if (action === "update-schedule") {
    if (typeof body.enabled !== "boolean") {
      throw new DatabaseInsightsInputError(
        "enabled must be a boolean when updating snapshot schedule.",
      );
    }
    if (
      typeof body.intervalHours !== "number" ||
      !Number.isInteger(body.intervalHours) ||
      body.intervalHours < 1 ||
      body.intervalHours > 168
    ) {
      throw new DatabaseInsightsInputError("intervalHours must be an integer between 1 and 168.");
    }
    return {
      action: "update-schedule",
      enabled: body.enabled,
      intervalHours: body.intervalHours,
    };
  }

  if (action === "run-scheduled-snapshot") {
    return {
      action: "run-scheduled-snapshot",
    };
  }

  throw new DatabaseInsightsInputError(
    "action must be capture-snapshot, delete-snapshot, update-schedule, or run-scheduled-snapshot.",
  );
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

export function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "0 ms";
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remSeconds}s`;
}

export function filterErdGraphBySchema(
  graph: DatabaseRelationshipGraph,
  schemaFilter: string,
): DatabaseRelationshipGraph {
  const normalized = schemaFilter.trim();
  if (!normalized || normalized === "all") {
    return graph;
  }

  const primaryIds = new Set(
    graph.nodes.filter((node) => node.schema === normalized).map((node) => node.id),
  );
  const edges = graph.edges.filter(
    (edge) => primaryIds.has(edge.sourceTable) || primaryIds.has(edge.targetTable),
  );
  const visibleNodeIds = new Set(primaryIds);
  for (const edge of edges) {
    visibleNodeIds.add(edge.sourceTable);
    visibleNodeIds.add(edge.targetTable);
  }
  const nodes = graph.nodes.filter((node) => visibleNodeIds.has(node.id));
  const isolatedTables = nodes
    .filter((node) => node.inboundCount === 0 && node.outboundCount === 0)
    .map((node) => node.id);

  return {
    schemas: graph.schemas,
    nodes,
    edges,
    isolatedTables,
  };
}

export function filterDiffEntries(
  entries: readonly DatabaseSchemaDiffEntry[],
  filters: {
    readonly changeType?: "all" | SchemaDiffChangeType;
    readonly category?: string;
    readonly search?: string;
  },
): readonly DatabaseSchemaDiffEntry[] {
  const changeType = filters.changeType ?? "all";
  const category = filters.category && filters.category !== "all" ? filters.category : undefined;
  const search = filters.search?.trim().toLowerCase();

  return entries.filter((entry) => {
    if (changeType !== "all" && entry.changeType !== changeType) return false;
    if (category && entry.category !== category) return false;
    if (search) {
      const haystack = [
        entry.target,
        entry.tableId ?? "",
        entry.summary,
        entry.before ?? "",
        entry.after ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}
