import type { ProviderCapabilities, ProviderConnectionState, ProviderName } from "@foundry/types";
import type { CapabilityKey } from "@foundry/ui";

export interface ControlCenterConnection {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderName;
  readonly status: ProviderConnectionState;
  readonly capabilities?: ProviderCapabilities;
  readonly lastCheckedAt?: string;
}

export interface ControlCenterMetric {
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
  readonly capturedAt: string;
}

export interface ControlCenterFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: "critical" | "high" | "medium" | "low" | "informational";
  readonly state: "open" | "acknowledged" | "resolved" | "ignored";
  readonly lastSeenAt: string;
}

export interface ControlCenterProject {
  readonly id: string;
  readonly name: string;
  readonly environment: "production" | "staging" | "development";
  readonly createdAt: string;
  readonly connections: readonly ControlCenterConnection[];
  readonly metrics: readonly ControlCenterMetric[];
  readonly findings: readonly ControlCenterFinding[];
}

export interface ControlCenterActivity {
  readonly id: string;
  readonly projectId?: string;
  readonly action: string;
  readonly resourceType: string;
  readonly result: string;
  readonly createdAt: string;
}

export interface ControlCenterData {
  readonly workspace: { readonly id: string; readonly name: string };
  readonly projects: readonly ControlCenterProject[];
  readonly activity: readonly ControlCenterActivity[];
}

export interface ControlCenterSummary {
  readonly connectedProjects: number;
  readonly totalProjects: number;
  readonly providerCounts: Readonly<Record<ProviderName, number>>;
  readonly totalUsers?: number;
  readonly databaseBytes?: number;
  readonly storageBytes?: number;
  readonly openFindings: number;
  readonly recentErrors: number;
  readonly health: "clear" | "mixed" | "attention" | "awaiting";
}

const connectedStates = new Set<ProviderConnectionState>([
  "healthy",
  "degraded",
  "permission_missing",
]);

function latestMetric(project: ControlCenterProject, names: readonly string[]): number | undefined {
  return project.metrics
    .filter((metric) => names.includes(metric.name))
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0]?.value;
}

function sumLatestMetric(
  projects: readonly ControlCenterProject[],
  names: readonly string[],
): number | undefined {
  const values = projects
    .map((project) => latestMetric(project, names))
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
}

export function getProjectCapabilities(
  project: ControlCenterProject | undefined,
): Partial<Record<CapabilityKey, boolean>> & Partial<ProviderCapabilities> {
  const capabilities: Partial<Record<CapabilityKey, boolean>> & Partial<ProviderCapabilities> = {};
  for (const connection of project?.connections ?? []) {
    for (const [key, value] of Object.entries(connection.capabilities ?? {})) {
      if (value === true) capabilities[key as keyof ProviderCapabilities] = true;
    }
  }
  capabilities.database = Boolean(
    capabilities.database ||
    capabilities.relationalDatabase ||
    capabilities.documentDatabase ||
    capabilities.realtimeDatabase ||
    capabilities.sql,
  );
  capabilities.authentication = capabilities.auth === true;
  capabilities.observability = Boolean(capabilities.logs || capabilities.metrics);
  capabilities.analytics = capabilities.metrics === true;
  return capabilities;
}

export function formatMetricForProject(
  project: ControlCenterProject,
  names: readonly string[],
): number | undefined {
  return latestMetric(project, names);
}

export function getProjectConnectionState(
  project: ControlCenterProject,
): ProviderConnectionState | "not_connected" {
  return project.connections[0]?.status ?? "not_connected";
}

export function buildControlCenterSummary(data: ControlCenterData): ControlCenterSummary {
  const connections = data.projects.flatMap((project) => project.connections);
  const connectedProjects = data.projects.filter((project) =>
    project.connections.some((connection) => connectedStates.has(connection.status)),
  ).length;
  const providerCounts: Record<ProviderName, number> = { supabase: 0, firebase: 0 };

  for (const project of data.projects) {
    const provider = project.connections[0]?.provider;
    if (provider) providerCounts[provider] += 1;
  }

  const openFindings = data.projects.reduce(
    (total, project) =>
      total +
      project.findings.filter((finding) => ["open", "acknowledged"].includes(finding.state)).length,
    0,
  );
  const recentErrors = data.activity.filter(
    (event) => event.result.toLowerCase() !== "success",
  ).length;
  const disconnectedConnections = connections.filter((connection) =>
    ["disconnected", "credentials_expired", "permission_missing"].includes(connection.status),
  ).length;

  let health: ControlCenterSummary["health"] = "awaiting";
  if (data.projects.length > 0) {
    health = disconnectedConnections > 0 || recentErrors > 0 ? "attention" : "clear";
    if (connectedProjects < data.projects.length && health === "clear") health = "mixed";
  }

  return {
    connectedProjects,
    totalProjects: data.projects.length,
    providerCounts,
    ...(sumLatestMetric(data.projects, ["auth.users", "users", "total_users"]) !== undefined
      ? { totalUsers: sumLatestMetric(data.projects, ["auth.users", "users", "total_users"]) }
      : {}),
    ...(sumLatestMetric(data.projects, ["database.storage_bytes", "database.bytes"]) !== undefined
      ? {
          databaseBytes: sumLatestMetric(data.projects, [
            "database.storage_bytes",
            "database.bytes",
          ]),
        }
      : {}),
    ...(sumLatestMetric(data.projects, ["storage.bytes", "storage.storage_bytes"]) !== undefined
      ? { storageBytes: sumLatestMetric(data.projects, ["storage.bytes", "storage.storage_bytes"]) }
      : {}),
    openFindings,
    recentErrors,
    health,
  };
}

export function formatCount(value: number | undefined): string {
  return value === undefined
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatBytes(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = "B";
  for (const nextUnit of units) {
    amount /= 1024;
    unit = nextUnit;
    if (amount < 1024) break;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
}

export function formatConnectionState(state: ProviderConnectionState | "not_connected"): string {
  return {
    healthy: "Healthy",
    degraded: "Degraded",
    permission_missing: "Permission gap",
    disconnected: "Disconnected",
    credentials_expired: "Credentials expired",
    pending: "Checking",
    not_connected: "Not connected",
  }[state];
}
