"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { classifySql, type SqlClassification } from "@foundry/security";
import { encodeCsv, type TransferRecord } from "@/lib/database-transfer";
import { fetchDatabaseApi, type DatabaseApiResponse } from "@/lib/database-api";
import {
  buildSqlAutocompleteSuggestions,
  groupSavedQueriesByFolder,
  tokenizeSqlForHighlight,
  type SqlHistoryItem,
} from "@/lib/sql-studio";

interface SavedQueryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly createdById: string;
  readonly name: string;
  readonly folder?: string;
  readonly sqlText: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SqlQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, string | number | boolean | null | string[]>>[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly durationMs: number;
}

interface PendingSqlConfirmation {
  readonly sql: string;
  readonly classification: SqlClassification;
  readonly estimatedRows?: number;
  readonly token: string;
  readonly expiresAt: string;
}

interface QueryTab {
  readonly id: string;
  readonly title: string;
  readonly sql: string;
  readonly maxRows: number;
  readonly savedQueryId?: string;
  readonly folder?: string;
  readonly result?: SqlQueryResult;
  readonly lastClassification?: SqlClassification;
  readonly estimatedRows?: number;
  readonly pendingConfirmation?: PendingSqlConfirmation;
  readonly error?: string;
}

export interface SqlStudioProps {
  readonly projectId: string;
  readonly tables: readonly {
    readonly id: string;
    readonly name: string;
    readonly schema?: string;
  }[];
  readonly columns: readonly {
    readonly name: string;
    readonly dataType?: string;
  }[];
  readonly schemas: readonly string[];
  readonly selectedTable?: string;
  readonly onDatabaseMutated?: () => void;
}

function inspectDraftSql(sql: string): SqlClassification | undefined {
  try {
    return classifySql(sql);
  } catch {
    return undefined;
  }
}

function extractCurrentWord(sql: string): string {
  const match = /([A-Za-z0-9_."]+)$/.exec(sql.trimEnd());
  return match?.[1] ?? "";
}

function formatResultCell(value: string | number | boolean | null | string[] | undefined): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function downloadQueryResults(
  format: "csv" | "json",
  tabTitle: string,
  result: SqlQueryResult,
): void {
  const headers = [...result.columns];
  const content =
    format === "json"
      ? JSON.stringify(result.rows, null, 2)
      : encodeCsv(headers, result.rows as readonly TransferRecord[]);
  const blob = new Blob([content], {
    type: format === "json" ? "application/json" : "text/csv",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const safeName = tabTitle.trim().replace(/[^A-Za-z0-9_.-]/g, "_") || "query_results";
  link.download = `${safeName}.${format}`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function SqlStudio({
  projectId,
  tables,
  columns,
  schemas,
  selectedTable,
  onDatabaseMutated,
}: SqlStudioProps) {
  const defaultTable = selectedTable ?? tables[0]?.id ?? "public.users";
  const [tabs, setTabs] = useState<readonly QueryTab[]>(() => [
    {
      id: "tab-1",
      title: "Query 1",
      sql: `SELECT * FROM ${defaultTable} LIMIT 25;`,
      maxRows: 100,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState("tab-1");
  const [savedQueries, setSavedQueries] = useState<readonly SavedQueryRecord[]>([]);
  const [history, setHistory] = useState<readonly SqlHistoryItem[]>([]);
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [isSavingQuery, setIsSavingQuery] = useState(false);
  const [saveName, setSaveName] = useState("Active inspection");
  const [saveFolder, setSaveFolder] = useState("Operations");
  const [workspaceError, setWorkspaceError] = useState<string>();
  const abortControllerRef = useRef<AbortController | null>(null);
  const tabCounterRef = useRef(1);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  useEffect(() => {
    let active = true;
    fetchDatabaseApi<{
      readonly savedQueries: readonly SavedQueryRecord[];
      readonly history: readonly SqlHistoryItem[];
    }>(`/api/projects/${projectId}/sql`)
      .then((data) => {
        if (!active) return;
        setSavedQueries(data.savedQueries);
        setHistory(data.history);
        setWorkspaceError(undefined);
      })
      .catch((caught: unknown) => {
        if (active) {
          setWorkspaceError(
            caught instanceof Error ? caught.message : "SQL Studio workspace could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (active) setIsWorkspaceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  async function refreshWorkspace(): Promise<void> {
    try {
      const data = await fetchDatabaseApi<{
        readonly savedQueries: readonly SavedQueryRecord[];
        readonly history: readonly SqlHistoryItem[];
      }>(`/api/projects/${projectId}/sql`);
      setSavedQueries(data.savedQueries);
      setHistory(data.history);
    } catch {
      // Keep existing workspace state if background refresh fails
    }
  }

  function updateTab(tabId: string, patch: Partial<QueryTab>): void {
    setTabs((current) => current.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)));
  }

  function addTab(initial?: {
    readonly title?: string;
    readonly sql?: string;
    readonly savedQueryId?: string;
    readonly folder?: string;
  }): void {
    tabCounterRef.current += 1;
    const nextId = `tab-${tabCounterRef.current}`;
    const nextTitle = initial?.title ?? `Query ${tabCounterRef.current}`;
    const nextSql =
      initial?.sql ?? `SELECT * FROM ${selectedTable ?? tables[0]?.id ?? "public.users"} LIMIT 25;`;
    const nextTab: QueryTab = {
      id: nextId,
      title: nextTitle,
      sql: nextSql,
      maxRows: 100,
      ...(initial?.savedQueryId ? { savedQueryId: initial.savedQueryId } : {}),
      ...(initial?.folder ? { folder: initial.folder } : {}),
    };
    setTabs((current) => [...current, nextTab]);
    setActiveTabId(nextId);
    setSaveName(nextTitle);
    setSaveFolder(initial?.folder ?? "");
  }

  function closeTab(tabId: string): void {
    if (tabs.length <= 1) return;
    const remaining = tabs.filter((tab) => tab.id !== tabId);
    setTabs(remaining);
    if (activeTabId === tabId && remaining[0]) {
      setActiveTabId(remaining[0].id);
    }
  }

  function cancelRunningQuery(): void {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsRunning(false);
    if (activeTab) {
      updateTab(activeTab.id, {
        error: "Query execution was cancelled.",
      });
    }
  }

  async function runQuery(confirmationToken?: string): Promise<void> {
    if (!activeTab) return;
    const sql = activeTab.sql.trim();
    if (!sql) {
      updateTab(activeTab.id, { error: "Enter a SQL statement before running." });
      return;
    }

    const draftClassification = inspectDraftSql(sql);
    if (!draftClassification) {
      updateTab(activeTab.id, { error: "SQL text must contain a valid statement." });
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsRunning(true);
    updateTab(activeTab.id, { error: undefined });

    try {
      if (draftClassification.requiresConfirmation && !confirmationToken) {
        const prepareResponse = await fetch(`/api/projects/${projectId}/sql`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            operation: "prepare",
            sql,
          }),
        });
        const prepareBody = (await prepareResponse.json()) as DatabaseApiResponse<{
          readonly classification: SqlClassification;
          readonly estimatedRows?: number;
          readonly confirmation?: {
            readonly token: string;
            readonly expiresAt: string;
          };
        }>;
        if (!prepareResponse.ok || !prepareBody.data?.confirmation) {
          throw new Error(
            prepareBody.error?.message ?? "Could not prepare destructive SQL confirmation.",
          );
        }
        updateTab(activeTab.id, {
          pendingConfirmation: {
            sql,
            classification: prepareBody.data.classification,
            ...(prepareBody.data.estimatedRows !== undefined
              ? { estimatedRows: prepareBody.data.estimatedRows }
              : {}),
            token: prepareBody.data.confirmation.token,
            expiresAt: prepareBody.data.confirmation.expiresAt,
          },
          error: undefined,
        });
        return;
      }

      const executeResponse = await fetch(`/api/projects/${projectId}/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          operation: "execute",
          sql,
          maxRows: activeTab.maxRows,
          ...(confirmationToken ? { confirmationToken } : {}),
        }),
      });
      const executeBody = (await executeResponse.json()) as DatabaseApiResponse<{
        readonly classification: SqlClassification;
        readonly result: SqlQueryResult;
        readonly estimatedRows?: number;
      }>;
      if (!executeResponse.ok || !executeBody.data) {
        throw new Error(executeBody.error?.message ?? "SQL query execution failed.");
      }

      updateTab(activeTab.id, {
        result: executeBody.data.result,
        lastClassification: executeBody.data.classification,
        ...(executeBody.data.estimatedRows !== undefined
          ? { estimatedRows: executeBody.data.estimatedRows }
          : { estimatedRows: undefined }),
        pendingConfirmation: undefined,
        error: undefined,
      });

      await refreshWorkspace();
      if (executeBody.data.classification.kind !== "read_only") {
        onDatabaseMutated?.();
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        return;
      }
      updateTab(activeTab.id, {
        error: caught instanceof Error ? caught.message : "SQL query execution failed.",
      });
    } finally {
      abortControllerRef.current = null;
      setIsRunning(false);
    }
  }

  async function saveActiveQuery(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!activeTab) return;
    const trimmedName = saveName.trim();
    if (!trimmedName) {
      updateTab(activeTab.id, { error: "Provide a name before saving the query." });
      return;
    }
    setIsSavingQuery(true);
    updateTab(activeTab.id, { error: undefined });
    try {
      const response = await fetch(`/api/projects/${projectId}/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          operation: "save-query",
          ...(activeTab.savedQueryId ? { queryId: activeTab.savedQueryId } : {}),
          name: trimmedName,
          ...(saveFolder.trim() ? { folder: saveFolder.trim() } : {}),
          sqlText: activeTab.sql,
        }),
      });
      const body = (await response.json()) as DatabaseApiResponse<SavedQueryRecord>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Saved query could not be stored.");
      }
      updateTab(activeTab.id, {
        title: body.data.name,
        savedQueryId: body.data.id,
        folder: body.data.folder,
      });
      await refreshWorkspace();
    } catch (caught) {
      updateTab(activeTab.id, {
        error: caught instanceof Error ? caught.message : "Saved query could not be stored.",
      });
    } finally {
      setIsSavingQuery(false);
    }
  }

  async function deleteSavedQuery(queryId: string): Promise<void> {
    try {
      const response = await fetch(`/api/projects/${projectId}/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          operation: "delete-query",
          queryId,
        }),
      });
      const body = (await response.json()) as DatabaseApiResponse<{ deleted: boolean }>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Saved query could not be deleted.");
      }
      setSavedQueries((current) => current.filter((item) => item.id !== queryId));
      setTabs((current) =>
        current.map((tab) =>
          tab.savedQueryId === queryId ? { ...tab, savedQueryId: undefined } : tab,
        ),
      );
    } catch (caught) {
      setWorkspaceError(
        caught instanceof Error ? caught.message : "Saved query could not be deleted.",
      );
    }
  }

  function applyAutocompleteSuggestion(insertText: string): void {
    if (!activeTab) return;
    const trimmedEnd = activeTab.sql.replace(/([A-Za-z0-9_."]*)$/, `${insertText} `);
    updateTab(activeTab.id, {
      sql: trimmedEnd,
      pendingConfirmation: undefined,
    });
  }

  if (!activeTab) return null;

  const draftClassification = inspectDraftSql(activeTab.sql);
  const currentPrefix = extractCurrentWord(activeTab.sql);
  const suggestions = buildSqlAutocompleteSuggestions({
    prefix: currentPrefix,
    schemas,
    tables,
    columns: columns.map((column) => ({
      name: column.name,
      ...(selectedTable ? { table: selectedTable } : {}),
      ...(column.dataType ? { dataType: column.dataType } : {}),
    })),
    limit: 8,
  });
  const highlightedTokens = tokenizeSqlForHighlight(activeTab.sql);
  const groupedSavedQueries = groupSavedQueriesByFolder(savedQueries);

  return (
    <section className="foundry-sql-studio" aria-label="SQL Studio">
      <div className="foundry-sql-studio-header">
        <div>
          <p className="foundry-card-eyebrow">SQL Studio</p>
          <h4>Multi-tab query runner, saved folders, and destructive query guardrails</h4>
        </div>
        <span className={`foundry-sql-safety-badge is-${draftClassification?.kind ?? "invalid"}`}>
          {draftClassification
            ? `${draftClassification.kind.replace("_", " ")} · ${draftClassification.statementCount} stmt${draftClassification.statementCount === 1 ? "" : "s"}`
            : "awaiting valid SQL"}
        </span>
      </div>

      <div className="foundry-sql-tabs" role="tablist" aria-label="SQL editor tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`foundry-sql-tab ${tab.id === activeTab.id ? "is-active" : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeTab.id}
              onClick={() => {
                setActiveTabId(tab.id);
                setSaveName(tab.title);
                setSaveFolder(tab.folder ?? "");
              }}
            >
              {tab.folder ? `${tab.folder} / ${tab.title}` : tab.title}
            </button>
            {tabs.length > 1 ? (
              <button
                type="button"
                className="foundry-sql-tab-close"
                aria-label={`Close ${tab.title}`}
                onClick={() => closeTab(tab.id)}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        <button type="button" className="foundry-sql-tab-add" onClick={() => addTab()}>
          + New query tab
        </button>
      </div>

      <div className="foundry-sql-workspace">
        <div className="foundry-sql-main">
          <div className="foundry-sql-editor-card">
            <div className="foundry-sql-editor-toolbar">
              <label>
                Tab name
                <input
                  value={activeTab.title}
                  onChange={(event) => updateTab(activeTab.id, { title: event.target.value })}
                  aria-label="Active query tab name"
                />
              </label>
              <label>
                Row limit
                <select
                  value={String(activeTab.maxRows)}
                  onChange={(event) =>
                    updateTab(activeTab.id, { maxRows: Number(event.target.value) })
                  }
                  aria-label="Query row limit"
                >
                  <option value="100">100 rows (default)</option>
                  <option value="250">250 rows</option>
                  <option value="500">500 rows</option>
                  <option value="1000">1,000 rows (max)</option>
                </select>
              </label>
              <div className="foundry-sql-editor-actions">
                <button
                  type="button"
                  className="foundry-button foundry-button-primary"
                  disabled={isRunning}
                  onClick={() => void runQuery()}
                >
                  {isRunning
                    ? "Running…"
                    : draftClassification?.requiresConfirmation
                      ? "Prepare & review SQL"
                      : "Run query"}
                </button>
                {isRunning ? (
                  <button
                    type="button"
                    className="foundry-button foundry-button-secondary"
                    onClick={cancelRunningQuery}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>

            <textarea
              className="foundry-sql-textarea"
              value={activeTab.sql}
              onChange={(event) =>
                updateTab(activeTab.id, {
                  sql: event.target.value,
                  pendingConfirmation: undefined,
                })
              }
              rows={6}
              spellCheck={false}
              aria-label="SQL query editor"
              placeholder="SELECT * FROM public.users LIMIT 100;"
            />

            <pre className="foundry-sql-highlight" aria-label="Syntax highlighted SQL preview">
              <code>
                {highlightedTokens.map((token, index) => (
                  <span key={`${index}-${token.type}`} className={`sql-token-${token.type}`}>
                    {token.value}
                  </span>
                ))}
              </code>
            </pre>

            <div className="foundry-sql-autocomplete" aria-label="Schema autocomplete suggestions">
              <span>Autocomplete:</span>
              {suggestions.map((suggestion) => (
                <button
                  key={`${suggestion.kind}:${suggestion.label}`}
                  type="button"
                  onClick={() => applyAutocompleteSuggestion(suggestion.insertText)}
                  title={suggestion.detail}
                >
                  <strong>{suggestion.label}</strong>
                  <small>{suggestion.kind}</small>
                </button>
              ))}
            </div>
          </div>

          {activeTab.pendingConfirmation ? (
            <div className="foundry-sql-confirmation" role="alert">
              <div>
                <strong>
                  Explicit confirmation required (
                  {activeTab.pendingConfirmation.classification.kind})
                </strong>
                <p>{activeTab.pendingConfirmation.classification.reason}</p>
                <small>
                  {activeTab.pendingConfirmation.estimatedRows !== undefined
                    ? `Estimated affected rows (EXPLAIN): ${activeTab.pendingConfirmation.estimatedRows.toLocaleString()} · `
                    : ""}
                  Single-use challenge expires at{" "}
                  {new Date(activeTab.pendingConfirmation.expiresAt).toLocaleTimeString()}
                </small>
              </div>
              <div className="foundry-sql-confirmation-actions">
                <button
                  type="button"
                  className="foundry-button foundry-button-primary"
                  disabled={isRunning}
                  onClick={() => void runQuery(activeTab.pendingConfirmation?.token)}
                >
                  Confirm & execute SQL
                </button>
                <button
                  type="button"
                  className="foundry-button foundry-button-secondary"
                  disabled={isRunning}
                  onClick={() => updateTab(activeTab.id, { pendingConfirmation: undefined })}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}

          {activeTab.error ? <p className="foundry-database-error">{activeTab.error}</p> : null}
          {workspaceError ? <p className="foundry-database-error">{workspaceError}</p> : null}

          <form className="foundry-sql-save-bar" onSubmit={saveActiveQuery}>
            <strong>{activeTab.savedQueryId ? "Update saved query" : "Save query"}</strong>
            <input
              value={saveName}
              onChange={(event) => setSaveName(event.target.value)}
              placeholder="Query name"
              aria-label="Saved query name"
            />
            <input
              value={saveFolder}
              onChange={(event) => setSaveFolder(event.target.value)}
              placeholder="Folder (optional)"
              aria-label="Saved query folder"
            />
            <button type="submit" disabled={isSavingQuery}>
              {isSavingQuery
                ? "Saving…"
                : activeTab.savedQueryId
                  ? "Update saved query"
                  : "Save to project"}
            </button>
            {activeTab.savedQueryId ? (
              <button
                type="button"
                onClick={() => updateTab(activeTab.id, { savedQueryId: undefined })}
              >
                Detach copy
              </button>
            ) : null}
          </form>

          {activeTab.result ? (
            <div className="foundry-sql-results">
              <div className="foundry-sql-results-header">
                <div>
                  <strong>Query results</strong>
                  <span>
                    {activeTab.result.rowCount.toLocaleString()} rows ·{" "}
                    {activeTab.result.durationMs} ms
                    {activeTab.estimatedRows !== undefined
                      ? ` · ~${activeTab.estimatedRows.toLocaleString()} estimated`
                      : ""}
                    {activeTab.result.truncated ? " · truncated to row limit" : ""}
                  </span>
                </div>
                <div className="foundry-sql-results-actions">
                  <button
                    type="button"
                    onClick={() =>
                      downloadQueryResults(
                        "json",
                        activeTab.title,
                        activeTab.result as SqlQueryResult,
                      )
                    }
                  >
                    Export JSON
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      downloadQueryResults(
                        "csv",
                        activeTab.title,
                        activeTab.result as SqlQueryResult,
                      )
                    }
                  >
                    Export CSV
                  </button>
                </div>
              </div>
              {activeTab.result.columns.length === 0 ? (
                <p className="foundry-database-empty">
                  Statement completed in {activeTab.result.durationMs} ms (
                  {activeTab.result.rowCount} rows affected).
                </p>
              ) : (
                <div className="foundry-database-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {activeTab.result.columns.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {activeTab.result.rows.map((row, rowIndex) => (
                        <tr key={`row-${rowIndex}`}>
                          {activeTab.result?.columns.map((column) => (
                            <td key={`${rowIndex}-${column}`}>{formatResultCell(row[column])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <p className="foundry-database-empty">
              Run a query to inspect bounded results, timing, and row counts.
            </p>
          )}
        </div>

        <aside className="foundry-sql-sidebar">
          <div className="foundry-sql-sidebar-section">
            <h5>Saved queries ({savedQueries.length})</h5>
            {isWorkspaceLoading ? (
              <p className="foundry-database-empty">Loading saved queries…</p>
            ) : groupedSavedQueries.length === 0 ? (
              <p className="foundry-database-empty">No saved queries for this project yet.</p>
            ) : (
              groupedSavedQueries.map((group) => (
                <div key={group.folder} className="foundry-sql-folder-group">
                  <strong>{group.folder}</strong>
                  <ul>
                    {group.items.map((query) => (
                      <li key={query.id}>
                        <button
                          type="button"
                          onClick={() =>
                            addTab({
                              title: query.name,
                              sql: query.sqlText,
                              savedQueryId: query.id,
                              folder: query.folder,
                            })
                          }
                        >
                          <span>{query.name}</span>
                          <small>{query.sqlText.slice(0, 64)}</small>
                        </button>
                        <button
                          type="button"
                          className="foundry-sql-delete-btn"
                          aria-label={`Delete saved query ${query.name}`}
                          onClick={() => void deleteSavedQuery(query.id)}
                        >
                          Delete
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>

          <div className="foundry-sql-sidebar-section">
            <h5>Recent query history ({history.length})</h5>
            {history.length === 0 ? (
              <p className="foundry-database-empty">No SQL executions recorded yet.</p>
            ) : (
              <ul className="foundry-sql-history-list">
                {history.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() =>
                        addTab({
                          title: `History (${entry.kind})`,
                          sql: entry.sqlPreview,
                        })
                      }
                    >
                      <span>
                        <strong>{entry.kind}</strong> · {entry.status}
                        {entry.durationMs !== undefined ? ` · ${entry.durationMs} ms` : ""}
                        {entry.rowCount !== undefined ? ` · ${entry.rowCount} rows` : ""}
                      </span>
                      <code>{entry.sqlPreview}</code>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
