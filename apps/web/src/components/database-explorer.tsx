"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  asProviderRecord,
  encodeCsv,
  parseTransferFile,
  type TransferRecord,
} from "@/lib/database-transfer";
import {
  duplicateRowValues,
  prepareRowInputValues,
  prepareRowPatchValues,
  type RowEditorInput,
} from "@/lib/database-row-editor";
import {
  ensureUniqueSchemaColumnNames,
  parseSchemaReference,
  prepareSchemaColumnDraft,
  type SchemaColumnDraft,
} from "@/lib/database-schema-editor";

interface DatabaseTable {
  readonly id: string;
  readonly name: string;
  readonly schema?: string;
  readonly kind: string;
  readonly isView?: boolean;
  readonly isMaterializedView?: boolean;
  readonly rowCount?: number;
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

interface DatabaseTableDetails {
  readonly indexes: readonly {
    readonly name: string;
    readonly definition: string;
    readonly isUnique: boolean;
    readonly isPrimary: boolean;
  }[];
  readonly constraints: readonly {
    readonly name: string;
    readonly type: string;
    readonly definition: string;
  }[];
  readonly relations: readonly {
    readonly name: string;
    readonly columns: readonly string[];
    readonly referencedTable: string;
    readonly referencedColumns: readonly string[];
  }[];
  readonly triggers: readonly string[];
  readonly policies: readonly {
    readonly name: string;
    readonly command: string;
    readonly roles: readonly string[];
    readonly usingExpression?: string;
    readonly checkExpression?: string;
  }[];
  readonly statistics?: {
    readonly estimatedRowCount: number;
    readonly liveRowCount: number;
    readonly deadRowCount: number;
    readonly totalBytes: number;
    readonly lastVacuum?: string;
    readonly lastAnalyze?: string;
  };
}

interface DatabaseCatalog {
  readonly schemas: readonly { readonly name: string }[];
  readonly functions: readonly {
    readonly id: string;
    readonly schema: string;
    readonly name: string;
    readonly returnType: string;
    readonly language: string;
  }[];
  readonly extensions: readonly { readonly name: string; readonly version: string }[];
}

interface DatabaseRow {
  readonly id: string;
  readonly values: Readonly<Record<string, string | number | boolean | null | string[]>>;
  readonly identity?: { readonly column: string; readonly value: string | number | boolean | null };
}

interface DatabaseExplorerProps {
  readonly projectId: string;
}

type DatabaseDetailTab =
  "data" | "structure" | "indexes" | "relations" | "policies" | "activity" | "statistics";
type TableColumnDraft = SchemaColumnDraft & { readonly id: number };

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
  const [catalog, setCatalog] = useState<DatabaseCatalog>();
  const [selectedTable, setSelectedTable] = useState<string>();
  const [activeDetailTab, setActiveDetailTab] = useState<DatabaseDetailTab>("data");
  const [columns, setColumns] = useState<readonly DatabaseColumn[]>([]);
  const [details, setDetails] = useState<DatabaseTableDetails>();
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
  const [isCreating, setIsCreating] = useState(false);
  const [isDuplicating, setIsDuplicating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSchemaSaving, setIsSchemaSaving] = useState(false);
  const [newTableName, setNewTableName] = useState("");
  const [newTableColumn, setNewTableColumn] = useState("");
  const [newTableType, setNewTableType] = useState("text");
  const [newTableNullable, setNewTableNullable] = useState(false);
  const [newTablePrimaryKey, setNewTablePrimaryKey] = useState(false);
  const [newTableUnique, setNewTableUnique] = useState(false);
  const [newTableDefault, setNewTableDefault] = useState("");
  const [newTableReference, setNewTableReference] = useState("");
  const [newTableAdditionalColumns, setNewTableAdditionalColumns] = useState<
    readonly TableColumnDraft[]
  >([]);
  const [newColumnName, setNewColumnName] = useState("");
  const [newColumnType, setNewColumnType] = useState("text");
  const [newColumnNullable, setNewColumnNullable] = useState(true);
  const [newColumnUnique, setNewColumnUnique] = useState(false);
  const [newColumnDefault, setNewColumnDefault] = useState("");
  const [newColumnReference, setNewColumnReference] = useState("");
  const [newIndexName, setNewIndexName] = useState("");
  const [newIndexColumn, setNewIndexColumn] = useState("");
  const [newIndexUnique, setNewIndexUnique] = useState(false);
  const [editingRowId, setEditingRowId] = useState<string>();
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [newRowValues, setNewRowValues] = useState<RowEditorInput>({});
  const [selectedRowIds, setSelectedRowIds] = useState<ReadonlySet<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isBulkEditing, setIsBulkEditing] = useState(false);
  const [bulkEditColumn, setBulkEditColumn] = useState("");
  const [bulkEditValue, setBulkEditValue] = useState("");
  const [error, setError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      readApi<readonly DatabaseTable[]>(`/api/projects/${projectId}/database?resource=tables`),
      readApi<DatabaseCatalog>(`/api/projects/${projectId}/database?resource=catalog`),
    ])
      .then(([result, nextCatalog]) => {
        if (!active) return;
        setTables(result);
        setCatalog(nextCatalog);
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
  }, [projectId, reloadToken]);

  useEffect(() => {
    if (!selectedTable) return;
    let active = true;
    Promise.all([
      readApi<readonly DatabaseColumn[]>(
        `/api/projects/${projectId}/database?resource=columns&table=${encodeURIComponent(selectedTable)}`,
      ),
      readApi<DatabaseTableDetails>(
        `/api/projects/${projectId}/database?resource=details&table=${encodeURIComponent(selectedTable)}`,
      ),
      readApi<{ items: readonly DatabaseRow[]; nextCursor?: string }>(
        buildRowsUrl(projectId, selectedTable, { search, sortColumn, sortDirection }),
      ),
    ])
      .then(([nextColumns, nextDetails, page]) => {
        if (!active) return;
        setColumns(nextColumns);
        setDetails(nextDetails);
        setRows(page.items);
        setNextCursor(page.nextCursor);
        setSelectedRowIds(new Set());
        setIsBulkEditing(false);
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
      setSelectedRowIds(new Set());
      setIsBulkEditing(false);
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

  function startCreating() {
    setError(undefined);
    setNewRowValues(
      Object.fromEntries(
        columns.filter((column) => !column.isIdentity).map((column) => [column.name, ""]),
      ),
    );
    setIsCreating(true);
  }

  function cancelCreating() {
    setIsCreating(false);
    setNewRowValues({});
  }

  async function createRow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTable) return;
    setIsSaving(true);
    setError(undefined);
    try {
      const values = prepareRowInputValues(columns, newRowValues);
      const response = await fetch(`/api/projects/${projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ operation: "insert", table: selectedTable, values }),
      });
      const body = (await response.json()) as ApiResponse<DatabaseRow>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "The row could not be created.");
      }
      cancelCreating();
      setIsTableLoading(true);
      setReloadToken((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The row could not be created.");
    } finally {
      setIsSaving(false);
    }
  }

  async function duplicateRow(row: DatabaseRow) {
    if (!selectedTable) return;
    setIsDuplicating(true);
    setError(undefined);
    try {
      const values = duplicateRowValues(columns, row.values);
      const response = await fetch(`/api/projects/${projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ operation: "insert", table: selectedTable, values }),
      });
      const body = (await response.json()) as ApiResponse<DatabaseRow>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "The row could not be duplicated.");
      }
      setIsTableLoading(true);
      setReloadToken((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The row could not be duplicated.");
    } finally {
      setIsDuplicating(false);
    }
  }

  function toggleRowSelection(row: DatabaseRow) {
    if (!row.identity) return;
    setSelectedRowIds((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  }

  function toggleAllVisibleRows() {
    const selectableRows = rows.filter((row) => row.identity);
    setSelectedRowIds((current) => {
      const next = new Set(current);
      const allSelected = selectableRows.every((row) => next.has(row.id));
      for (const row of selectableRows) {
        if (allSelected) next.delete(row.id);
        else next.add(row.id);
      }
      return next;
    });
  }

  function startBulkEditing() {
    const firstEditableColumn = columns.find((column) => !column.isIdentity);
    if (!firstEditableColumn) {
      setError("This table has no editable columns.");
      return;
    }
    setError(undefined);
    setBulkEditColumn(firstEditableColumn.name);
    setBulkEditValue("");
    setIsBulkEditing(true);
  }

  function cancelBulkEditing() {
    setIsBulkEditing(false);
    setBulkEditColumn("");
    setBulkEditValue("");
  }

  async function applyBulkEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTable || selectedRowIds.size === 0) return;
    const selectedRows = rows.filter((row) => selectedRowIds.has(row.id));
    const identities = selectedRows.flatMap((row) => (row.identity ? [row.identity] : []));
    if (identities.length !== selectedRows.length) {
      setError("Every selected row must have a stable single-column identity.");
      return;
    }
    setError(undefined);
    try {
      const values = prepareRowPatchValues(columns, { [bulkEditColumn]: bulkEditValue });
      const response = await fetch(`/api/projects/${projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          operation: "bulk-update",
          table: selectedTable,
          identities,
          values,
        }),
      });
      const body = (await response.json()) as ApiResponse<readonly DatabaseRow[]>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "The selected rows could not be updated.");
      }
      setSelectedRowIds(new Set());
      cancelBulkEditing();
      setIsTableLoading(true);
      setReloadToken((current) => current + 1);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The selected rows could not be updated.",
      );
    }
  }

  async function deleteSelectedRows() {
    if (!selectedTable || selectedRowIds.size === 0) return;
    const selectedRows = rows.filter((row) => selectedRowIds.has(row.id));
    const identities = selectedRows.flatMap((row) => (row.identity ? [row.identity] : []));
    if (identities.length !== selectedRows.length) {
      setError("Every selected row must have a stable single-column identity.");
      return;
    }
    setIsBulkDeleting(true);
    setError(undefined);
    try {
      const prepareResponse = await fetch(`/api/projects/${projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          operation: "prepare-bulk-delete",
          table: selectedTable,
          identities,
        }),
      });
      const prepared = (await prepareResponse.json()) as ApiResponse<{ token: string }>;
      if (!prepareResponse.ok || !prepared.data) {
        throw new Error(
          prepared.error?.message ?? "A bulk deletion confirmation could not be prepared.",
        );
      }
      const confirmed = window.confirm(
        `Delete ${identities.length} selected rows from ${selectedTable}? This cannot be undone.`,
      );
      if (!confirmed) return;
      const response = await fetch(`/api/projects/${projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          operation: "bulk-delete",
          table: selectedTable,
          identities,
          confirmationToken: prepared.data.token,
        }),
      });
      const body = (await response.json()) as ApiResponse<readonly DatabaseRow[]>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "The selected rows could not be deleted.");
      }
      setSelectedRowIds(new Set());
      setIsTableLoading(true);
      setReloadToken((current) => current + 1);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The selected rows could not be deleted.",
      );
    } finally {
      setIsBulkDeleting(false);
    }
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

  async function createTable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const table = newTableName.trim();
    const column = newTableColumn.trim();
    if (!table || !column) {
      setError("A table name and first column are required.");
      return;
    }
    try {
      const definitions = [
        prepareSchemaColumnDraft({
          name: newTableColumn,
          dataType: newTableType,
          nullable: newTableNullable,
          isPrimaryKey: newTablePrimaryKey,
          isUnique: newTableUnique,
          defaultValue: newTableDefault,
          reference: newTableReference,
        }),
        ...newTableAdditionalColumns.map((draft) => prepareSchemaColumnDraft(draft)),
      ];
      ensureUniqueSchemaColumnNames(definitions);
      setError(undefined);
      setIsSchemaSaving(true);
      const response = await fetch(`/api/projects/${projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          operation: "create-table",
          schema: "public",
          table,
          columns: definitions,
        }),
      });
      const body = (await response.json()) as ApiResponse<DatabaseTable>;
      if (!response.ok || !body.data)
        throw new Error(body.error?.message ?? "The table could not be created.");
      setNewTableName("");
      setNewTableColumn("");
      setNewTableDefault("");
      setNewTableNullable(false);
      setNewTablePrimaryKey(false);
      setNewTableUnique(false);
      setNewTableReference("");
      setNewTableAdditionalColumns([]);
      setSelectedTable(body.data.id);
      setReloadToken((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The table could not be created.");
    } finally {
      setIsSchemaSaving(false);
    }
  }

  function addTableColumnDraft() {
    setNewTableAdditionalColumns((current) => [
      ...current,
      {
        id: current.length === 0 ? 1 : Math.max(...current.map((draft) => draft.id)) + 1,
        name: "",
        dataType: "text",
        nullable: true,
      },
    ]);
  }

  function updateTableColumnDraft(id: number, update: Partial<SchemaColumnDraft>) {
    setNewTableAdditionalColumns((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, ...update } : draft)),
    );
  }

  async function addColumn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const column = newColumnName.trim();
    if (!selectedTable || !column) {
      setError("A column name is required.");
      return;
    }
    let references;
    try {
      references = parseSchemaReference(newColumnReference);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The column reference is invalid.");
      return;
    }
    setIsSchemaSaving(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/projects/${projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          operation: "add-column",
          table: selectedTable,
          column: {
            name: column,
            dataType: newColumnType,
            nullable: newColumnNullable,
            ...(newColumnUnique ? { isUnique: true } : {}),
            ...(newColumnDefault.trim() ? { defaultValue: newColumnDefault.trim() } : {}),
            ...(references ? { references } : {}),
          },
        }),
      });
      const body = (await response.json()) as ApiResponse<DatabaseColumn>;
      if (!response.ok || !body.data)
        throw new Error(body.error?.message ?? "The column could not be added.");
      setNewColumnName("");
      setNewColumnDefault("");
      setNewColumnNullable(true);
      setNewColumnUnique(false);
      setNewColumnReference("");
      setReloadToken((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The column could not be added.");
    } finally {
      setIsSchemaSaving(false);
    }
  }

  async function createIndex(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTable || !newIndexColumn) {
      setError("Choose a column before creating an index.");
      return;
    }
    setIsSchemaSaving(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/projects/${projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          operation: "create-index",
          table: selectedTable,
          index: {
            column: newIndexColumn,
            isUnique: newIndexUnique,
            ...(newIndexName.trim() ? { name: newIndexName.trim() } : {}),
          },
        }),
      });
      const body = (await response.json()) as ApiResponse<unknown>;
      if (!response.ok || !body.data)
        throw new Error(body.error?.message ?? "The index could not be created.");
      setNewIndexName("");
      setNewIndexColumn("");
      setNewIndexUnique(false);
      setReloadToken((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The index could not be created.");
    } finally {
      setIsSchemaSaving(false);
    }
  }

  const selectableRows = rows.filter((row) => row.identity);
  const allVisibleRowsSelected =
    selectableRows.length > 0 && selectableRows.every((row) => selectedRowIds.has(row.id));

  return (
    <div className="foundry-database-explorer">
      <div className="foundry-database-header">
        <div>
          <p className="foundry-card-eyebrow">Database explorer</p>
          <h3>PostgreSQL surface</h3>
        </div>
        <span className="foundry-project-tag">server-side read</span>
      </div>
      {catalog ? (
        <div className="foundry-database-catalog" aria-label="Database catalog summary">
          <span>{catalog.functions.length} functions</span>
          <span>{catalog.extensions.length} extensions</span>
          <span>{catalog.schemas.length} schemas</span>
        </div>
      ) : null}
      <div className="foundry-database-schema-tools">
        <form onSubmit={createTable}>
          <strong>New table</strong>
          <input
            value={newTableName}
            onChange={(event) => setNewTableName(event.target.value)}
            placeholder="table name"
          />
          <input
            value={newTableColumn}
            onChange={(event) => setNewTableColumn(event.target.value)}
            placeholder="first column"
          />
          <select value={newTableType} onChange={(event) => setNewTableType(event.target.value)}>
            <option value="text">text</option>
            <option value="integer">integer</option>
            <option value="boolean">boolean</option>
            <option value="uuid">uuid</option>
            <option value="timestamp with time zone">timestamp with time zone</option>
          </select>
          <label>
            <input
              type="checkbox"
              checked={newTableNullable}
              disabled={newTablePrimaryKey}
              onChange={(event) => setNewTableNullable(event.target.checked)}
            />
            nullable
          </label>
          <label>
            <input
              type="checkbox"
              checked={newTablePrimaryKey}
              onChange={(event) => {
                setNewTablePrimaryKey(event.target.checked);
                if (event.target.checked) setNewTableUnique(false);
              }}
            />
            primary key
          </label>
          <label>
            <input
              type="checkbox"
              checked={newTableUnique}
              disabled={newTablePrimaryKey}
              onChange={(event) => setNewTableUnique(event.target.checked)}
            />
            unique
          </label>
          <input
            value={newTableDefault}
            onChange={(event) => setNewTableDefault(event.target.value)}
            placeholder="default (optional)"
            aria-label="New table column default"
          />
          <input
            value={newTableReference}
            onChange={(event) => setNewTableReference(event.target.value)}
            placeholder="reference: schema.table.column"
            aria-label="New table column foreign key reference"
          />
          {newTableAdditionalColumns.map((draft) => (
            <div key={draft.id} className="foundry-database-column-draft">
              <input
                value={draft.name}
                onChange={(event) => updateTableColumnDraft(draft.id, { name: event.target.value })}
                placeholder="additional column"
                aria-label={`Additional column ${draft.id} name`}
              />
              <select
                value={draft.dataType}
                onChange={(event) =>
                  updateTableColumnDraft(draft.id, { dataType: event.target.value })
                }
                aria-label={`Additional column ${draft.id} type`}
              >
                <option value="text">text</option>
                <option value="integer">integer</option>
                <option value="boolean">boolean</option>
                <option value="uuid">uuid</option>
                <option value="timestamp with time zone">timestamp with time zone</option>
              </select>
              <label>
                <input
                  type="checkbox"
                  checked={draft.nullable}
                  onChange={(event) =>
                    updateTableColumnDraft(draft.id, { nullable: event.target.checked })
                  }
                />
                nullable
              </label>
              <input
                value={draft.defaultValue ?? ""}
                onChange={(event) =>
                  updateTableColumnDraft(draft.id, { defaultValue: event.target.value })
                }
                placeholder="default (optional)"
                aria-label={`Additional column ${draft.id} default`}
              />
              <button
                type="button"
                onClick={() =>
                  setNewTableAdditionalColumns((current) =>
                    current.filter((candidate) => candidate.id !== draft.id),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={addTableColumnDraft} disabled={isSchemaSaving}>
            Add column definition
          </button>
          <button type="submit" disabled={isSchemaSaving}>
            Create
          </button>
        </form>
        {selectedTable ? (
          <form onSubmit={addColumn}>
            <strong>Add column</strong>
            <input
              value={newColumnName}
              onChange={(event) => setNewColumnName(event.target.value)}
              placeholder="column name"
            />
            <select
              value={newColumnType}
              onChange={(event) => setNewColumnType(event.target.value)}
            >
              <option value="text">text</option>
              <option value="integer">integer</option>
              <option value="boolean">boolean</option>
              <option value="uuid">uuid</option>
              <option value="timestamp with time zone">timestamp with time zone</option>
            </select>
            <label>
              <input
                type="checkbox"
                checked={newColumnNullable}
                onChange={(event) => setNewColumnNullable(event.target.checked)}
              />
              nullable
            </label>
            <label>
              <input
                type="checkbox"
                checked={newColumnUnique}
                onChange={(event) => setNewColumnUnique(event.target.checked)}
              />
              unique
            </label>
            <input
              value={newColumnDefault}
              onChange={(event) => setNewColumnDefault(event.target.value)}
              placeholder="default (optional)"
              aria-label="New column default"
            />
            <input
              value={newColumnReference}
              onChange={(event) => setNewColumnReference(event.target.value)}
              placeholder="reference: schema.table.column"
              aria-label="New column foreign key reference"
            />
            <button type="submit" disabled={isSchemaSaving}>
              Add
            </button>
          </form>
        ) : null}
        {selectedTable && columns.length > 0 ? (
          <form onSubmit={createIndex}>
            <strong>New index</strong>
            <select
              value={newIndexColumn}
              onChange={(event) => setNewIndexColumn(event.target.value)}
              aria-label="Indexed column"
            >
              <option value="">choose column</option>
              {columns.map((column) => (
                <option key={column.id} value={column.name}>
                  {column.name}
                </option>
              ))}
            </select>
            <input
              value={newIndexName}
              onChange={(event) => setNewIndexName(event.target.value)}
              placeholder="index name (optional)"
              aria-label="Index name"
            />
            <label>
              <input
                type="checkbox"
                checked={newIndexUnique}
                onChange={(event) => setNewIndexUnique(event.target.checked)}
              />
              unique
            </label>
            <button type="submit" disabled={isSchemaSaving}>
              Create index
            </button>
          </form>
        ) : null}
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
      {selectedTable && columns.length > 0 ? (
        <div className="foundry-database-row-form">
          {!isCreating ? (
            <button type="button" onClick={startCreating} disabled={isTableLoading}>
              + Add row
            </button>
          ) : (
            <form onSubmit={createRow}>
              <strong>Add row</strong>
              <div className="foundry-database-row-fields">
                {columns
                  .filter((column) => !column.isIdentity)
                  .map((column) => (
                    <label key={column.id}>
                      {column.name}
                      {column.dataType.includes("boolean") ? (
                        <select
                          value={newRowValues[column.name] ?? ""}
                          disabled={isSaving}
                          onChange={(event) =>
                            setNewRowValues((current) => ({
                              ...current,
                              [column.name]: event.target.value,
                            }))
                          }
                        >
                          <option value="">Use default / null</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input
                          value={newRowValues[column.name] ?? ""}
                          inputMode={
                            column.dataType.includes("int") || column.dataType.includes("numeric")
                              ? "decimal"
                              : undefined
                          }
                          placeholder={column.defaultValue ? "Use default" : undefined}
                          disabled={isSaving}
                          onChange={(event) =>
                            setNewRowValues((current) => ({
                              ...current,
                              [column.name]: event.target.value,
                            }))
                          }
                        />
                      )}
                    </label>
                  ))}
              </div>
              <span className="foundry-database-row-actions">
                <button type="submit" disabled={isSaving}>
                  {isSaving ? "Creating…" : "Create row"}
                </button>
                <button type="button" disabled={isSaving} onClick={cancelCreating}>
                  Cancel
                </button>
              </span>
            </form>
          )}
        </div>
      ) : null}
      {selectedRowIds.size > 0 ? (
        <div className="foundry-database-bulk-actions" aria-live="polite">
          <strong>{selectedRowIds.size} rows selected</strong>
          {!isBulkEditing ? (
            <>
              <button type="button" disabled={isBulkDeleting} onClick={startBulkEditing}>
                Bulk edit
              </button>
              <button type="button" disabled={isBulkDeleting} onClick={deleteSelectedRows}>
                {isBulkDeleting ? "Deleting…" : "Delete selected"}
              </button>
              <button
                type="button"
                disabled={isBulkDeleting}
                onClick={() => setSelectedRowIds(new Set())}
              >
                Clear selection
              </button>
            </>
          ) : (
            <form onSubmit={applyBulkEdit}>
              <label>
                Column
                <select
                  value={bulkEditColumn}
                  onChange={(event) => {
                    setBulkEditColumn(event.target.value);
                    setBulkEditValue("");
                  }}
                >
                  {columns
                    .filter((column) => !column.isIdentity)
                    .map((column) => (
                      <option key={column.id} value={column.name}>
                        {column.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Value
                <input
                  value={bulkEditValue}
                  onChange={(event) => setBulkEditValue(event.target.value)}
                />
              </label>
              <button type="submit">Apply edit</button>
              <button type="button" onClick={cancelBulkEditing}>
                Cancel
              </button>
            </form>
          )}
        </div>
      ) : null}
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
                  setActiveDetailTab("data");
                  setSelectedTable(table.id);
                }}
              >
                <span>{table.name}</span>
                <small>
                  {table.schema}
                  {table.isMaterializedView
                    ? " · materialized view"
                    : table.isView
                      ? " · view"
                      : ""}
                  {table.rowCount !== undefined ? ` · ${table.rowCount.toLocaleString()} rows` : ""}
                </small>
              </button>
            ))}
          </div>
          <div className="foundry-database-detail">
            <div className="foundry-database-detail-header">
              <strong>{selectedTable}</strong>
              <span>{isTableLoading ? "Loading…" : `${rows.length} rows in page`}</span>
            </div>
            {details ? (
              <>
                <div className="foundry-database-metadata" aria-label="Table structure summary">
                  <span>Indexes {details.indexes.length}</span>
                  <span>Constraints {details.constraints.length}</span>
                  <span>Relations {details.relations.length}</span>
                  <span>Policies {details.policies.length}</span>
                  <span>Triggers {details.triggers.length}</span>
                </div>
                <div className="foundry-database-tabs" role="tablist" aria-label="Table details">
                  {(
                    [
                      ["data", "Data"],
                      ["structure", "Structure"],
                      ["indexes", "Indexes"],
                      ["relations", "Relations"],
                      ["policies", "Policies"],
                      ["activity", "Activity"],
                      ["statistics", "Statistics"],
                    ] as const
                  ).map(([tab, label]) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeDetailTab === tab}
                      className={activeDetailTab === tab ? "is-selected" : ""}
                      key={tab}
                      onClick={() => setActiveDetailTab(tab)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {activeDetailTab === "data" ? (
              <>
                <div className="foundry-database-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            checked={allVisibleRowsSelected}
                            disabled={selectableRows.length === 0 || isBulkDeleting}
                            onChange={toggleAllVisibleRows}
                            aria-label="Select all rows with a stable identity"
                          />
                        </th>
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
                          <td>
                            <input
                              type="checkbox"
                              checked={row.identity ? selectedRowIds.has(row.id) : false}
                              disabled={!row.identity || isBulkDeleting}
                              onChange={() => toggleRowSelection(row)}
                              aria-label={
                                row.identity
                                  ? `Select row ${String(row.identity.value)}`
                                  : "Row cannot be selected without a stable identity"
                              }
                            />
                          </td>
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
                                  disabled={isDuplicating}
                                  onClick={() => duplicateRow(row)}
                                >
                                  {isDuplicating ? "Duplicating…" : "Duplicate"}
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
                  <button
                    type="button"
                    disabled={!nextCursor || isTableLoading}
                    onClick={loadNextPage}
                  >
                    Next page →
                  </button>
                </div>
              </>
            ) : (
              <DatabaseDetailPanel tab={activeDetailTab} columns={columns} details={details} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DatabaseDetailPanel({
  tab,
  columns,
  details,
}: {
  readonly tab: Exclude<DatabaseDetailTab, "data">;
  readonly columns: readonly DatabaseColumn[];
  readonly details: DatabaseTableDetails | undefined;
}) {
  if (!details) return <p className="foundry-database-empty">Table details are still loading.</p>;
  if (tab === "structure") {
    return (
      <div className="foundry-database-detail-panel" role="tabpanel">
        <h4>Structure</h4>
        <table>
          <thead>
            <tr>
              <th>Column</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th>Identity</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column.id}>
                <td>
                  {column.name}
                  {column.isPrimaryKey ? " · PK" : ""}
                </td>
                <td>{column.dataType}</td>
                <td>{column.nullable ? "yes" : "no"}</td>
                <td>{column.defaultValue ?? "—"}</td>
                <td>{column.isIdentity ? "generated" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (tab === "indexes") {
    return (
      <div className="foundry-database-detail-panel" role="tabpanel">
        <h4>Indexes</h4>
        {details.indexes.length === 0 ? (
          <p className="foundry-database-empty">No indexes reported for this table.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Definition</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {details.indexes.map((index) => (
                <tr key={index.name}>
                  <td>{index.name}</td>
                  <td>{index.definition}</td>
                  <td>
                    {[index.isPrimary ? "primary" : "", index.isUnique ? "unique" : ""]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }
  if (tab === "relations") {
    return (
      <div className="foundry-database-detail-panel" role="tabpanel">
        <h4>Relations and constraints</h4>
        {details.relations.length === 0 && details.constraints.length === 0 ? (
          <p className="foundry-database-empty">No relations or constraints reported.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Relation</th>
                  <th>Columns</th>
                  <th>References</th>
                </tr>
              </thead>
              <tbody>
                {details.relations.map((relation) => (
                  <tr key={relation.name}>
                    <td>{relation.name}</td>
                    <td>{relation.columns.join(", ")}</td>
                    <td>{`${relation.referencedTable} (${relation.referencedColumns.join(", ")})`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul>
              {details.constraints.map((constraint) => (
                <li key={constraint.name}>
                  {constraint.name} · {constraint.type} · {constraint.definition}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }
  if (tab === "policies") {
    return (
      <div className="foundry-database-detail-panel" role="tabpanel">
        <h4>Row-level security policies</h4>
        {details.policies.length === 0 ? (
          <p className="foundry-database-empty">No policies reported for this table.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Command</th>
                <th>Roles</th>
                <th>Using</th>
                <th>With check</th>
              </tr>
            </thead>
            <tbody>
              {details.policies.map((policy) => (
                <tr key={policy.name}>
                  <td>{policy.name}</td>
                  <td>{policy.command}</td>
                  <td>{policy.roles.join(", ") || "—"}</td>
                  <td>{policy.usingExpression ?? "—"}</td>
                  <td>{policy.checkExpression ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }
  if (tab === "statistics") {
    const statistics = details.statistics;
    return (
      <div className="foundry-database-detail-panel" role="tabpanel">
        <h4>Table statistics</h4>
        {!statistics ? (
          <p className="foundry-database-empty">Statistics are not available for this table.</p>
        ) : (
          <dl className="foundry-database-statistics">
            <div>
              <dt>Estimated rows</dt>
              <dd>{statistics.estimatedRowCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Live rows</dt>
              <dd>{statistics.liveRowCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Dead rows</dt>
              <dd>{statistics.deadRowCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Total size</dt>
              <dd>{formatBytes(statistics.totalBytes)}</dd>
            </div>
            <div>
              <dt>Last vacuum</dt>
              <dd>{statistics.lastVacuum ?? "—"}</dd>
            </div>
            <div>
              <dt>Last analyze</dt>
              <dd>{statistics.lastAnalyze ?? "—"}</dd>
            </div>
          </dl>
        )}
      </div>
    );
  }
  return (
    <div className="foundry-database-detail-panel" role="tabpanel">
      <h4>Activity</h4>
      {details.triggers.length === 0 ? (
        <p className="foundry-database-empty">No triggers reported for this table.</p>
      ) : (
        <ul>
          {details.triggers.map((trigger) => (
            <li key={trigger}>{trigger}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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
