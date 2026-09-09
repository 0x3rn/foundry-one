"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  asProviderRecord,
  encodeCsv,
  parseTransferFile,
  type TransferRecord,
} from "@/lib/database-transfer";

interface DatabaseTable {
  readonly id: string;
  readonly name: string;
  readonly schema?: string;
  readonly kind: string;
  readonly isView?: boolean;
}

interface DatabaseColumn {
  readonly id: string;
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly defaultValue?: string;
  readonly isPrimaryKey: boolean;
  readonly isIdentity: boolean;
}

interface DatabaseRow {
  readonly id: string;
  readonly values: Readonly<Record<string, string | number | boolean | null | string[]>>;
  readonly identity?: { readonly column: string; readonly value: string | number | boolean | null };
}

interface DatabaseExplorerProps {
  readonly projectId: string;
}

interface ApiResponse<T> {
  readonly data?: T;
  readonly error?: { readonly message?: string };
}

async function readApi<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const body = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !body.data)
    throw new Error(body.error?.message ?? "Database request failed.");
  return body.data;
}

export function DatabaseExplorer({ projectId }: DatabaseExplorerProps) {
  const [tables, setTables] = useState<readonly DatabaseTable[]>([]);
  const [selectedTable, setSelectedTable] = useState<string>();
  const [columns, setColumns] = useState<readonly DatabaseColumn[]>([]);
  const [rows, setRows] = useState<readonly DatabaseRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [sortColumn, setSortColumn] = useState<string>();
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [isLoading, setIsLoading] = useState(true);
  const [isTableLoading, setIsTableLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editingRowId, setEditingRowId] = useState<string>();
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    readApi<readonly DatabaseTable[]>(`/api/projects/${projectId}/database?resource=tables`)
      .then((result) => {
        if (!active) return;
        setTables(result);
        setSelectedTable((current) => current ?? result[0]?.id);
      })
      .catch((caught: unknown) => {
        if (active)
          setError(
            caught instanceof Error ? caught.message : "Database tables could not be loaded.",
          );
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (!selectedTable) return;
    let active = true;
    Promise.all([
      readApi<readonly DatabaseColumn[]>(
        `/api/projects/${projectId}/database?resource=columns&table=${encodeURIComponent(selectedTable)}`,
      ),
      readApi<{ items: readonly DatabaseRow[]; nextCursor?: string }>(
        buildRowsUrl(projectId, selectedTable, { search, sortColumn, sortDirection }),
      ),
    ])
      .then(([nextColumns, page]) => {
        if (!active) return;
        setColumns(nextColumns);
        setRows(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((caught: unknown) => {
        if (active)
          setError(caught instanceof Error ? caught.message : "Table data could not be loaded.");
      })
      .finally(() => {
        if (active) setIsTableLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, selectedTable, search, sortColumn, sortDirection, reloadToken]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsTableLoading(true);
    setNextCursor(undefined);
    setSearch(searchInput.trim());
  }

  function toggleSort(column: string) {
    setIsTableLoading(true);
    setNextCursor(undefined);
    if (sortColumn === column) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  async function loadNextPage() {
    if (!selectedTable || !nextCursor) return;
    setIsTableLoading(true);
    try {
      const page = await readApi<{ items: readonly DatabaseRow[]; nextCursor?: string }>(
        buildRowsUrl(projectId, selectedTable, {
          cursor: nextCursor,
          search,
          sortColumn,
          sortDirection,
        }),
      );
      setRows(page.items);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The next page could not be loaded.");
    } finally {
      setIsTableLoading(false);
    }
  }

  function startEditing(row: DatabaseRow) {
    if (!row.identity) return;
    setError(undefined);
    setEditingRowId(row.id);
    setEditValues(
      Object.fromEntries(
        columns.map((column) => [
          column.name,
          formatCell(row.values[column.name]) === "null" ? "" : formatCell(row.values[column.name]),
        ]),
      ),
    );
  }

  function cancelEditing() {
    setEditingRowId(undefined);
    setEditValues({});
  }

  async function saveEditing(row: DatabaseRow) {
    if (!selectedTable || !row.identity) return;
    setIsSaving(true);
    setError(undefined);
    try {
      const values = Object.fromEntries(
        columns
          .filter((column) => !column.isIdentity)
          .map((column) => [column.name, parseEditorValue(editValues[column.name] ?? "", column)]),
      );
      const response = await fetch(`/api/projects/${projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          operation: "update",
          table: selectedTable,
          identity: row.identity,
          values,
        }),
      });
      const body = (await response.json()) as ApiResponse<DatabaseRow>;
      if (!response.ok || !body.data)
        throw new Error(body.error?.message ?? "The row could not be updated.");
      setRows((current) =>
        current.map((candidate) =>
          candidate.id === row.id ? (body.data as DatabaseRow) : candidate,
        ),
      );
      cancelEditing();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The row could not be updated.");
    } finally {
      setIsSaving(false);
    }
  }

  async function importRows(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedTable) return;
    setIsImporting(true);
    setError(undefined);
    try {
      const format = file.name.toLowerCase().endsWith(".json") ? "json" : "csv";
      const importedRows = parseTransferFile(await file.text(), format);
      if (importedRows.length > 100) throw new Error("Imports are limited to 100 rows per action.");
      for (const row of importedRows) {
        const response = await fetch(`/api/projects/${projectId}/database`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            operation: "insert",
            table: selectedTable,
            values: asProviderRecord(row),
          }),
        });
        const body = (await response.json()) as ApiResponse<DatabaseRow>;
        if (!response.ok || !body.data) {
          throw new Error(body.error?.message ?? "An imported row could not be inserted.");
        }
      }
      setIsTableLoading(true);
      setReloadToken((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The import could not be completed.");
    } finally {
      setIsImporting(false);
    }
  }

  async function deleteRow(row: DatabaseRow) {
    if (!selectedTable || !row.identity) return;
    setIsDeleting(true);
    setError(undefined);
    try {
      const prepareResponse = await fetch(`/api/projects/${projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          operation: "prepare-delete",
          table: selectedTable,
          identity: row.identity,
        }),
      });
      const prepared = (await prepareResponse.json()) as ApiResponse<{ token: string }>;
      if (!prepareResponse.ok || !prepared.data) {
        throw new Error(
          prepared.error?.message ?? "A deletion confirmation could not be prepared.",
        );
      }
      const confirmed = window.confirm(
        `Delete ${selectedTable} where ${row.identity.column} = ${String(row.identity.value)}? This cannot be undone.`,
      );
      if (!confirmed) return;
      const response = await fetch(`/api/projects/${projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          operation: "delete",
          table: selectedTable,
          identity: row.identity,
          confirmationToken: prepared.data.token,
        }),
      });
      const body = (await response.json()) as ApiResponse<DatabaseRow>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "The row could not be deleted.");
      }
      setRows((current) => current.filter((candidate) => candidate.id !== row.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The row could not be deleted.");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="foundry-database-explorer">
      <div className="foundry-database-header">
        <div>
          <p className="foundry-card-eyebrow">Database explorer</p>
          <h3>PostgreSQL surface</h3>
        </div>
        <span className="foundry-project-tag">server-side read</span>
      </div>
      <form className="foundry-database-toolbar" onSubmit={submitSearch}>
        <label>
          Search rows
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            maxLength={120}
            placeholder="Search all values"
          />
        </label>
        <button type="submit" disabled={isTableLoading}>
          Apply
        </button>
        {search ? <span>Filtering for “{search}”</span> : <span>All rows</span>}
      </form>
      {error ? <p className="foundry-database-error">{error}</p> : null}
      {isLoading ? (
        <p className="foundry-database-empty">Reading schemas and tables…</p>
      ) : tables.length === 0 ? (
        <p className="foundry-database-empty">No tables were returned for this connection.</p>
      ) : (
        <div className="foundry-database-grid">
          <div className="foundry-database-table-list" aria-label="Database tables">
            {tables.map((table) => (
              <button
                className={selectedTable === table.id ? "is-selected" : ""}
                type="button"
                key={table.id}
                onClick={() => {
                  setIsTableLoading(true);
                  setError(undefined);
                  setSelectedTable(table.id);
                }}
              >
                <span>{table.name}</span>
                <small>
                  {table.schema}
                  {table.isView ? " · view" : ""}
                </small>
              </button>
            ))}
          </div>
          <div className="foundry-database-detail">
            <div className="foundry-database-detail-header">
              <strong>{selectedTable}</strong>
              <span>{isTableLoading ? "Loading…" : `${rows.length} rows in page`}</span>
            </div>
            <div className="foundry-database-table-wrap">
              <table>
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th key={column.id}>
                        <button type="button" onClick={() => toggleSort(column.name)}>
                          {column.name}
                          {sortColumn === column.name
                            ? sortDirection === "asc"
                              ? " ↑"
                              : " ↓"
                            : ""}
                        </button>
                        {column.isPrimaryKey ? " · PK" : ""}
                      </th>
                    ))}
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      {columns.map((column) => {
                        const isEditing = editingRowId === row.id;
                        return (
                          <td key={column.id}>
                            {isEditing ? (
                              <input
                                value={editValues[column.name] ?? ""}
                                disabled={column.isIdentity || isSaving}
                                onChange={(event) =>
                                  setEditValues((current) => ({
                                    ...current,
                                    [column.name]: event.target.value,
                                  }))
                                }
                                aria-label={`Edit ${column.name}`}
                              />
                            ) : (
                              formatCell(row.values[column.name])
                            )}
                          </td>
                        );
                      })}
                      <td>
                        {editingRowId === row.id ? (
                          <span className="foundry-database-row-actions">
                            <button
                              type="button"
                              disabled={isSaving}
                              onClick={() => saveEditing(row)}
                            >
                              {isSaving ? "Saving…" : "Save"}
                            </button>
                            <button type="button" disabled={isSaving} onClick={cancelEditing}>
                              Cancel
                            </button>
                          </span>
                        ) : row.identity ? (
                          <span className="foundry-database-row-actions">
                            <button type="button" onClick={() => startEditing(row)}>
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={isDeleting}
                              onClick={() => deleteRow(row)}
                            >
                              Delete
                            </button>
                          </span>
                        ) : (
                          <span title="This row has no stable single-column primary key.">
                            Read-only
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="foundry-database-footer">
              <span>{columns.length} columns · stable row identity exposed when available</span>
              <button
                type="button"
                onClick={() => downloadRows("json", selectedTable, columns, rows)}
              >
                Export JSON
              </button>
              <button
                type="button"
                onClick={() => downloadRows("csv", selectedTable, columns, rows)}
              >
                Export CSV
              </button>
              <button
                type="button"
                disabled={isImporting}
                onClick={() => fileInputRef.current?.click()}
              >
                {isImporting ? "Importing…" : "Import"}
              </button>
              <input
                ref={fileInputRef}
                className="foundry-visually-hidden"
                type="file"
                accept=".csv,.json,application/json,text/csv"
                onChange={importRows}
              />
              <button type="button" disabled={!nextCursor || isTableLoading} onClick={loadNextPage}>
                Next page →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatCell(value: string | number | boolean | null | string[] | undefined): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function buildRowsUrl(
  projectId: string,
  table: string,
  query: {
    readonly cursor?: string;
    readonly search?: string;
    readonly sortColumn?: string;
    readonly sortDirection?: "asc" | "desc";
  },
): string {
  const params = new URLSearchParams({ resource: "rows", table });
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.search) params.set("search", query.search);
  if (query.sortColumn) params.set("sortColumn", query.sortColumn);
  if (query.sortDirection) params.set("sortDirection", query.sortDirection);
  return `/api/projects/${projectId}/database?${params.toString()}`;
}

function downloadRows(
  format: "csv" | "json",
  table: string | undefined,
  columns: readonly DatabaseColumn[],
  rows: readonly DatabaseRow[],
): void {
  if (!table) return;
  const headers = columns.map((column) => column.name);
  const content =
    format === "json"
      ? JSON.stringify(
          rows.map((row) => row.values),
          null,
          2,
        )
      : encodeCsv(
          headers,
          rows.map((row) => row.values as TransferRecord),
        );
  const blob = new Blob([content], { type: format === "json" ? "application/json" : "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${table.replace(/[^A-Za-z0-9_.-]/g, "_")}.${format}`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function parseEditorValue(value: string, column: DatabaseColumn): string | number | boolean | null {
  if (!value && column.nullable) return null;
  if (column.dataType.includes("boolean")) return value.toLowerCase() === "true";
  if (
    column.dataType.includes("int") ||
    column.dataType.includes("numeric") ||
    column.dataType.includes("decimal") ||
    column.dataType.includes("real") ||
    column.dataType.includes("double")
  ) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${column.name} must be a number.`);
    return parsed;
  }
  return value;
}
