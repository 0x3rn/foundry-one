"use client";

import { useEffect, useState } from "react";

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
  const [isLoading, setIsLoading] = useState(true);
  const [isTableLoading, setIsTableLoading] = useState(false);
  const [error, setError] = useState<string>();

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
        `/api/projects/${projectId}/database?resource=rows&table=${encodeURIComponent(selectedTable)}`,
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
  }, [projectId, selectedTable]);

  async function loadNextPage() {
    if (!selectedTable || !nextCursor) return;
    setIsTableLoading(true);
    try {
      const page = await readApi<{ items: readonly DatabaseRow[]; nextCursor?: string }>(
        `/api/projects/${projectId}/database?resource=rows&table=${encodeURIComponent(selectedTable)}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      setRows(page.items);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The next page could not be loaded.");
    } finally {
      setIsTableLoading(false);
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
                        {column.name}
                        {column.isPrimaryKey ? " · PK" : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      {columns.map((column) => (
                        <td key={column.id}>{formatCell(row.values[column.name])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="foundry-database-footer">
              <span>{columns.length} columns · stable row reads only</span>
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
