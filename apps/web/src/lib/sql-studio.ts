import { classifySql, type SqlStatementKind } from "@foundry/security";

export class SqlStudioInputError extends Error {
  readonly code = "INVALID_SQL_STUDIO_INPUT" as const;

  constructor(message: string) {
    super(message);
    this.name = "SqlStudioInputError";
  }
}

export type SqlStudioMutationRequest =
  | {
      readonly operation: "prepare";
      readonly sql: string;
    }
  | {
      readonly operation: "execute";
      readonly sql: string;
      readonly maxRows?: number;
      readonly confirmationToken?: string;
    }
  | {
      readonly operation: "save-query";
      readonly queryId?: string;
      readonly name: string;
      readonly folder?: string;
      readonly sqlText: string;
    }
  | {
      readonly operation: "delete-query";
      readonly queryId: string;
    };

export interface SqlHistoryItem {
  readonly id: string;
  readonly action: string;
  readonly status: string;
  readonly result: string;
  readonly kind: SqlStatementKind;
  readonly statementCount: number;
  readonly requiresConfirmation: boolean;
  readonly sqlPreview: string;
  readonly rowCount?: number;
  readonly durationMs?: number;
  readonly truncated?: boolean;
  readonly errorCode?: string;
  readonly actorName?: string;
  readonly createdAt: string;
}

export type SqlHistoryEntry = SqlHistoryItem;

export interface SqlHighlightToken {
  readonly type:
    "keyword" | "string" | "number" | "comment" | "operator" | "identifier" | "whitespace";
  readonly value: string;
}

export interface SqlAutocompleteSuggestion {
  readonly label: string;
  readonly insertText: string;
  readonly kind: "keyword" | "schema" | "table" | "column";
  readonly detail: string;
}

export interface SavedQueryFolderGroup<
  T extends { readonly id: string; readonly name: string; readonly folder?: string },
> {
  readonly folder: string;
  readonly items: readonly T[];
  readonly queries: readonly T[];
}

const SQL_KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "TRUE",
  "FALSE",
  "AS",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "FULL",
  "ON",
  "GROUP",
  "BY",
  "ORDER",
  "ASC",
  "DESC",
  "LIMIT",
  "OFFSET",
  "HAVING",
  "DISTINCT",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "WITH",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "RETURNING",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "TABLE",
  "VIEW",
  "INDEX",
  "EXPLAIN",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
]);

export function sanitizeSqlPreview(sql: string): string {
  const collapsed = sql
    .replace(/postgres(?:ql)?:\/\/[^\s"';]+/gi, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(password|secret|token|credential|authorization|api[-_]?key|service[-_]?role[-_]?key)\b\s*(=|:)\s*('[^']*'|"[^"]*"|[^\s,;)]+)/gi,
      "$1$2[redacted]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\bsbp_[A-Za-z0-9]{12,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}

export function parseSqlStudioRequest(value: unknown): SqlStudioMutationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SqlStudioInputError("SQL Studio request body must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  const operation = body.operation;

  if (operation === "prepare") {
    if (typeof body.sql !== "string" || !body.sql.trim()) {
      throw new SqlStudioInputError("SQL text is required.");
    }
    if (body.sql.length > 20_000) {
      throw new SqlStudioInputError("SQL text must be 20,000 characters or fewer.");
    }
    return { operation: "prepare", sql: body.sql };
  }

  if (operation === "execute") {
    if (typeof body.sql !== "string" || !body.sql.trim()) {
      throw new SqlStudioInputError("SQL text is required.");
    }
    if (body.sql.length > 20_000) {
      throw new SqlStudioInputError("SQL text must be 20,000 characters or fewer.");
    }
    const maxRows = body.maxRows;
    if (
      maxRows !== undefined &&
      (typeof maxRows !== "number" || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1_000)
    ) {
      throw new SqlStudioInputError("maxRows must be an integer between 1 and 1,000.");
    }
    const confirmationToken = body.confirmationToken;
    if (
      confirmationToken !== undefined &&
      (typeof confirmationToken !== "string" ||
        !confirmationToken.trim() ||
        confirmationToken.length > 256)
    ) {
      throw new SqlStudioInputError(
        "confirmationToken must be a valid token string when provided.",
      );
    }
    return {
      operation: "execute",
      sql: body.sql,
      ...(maxRows !== undefined ? { maxRows } : {}),
      ...(typeof confirmationToken === "string"
        ? { confirmationToken: confirmationToken.trim() }
        : {}),
    };
  }

  if (operation === "save-query") {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new SqlStudioInputError("A saved query name is required.");
    }
    if (typeof body.sqlText !== "string" || !body.sqlText.trim()) {
      throw new SqlStudioInputError("SQL text is required to save a query.");
    }
    const rawQueryId = body.queryId ?? body.id;
    if (rawQueryId !== undefined && (typeof rawQueryId !== "string" || !rawQueryId.trim())) {
      throw new SqlStudioInputError("Saved query id must be a non-empty string when provided.");
    }
    if (body.folder !== undefined && typeof body.folder !== "string") {
      throw new SqlStudioInputError("Saved query folder must be a string when provided.");
    }
    return {
      operation: "save-query",
      ...(typeof rawQueryId === "string" ? { queryId: rawQueryId.trim() } : {}),
      name: body.name.trim(),
      ...(typeof body.folder === "string" && body.folder.trim()
        ? { folder: body.folder.trim() }
        : {}),
      sqlText: body.sqlText,
    };
  }

  if (operation === "delete-query") {
    const rawQueryId = body.queryId ?? body.id;
    if (typeof rawQueryId !== "string" || !rawQueryId.trim()) {
      throw new SqlStudioInputError("A saved query id is required to delete a query.");
    }
    return {
      operation: "delete-query",
      queryId: rawQueryId.trim(),
    };
  }

  throw new SqlStudioInputError("operation must be prepare, execute, save-query, or delete-query.");
}

export function normalizeSqlHistoryRecord(record: {
  readonly id: string;
  readonly action: string;
  readonly status?: string;
  readonly result?: string;
  readonly metadata: unknown;
  readonly createdAt: Date | string;
  readonly actorName?: string | null;
  readonly actor?: { readonly name: string } | null;
}): SqlHistoryItem | null {
  if (!record.id || !record.action) return null;
  const metadata =
    record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};
  const rawKind = metadata.kind;
  const kind: SqlStatementKind =
    rawKind === "read_only" ||
    rawKind === "mutation" ||
    rawKind === "destructive" ||
    rawKind === "critical"
      ? rawKind
      : record.action === "sql.destructive"
        ? "destructive"
        : "read_only";
  const statementCount =
    typeof metadata.statementCount === "number" && Number.isInteger(metadata.statementCount)
      ? metadata.statementCount
      : 1;
  const requiresConfirmation =
    typeof metadata.requiresConfirmation === "boolean"
      ? metadata.requiresConfirmation
      : record.action === "sql.destructive";
  const sqlPreview =
    typeof metadata.sqlPreview === "string" && metadata.sqlPreview.trim()
      ? sanitizeSqlPreview(metadata.sqlPreview)
      : "SQL statement";
  const rowCount =
    typeof metadata.rowCount === "number" && Number.isFinite(metadata.rowCount)
      ? metadata.rowCount
      : undefined;
  const durationMs =
    typeof metadata.durationMs === "number" && Number.isFinite(metadata.durationMs)
      ? metadata.durationMs
      : undefined;
  const truncated = typeof metadata.truncated === "boolean" ? metadata.truncated : undefined;
  const errorCode =
    typeof metadata.errorCode === "string" && metadata.errorCode.trim()
      ? metadata.errorCode
      : undefined;
  const resolvedStatus = record.status ?? record.result ?? "succeeded";
  const resolvedActorName = record.actorName ?? record.actor?.name ?? undefined;

  return {
    id: record.id,
    action: record.action,
    status: resolvedStatus,
    result: resolvedStatus,
    kind,
    statementCount,
    requiresConfirmation,
    sqlPreview,
    ...(rowCount !== undefined ? { rowCount } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(resolvedActorName ? { actorName: resolvedActorName } : {}),
    createdAt:
      typeof record.createdAt === "string" ? record.createdAt : record.createdAt.toISOString(),
  };
}

export function groupSavedQueriesByFolder<
  T extends { readonly id: string; readonly name: string; readonly folder?: string },
>(queries: readonly T[]): readonly SavedQueryFolderGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const query of queries) {
    const folder = query.folder?.trim() || "General";
    const list = groups.get(folder) ?? [];
    list.push(query);
    groups.set(folder, list);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === "General") return 1;
      if (right === "General") return -1;
      return left.localeCompare(right);
    })
    .map(([folder, items]) => ({ folder, items, queries: items }));
}

export function tokenizeSqlForHighlight(sql: string): readonly SqlHighlightToken[] {
  const tokens: SqlHighlightToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const ch = sql[index] as string;
    const next = sql[index + 1];

    if (/\s/.test(ch)) {
      let end = index + 1;
      while (end < sql.length && /\s/.test(sql[end] as string)) end += 1;
      tokens.push({ type: "whitespace", value: sql.slice(index, end) });
      index = end;
      continue;
    }

    if (ch === "-" && next === "-") {
      let end = index + 2;
      while (end < sql.length && sql[end] !== "\n") end += 1;
      tokens.push({ type: "comment", value: sql.slice(index, end) });
      index = end;
      continue;
    }

    if (ch === "/" && next === "*") {
      let end = index + 2;
      while (end < sql.length && !(sql[end] === "*" && sql[end + 1] === "/")) end += 1;
      end = Math.min(sql.length, end + 2);
      tokens.push({ type: "comment", value: sql.slice(index, end) });
      index = end;
      continue;
    }

    if (ch === "'") {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === "'" && sql[end + 1] === "'") {
          end += 2;
          continue;
        }
        if (sql[end] === "'") {
          end += 1;
          break;
        }
        end += 1;
      }
      tokens.push({ type: "string", value: sql.slice(index, end) });
      index = end;
      continue;
    }

    if (/\d/.test(ch)) {
      let end = index + 1;
      while (end < sql.length && /[\d._]/.test(sql[end] as string)) end += 1;
      tokens.push({ type: "number", value: sql.slice(index, end) });
      index = end;
      continue;
    }

    if (/[A-Za-z_"]/.test(ch)) {
      if (ch === '"') {
        let end = index + 1;
        while (end < sql.length && sql[end] !== '"') end += 1;
        end = Math.min(sql.length, end + 1);
        tokens.push({ type: "identifier", value: sql.slice(index, end) });
        index = end;
        continue;
      }
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end] as string)) end += 1;
      const word = sql.slice(index, end);
      tokens.push({
        type: SQL_KEYWORDS.has(word.toUpperCase()) ? "keyword" : "identifier",
        value: word,
      });
      index = end;
      continue;
    }

    tokens.push({ type: "operator", value: ch });
    index += 1;
  }

  return tokens;
}

export function buildSqlAutocompleteSuggestions(input: {
  readonly prefix: string;
  readonly schemas?: readonly string[];
  readonly tables?: readonly {
    readonly id?: string;
    readonly name: string;
    readonly schema?: string;
  }[];
  readonly columns?: readonly {
    readonly name: string;
    readonly table?: string;
    readonly dataType?: string;
  }[];
  readonly limit?: number;
}): readonly SqlAutocompleteSuggestion[] {
  const rawPrefix = input.prefix.replaceAll('"', "").trim().toLowerCase();
  const limit = input.limit ?? 8;
  const suggestions: SqlAutocompleteSuggestion[] = [];
  const seen = new Set<string>();

  const pushSuggestion = (suggestion: SqlAutocompleteSuggestion) => {
    const key = `${suggestion.kind}:${suggestion.label}`;
    if (seen.has(key)) return;
    if (
      rawPrefix &&
      !suggestion.label.toLowerCase().includes(rawPrefix) &&
      !suggestion.insertText.toLowerCase().includes(rawPrefix)
    ) {
      return;
    }
    seen.add(key);
    suggestions.push(suggestion);
  };

  for (const table of input.tables ?? []) {
    const qualified = table.id ?? (table.schema ? `${table.schema}.${table.name}` : table.name);
    pushSuggestion({
      label: qualified,
      insertText: qualified,
      kind: "table",
      detail: table.schema ? `Table in ${table.schema}` : "Table",
    });
  }

  for (const column of input.columns ?? []) {
    pushSuggestion({
      label: column.name,
      insertText: column.name,
      kind: "column",
      detail: [column.table, column.dataType].filter(Boolean).join(" · ") || "Column",
    });
  }

  for (const schema of input.schemas ?? []) {
    pushSuggestion({
      label: schema,
      insertText: schema,
      kind: "schema",
      detail: "Schema",
    });
  }

  for (const keyword of SQL_KEYWORDS) {
    pushSuggestion({
      label: keyword,
      insertText: keyword,
      kind: "keyword",
      detail: "SQL keyword",
    });
  }

  return suggestions.slice(0, limit);
}

export function tryClassifySqlDraft(sql: string) {
  try {
    return classifySql(sql);
  } catch {
    return null;
  }
}
