"use client";

import { useEffect, useState, type FormEvent } from "react";
import type {
  DatabaseOperationsSnapshot,
  DatabaseRelationshipGraph,
  DatabaseSchemaDiff,
  DatabaseSchemaSnapshotCounts,
  SchemaDiffChangeType,
} from "@foundry/providers-core";
import { fetchDatabaseApi, type DatabaseApiResponse } from "@/lib/database-api";
import {
  filterDiffEntries,
  filterErdGraphBySchema,
  formatBytes,
  formatDurationMs,
} from "@/lib/database-insights";

interface SnapshotSummaryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly environment: "production" | "staging" | "development";
  readonly provider: "supabase" | "firebase";
  readonly label: string;
  readonly trigger: "manual" | "scheduled";
  readonly createdById?: string;
  readonly fingerprint: string;
  readonly counts: DatabaseSchemaSnapshotCounts;
  readonly capturedAt: string;
  readonly createdAt: string;
}

interface SnapshotScheduleRecord {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly lastCapturedAt?: string;
  readonly nextDueAt?: string;
  readonly isDue: boolean;
  readonly updatedAt?: string;
}

interface OverviewPayload {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly environment: "production" | "staging" | "development";
  };
  readonly liveSnapshotSummary: {
    readonly capturedAt: string;
    readonly fingerprint: string;
    readonly counts: DatabaseSchemaSnapshotCounts;
  };
  readonly erd: DatabaseRelationshipGraph;
  readonly snapshots: readonly SnapshotSummaryRecord[];
  readonly workspaceSnapshots: readonly SnapshotSummaryRecord[];
  readonly schedule: SnapshotScheduleRecord;
  readonly operations: DatabaseOperationsSnapshot;
}

interface DiffPayload {
  readonly source: SnapshotSummaryRecord;
  readonly target: SnapshotSummaryRecord;
  readonly diff: DatabaseSchemaDiff;
}

export interface DatabaseInsightsProps {
  readonly projectId: string;
  readonly selectedTable?: string;
  readonly onSelectTable?: (tableId: string) => void;
}

type InsightsTab = "erd" | "snapshots" | "maintenance";

export function DatabaseInsights({
  projectId,
  selectedTable,
  onSelectTable,
}: DatabaseInsightsProps) {
  const [activeTab, setActiveTab] = useState<InsightsTab>("erd");
  const [overview, setOverview] = useState<OverviewPayload>();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [statusMessage, setStatusMessage] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);

  // ERD state
  const [schemaFilter, setSchemaFilter] = useState<string>("all");
  const [erdSearch, setErdSearch] = useState<string>("");
  const [showIsolatedTables, setShowIsolatedTables] = useState<boolean>(true);
  const [focusedErdTable, setFocusedErdTable] = useState<string>();

  // Snapshot & schedule state
  const [snapshotLabel, setSnapshotLabel] = useState<string>("");
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [scheduleEnabled, setScheduleEnabled] = useState<boolean>(false);
  const [scheduleIntervalHours, setScheduleIntervalHours] = useState<number>(24);
  const [isSavingSchedule, setIsSavingSchedule] = useState<boolean>(false);

  // Diff state
  const [sourceEndpointId, setSourceEndpointId] = useState<string>("live");
  const [targetEndpointId, setTargetEndpointId] = useState<string>("live");
  const [diffPayload, setDiffPayload] = useState<DiffPayload>();
  const [isComparing, setIsComparing] = useState<boolean>(false);
  const [diffChangeTypeFilter, setDiffChangeTypeFilter] = useState<"all" | SchemaDiffChangeType>(
    "all",
  );
  const [diffCategoryFilter, setDiffCategoryFilter] = useState<string>("all");
  const [diffSearch, setDiffSearch] = useState<string>("");

  // Copied advisory SQL indicator
  const [copiedAdvisoryId, setCopiedAdvisoryId] = useState<string>();

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const result = await fetchDatabaseApi<OverviewPayload>(
          `/api/projects/${projectId}/database/insights?resource=overview`,
        );
        if (!active) return;
        setOverview(result);
        setScheduleEnabled(result.schedule.enabled);
        setScheduleIntervalHours(result.schedule.intervalHours);
        if (result.snapshots[0]) {
          setSourceEndpointId((current) =>
            current === "live" ? result.snapshots[0]!.id : current,
          );
        }
        setError(undefined);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Database insights could not be loaded.");
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [projectId, reloadToken]);

  async function captureSnapshot(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsCapturing(true);
    setError(undefined);
    setStatusMessage(undefined);
    try {
      const response = await fetch(`/api/projects/${projectId}/database/insights`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "capture-snapshot",
          ...(snapshotLabel.trim() ? { label: snapshotLabel.trim() } : {}),
        }),
      });
      const body = (await response.json()) as DatabaseApiResponse<{
        readonly created: SnapshotSummaryRecord;
        readonly snapshots: readonly SnapshotSummaryRecord[];
        readonly workspaceSnapshots: readonly SnapshotSummaryRecord[];
        readonly schedule: SnapshotScheduleRecord;
      }>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Could not capture schema snapshot.");
      }
      setSnapshotLabel("");
      setOverview((current) =>
        current
          ? {
              ...current,
              snapshots: body.data!.snapshots,
              workspaceSnapshots: body.data!.workspaceSnapshots,
              schedule: body.data!.schedule,
            }
          : current,
      );
      setSourceEndpointId(body.data.created.id);
      setTargetEndpointId("live");
      setStatusMessage(`Captured schema snapshot "${body.data.created.label}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not capture schema snapshot.");
    } finally {
      setIsCapturing(false);
    }
  }

  async function deleteSnapshot(snapshotId: string): Promise<void> {
    setError(undefined);
    setStatusMessage(undefined);
    try {
      const response = await fetch(`/api/projects/${projectId}/database/insights`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete-snapshot",
          snapshotId,
        }),
      });
      const body = (await response.json()) as DatabaseApiResponse<{
        readonly deletedId: string;
        readonly snapshots: readonly SnapshotSummaryRecord[];
        readonly workspaceSnapshots: readonly SnapshotSummaryRecord[];
      }>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Could not delete schema snapshot.");
      }
      setOverview((current) =>
        current
          ? {
              ...current,
              snapshots: body.data!.snapshots,
              workspaceSnapshots: body.data!.workspaceSnapshots,
            }
          : current,
      );
      if (sourceEndpointId === snapshotId) setSourceEndpointId("live");
      if (targetEndpointId === snapshotId) setTargetEndpointId("live");
      setStatusMessage("Deleted schema snapshot.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete schema snapshot.");
    }
  }

  async function saveSchedule(): Promise<void> {
    setIsSavingSchedule(true);
    setError(undefined);
    setStatusMessage(undefined);
    try {
      const response = await fetch(`/api/projects/${projectId}/database/insights`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-schedule",
          enabled: scheduleEnabled,
          intervalHours: scheduleIntervalHours,
        }),
      });
      const body = (await response.json()) as DatabaseApiResponse<{
        readonly schedule: SnapshotScheduleRecord;
      }>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Could not update snapshot schedule.");
      }
      setOverview((current) => (current ? { ...current, schedule: body.data!.schedule } : current));
      setStatusMessage(
        body.data.schedule.enabled
          ? `Scheduled snapshots enabled (every ${body.data.schedule.intervalHours}h).`
          : "Scheduled snapshots paused.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update snapshot schedule.");
    } finally {
      setIsSavingSchedule(false);
    }
  }

  async function triggerScheduledSnapshotNow(): Promise<void> {
    setIsCapturing(true);
    setError(undefined);
    setStatusMessage(undefined);
    try {
      const response = await fetch(`/api/projects/${projectId}/database/insights`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run-scheduled-snapshot",
        }),
      });
      const body = (await response.json()) as DatabaseApiResponse<{
        readonly created: SnapshotSummaryRecord;
        readonly schedule: SnapshotScheduleRecord;
        readonly snapshots: readonly SnapshotSummaryRecord[];
        readonly workspaceSnapshots: readonly SnapshotSummaryRecord[];
      }>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Could not run scheduled snapshot.");
      }
      setOverview((current) =>
        current
          ? {
              ...current,
              snapshots: body.data!.snapshots,
              workspaceSnapshots: body.data!.workspaceSnapshots,
              schedule: body.data!.schedule,
            }
          : current,
      );
      setStatusMessage(`Captured scheduled snapshot "${body.data.created.label}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run scheduled snapshot.");
    } finally {
      setIsCapturing(false);
    }
  }

  async function runSchemaDiff(): Promise<void> {
    setIsComparing(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({
        resource: "diff",
        sourceSnapshotId: sourceEndpointId,
        targetSnapshotId: targetEndpointId,
      });
      const result = await fetchDatabaseApi<DiffPayload>(
        `/api/projects/${projectId}/database/insights?${params.toString()}`,
      );
      setDiffPayload(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Schema comparison could not be completed.");
    } finally {
      setIsComparing(false);
    }
  }

  function copyAdvisorySql(recommendationId: string, sqlText: string): void {
    void globalThis.navigator?.clipboard?.writeText(sqlText);
    setCopiedAdvisoryId(recommendationId);
    globalThis.setTimeout(() => {
      setCopiedAdvisoryId((current) => (current === recommendationId ? undefined : current));
    }, 2000);
  }

  const activeErdFocus = focusedErdTable ?? selectedTable;
  const filteredErd = overview ? filterErdGraphBySchema(overview.erd, schemaFilter) : undefined;
  const erdSearchNormalized = erdSearch.trim().toLowerCase();
  const visibleErdNodes = (filteredErd?.nodes ?? []).filter((node) => {
    if (!showIsolatedTables && node.inboundCount === 0 && node.outboundCount === 0) {
      return false;
    }
    if (!erdSearchNormalized) return true;
    return (
      node.id.toLowerCase().includes(erdSearchNormalized) ||
      node.columns.some((col) => col.name.toLowerCase().includes(erdSearchNormalized))
    );
  });
  const visibleErdNodeIds = new Set(visibleErdNodes.map((node) => node.id));
  const visibleErdEdges = (filteredErd?.edges ?? []).filter(
    (edge) => visibleErdNodeIds.has(edge.sourceTable) || visibleErdNodeIds.has(edge.targetTable),
  );

  const filteredDiffEntries = diffPayload
    ? filterDiffEntries(diffPayload.diff.entries, {
        changeType: diffChangeTypeFilter,
        category: diffCategoryFilter,
        search: diffSearch,
      })
    : [];

  return (
    <section
      className="foundry-db-insights"
      aria-label="Relationships, schema snapshots, diffs, and maintenance"
    >
      <div className="foundry-db-insights-header">
        <div>
          <p className="foundry-kicker">RELATIONAL INSIGHTS &amp; OPERATIONS</p>
          <h4>Relationships, Schema Snapshots, Environment Diffs &amp; Maintenance</h4>
        </div>
        <div className="foundry-db-insights-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "erd"}
            className={activeTab === "erd" ? "is-active" : ""}
            onClick={() => setActiveTab("erd")}
          >
            ERD &amp; Relationships
            {overview ? ` (${overview.erd.edges.length})` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "snapshots"}
            className={activeTab === "snapshots" ? "is-active" : ""}
            onClick={() => setActiveTab("snapshots")}
          >
            Snapshots &amp; Env Diff
            {overview ? ` (${overview.snapshots.length})` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "maintenance"}
            className={activeTab === "maintenance" ? "is-active" : ""}
            onClick={() => setActiveTab("maintenance")}
          >
            Maintenance &amp; Health
            {overview ? ` (${overview.operations.recommendations.length})` : ""}
          </button>
          <button
            type="button"
            className="foundry-db-insights-refresh"
            disabled={isLoading}
            onClick={() => {
              setIsLoading(true);
              setReloadToken((current) => current + 1);
            }}
          >
            {isLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <p className="foundry-database-error" role="alert">
          {error}
        </p>
      ) : null}
      {statusMessage ? (
        <p className="foundry-database-status" role="status">
          {statusMessage}
        </p>
      ) : null}

      {isLoading && !overview ? (
        <p className="foundry-database-empty">
          Inspecting database relationships, schema snapshots, and operational health…
        </p>
      ) : null}

      {overview && activeTab === "erd" ? (
        <div className="foundry-db-insights-panel" role="tabpanel">
          <div className="foundry-erd-toolbar">
            <label>
              <span>Schema</span>
              <select
                value={schemaFilter}
                onChange={(event) => setSchemaFilter(event.target.value)}
              >
                <option value="all">All schemas ({overview.erd.schemas.length})</option>
                {overview.erd.schemas.map((schemaName) => (
                  <option key={schemaName} value={schemaName}>
                    {schemaName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Filter tables or columns</span>
              <input
                type="search"
                value={erdSearch}
                onChange={(event) => setErdSearch(event.target.value)}
                placeholder="public.users, user_id, organization_id…"
              />
            </label>
            <label className="foundry-erd-checkbox">
              <input
                type="checkbox"
                checked={showIsolatedTables}
                onChange={(event) => setShowIsolatedTables(event.target.checked)}
              />
              <span>Show isolated tables ({filteredErd?.isolatedTables.length ?? 0})</span>
            </label>
            <div className="foundry-erd-summary-pills">
              <span>{visibleErdNodes.length} tables shown</span>
              <span>{visibleErdEdges.length} foreign keys</span>
              <span>Fingerprint {overview.liveSnapshotSummary.fingerprint.slice(0, 12)}</span>
            </div>
          </div>

          <div className="foundry-erd-layout">
            <div className="foundry-erd-nodes-grid">
              {visibleErdNodes.length === 0 ? (
                <p className="foundry-database-empty">
                  No tables match the current ERD schema or search filter.
                </p>
              ) : (
                visibleErdNodes.map((node) => {
                  const isFocused = activeErdFocus === node.id;
                  const isConnectedToFocus =
                    Boolean(activeErdFocus) &&
                    visibleErdEdges.some(
                      (edge) =>
                        (edge.sourceTable === activeErdFocus && edge.targetTable === node.id) ||
                        (edge.targetTable === activeErdFocus && edge.sourceTable === node.id),
                    );
                  return (
                    <article
                      key={node.id}
                      className={`foundry-erd-node-card${isFocused ? " is-focused" : ""}${isConnectedToFocus ? " is-connected" : ""}`}
                    >
                      <header className="foundry-erd-node-header">
                        <button
                          type="button"
                          onClick={() => {
                            setFocusedErdTable((current) =>
                              current === node.id ? undefined : node.id,
                            );
                            onSelectTable?.(node.id);
                          }}
                        >
                          <strong>{node.id}</strong>
                        </button>
                        <div className="foundry-erd-node-badges">
                          {node.isView ? (
                            <span className="foundry-erd-badge">
                              {node.isMaterializedView ? "MAT VIEW" : "VIEW"}
                            </span>
                          ) : null}
                          <span className="foundry-erd-badge" title="Outbound foreign keys">
                            {node.outboundCount} out
                          </span>
                          <span className="foundry-erd-badge" title="Inbound references">
                            {node.inboundCount} in
                          </span>
                        </div>
                      </header>
                      <ul className="foundry-erd-column-list">
                        {node.columns.slice(0, 8).map((col) => (
                          <li key={col.name}>
                            <span>
                              {col.isPrimaryKey ? (
                                <em className="foundry-erd-key-tag is-pk">PK</em>
                              ) : null}
                              {col.isForeignKey ? (
                                <em className="foundry-erd-key-tag is-fk">FK</em>
                              ) : null}
                              {col.name}
                            </span>
                            <small>
                              {col.dataType}
                              {col.referencedTable ? ` → ${col.referencedTable}` : ""}
                            </small>
                          </li>
                        ))}
                        {node.columns.length > 8 ? (
                          <li className="foundry-erd-more-cols">
                            +{node.columns.length - 8} more columns
                          </li>
                        ) : null}
                      </ul>
                    </article>
                  );
                })
              )}
            </div>

            <aside className="foundry-erd-edges-panel">
              <h5>Foreign-Key Relationships ({visibleErdEdges.length})</h5>
              {visibleErdEdges.length === 0 ? (
                <p className="foundry-database-empty">
                  No foreign-key relationships reported for the selected filter.
                </p>
              ) : (
                <ul className="foundry-erd-edge-list">
                  {visibleErdEdges.map((edge) => {
                    const isHighlighted =
                      activeErdFocus === edge.sourceTable || activeErdFocus === edge.targetTable;
                    return (
                      <li key={edge.id} className={isHighlighted ? "is-highlighted" : ""}>
                        <div className="foundry-erd-edge-route">
                          <button
                            type="button"
                            onClick={() => {
                              setFocusedErdTable(edge.sourceTable);
                              onSelectTable?.(edge.sourceTable);
                            }}
                          >
                            {edge.sourceTable}
                          </button>
                          <span>→</span>
                          <button
                            type="button"
                            onClick={() => {
                              setFocusedErdTable(edge.targetTable);
                              onSelectTable?.(edge.targetTable);
                            }}
                          >
                            {edge.targetTable}
                          </button>
                        </div>
                        <small>
                          ({edge.sourceColumns.join(", ")}) references (
                          {edge.targetColumns.join(", ")}) · {edge.constraintName}
                        </small>
                      </li>
                    );
                  })}
                </ul>
              )}
            </aside>
          </div>
        </div>
      ) : null}

      {overview && activeTab === "snapshots" ? (
        <div className="foundry-db-insights-panel" role="tabpanel">
          <div className="foundry-snapshots-top-grid">
            <form className="foundry-snapshot-card" onSubmit={captureSnapshot}>
              <h5>Capture On-Demand Schema Snapshot</h5>
              <p>
                Persists normalized catalog metadata (schemas, tables, columns, indexes,
                constraints, foreign keys, RLS policies, functions, and extensions).
              </p>
              <div className="foundry-snapshot-form-row">
                <input
                  type="text"
                  value={snapshotLabel}
                  onChange={(event) => setSnapshotLabel(event.target.value)}
                  placeholder="Optional label (e.g. Pre-migration baseline v1.4)"
                  maxLength={90}
                />
                <button type="submit" disabled={isCapturing}>
                  {isCapturing ? "Capturing…" : "Capture snapshot"}
                </button>
              </div>
            </form>

            <div className="foundry-snapshot-card">
              <h5>Scheduled Snapshot Policy</h5>
              <p>
                Automatically record periodic normalized schema snapshots for drift detection and
                cross-environment auditing.
              </p>
              <div className="foundry-snapshot-schedule-row">
                <label className="foundry-erd-checkbox">
                  <input
                    type="checkbox"
                    checked={scheduleEnabled}
                    onChange={(event) => setScheduleEnabled(event.target.checked)}
                  />
                  <span>Enable schedule</span>
                </label>
                <select
                  value={scheduleIntervalHours}
                  onChange={(event) => setScheduleIntervalHours(Number(event.target.value))}
                >
                  <option value={1}>Every 1 hour</option>
                  <option value={6}>Every 6 hours</option>
                  <option value={12}>Every 12 hours</option>
                  <option value={24}>Every 24 hours (Daily)</option>
                  <option value={168}>Every 168 hours (Weekly)</option>
                </select>
                <button
                  type="button"
                  disabled={isSavingSchedule}
                  onClick={() => void saveSchedule()}
                >
                  {isSavingSchedule ? "Saving…" : "Save schedule"}
                </button>
                <button
                  type="button"
                  disabled={isCapturing}
                  onClick={() => void triggerScheduledSnapshotNow()}
                >
                  Run scheduled capture
                </button>
              </div>
              <small className="foundry-schedule-meta">
                Status: {overview.schedule.enabled ? "Active" : "Paused"} · Interval:{" "}
                {overview.schedule.intervalHours}h
                {overview.schedule.lastCapturedAt
                  ? ` · Last captured: ${overview.schedule.lastCapturedAt.slice(0, 19).replace("T", " ")} UTC`
                  : ""}
                {overview.schedule.nextDueAt
                  ? ` · Next due: ${overview.schedule.nextDueAt.slice(0, 19).replace("T", " ")} UTC`
                  : ""}
              </small>
            </div>
          </div>

          <div className="foundry-snapshot-card foundry-diff-studio">
            <div className="foundry-diff-controls">
              <div>
                <h5>Schema &amp; Environment Diff Studio</h5>
                <small>
                  Compare any two snapshots or compare a saved snapshot against the live connected
                  database across environments.
                </small>
              </div>
              <div className="foundry-diff-selectors">
                <label>
                  <span>Base (Before)</span>
                  <select
                    value={sourceEndpointId}
                    onChange={(event) => setSourceEndpointId(event.target.value)}
                  >
                    <option value="live">
                      Live database ({overview.project.name} · {overview.project.environment})
                    </option>
                    {overview.workspaceSnapshots.map((snap) => (
                      <option key={`src-${snap.id}`} value={snap.id}>
                        [{snap.environment}] {snap.projectName} — {snap.label} (
                        {snap.fingerprint.slice(0, 8)})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Target (After)</span>
                  <select
                    value={targetEndpointId}
                    onChange={(event) => setTargetEndpointId(event.target.value)}
                  >
                    <option value="live">
                      Live database ({overview.project.name} · {overview.project.environment})
                    </option>
                    {overview.workspaceSnapshots.map((snap) => (
                      <option key={`tgt-${snap.id}`} value={snap.id}>
                        [{snap.environment}] {snap.projectName} — {snap.label} (
                        {snap.fingerprint.slice(0, 8)})
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" disabled={isComparing} onClick={() => void runSchemaDiff()}>
                  {isComparing ? "Comparing…" : "Compare schemas"}
                </button>
              </div>
            </div>

            {diffPayload ? (
              <div className="foundry-diff-results">
                <div className="foundry-diff-summary-bar">
                  <span
                    className={`foundry-diff-status-pill ${diffPayload.diff.identical ? "is-identical" : "is-changed"}`}
                  >
                    {diffPayload.diff.identical
                      ? "Identical schemas (0 false diffs)"
                      : `${diffPayload.diff.summary.totalChanges} schema changes detected`}
                  </span>
                  <span>+{diffPayload.diff.summary.addedCount} added</span>
                  <span>-{diffPayload.diff.summary.removedCount} removed</span>
                  <span>~{diffPayload.diff.summary.modifiedCount} modified</span>
                  <span>{diffPayload.diff.summary.changedTableCount} tables affected</span>
                </div>

                {!diffPayload.diff.identical ? (
                  <div className="foundry-diff-filter-row">
                    <select
                      value={diffChangeTypeFilter}
                      onChange={(event) =>
                        setDiffChangeTypeFilter(event.target.value as "all" | SchemaDiffChangeType)
                      }
                    >
                      <option value="all">All change types</option>
                      <option value="added">Added (+)</option>
                      <option value="removed">Removed (-)</option>
                      <option value="modified">Modified (~)</option>
                    </select>
                    <select
                      value={diffCategoryFilter}
                      onChange={(event) => setDiffCategoryFilter(event.target.value)}
                    >
                      <option value="all">All object categories</option>
                      <option value="table">Tables / Views</option>
                      <option value="column">Columns</option>
                      <option value="index">Indexes</option>
                      <option value="constraint">Constraints</option>
                      <option value="relation">Foreign Keys</option>
                      <option value="policy">RLS Policies</option>
                      <option value="trigger">Triggers</option>
                      <option value="function">Functions</option>
                      <option value="extension">Extensions</option>
                      <option value="schema">Schemas</option>
                    </select>
                    <input
                      type="search"
                      value={diffSearch}
                      onChange={(event) => setDiffSearch(event.target.value)}
                      placeholder="Filter diff entries by table, column, policy, or type…"
                    />
                  </div>
                ) : null}

                {diffPayload.diff.identical ? (
                  <p className="foundry-database-empty">
                    Source fingerprint ({diffPayload.diff.sourceFingerprint.slice(0, 12)}) and
                    target fingerprint ({diffPayload.diff.targetFingerprint.slice(0, 12)}) match
                    with zero structural differences.
                  </p>
                ) : filteredDiffEntries.length === 0 ? (
                  <p className="foundry-database-empty">
                    No diff entries match the selected filter criteria.
                  </p>
                ) : (
                  <div className="foundry-database-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Change</th>
                          <th>Category</th>
                          <th>Target</th>
                          <th>Summary</th>
                          <th>Before</th>
                          <th>After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDiffEntries.map((entry) => (
                          <tr key={entry.id}>
                            <td>
                              <span className={`foundry-diff-badge is-${entry.changeType}`}>
                                {entry.changeType}
                              </span>
                            </td>
                            <td>{entry.category}</td>
                            <td>{entry.target}</td>
                            <td>{entry.summary}</td>
                            <td>{entry.before ?? "—"}</td>
                            <td>{entry.after ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="foundry-snapshot-card">
            <h5>Saved Normalized Schema Snapshots ({overview.workspaceSnapshots.length})</h5>
            {overview.workspaceSnapshots.length === 0 ? (
              <p className="foundry-database-empty">
                No schema snapshots have been persisted yet. Capture an on-demand snapshot above to
                establish a baseline.
              </p>
            ) : (
              <div className="foundry-database-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Label</th>
                      <th>Project / Env</th>
                      <th>Trigger</th>
                      <th>Objects</th>
                      <th>Fingerprint</th>
                      <th>Captured At</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.workspaceSnapshots.map((snap) => (
                      <tr key={snap.id}>
                        <td>{snap.label}</td>
                        <td>
                          {snap.projectName} · {snap.environment}
                        </td>
                        <td>{snap.trigger}</td>
                        <td>
                          {snap.counts.tables} tables · {snap.counts.columns} cols ·{" "}
                          {snap.counts.indexes} idx · {snap.counts.policies} policies
                        </td>
                        <td>{snap.fingerprint.slice(0, 12)}</td>
                        <td>{snap.capturedAt.slice(0, 19).replace("T", " ")} UTC</td>
                        <td>
                          <div className="foundry-database-row-actions">
                            <button type="button" onClick={() => setSourceEndpointId(snap.id)}>
                              Set Base
                            </button>
                            <button type="button" onClick={() => setTargetEndpointId(snap.id)}>
                              Set Target
                            </button>
                            {snap.projectId === projectId ? (
                              <button type="button" onClick={() => void deleteSnapshot(snap.id)}>
                                Delete
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {overview && activeTab === "maintenance" ? (
        <div className="foundry-db-insights-panel" role="tabpanel">
          <div className="foundry-advisory-banner">
            <strong>Advisory Maintenance Mode</strong>
            <span>
              All index, bloat, and vacuum recommendations below are strictly advisory. Foundry One
              never executes index drops, creations, or vacuum operations automatically without
              explicit operator action.
            </span>
          </div>

          <div className="foundry-maintenance-summary-grid">
            <div className="foundry-snapshot-card">
              <h5>Connection Pool &amp; Session Monitor</h5>
              <dl className="foundry-maintenance-stats">
                <div>
                  <dt>Total</dt>
                  <dd>
                    {overview.operations.connections.totalConnections}
                    {overview.operations.connections.maxConnections
                      ? ` / ${overview.operations.connections.maxConnections}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>Active</dt>
                  <dd>{overview.operations.connections.activeConnections}</dd>
                </div>
                <div>
                  <dt>Idle</dt>
                  <dd>{overview.operations.connections.idleConnections}</dd>
                </div>
                <div>
                  <dt>Idle in Tx</dt>
                  <dd>{overview.operations.connections.idleInTransactionConnections}</dd>
                </div>
                <div>
                  <dt>Waiting</dt>
                  <dd>{overview.operations.connections.waitingConnections}</dd>
                </div>
                <div>
                  <dt>Utilization</dt>
                  <dd>
                    {overview.operations.connections.utilizationPercent !== undefined
                      ? `${overview.operations.connections.utilizationPercent}%`
                      : "—"}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="foundry-snapshot-card">
              <h5>Backup &amp; Recovery Metadata</h5>
              <div className="foundry-backup-status">
                <span className={`foundry-diff-badge is-${overview.operations.backup.status}`}>
                  {overview.operations.backup.status}
                </span>
                {overview.operations.backup.status === "available" ? (
                  <p>
                    {overview.operations.backup.note} PITR:{" "}
                    {overview.operations.backup.pitrEnabled ? "Enabled" : "Disabled"} · Physical
                    backups: {overview.operations.backup.physicalBackupsSupported ? "Yes" : "No"}
                    {overview.operations.backup.latestBackupAt
                      ? ` · Latest: ${overview.operations.backup.latestBackupAt}`
                      : ""}
                  </p>
                ) : (
                  <p>{overview.operations.backup.reason}</p>
                )}
              </div>
              {overview.operations.degradedMetrics.length > 0 ? (
                <small className="foundry-schedule-meta">
                  Degraded metrics: {overview.operations.degradedMetrics.join(", ")}
                </small>
              ) : (
                <small className="foundry-schedule-meta">
                  All pg_stat operational telemetry probes succeeded.
                </small>
              )}
            </div>
          </div>

          <div className="foundry-snapshot-card">
            <h5>
              Advisory Index &amp; Maintenance Recommendations (
              {overview.operations.recommendations.length})
            </h5>
            {overview.operations.recommendations.length === 0 ? (
              <p className="foundry-database-empty">
                No missing foreign-key indexes, duplicate indexes, unused indexes, or vacuum bloat
                advisories detected.
              </p>
            ) : (
              <ul className="foundry-advisory-list">
                {overview.operations.recommendations.map((rec) => (
                  <li key={rec.id} className={`foundry-advisory-item is-${rec.severity}`}>
                    <div className="foundry-advisory-main">
                      <div>
                        <span className={`foundry-diff-badge is-${rec.severity}`}>
                          {rec.severity}
                        </span>
                        <strong>{rec.title}</strong>
                        <small>{rec.kind.replaceAll("_", " ")}</small>
                      </div>
                      <p>{rec.summary}</p>
                      <small>{rec.reason}</small>
                      {rec.suggestedSql ? (
                        <pre className="foundry-advisory-sql">
                          <code>{rec.suggestedSql}</code>
                        </pre>
                      ) : null}
                    </div>
                    {rec.suggestedSql ? (
                      <button
                        type="button"
                        onClick={() => copyAdvisorySql(rec.id, rec.suggestedSql!)}
                      >
                        {copiedAdvisoryId === rec.id ? "Copied SQL" : "Copy advisory SQL"}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="foundry-snapshots-top-grid">
            <div className="foundry-snapshot-card">
              <h5>
                Active &amp; Long-Running Queries / Transactions (
                {overview.operations.longRunningActivities.length})
              </h5>
              {overview.operations.longRunningActivities.length === 0 ? (
                <p className="foundry-database-empty">
                  No long-running queries or idle-in-transaction sessions active.
                </p>
              ) : (
                <div className="foundry-database-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>PID</th>
                        <th>User</th>
                        <th>State</th>
                        <th>Duration</th>
                        <th>Wait</th>
                        <th>Query Preview</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.operations.longRunningActivities.map((act) => (
                        <tr key={act.pid}>
                          <td>{act.pid}</td>
                          <td>{act.user}</td>
                          <td>{act.state}</td>
                          <td>{formatDurationMs(act.durationMs)}</td>
                          <td>
                            {act.waitEventType
                              ? `${act.waitEventType}:${act.waitEvent ?? ""}`
                              : "—"}
                          </td>
                          <td>{act.queryPreview || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="foundry-snapshot-card">
              <h5>Active Locks &amp; Contention ({overview.operations.locks.length})</h5>
              {overview.operations.locks.length === 0 ? (
                <p className="foundry-database-empty">
                  No blocking or exclusive relation locks currently held.
                </p>
              ) : (
                <div className="foundry-database-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>PID</th>
                        <th>Relation</th>
                        <th>Mode</th>
                        <th>Granted</th>
                        <th>Blocked By</th>
                        <th>Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.operations.locks.map((lock, idx) => (
                        <tr key={`${lock.pid}-${lock.mode}-${idx}`}>
                          <td>{lock.pid}</td>
                          <td>{lock.relation ?? lock.lockType}</td>
                          <td>{lock.mode}</td>
                          <td>{lock.granted ? "yes" : "waiting"}</td>
                          <td>{lock.blockedByCount}</td>
                          <td>
                            {lock.durationMs !== undefined
                              ? formatDurationMs(lock.durationMs)
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="foundry-snapshot-card">
            <h5>
              Table Sizes, Dead-Tuple Bloat &amp; Vacuum Health (
              {overview.operations.tableMaintenance.length})
            </h5>
            {overview.operations.tableMaintenance.length === 0 ? (
              <p className="foundry-database-empty">
                No user tables reported by pg_stat_user_tables.
              </p>
            ) : (
              <div className="foundry-database-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Table</th>
                      <th>Total Size</th>
                      <th>Table / Index</th>
                      <th>Live / Dead Rows</th>
                      <th>Bloat</th>
                      <th>Seq / Idx Scans</th>
                      <th>Last Vacuum / Analyze</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.operations.tableMaintenance.map((item) => (
                      <tr key={item.tableId}>
                        <td>{item.tableId}</td>
                        <td>{formatBytes(item.totalBytes)}</td>
                        <td>
                          {formatBytes(item.tableBytes)} / {formatBytes(item.indexBytes)}
                        </td>
                        <td>
                          {item.liveRows.toLocaleString()} / {item.deadRows.toLocaleString()} (
                          {Math.round(item.deadRowRatio * 100)}%)
                        </td>
                        <td>
                          <span className={`foundry-diff-badge is-bloat-${item.bloatLevel}`}>
                            {item.bloatLevel}
                          </span>
                        </td>
                        <td>
                          {item.seqScans.toLocaleString()} / {item.indexScans.toLocaleString()}
                        </td>
                        <td>
                          {(item.lastVacuum ?? item.lastAutoVacuum ?? "never").slice(0, 16)} ·{" "}
                          {(item.lastAnalyze ?? item.lastAutoAnalyze ?? "never").slice(0, 16)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="foundry-snapshot-card">
            <h5>Index Usage &amp; Footprint ({overview.operations.indexUsage.length})</h5>
            {overview.operations.indexUsage.length === 0 ? (
              <p className="foundry-database-empty">
                No user indexes reported by pg_stat_user_indexes.
              </p>
            ) : (
              <div className="foundry-database-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Index</th>
                      <th>Table</th>
                      <th>Columns</th>
                      <th>Size</th>
                      <th>Scans</th>
                      <th>Tuples Read</th>
                      <th>Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.operations.indexUsage.map((idx) => (
                      <tr key={`${idx.tableId}.${idx.indexName}`}>
                        <td>{idx.indexName}</td>
                        <td>{idx.tableId}</td>
                        <td>{idx.columns.join(", ") || "—"}</td>
                        <td>{formatBytes(idx.sizeBytes)}</td>
                        <td>{idx.scans.toLocaleString()}</td>
                        <td>{idx.tuplesRead.toLocaleString()}</td>
                        <td>
                          {[
                            idx.isPrimary ? "PK" : "",
                            idx.isUnique ? "UNIQUE" : "",
                            idx.scans === 0 && !idx.isPrimary && !idx.isUnique ? "0 SCANS" : "",
                          ]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
