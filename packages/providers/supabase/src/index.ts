import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import postgres from "postgres";
import type {
  AuthProvider,
  BackendProvider,
  BackendProviderFactory,
  DatabaseConstraint,
  DatabaseCatalog,
  DatabaseColumnAlteration,
  DatabaseColumnDefinition,
  DatabaseExtension,
  DatabaseFunction,
  DatabaseIndex,
  DatabaseIndexDefinition,
  DatabasePolicy,
  DatabaseQueryOptions,
  DatabaseQueryResult,
  DatabaseRelation,
  DatabaseRowQuery,
  DatabaseSchema,
  DatabaseTableStatistics,
  DatabaseTableDetails,
  DatabaseProvider,
  DatabaseActiveActivity,
  DatabaseBackupMetadata,
  DatabaseConnectionSummary,
  DatabaseIndexUsage,
  DatabaseLockSummary,
  DatabaseOperationsSnapshot,
  DatabaseSchemaSnapshot,
  DatabaseTableMaintenance,
  DatabaseTableSnapshot,
  NormalizedFile,
  NormalizedColumn,
  NormalizedTable,
  NormalizedRow,
  NormalizedUser,
  ProviderConnectionResult,
  ProviderPage,
  ProviderRecord,
  ProviderProjectMetadata,
  ProviderServices,
  ProviderScalar,
  StorageProvider,
} from "@foundry/providers-core";
import {
  ProviderError,
  analyzeDatabaseMaintenance,
  buildSchemaSnapshotFromParts,
  extractIndexColumnsFromDefinition,
} from "@foundry/providers-core";
import type { ProviderCapabilities } from "@foundry/types";

const SUPABASE_MANAGEMENT_API = "https://api.supabase.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface SupabaseCredentials {
  readonly projectUrl: string;
  readonly serviceRoleKey: string;
  readonly managementApiToken?: string;
  readonly databaseUrl?: string;
}

export interface SupabaseHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export interface SupabaseHttpClient {
  request(
    url: string,
    init: { readonly method: "GET" | "POST"; readonly headers: Readonly<Record<string, string>> },
  ): Promise<SupabaseHttpResponse>;
}

export interface SupabaseDatabaseClient {
  query<T extends Record<string, unknown>>(
    query: string,
    parameters?: readonly unknown[],
  ): Promise<readonly T[]>;
  end(): Promise<void>;
}

export class SupabaseCredentialError extends Error {
  readonly code = "INVALID_SUPABASE_CREDENTIALS" as const;

  constructor(message: string) {
    super(message);
    this.name = "SupabaseCredentialError";
  }
}

function parseProjectUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new SupabaseCredentialError("projectUrl must be a valid HTTPS URL.");
  }

  if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co")) {
    throw new SupabaseCredentialError("projectUrl must point to an HTTPS Supabase project.");
  }

  return url.origin;
}

export function parseSupabaseCredentials(
  input: Readonly<Record<string, string>>,
): SupabaseCredentials {
  const projectUrl = input.projectUrl ? parseProjectUrl(input.projectUrl) : "";
  if (!projectUrl) {
    throw new SupabaseCredentialError("projectUrl is required.");
  }
  if (!input.serviceRoleKey?.trim()) {
    throw new SupabaseCredentialError("serviceRoleKey is required.");
  }

  return {
    projectUrl,
    serviceRoleKey: input.serviceRoleKey.trim(),
    ...(input.managementApiToken?.trim()
      ? { managementApiToken: input.managementApiToken.trim() }
      : {}),
    ...(input.databaseUrl?.trim() ? { databaseUrl: input.databaseUrl.trim() } : {}),
  };
}

function projectReference(projectUrl: string): string {
  const hostname = new URL(projectUrl).hostname;
  return hostname.slice(0, hostname.indexOf("."));
}

function defaultHttpClient(timeoutMs = DEFAULT_TIMEOUT_MS): SupabaseHttpClient {
  return {
    async request(url, init) {
      const controller = new globalThis.AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await globalThis.fetch(url, {
          method: init.method,
          headers: init.headers,
          signal: controller.signal,
        });
        return {
          status: response.status,
          json: async () => response.json(),
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function projectHeaders(credentials: SupabaseCredentials): Readonly<Record<string, string>> {
  return {
    apikey: credentials.serviceRoleKey,
    Authorization: `Bearer ${credentials.serviceRoleKey}`,
  };
}

function managementHeaders(credentials: SupabaseCredentials): Readonly<Record<string, string>> {
  return credentials.managementApiToken
    ? { Authorization: `Bearer ${credentials.managementApiToken}` }
    : {};
}

function normalizeHttpError(
  status: number,
  provider: "supabase",
  operation: string,
): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError("permission_missing", "Supabase denied this operation.", {
      provider,
      operation,
    });
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new ProviderError("provider_unavailable", "Supabase is temporarily unavailable.", {
      provider,
      operation,
      retryable: true,
    });
  }
  return new ProviderError("connection_failed", "Supabase rejected this operation.", {
    provider,
    operation,
  });
}

interface ProbeResult {
  readonly ok: boolean;
  readonly permissionMissing: boolean;
}

async function probe(
  client: SupabaseHttpClient,
  url: string,
  headers: Readonly<Record<string, string>>,
  operation: string,
): Promise<ProbeResult> {
  try {
    const response = await client.request(url, { method: "GET", headers });
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, permissionMissing: false };
    }
    const error = normalizeHttpError(response.status, "supabase", operation);
    return { ok: false, permissionMissing: error.code === "permission_missing" };
  } catch {
    return { ok: false, permissionMissing: false };
  }
}

function emptyCapabilities(): ProviderCapabilities {
  return {
    projectMetadata: false,
    relationalDatabase: false,
    documentDatabase: false,
    realtimeDatabase: false,
    sql: false,
    auth: false,
    storage: false,
    functions: false,
    logs: false,
    metrics: false,
    security: false,
  };
}

function asRecords(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number {
  const normalized = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(normalized) ? normalized : 0;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    throw new ProviderError("invalid_configuration", "Database identifiers must be simple names.", {
      provider: "supabase",
      operation: "validate database identifier",
    });
  }
  return `"${value}"`;
}

function splitTableReference(value: string): { readonly schema: string; readonly table: string } {
  const [schema, table, ...rest] = value.split(".");
  if (!schema || !table || rest.length > 0) {
    throw new ProviderError(
      "invalid_configuration",
      "A table reference must use the schema.table format.",
      { provider: "supabase", operation: "validate table reference" },
    );
  }
  return { schema, table };
}

function validateDataType(value: string): string {
  const normalized = value.trim();
  if (
    !/^(smallint|integer|bigint|decimal|numeric|real|double precision|boolean|text|uuid|date|json|jsonb|bytea|varchar(?:\(\d+\))?|char(?:\(\d+\))?|timestamp(?: with(?:out)? time zone)?)(\[\])?$/i.test(
      normalized,
    )
  ) {
    throw new ProviderError(
      "invalid_configuration",
      "The PostgreSQL data type is not supported by the visual schema editor.",
      { provider: "supabase", operation: "validate PostgreSQL data type" },
    );
  }
  return normalized;
}

function validateDefaultValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (
    !/^(CURRENT_TIMESTAMP|CURRENT_DATE|TRUE|FALSE|NULL|gen_random_uuid\(\)|-?\d+(?:\.\d+)?|'(?:''|[^'])*')$/i.test(
      normalized,
    )
  ) {
    throw new ProviderError(
      "invalid_configuration",
      "The default value is not supported by the visual schema editor.",
      { provider: "supabase", operation: "validate PostgreSQL default" },
    );
  }
  return normalized;
}

function validateColumnDefinition(column: DatabaseColumnDefinition): {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly isPrimaryKey: boolean;
  readonly isUnique: boolean;
  readonly defaultValue?: string;
  readonly references?: {
    readonly schema: string;
    readonly table: string;
    readonly column: string;
  };
} {
  if (!column.name.trim()) {
    throw new ProviderError("invalid_configuration", "A column name is required.", {
      provider: "supabase",
      operation: "validate PostgreSQL column",
    });
  }
  quoteIdentifier(column.name);
  if (column.isPrimaryKey && column.nullable) {
    throw new ProviderError("invalid_configuration", "A primary key column cannot be nullable.", {
      provider: "supabase",
      operation: "validate PostgreSQL column",
    });
  }
  if (column.isPrimaryKey && column.isUnique) {
    throw new ProviderError(
      "invalid_configuration",
      "A primary key is already unique; choose one constraint type.",
      { provider: "supabase", operation: "validate PostgreSQL column" },
    );
  }
  const references = column.references
    ? (() => {
        quoteIdentifier(column.references.schema);
        quoteIdentifier(column.references.table);
        quoteIdentifier(column.references.column);
        return column.references;
      })()
    : undefined;
  return {
    name: column.name,
    dataType: validateDataType(column.dataType),
    nullable: column.nullable,
    isPrimaryKey: column.isPrimaryKey ?? false,
    isUnique: column.isUnique ?? false,
    ...(validateDefaultValue(column.defaultValue)
      ? { defaultValue: validateDefaultValue(column.defaultValue) }
      : {}),
    ...(references ? { references } : {}),
  };
}

function defaultDatabaseClient(databaseUrl: string): SupabaseDatabaseClient {
  const client = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 10,
    ssl: "require",
    connection: {
      statement_timeout: DEFAULT_TIMEOUT_MS,
      lock_timeout: DEFAULT_TIMEOUT_MS,
    },
  });
  return {
    async query<T extends Record<string, unknown>>(query: string, parameters = []) {
      return (await client.unsafe<T[]>(query, [...parameters])) as readonly T[];
    },
    async end() {
      await client.end({ timeout: 5 });
    },
  };
}

function normalizeRowValue(value: unknown): string | number | boolean | null | string[] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  return JSON.stringify(value);
}

function normalizeRow(
  row: Record<string, unknown>,
  index: number,
  identityColumn?: string,
): NormalizedRow {
  const values = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeRowValue(value)]),
  );
  const stableId = identityColumn ? row[identityColumn] : undefined;
  const normalizedIdentity = stableId === undefined ? undefined : normalizeRowValue(stableId);
  const hasScalarIdentity =
    normalizedIdentity === null ||
    typeof normalizedIdentity === "string" ||
    typeof normalizedIdentity === "number" ||
    typeof normalizedIdentity === "boolean";
  return {
    id: stableId === undefined ? `row-${index}` : String(stableId),
    values,
    ...(identityColumn && hasScalarIdentity
      ? { identity: { column: identityColumn, value: normalizedIdentity as ProviderScalar } }
      : {}),
  };
}

function normalizeRowQuery(query?: DatabaseRowQuery | string): DatabaseRowQuery {
  return typeof query === "string" ? { cursor: query } : (query ?? {});
}

function sanitizeDatabaseErrorMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) {
    return "The SQL query could not be executed.";
  }
  const record = error as Error & { detail?: unknown; hint?: unknown };
  const detail =
    typeof record.detail === "string" && record.detail.trim() ? ` (${record.detail.trim()})` : "";
  const hint =
    typeof record.hint === "string" && record.hint.trim() ? ` Hint: ${record.hint.trim()}` : "";
  const combined = `${error.message.trim()}${detail}${hint}`
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/(password|secret|token|apikey|api_key)\s*=\s*[^\s,;]+/gi, "$1=[REDACTED]");
  return combined.slice(0, 320);
}

function sanitizeQueryPreview(query: string): string {
  return query
    .replace(/\s+/g, " ")
    .trim()
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/(password|secret|token|apikey|api_key)\s*=\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .slice(0, 220);
}

async function fetchSupabaseBackupMetadata(
  credentials?: SupabaseCredentials,
  httpClient?: SupabaseHttpClient,
): Promise<DatabaseBackupMetadata> {
  if (!credentials?.managementApiToken || !httpClient) {
    return {
      provider: "supabase",
      status: "unavailable",
      reason:
        "Configure a Supabase Management API token to inspect automated backup and point-in-time recovery (PITR) metadata.",
    };
  }

  try {
    const reference = projectReference(credentials.projectUrl);
    const response = await httpClient.request(
      `${SUPABASE_MANAGEMENT_API}/v1/projects/${reference}/database/backups`,
      {
        method: "GET",
        headers: managementHeaders(credentials),
      },
    );

    if (response.status === 401 || response.status === 403) {
      return {
        provider: "supabase",
        status: "unavailable",
        reason:
          "The configured Management API token lacks permission to read database backup metadata.",
      };
    }

    if (response.status === 404 || response.status === 501) {
      return {
        provider: "supabase",
        status: "unsupported",
        reason: "Database backup metadata is not exposed for this Supabase project tier.",
      };
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        provider: "supabase",
        status: "unavailable",
        reason: "Supabase backup metadata is temporarily unavailable.",
      };
    }

    const body = (await response.json()) as Record<string, unknown>;
    const backups = asRecords(body.backups);
    const pitrEnabled = Boolean(body.pitr_enabled);
    const walgEnabled = Boolean(body.walg_enabled);
    const physicalBackupsSupported =
      typeof body.physical_backup_data === "object" && body.physical_backup_data !== null
        ? true
        : backups.some((item) => Boolean(item.is_physical_backup));
    const latestBackup = backups[0];
    const latestBackupAt =
      asString(latestBackup?.inserted_at) ?? asString(latestBackup?.created_at);
    const latestBackupStatus = asString(latestBackup?.status);

    return {
      provider: "supabase",
      status: "available",
      pitrEnabled,
      walgEnabled,
      physicalBackupsSupported,
      backupCount: backups.length,
      ...(latestBackupAt ? { latestBackupAt } : {}),
      ...(latestBackupStatus ? { latestBackupStatus } : {}),
      restoreSupported: true,
      note: pitrEnabled
        ? "Point-in-time recovery (PITR) and automated backups are active."
        : backups.length > 0
          ? `${backups.length} scheduled backup${backups.length === 1 ? "" : "s"} recorded by Supabase.`
          : "Automated backups are managed by Supabase; no snapshots were listed in the response.",
    };
  } catch {
    return {
      provider: "supabase",
      status: "unavailable",
      reason: "Could not reach Supabase Management API to inspect backup metadata.",
    };
  }
}

function mapConstraintTypeChar(type: string): DatabaseConstraint["type"] {
  return (
    ({ p: "primary_key", f: "foreign_key", u: "unique", c: "check", x: "exclusion" }[
      type
    ] as DatabaseConstraint["type"]) ?? "other"
  );
}

function parseForeignKeyConstraintDefinition(
  defaultSchema: string,
  definition: string,
): {
  readonly columns: string[];
  readonly referencedTable: string;
  readonly referencedColumns: string[];
} | null {
  const match = /^FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i.exec(
    definition.trim(),
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const cleanIdent = (value: string): string => value.trim().replace(/^"+|"+$/g, "");
  const columns = match[1].split(",").map(cleanIdent).filter(Boolean);
  const referencedColumns = match[3].split(",").map(cleanIdent).filter(Boolean);
  const rawTarget = match[2].trim();
  const targetParts = rawTarget.split(".").map(cleanIdent).filter(Boolean);
  const referencedTable =
    targetParts.length >= 2
      ? `${targetParts[0]}.${targetParts[1]}`
      : `${defaultSchema}.${targetParts[0] ?? rawTarget}`;
  if (columns.length === 0 || referencedColumns.length === 0) return null;
  return { columns, referencedTable, referencedColumns };
}

function createDatabaseProvider(
  databaseUrl: string,
  client: SupabaseDatabaseClient = defaultDatabaseClient(databaseUrl),
  options?: {
    readonly credentials?: SupabaseCredentials;
    readonly httpClient?: SupabaseHttpClient;
  },
): DatabaseProvider {
  return {
    async createTable(schema, table, columns): Promise<NormalizedTable> {
      const quotedSchema = quoteIdentifier(schema);
      const quotedTable = quoteIdentifier(table);
      if (columns.length === 0 || columns.length > 50) {
        throw new ProviderError(
          "invalid_configuration",
          "A table must define between 1 and 50 columns.",
          { provider: "supabase", operation: "create PostgreSQL table" },
        );
      }
      const normalizedColumns = columns.map(validateColumnDefinition);
      const names = new Set(normalizedColumns.map((column) => column.name));
      if (names.size !== normalizedColumns.length) {
        throw new ProviderError("invalid_configuration", "Table column names must be unique.", {
          provider: "supabase",
          operation: "create PostgreSQL table",
        });
      }
      if (normalizedColumns.filter((column) => column.isPrimaryKey).length > 1) {
        throw new ProviderError(
          "invalid_configuration",
          "The visual schema editor currently supports one primary key column.",
          { provider: "supabase", operation: "create PostgreSQL table" },
        );
      }
      const definition = normalizedColumns
        .map(
          (column) =>
            `${quoteIdentifier(column.name)} ${column.dataType}${column.defaultValue ? ` DEFAULT ${column.defaultValue}` : ""}${column.isPrimaryKey ? " PRIMARY KEY" : ""}${column.isUnique ? " UNIQUE" : ""}${column.references ? ` REFERENCES ${quoteIdentifier(column.references.schema)}.${quoteIdentifier(column.references.table)} (${quoteIdentifier(column.references.column)})` : ""}${column.nullable ? "" : " NOT NULL"}`,
        )
        .join(", ");
      await client.query(`CREATE TABLE ${quotedSchema}.${quotedTable} (${definition})`);
      return { id: `${schema}.${table}`, name: table, schema, kind: "table", isView: false };
    },
    async addColumn(table, column): Promise<NormalizedColumn> {
      const reference = splitTableReference(table);
      const normalizedColumn = validateColumnDefinition(column);
      if (normalizedColumn.isPrimaryKey) {
        throw new ProviderError(
          "invalid_configuration",
          "Adding a primary key requires a table constraint workflow.",
          { provider: "supabase", operation: "add PostgreSQL column" },
        );
      }
      await client.query(
        `ALTER TABLE ${quoteIdentifier(reference.schema)}.${quoteIdentifier(reference.table)} ADD COLUMN ${quoteIdentifier(normalizedColumn.name)} ${normalizedColumn.dataType}${normalizedColumn.defaultValue ? ` DEFAULT ${normalizedColumn.defaultValue}` : ""}${normalizedColumn.isUnique ? " UNIQUE" : ""}${normalizedColumn.references ? ` REFERENCES ${quoteIdentifier(normalizedColumn.references.schema)}.${quoteIdentifier(normalizedColumn.references.table)} (${quoteIdentifier(normalizedColumn.references.column)})` : ""}${normalizedColumn.nullable ? "" : " NOT NULL"}`,
      );
      return {
        id: `${table}.${normalizedColumn.name}`,
        name: normalizedColumn.name,
        dataType: normalizedColumn.dataType,
        nullable: normalizedColumn.nullable,
        isPrimaryKey: false,
        isIdentity: false,
        ...(normalizedColumn.defaultValue ? { defaultValue: normalizedColumn.defaultValue } : {}),
      };
    },
    async alterColumn(table, column, changes: DatabaseColumnAlteration): Promise<void> {
      const reference = splitTableReference(table);
      const statements: string[] = [];
      const quotedColumn = quoteIdentifier(column);
      if (changes.dataType !== undefined) {
        statements.push(`ALTER COLUMN ${quotedColumn} TYPE ${validateDataType(changes.dataType)}`);
      }
      if (changes.nullable !== undefined) {
        statements.push(
          `ALTER COLUMN ${quotedColumn} ${changes.nullable ? "DROP NOT NULL" : "SET NOT NULL"}`,
        );
      }
      if (changes.defaultValue !== undefined) {
        const defaultValue = validateDefaultValue(changes.defaultValue ?? undefined);
        statements.push(
          defaultValue
            ? `ALTER COLUMN ${quotedColumn} SET DEFAULT ${defaultValue}`
            : `ALTER COLUMN ${quotedColumn} DROP DEFAULT`,
        );
      }
      if (statements.length === 0) {
        throw new ProviderError(
          "invalid_configuration",
          "At least one column alteration is required.",
          { provider: "supabase", operation: "alter PostgreSQL column" },
        );
      }
      await client.query(
        `ALTER TABLE ${quoteIdentifier(reference.schema)}.${quoteIdentifier(reference.table)} ${statements.join(", ")}`,
      );
    },
    async createIndex(table, index: DatabaseIndexDefinition): Promise<DatabaseIndex> {
      const reference = splitTableReference(table);
      const quotedColumn = quoteIdentifier(index.column);
      const indexName = index.name?.trim() || `${reference.table}_${index.column}_idx`;
      if (indexName.length > 63) {
        throw new ProviderError(
          "invalid_configuration",
          "PostgreSQL index names must be 63 characters or fewer.",
          { provider: "supabase", operation: "validate PostgreSQL index" },
        );
      }
      const definition = `CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(indexName)} ON ${quoteIdentifier(reference.schema)}.${quoteIdentifier(reference.table)} (${quotedColumn})`;
      await client.query(definition);
      return {
        name: indexName,
        definition,
        isUnique: index.isUnique,
        isPrimary: false,
      };
    },
    async listTables(): Promise<readonly NormalizedTable[]> {
      const rows = await client.query<{
        schema_name: string;
        table_name: string;
        table_type: string;
        row_count: number | string | null;
      }>(
        `SELECT n.nspname AS schema_name,
                c.relname AS table_name,
                CASE c.relkind
                  WHEN 'r' THEN 'BASE TABLE'
                  WHEN 'v' THEN 'VIEW'
                  WHEN 'm' THEN 'MATERIALIZED VIEW'
                END AS table_type,
                CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS row_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'v', 'm')
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY n.nspname, c.relname`,
      );
      return rows.map((row) => ({
        id: `${row.schema_name}.${row.table_name}`,
        name: row.table_name,
        schema: row.schema_name,
        kind: "table",
        isView: row.table_type !== "BASE TABLE",
        isMaterializedView: row.table_type === "MATERIALIZED VIEW",
        ...(row.row_count !== null ? { rowCount: asFiniteNumber(row.row_count) } : {}),
      }));
    },
    async listColumns(table): Promise<readonly NormalizedColumn[]> {
      const reference = splitTableReference(table);
      const rows = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        is_identity: string;
        is_primary_key: boolean;
      }>(
        `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, c.is_identity,
                EXISTS (
                  SELECT 1
                  FROM information_schema.key_column_usage k
                  JOIN information_schema.table_constraints tc
                    ON tc.constraint_name = k.constraint_name
                   AND tc.table_schema = k.table_schema
                   AND tc.table_name = k.table_name
                  WHERE k.table_schema = $1 AND k.table_name = $2
                    AND k.column_name = c.column_name
                    AND tc.constraint_type = 'PRIMARY KEY'
                ) AS is_primary_key
         FROM information_schema.columns c
         WHERE c.table_schema = $1 AND c.table_name = $2
         ORDER BY c.ordinal_position`,
        [reference.schema, reference.table],
      );
      return rows.map((row) => ({
        id: `${table}.${row.column_name}`,
        name: row.column_name,
        dataType: row.data_type,
        nullable: row.is_nullable === "YES",
        ...(row.column_default ? { defaultValue: row.column_default } : {}),
        isPrimaryKey: row.is_primary_key,
        isIdentity: row.is_identity === "YES",
      }));
    },
    async describeCatalog(): Promise<DatabaseCatalog> {
      // The default client uses one connection. Keep these catalog reads
      // sequential so postgres.js cannot leave queued introspection queries
      // unresolved when the provider is connected to a managed Supabase
      // database.
      const schemas = await client.query<{ schema_name: string }>(
        `SELECT schema_name
         FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
         ORDER BY schema_name`,
      );
      const functions = await client.query<{
        oid: number;
        schema_name: string;
        function_name: string;
        return_type: string;
        language_name: string;
      }>(
        `SELECT p.oid, n.nspname AS schema_name, p.proname AS function_name,
                pg_get_function_result(p.oid) AS return_type, l.lanname AS language_name
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY n.nspname, p.proname, p.oid`,
      );
      const extensions = await client.query<{ extname: string; extversion: string }>(
        `SELECT extname, extversion
         FROM pg_extension
         ORDER BY extname`,
      );
      return {
        schemas: schemas.map((schema) => ({ name: schema.schema_name }) satisfies DatabaseSchema),
        functions: functions.map(
          (item) =>
            ({
              id: `${item.schema_name}.${item.function_name}.${item.oid}`,
              schema: item.schema_name,
              name: item.function_name,
              returnType: item.return_type,
              language: item.language_name,
            }) satisfies DatabaseFunction,
        ),
        extensions: extensions.map(
          (item) => ({ name: item.extname, version: item.extversion }) satisfies DatabaseExtension,
        ),
      };
    },
    async describeTable(table): Promise<DatabaseTableDetails> {
      const reference = splitTableReference(table);
      const [indexes, constraints, relations, triggers, policies, statistics] = await Promise.all([
        client.query<{ indexname: string; indexdef: string }>(
          `SELECT indexname, indexdef
           FROM pg_indexes
           WHERE schemaname = $1 AND tablename = $2
           ORDER BY indexname`,
          [reference.schema, reference.table],
        ),
        client.query<{ name: string; contype: string; definition: string }>(
          `SELECT con.conname AS name, con.contype, pg_get_constraintdef(con.oid) AS definition
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = rel.relnamespace
           WHERE ns.nspname = $1 AND rel.relname = $2
           ORDER BY con.conname`,
          [reference.schema, reference.table],
        ),
        client.query<{
          constraint_name: string;
          column_name: string;
          foreign_table_schema: string;
          foreign_table_name: string;
          foreign_column_name: string;
        }>(
          `SELECT k.constraint_name, k.column_name,
                  c.table_schema AS foreign_table_schema,
                  c.table_name AS foreign_table_name,
                  c.column_name AS foreign_column_name
           FROM information_schema.key_column_usage k
           JOIN information_schema.referential_constraints r
             ON r.constraint_name = k.constraint_name
            AND r.constraint_schema = k.constraint_schema
           JOIN information_schema.constraint_column_usage c
             ON c.constraint_name = r.unique_constraint_name
            AND c.constraint_schema = r.unique_constraint_schema
           WHERE k.table_schema = $1 AND k.table_name = $2
           ORDER BY k.constraint_name, k.ordinal_position`,
          [reference.schema, reference.table],
        ),
        client.query<{ trigger_name: string }>(
          `SELECT trigger_name
           FROM information_schema.triggers
           WHERE event_object_schema = $1 AND event_object_table = $2
           ORDER BY trigger_name`,
          [reference.schema, reference.table],
        ),
        client.query<{
          policyname: string;
          cmd: string;
          roles: string[];
          qual: string | null;
          with_check: string | null;
        }>(
          `SELECT policyname, cmd, roles, qual, with_check
           FROM pg_policies
           WHERE schemaname = $1 AND tablename = $2
           ORDER BY policyname`,
          [reference.schema, reference.table],
        ),
        client.query<{
          estimated_row_count: number | string | null;
          live_row_count: number | string | null;
          dead_row_count: number | string | null;
          total_bytes: number | string | null;
          last_vacuum: string | null;
          last_analyze: string | null;
        }>(
          `SELECT c.reltuples AS estimated_row_count,
                  COALESCE(s.n_live_tup, 0) AS live_row_count,
                  COALESCE(s.n_dead_tup, 0) AS dead_row_count,
                  pg_total_relation_size(c.oid) AS total_bytes,
                  s.last_vacuum::text,
                  s.last_analyze::text
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_stat_user_tables s
             ON s.relid = c.oid
           WHERE n.nspname = $1 AND c.relname = $2
           LIMIT 1`,
          [reference.schema, reference.table],
        ),
      ]);
      const constraintType = (type: string): DatabaseConstraint["type"] =>
        (({ p: "primary_key", f: "foreign_key", u: "unique", c: "check", x: "exclusion" })[
          type
        ] as DatabaseConstraint["type"]) ?? "other";
      const groupedRelations = new Map<
        string,
        { columns: string[]; referencedTable: string; referencedColumns: string[] }
      >();
      for (const relation of relations) {
        const current = groupedRelations.get(relation.constraint_name) ?? {
          columns: [],
          referencedTable: `${relation.foreign_table_schema}.${relation.foreign_table_name}`,
          referencedColumns: [],
        };
        current.columns.push(relation.column_name);
        current.referencedColumns.push(relation.foreign_column_name);
        groupedRelations.set(relation.constraint_name, current);
      }
      for (const constraint of constraints) {
        if (constraint.contype === "f" && !groupedRelations.has(constraint.name)) {
          const parsed = parseForeignKeyConstraintDefinition(
            reference.schema,
            constraint.definition,
          );
          if (parsed) {
            groupedRelations.set(constraint.name, parsed);
          }
        }
      }
      const primaryIndexNames = new Set(
        constraints
          .filter((constraint) => constraint.contype === "p")
          .map((constraint) => constraint.name),
      );
      return {
        indexes: indexes.map(
          (index) =>
            ({
              name: index.indexname,
              definition: index.indexdef,
              isUnique: /UNIQUE INDEX/i.test(index.indexdef),
              isPrimary: primaryIndexNames.has(index.indexname),
            }) satisfies DatabaseIndex,
        ),
        constraints: constraints.map((constraint) => ({
          name: constraint.name,
          type: constraintType(constraint.contype),
          definition: constraint.definition,
        })),
        relations: [...groupedRelations.entries()].map(
          ([name, relation]) => ({ name, ...relation }) satisfies DatabaseRelation,
        ),
        triggers: triggers.map((trigger) => trigger.trigger_name),
        policies: policies.map(
          (policy) =>
            ({
              name: policy.policyname,
              command: policy.cmd,
              roles: policy.roles,
              ...(policy.qual ? { usingExpression: policy.qual } : {}),
              ...(policy.with_check ? { checkExpression: policy.with_check } : {}),
            }) satisfies DatabasePolicy,
        ),
        ...(statistics[0]
          ? {
              statistics: {
                estimatedRowCount: asFiniteNumber(statistics[0].estimated_row_count),
                liveRowCount: asFiniteNumber(statistics[0].live_row_count),
                deadRowCount: asFiniteNumber(statistics[0].dead_row_count),
                totalBytes: asFiniteNumber(statistics[0].total_bytes),
                ...(statistics[0].last_vacuum ? { lastVacuum: statistics[0].last_vacuum } : {}),
                ...(statistics[0].last_analyze ? { lastAnalyze: statistics[0].last_analyze } : {}),
              } satisfies DatabaseTableStatistics,
            }
          : {}),
      };
    },
    async executeQuery(query, options: DatabaseQueryOptions = {}): Promise<DatabaseQueryResult> {
      const startedAt = Date.now();
      const maxRows = Number.isInteger(options.maxRows)
        ? Math.min(1_000, Math.max(1, options.maxRows as number))
        : 100;
      let rows: readonly Record<string, unknown>[];
      try {
        rows = await client.query<Record<string, unknown>>(query);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("connection_failed", sanitizeDatabaseErrorMessage(error), {
          provider: "supabase",
          operation: "execute SQL query",
        });
      }
      const normalizedRows = rows.slice(0, maxRows).map((row) => {
        return Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, normalizeRowValue(value)]),
        ) as ProviderRecord;
      });
      return {
        columns: normalizedRows[0] ? Object.keys(normalizedRows[0]) : [],
        rows: normalizedRows,
        rowCount: rows.length,
        truncated: rows.length > maxRows,
        durationMs: Date.now() - startedAt,
      };
    },
    async estimateQueryRows(query): Promise<number | undefined> {
      const trimmed = query.trim().replace(/;+\s*$/, "");
      if (!trimmed || trimmed.includes(";")) return undefined;
      if (!/^(SELECT|WITH|UPDATE|DELETE|INSERT|VALUES)\b/i.test(trimmed)) {
        return undefined;
      }
      try {
        const rows = await client.query<Record<string, unknown>>(
          `EXPLAIN (FORMAT JSON) ${trimmed}`,
        );
        const planPayload = rows[0]?.["QUERY PLAN"];
        const parsed =
          typeof planPayload === "string" ? (JSON.parse(planPayload) as unknown) : planPayload;
        const firstPlan = Array.isArray(parsed)
          ? (parsed[0] as { Plan?: { "Plan Rows"?: unknown } } | undefined)
          : undefined;
        const planRows = firstPlan?.Plan?.["Plan Rows"];
        const numeric = typeof planRows === "number" ? planRows : Number(planRows);
        return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : undefined;
      } catch {
        return undefined;
      }
    },
    async listRows(table, query): Promise<ProviderPage<NormalizedRow>> {
      const reference = splitTableReference(table);
      const pageSize = 50;
      const normalizedQuery = normalizeRowQuery(query);
      const cursor = normalizedQuery.cursor;
      const offset = cursor ? Number.parseInt(cursor, 10) : 0;
      if (!Number.isInteger(offset) || offset < 0) {
        throw new ProviderError(
          "invalid_configuration",
          "The row cursor must be a non-negative integer.",
          {
            provider: "supabase",
            operation: "list database rows",
          },
        );
      }
      const search = normalizedQuery.search?.trim();
      if (search && search.length > 120) {
        throw new ProviderError(
          "invalid_configuration",
          "The row search must be 120 characters or fewer.",
          { provider: "supabase", operation: "list database rows" },
        );
      }
      const sortColumn = normalizedQuery.sortColumn?.trim();
      if (sortColumn) quoteIdentifier(sortColumn);
      const sortDirection = normalizedQuery.sortDirection ?? "asc";
      if (sortDirection !== "asc" && sortDirection !== "desc") {
        throw new ProviderError(
          "invalid_configuration",
          "The row sort direction must be asc or desc.",
          { provider: "supabase", operation: "list database rows" },
        );
      }
      const primaryKeyRows = await client.query<{ column_name: string }>(
        `SELECT k.column_name
         FROM information_schema.key_column_usage k
         JOIN information_schema.table_constraints tc
           ON tc.constraint_name = k.constraint_name
          AND tc.table_schema = k.table_schema
          AND tc.table_name = k.table_name
         WHERE k.table_schema = $1 AND k.table_name = $2
           AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY k.ordinal_position`,
        [reference.schema, reference.table],
      );
      const identityColumn =
        primaryKeyRows.length === 1 ? primaryKeyRows[0]?.column_name : undefined;
      const where = search ? "WHERE to_jsonb(t)::text ILIKE $1" : "";
      const parameterOffset = search ? 2 : 1;
      const parameters: unknown[] = search
        ? [`%${search}%`, pageSize + 1, offset]
        : [pageSize + 1, offset];
      const orderBy = sortColumn
        ? `ORDER BY ${quoteIdentifier(sortColumn)} ${sortDirection.toUpperCase()}`
        : "";
      const rows = await client.query<Record<string, unknown>>(
        `SELECT t.* FROM ${quoteIdentifier(reference.schema)}.${quoteIdentifier(reference.table)} AS t ${where} ${orderBy} LIMIT $${parameterOffset} OFFSET $${parameterOffset + 1}`,
        parameters,
      );
      const hasNextPage = rows.length > pageSize;
      return {
        items: rows
          .slice(0, pageSize)
          .map((row, index) => normalizeRow(row, offset + index, identityColumn)),
        ...(hasNextPage ? { nextCursor: String(offset + pageSize) } : {}),
      };
    },
    async insertRow(table, values): Promise<NormalizedRow> {
      const reference = splitTableReference(table);
      const entries = Object.entries(values);
      if (entries.length === 0) {
        throw new ProviderError(
          "invalid_configuration",
          "At least one column is required to insert a row.",
          {
            provider: "supabase",
            operation: "insert database row",
          },
        );
      }
      const columns = entries.map(([column]) => quoteIdentifier(column));
      const placeholders = entries.map((_, index) => `$${index + 1}`).join(", ");
      const rows = await client.query<Record<string, unknown>>(
        `INSERT INTO ${quoteIdentifier(reference.schema)}.${quoteIdentifier(reference.table)} (${columns.join(", ")}) VALUES (${placeholders}) RETURNING *`,
        entries.map(([, value]) => value),
      );
      if (!rows[0]) {
        throw new ProviderError(
          "connection_failed",
          "The database did not return the inserted row.",
          {
            provider: "supabase",
            operation: "insert database row",
          },
        );
      }
      return normalizeRow(rows[0], 0);
    },
    async updateRow(table, identity, values): Promise<NormalizedRow> {
      const reference = splitTableReference(table);
      const entries = Object.entries(values);
      if (entries.length === 0) {
        throw new ProviderError(
          "invalid_configuration",
          "At least one column is required to update a row.",
          {
            provider: "supabase",
            operation: "update database row",
          },
        );
      }
      const assignments = entries
        .map(([column], index) => `${quoteIdentifier(column)} = $${index + 1}`)
        .join(", ");
      const identityPlaceholder = `$${entries.length + 1}`;
      const rows = await client.query<Record<string, unknown>>(
        `UPDATE ${quoteIdentifier(reference.schema)}.${quoteIdentifier(reference.table)} SET ${assignments} WHERE ${quoteIdentifier(identity.column)} = ${identityPlaceholder} RETURNING *`,
        [...entries.map(([, value]) => value), identity.value],
      );
      if (!rows[0]) {
        throw new ProviderError("connection_failed", "The database row was not found for update.", {
          provider: "supabase",
          operation: "update database row",
        });
      }
      return normalizeRow(rows[0], 0);
    },
    async updateRows(table, identities, values): Promise<readonly NormalizedRow[]> {
      const reference = splitTableReference(table);
      if (identities.length === 0 || identities.length > 50) {
        throw new ProviderError(
          "invalid_configuration",
          "Bulk editing requires between 1 and 50 row identities.",
          { provider: "supabase", operation: "bulk update database rows" },
        );
      }
      const identityColumn = identities[0]?.column.trim();
      if (!identityColumn) {
        throw new ProviderError(
          "invalid_configuration",
          "Bulk editing requires a stable row identity.",
          { provider: "supabase", operation: "bulk update database rows" },
        );
      }
      quoteIdentifier(identityColumn);
      if (
        identities.some(
          (identity) => identity.column.trim() !== identityColumn || identity.value === null,
        )
      ) {
        throw new ProviderError(
          "invalid_configuration",
          "Bulk editing identities must use one non-null column.",
          { provider: "supabase", operation: "bulk update database rows" },
        );
      }
      const entries = Object.entries(values);
      if (entries.length === 0) {
        throw new ProviderError(
          "invalid_configuration",
          "Bulk editing requires at least one column value.",
          { provider: "supabase", operation: "bulk update database rows" },
        );
      }
      if (entries.some(([column]) => column === identityColumn)) {
        throw new ProviderError(
          "invalid_configuration",
          "A bulk edit cannot change the row identity.",
          { provider: "supabase", operation: "bulk update database rows" },
        );
      }
      const primaryKeyRows = await client.query<{ column_name: string }>(
        `SELECT k.column_name
         FROM information_schema.key_column_usage k
         JOIN information_schema.table_constraints tc
           ON tc.constraint_name = k.constraint_name
          AND tc.table_schema = k.table_schema
          AND tc.table_name = k.table_name
         WHERE k.table_schema = $1 AND k.table_name = $2
           AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY k.ordinal_position`,
        [reference.schema, reference.table],
      );
      if (primaryKeyRows.length !== 1 || primaryKeyRows[0]?.column_name !== identityColumn) {
        throw new ProviderError(
          "invalid_configuration",
          "Bulk editing requires a single-column primary key.",
          { provider: "supabase", operation: "bulk update database rows" },
        );
      }
      const assignments = entries
        .map(([column], index) => `${quoteIdentifier(column)} = $${index + 1}`)
        .join(", ");
      const identityOffset = entries.length + 1;
      const placeholders = identities.map((_, index) => `$${identityOffset + index}`).join(", ");
      const rows = await client.query<Record<string, unknown>>(
        `UPDATE ${quoteIdentifier(reference.schema)}.${quoteIdentifier(reference.table)} SET ${assignments} WHERE ${quoteIdentifier(identityColumn)} IN (${placeholders}) RETURNING *`,
        [...entries.map(([, value]) => value), ...identities.map((identity) => identity.value)],
      );
      return rows.map((row, index) => normalizeRow(row, index, identityColumn));
    },
    async deleteRow(table, identity): Promise<NormalizedRow> {
      const reference = splitTableReference(table);
      const rows = await client.query<Record<string, unknown>>(
        `DELETE FROM ${quoteIdentifier(reference.schema)}.${quoteIdentifier(reference.table)} WHERE ${quoteIdentifier(identity.column)} = $1 RETURNING *`,
        [identity.value],
      );
      if (!rows[0]) {
        throw new ProviderError(
          "connection_failed",
          "The database row was not found for deletion.",
          {
            provider: "supabase",
            operation: "delete database row",
          },
        );
      }
      return normalizeRow(rows[0], 0);
    },
    async deleteRows(table, identities): Promise<readonly NormalizedRow[]> {
      const reference = splitTableReference(table);
      if (identities.length === 0 || identities.length > 50) {
        throw new ProviderError(
          "invalid_configuration",
          "Bulk deletion requires between 1 and 50 row identities.",
          { provider: "supabase", operation: "bulk delete database rows" },
        );
      }
      const identityColumn = identities[0]?.column.trim();
      if (!identityColumn) {
        throw new ProviderError(
          "invalid_configuration",
          "Bulk deletion requires a stable row identity.",
          { provider: "supabase", operation: "bulk delete database rows" },
        );
      }
      quoteIdentifier(identityColumn);
      if (
        identities.some(
          (identity) => identity.column.trim() !== identityColumn || identity.value === null,
        )
      ) {
        throw new ProviderError(
          "invalid_configuration",
          "Bulk deletion identities must use one non-null column.",
          { provider: "supabase", operation: "bulk delete database rows" },
        );
      }
      const primaryKeyRows = await client.query<{ column_name: string }>(
        `SELECT k.column_name
         FROM information_schema.key_column_usage k
         JOIN information_schema.table_constraints tc
           ON tc.constraint_name = k.constraint_name
          AND tc.table_schema = k.table_schema
          AND tc.table_name = k.table_name
         WHERE k.table_schema = $1 AND k.table_name = $2
           AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY k.ordinal_position`,
        [reference.schema, reference.table],
      );
      if (primaryKeyRows.length !== 1 || primaryKeyRows[0]?.column_name !== identityColumn) {
        throw new ProviderError(
          "invalid_configuration",
          "Bulk deletion requires a single-column primary key.",
          { provider: "supabase", operation: "bulk delete database rows" },
        );
      }
      const placeholders = identities.map((_, index) => `$${index + 1}`).join(", ");
      const rows = await client.query<Record<string, unknown>>(
        `DELETE FROM ${quoteIdentifier(reference.schema)}.${quoteIdentifier(reference.table)} WHERE ${quoteIdentifier(identityColumn)} IN (${placeholders}) RETURNING *`,
        identities.map((identity) => identity.value),
      );
      return rows.map((row, index) => normalizeRow(row, index, identityColumn));
    },
    async captureSchemaSnapshot(): Promise<DatabaseSchemaSnapshot> {
      // Execute sequential bulk catalog reads so single-connection clients
      // never queue overlapping introspection statements across many tables.
      const schemas = await client.query<{ schema_name: string }>(
        `SELECT schema_name
         FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
         ORDER BY schema_name`,
      );
      const functions = await client.query<{
        oid: number;
        schema_name: string;
        function_name: string;
        return_type: string;
        language_name: string;
      }>(
        `SELECT p.oid, n.nspname AS schema_name, p.proname AS function_name,
                pg_get_function_result(p.oid) AS return_type, l.lanname AS language_name
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY n.nspname, p.proname, p.oid`,
      );
      const extensions = await client.query<{ extname: string; extversion: string }>(
        `SELECT extname, extversion
         FROM pg_extension
         ORDER BY extname`,
      );
      const tableRows = await client.query<{
        schema_name: string;
        table_name: string;
        table_type: string;
        row_count: number | string | null;
      }>(
        `SELECT n.nspname AS schema_name,
                c.relname AS table_name,
                CASE c.relkind
                  WHEN 'r' THEN 'BASE TABLE'
                  WHEN 'v' THEN 'VIEW'
                  WHEN 'm' THEN 'MATERIALIZED VIEW'
                END AS table_type,
                CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS row_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'v', 'm')
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY n.nspname, c.relname`,
      );
      const columnRows = await client.query<{
        table_schema?: string;
        table_name?: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        is_identity: string;
        is_primary_key: boolean;
      }>(
        `SELECT c.table_schema,
                c.table_name,
                c.column_name,
                c.data_type,
                c.is_nullable,
                c.column_default,
                c.is_identity,
                EXISTS (
                  SELECT 1
                  FROM information_schema.key_column_usage k
                  JOIN information_schema.table_constraints tc
                    ON tc.constraint_name = k.constraint_name
                   AND tc.table_schema = k.table_schema
                   AND tc.table_name = k.table_name
                  WHERE k.table_schema = c.table_schema
                    AND k.table_name = c.table_name
                    AND k.column_name = c.column_name
                    AND tc.constraint_type = 'PRIMARY KEY'
                ) AS is_primary_key
         FROM information_schema.columns c
         WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
      );
      const indexRows = await client.query<{
        schemaname?: string;
        tablename?: string;
        indexname: string;
        indexdef: string;
      }>(
        `SELECT schemaname, tablename, indexname, indexdef
         FROM pg_indexes
         WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY schemaname, tablename, indexname`,
      );
      const constraintRows = await client.query<{
        schema_name?: string;
        table_name?: string;
        name: string;
        contype: string;
        definition: string;
      }>(
        `SELECT ns.nspname AS schema_name,
                rel.relname AS table_name,
                con.conname AS name,
                con.contype,
                pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
           AND rel.relkind IN ('r', 'v', 'm')
         ORDER BY ns.nspname, rel.relname, con.conname`,
      );
      const relationRows = await client.query<{
        table_schema?: string;
        table_name?: string;
        constraint_name: string;
        column_name: string;
        foreign_table_schema: string;
        foreign_table_name: string;
        foreign_column_name: string;
      }>(
        `SELECT k.table_schema,
                k.table_name,
                k.constraint_name,
                k.column_name,
                c.table_schema AS foreign_table_schema,
                c.table_name AS foreign_table_name,
                c.column_name AS foreign_column_name
         FROM information_schema.key_column_usage k
         JOIN information_schema.referential_constraints r
           ON r.constraint_name = k.constraint_name
          AND r.constraint_schema = k.constraint_schema
         JOIN information_schema.constraint_column_usage c
           ON c.constraint_name = r.unique_constraint_name
          AND c.constraint_schema = r.unique_constraint_schema
         WHERE k.table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY k.table_schema, k.table_name, k.constraint_name, k.ordinal_position`,
      );
      const triggerRows = await client.query<{
        event_object_schema?: string;
        event_object_table?: string;
        trigger_name: string;
      }>(
        `SELECT event_object_schema, event_object_table, trigger_name
         FROM information_schema.triggers
         WHERE event_object_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY event_object_schema, event_object_table, trigger_name`,
      );
      const policyRows = await client.query<{
        schemaname?: string;
        tablename?: string;
        policyname: string;
        cmd: string;
        roles: string[];
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT schemaname, tablename, policyname, cmd, roles, qual, with_check
         FROM pg_policies
         WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY schemaname, tablename, policyname`,
      );

      const defaultTableId =
        tableRows[0] !== undefined
          ? `${tableRows[0].schema_name}.${tableRows[0].table_name}`
          : undefined;
      const resolveTableId = (schema?: string, table?: string): string | undefined =>
        schema && table ? `${schema}.${table}` : defaultTableId;

      const columnsByTable = new Map<string, NormalizedColumn[]>();
      for (const row of columnRows) {
        const tableId = resolveTableId(row.table_schema, row.table_name);
        if (!tableId) continue;
        const list = columnsByTable.get(tableId) ?? [];
        list.push({
          id: `${tableId}.${row.column_name}`,
          name: row.column_name,
          dataType: row.data_type,
          nullable: row.is_nullable === "YES",
          ...(row.column_default ? { defaultValue: row.column_default } : {}),
          isPrimaryKey: Boolean(row.is_primary_key),
          isIdentity: row.is_identity === "YES",
        });
        columnsByTable.set(tableId, list);
      }

      const constraintsByTable = new Map<string, DatabaseConstraint[]>();
      const primaryConstraintNamesByTable = new Map<string, Set<string>>();
      for (const row of constraintRows) {
        const tableId = resolveTableId(row.schema_name, row.table_name);
        if (!tableId) continue;
        const list = constraintsByTable.get(tableId) ?? [];
        list.push({
          name: row.name,
          type: mapConstraintTypeChar(row.contype),
          definition: row.definition,
        });
        constraintsByTable.set(tableId, list);
        if (row.contype === "p") {
          const pkSet = primaryConstraintNamesByTable.get(tableId) ?? new Set<string>();
          pkSet.add(row.name);
          primaryConstraintNamesByTable.set(tableId, pkSet);
        }
      }

      const indexesByTable = new Map<string, DatabaseIndex[]>();
      for (const row of indexRows) {
        const tableId = resolveTableId(row.schemaname, row.tablename);
        if (!tableId) continue;
        const pkNames = primaryConstraintNamesByTable.get(tableId);
        const list = indexesByTable.get(tableId) ?? [];
        list.push({
          name: row.indexname,
          definition: row.indexdef,
          isUnique: /UNIQUE INDEX/i.test(row.indexdef),
          isPrimary: Boolean(pkNames?.has(row.indexname)),
        });
        indexesByTable.set(tableId, list);
      }

      const groupedRelationsByTable = new Map<
        string,
        Map<string, { columns: string[]; referencedTable: string; referencedColumns: string[] }>
      >();
      for (const row of relationRows) {
        const tableId = resolveTableId(row.table_schema, row.table_name);
        if (!tableId) continue;
        const tableMap =
          groupedRelationsByTable.get(tableId) ??
          new Map<
            string,
            { columns: string[]; referencedTable: string; referencedColumns: string[] }
          >();
        const current = tableMap.get(row.constraint_name) ?? {
          columns: [],
          referencedTable: `${row.foreign_table_schema}.${row.foreign_table_name}`,
          referencedColumns: [],
        };
        current.columns.push(row.column_name);
        current.referencedColumns.push(row.foreign_column_name);
        tableMap.set(row.constraint_name, current);
        groupedRelationsByTable.set(tableId, tableMap);
      }
      for (const row of constraintRows) {
        if (row.contype !== "f") continue;
        const tableId = resolveTableId(row.schema_name, row.table_name);
        if (!tableId) continue;
        const defaultSchema = row.schema_name ?? tableId.split(".")[0] ?? "public";
        const tableMap =
          groupedRelationsByTable.get(tableId) ??
          new Map<
            string,
            { columns: string[]; referencedTable: string; referencedColumns: string[] }
          >();
        if (!tableMap.has(row.name)) {
          const parsed = parseForeignKeyConstraintDefinition(defaultSchema, row.definition);
          if (parsed) {
            tableMap.set(row.name, parsed);
            groupedRelationsByTable.set(tableId, tableMap);
          }
        }
      }

      const triggersByTable = new Map<string, string[]>();
      for (const row of triggerRows) {
        const tableId = resolveTableId(row.event_object_schema, row.event_object_table);
        if (!tableId) continue;
        const list = triggersByTable.get(tableId) ?? [];
        list.push(row.trigger_name);
        triggersByTable.set(tableId, list);
      }

      const policiesByTable = new Map<string, DatabasePolicy[]>();
      for (const row of policyRows) {
        const tableId = resolveTableId(row.schemaname, row.tablename);
        if (!tableId) continue;
        const list = policiesByTable.get(tableId) ?? [];
        list.push({
          name: row.policyname,
          command: row.cmd,
          roles: Array.isArray(row.roles) ? row.roles : [],
          ...(row.qual ? { usingExpression: row.qual } : {}),
          ...(row.with_check ? { checkExpression: row.with_check } : {}),
        });
        policiesByTable.set(tableId, list);
      }

      const snapshotTables: DatabaseTableSnapshot[] = tableRows.map((row) => {
        const tableId = `${row.schema_name}.${row.table_name}`;
        const relationMap = groupedRelationsByTable.get(tableId);
        const relations: DatabaseRelation[] = relationMap
          ? [...relationMap.entries()].map(([name, rel]) => ({ name, ...rel }))
          : [];
        return {
          id: tableId,
          schema: row.schema_name,
          name: row.table_name,
          isView: row.table_type !== "BASE TABLE",
          isMaterializedView: row.table_type === "MATERIALIZED VIEW",
          columns: columnsByTable.get(tableId) ?? [],
          indexes: indexesByTable.get(tableId) ?? [],
          constraints: constraintsByTable.get(tableId) ?? [],
          relations,
          policies: policiesByTable.get(tableId) ?? [],
          triggers: triggersByTable.get(tableId) ?? [],
        };
      });

      return buildSchemaSnapshotFromParts({
        provider: "supabase",
        catalog: {
          schemas: schemas.map((item) => ({ name: item.schema_name })),
          functions: functions.map((item) => ({
            id: `${item.schema_name}.${item.function_name}.${item.oid}`,
            schema: item.schema_name,
            name: item.function_name,
            returnType: item.return_type,
            language: item.language_name,
          })),
          extensions: extensions.map((item) => ({
            name: item.extname,
            version: item.extversion,
          })),
        },
        tables: snapshotTables,
      });
    },
    async inspectOperations(): Promise<DatabaseOperationsSnapshot> {
      const degradedMetrics: string[] = [];

      let connections: DatabaseConnectionSummary = {
        totalConnections: 0,
        activeConnections: 0,
        idleConnections: 0,
        idleInTransactionConnections: 0,
        waitingConnections: 0,
      };
      try {
        const connRows = await client.query<{
          total_connections: number | string | null;
          active_connections: number | string | null;
          idle_connections: number | string | null;
          idle_in_transaction_connections: number | string | null;
          waiting_connections: number | string | null;
          max_connections: number | string | null;
        }>(
          `SELECT COUNT(*)::int AS total_connections,
                  COUNT(*) FILTER (WHERE state = 'active')::int AS active_connections,
                  COUNT(*) FILTER (WHERE state = 'idle')::int AS idle_connections,
                  COUNT(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_in_transaction_connections,
                  COUNT(*) FILTER (WHERE wait_event_type IS NOT NULL AND state = 'active')::int AS waiting_connections,
                  (SELECT setting::int FROM pg_settings WHERE name = 'max_connections' LIMIT 1) AS max_connections
           FROM pg_stat_activity
           WHERE datname = current_database()`,
        );
        const first = connRows[0];
        if (first) {
          const total = asFiniteNumber(first.total_connections);
          const maxConn = asFiniteNumber(first.max_connections);
          connections = {
            totalConnections: total,
            activeConnections: asFiniteNumber(first.active_connections),
            idleConnections: asFiniteNumber(first.idle_connections),
            idleInTransactionConnections: asFiniteNumber(first.idle_in_transaction_connections),
            waitingConnections: asFiniteNumber(first.waiting_connections),
            ...(maxConn > 0
              ? {
                  maxConnections: maxConn,
                  utilizationPercent: Math.min(100, Math.round((total / maxConn) * 1000) / 10),
                }
              : {}),
          };
        }
      } catch {
        degradedMetrics.push("connections");
      }

      let longRunningActivities: DatabaseActiveActivity[] = [];
      try {
        const activityRows = await client.query<{
          pid: number | string;
          username: string | null;
          application_name: string | null;
          state: string | null;
          wait_event_type: string | null;
          wait_event: string | null;
          duration_ms: number | string | null;
          query_preview: string | null;
        }>(
          `SELECT pid::int AS pid,
                  COALESCE(usename, 'unknown') AS username,
                  COALESCE(application_name, '') AS application_name,
                  COALESCE(state, 'unknown') AS state,
                  wait_event_type,
                  wait_event,
                  GREATEST(0, ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - COALESCE(query_start, xact_start, backend_start))) * 1000))::bigint AS duration_ms,
                  LEFT(COALESCE(query, ''), 240) AS query_preview
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND (
               state LIKE 'idle in transaction%'
               OR (state = 'active' AND COALESCE(query, '') NOT ILIKE '%pg_stat_activity%')
             )
           ORDER BY duration_ms DESC
           LIMIT 20`,
        );
        longRunningActivities = activityRows.map((row) => ({
          pid: asFiniteNumber(row.pid),
          user: row.username ?? "unknown",
          ...(row.application_name ? { applicationName: row.application_name } : {}),
          state: row.state ?? "unknown",
          ...(row.wait_event_type ? { waitEventType: row.wait_event_type } : {}),
          ...(row.wait_event ? { waitEvent: row.wait_event } : {}),
          durationMs: asFiniteNumber(row.duration_ms),
          queryPreview: sanitizeQueryPreview(row.query_preview ?? ""),
          isIdleInTransaction: (row.state ?? "").startsWith("idle in transaction"),
        }));
      } catch {
        degradedMetrics.push("long_running_activities");
      }

      let locks: DatabaseLockSummary[] = [];
      try {
        const lockRows = await client.query<{
          pid: number | string;
          lock_type: string;
          mode: string;
          granted: boolean;
          relation_name: string | null;
          blocked_by_count: number | string | null;
          state: string | null;
          duration_ms: number | string | null;
          query_preview: string | null;
        }>(
          `SELECT l.pid::int AS pid,
                  l.locktype AS lock_type,
                  l.mode AS mode,
                  l.granted AS granted,
                  CASE WHEN n.nspname IS NOT NULL AND c.relname IS NOT NULL THEN n.nspname || '.' || c.relname ELSE NULL END AS relation_name,
                  COALESCE(cardinality(pg_blocking_pids(l.pid)), 0)::int AS blocked_by_count,
                  COALESCE(a.state, 'unknown') AS state,
                  GREATEST(0, ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - COALESCE(a.query_start, a.xact_start, a.backend_start))) * 1000))::bigint AS duration_ms,
                  LEFT(COALESCE(a.query, ''), 180) AS query_preview
           FROM pg_locks l
           JOIN pg_stat_activity a ON a.pid = l.pid AND a.datname = current_database()
           LEFT JOIN pg_class c ON c.oid = l.relation
           LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE l.pid <> pg_backend_pid()
             AND (NOT l.granted OR cardinality(pg_blocking_pids(l.pid)) > 0 OR l.mode IN ('AccessExclusiveLock', 'ExclusiveLock', 'ShareRowExclusiveLock', 'RowExclusiveLock'))
           ORDER BY l.granted ASC, blocked_by_count DESC, duration_ms DESC
           LIMIT 25`,
        );
        locks = lockRows.map((row) => ({
          pid: asFiniteNumber(row.pid),
          lockType: row.lock_type,
          mode: row.mode,
          granted: Boolean(row.granted),
          ...(row.relation_name ? { relation: row.relation_name } : {}),
          blockedByCount: asFiniteNumber(row.blocked_by_count),
          ...(row.state ? { state: row.state } : {}),
          ...(row.duration_ms !== null ? { durationMs: asFiniteNumber(row.duration_ms) } : {}),
          ...(row.query_preview ? { queryPreview: sanitizeQueryPreview(row.query_preview) } : {}),
        }));
      } catch {
        degradedMetrics.push("locks");
      }

      let tableMaintenance: DatabaseTableMaintenance[] = [];
      try {
        const maintRows = await client.query<{
          schema_name: string;
          table_name: string;
          table_bytes: number | string | null;
          index_bytes: number | string | null;
          total_bytes: number | string | null;
          estimated_rows: number | string | null;
          live_rows: number | string | null;
          dead_rows: number | string | null;
          seq_scans: number | string | null;
          index_scans: number | string | null;
          last_vacuum: string | null;
          last_autovacuum: string | null;
          last_analyze: string | null;
          last_autoanalyze: string | null;
        }>(
          `SELECT s.schemaname AS schema_name,
                  s.relname AS table_name,
                  pg_table_size(s.relid)::bigint AS table_bytes,
                  pg_indexes_size(s.relid)::bigint AS index_bytes,
                  pg_total_relation_size(s.relid)::bigint AS total_bytes,
                  GREATEST(0, COALESCE(c.reltuples, s.n_live_tup, 0))::bigint AS estimated_rows,
                  COALESCE(s.n_live_tup, 0)::bigint AS live_rows,
                  COALESCE(s.n_dead_tup, 0)::bigint AS dead_rows,
                  COALESCE(s.seq_scan, 0)::bigint AS seq_scans,
                  COALESCE(s.idx_scan, 0)::bigint AS index_scans,
                  s.last_vacuum::text AS last_vacuum,
                  s.last_autovacuum::text AS last_autovacuum,
                  s.last_analyze::text AS last_analyze,
                  s.last_autoanalyze::text AS last_autoanalyze
           FROM pg_stat_user_tables s
           JOIN pg_class c ON c.oid = s.relid
           ORDER BY pg_total_relation_size(s.relid) DESC, s.schemaname, s.relname
           LIMIT 100`,
        );
        tableMaintenance = maintRows.map((row) => {
          const liveRows = asFiniteNumber(row.live_rows);
          const deadRows = asFiniteNumber(row.dead_rows);
          const totalRows = liveRows + deadRows;
          const deadRowRatio = totalRows > 0 ? Math.round((deadRows / totalRows) * 1000) / 1000 : 0;
          const bloatLevel: DatabaseTableMaintenance["bloatLevel"] =
            deadRows >= 500 && deadRowRatio >= 0.25
              ? "high"
              : deadRows >= 100 && deadRowRatio >= 0.1
                ? "moderate"
                : "low";
          const needsVacuum = deadRows >= 100 && deadRowRatio >= 0.1;
          const needsAnalyze = liveRows >= 250 && !row.last_analyze && !row.last_autoanalyze;
          return {
            tableId: `${row.schema_name}.${row.table_name}`,
            schema: row.schema_name,
            table: row.table_name,
            tableBytes: asFiniteNumber(row.table_bytes),
            indexBytes: asFiniteNumber(row.index_bytes),
            totalBytes: asFiniteNumber(row.total_bytes),
            estimatedRows: asFiniteNumber(row.estimated_rows),
            liveRows,
            deadRows,
            deadRowRatio,
            seqScans: asFiniteNumber(row.seq_scans),
            indexScans: asFiniteNumber(row.index_scans),
            ...(row.last_vacuum ? { lastVacuum: row.last_vacuum } : {}),
            ...(row.last_autovacuum ? { lastAutoVacuum: row.last_autovacuum } : {}),
            ...(row.last_analyze ? { lastAnalyze: row.last_analyze } : {}),
            ...(row.last_autoanalyze ? { lastAutoAnalyze: row.last_autoanalyze } : {}),
            bloatLevel,
            needsVacuum,
            needsAnalyze,
          };
        });
      } catch {
        degradedMetrics.push("table_maintenance");
      }

      let indexUsage: DatabaseIndexUsage[] = [];
      try {
        const indexUsageRows = await client.query<{
          schema_name: string;
          table_name: string;
          index_name: string;
          definition: string | null;
          size_bytes: number | string | null;
          scans: number | string | null;
          tuples_read: number | string | null;
          tuples_fetched: number | string | null;
          is_unique: boolean;
          is_primary: boolean;
        }>(
          `SELECT ui.schemaname AS schema_name,
                  ui.relname AS table_name,
                  ui.indexrelname AS index_name,
                  COALESCE(pi.indexdef, '') AS definition,
                  pg_relation_size(ui.indexrelid)::bigint AS size_bytes,
                  COALESCE(ui.idx_scan, 0)::bigint AS scans,
                  COALESCE(ui.idx_tup_read, 0)::bigint AS tuples_read,
                  COALESCE(ui.idx_tup_fetch, 0)::bigint AS tuples_fetched,
                  COALESCE(ix.indisunique, false) AS is_unique,
                  COALESCE(ix.indisprimary, false) AS is_primary
           FROM pg_stat_user_indexes ui
           JOIN pg_index ix ON ix.indexrelid = ui.indexrelid
           LEFT JOIN pg_indexes pi
             ON pi.schemaname = ui.schemaname
            AND pi.tablename = ui.relname
            AND pi.indexname = ui.indexrelname
           ORDER BY pg_relation_size(ui.indexrelid) DESC, ui.schemaname, ui.relname, ui.indexrelname
           LIMIT 200`,
        );
        indexUsage = indexUsageRows.map((row) => {
          const definition = row.definition ?? "";
          return {
            tableId: `${row.schema_name}.${row.table_name}`,
            schema: row.schema_name,
            table: row.table_name,
            indexName: row.index_name,
            definition,
            columns: extractIndexColumnsFromDefinition(definition),
            sizeBytes: asFiniteNumber(row.size_bytes),
            scans: asFiniteNumber(row.scans),
            tuplesRead: asFiniteNumber(row.tuples_read),
            tuplesFetched: asFiniteNumber(row.tuples_fetched),
            isUnique: Boolean(row.is_unique),
            isPrimary: Boolean(row.is_primary),
          };
        });
      } catch {
        degradedMetrics.push("index_usage");
      }

      let foreignKeysForAnalysis: {
        readonly id: string;
        readonly schema: string;
        readonly name: string;
        readonly relations: readonly DatabaseRelation[];
      }[] = [];
      try {
        const fkRows = await client.query<{
          table_schema?: string;
          table_name?: string;
          constraint_name: string;
          column_name: string;
          foreign_table_schema: string;
          foreign_table_name: string;
          foreign_column_name: string;
        }>(
          `SELECT k.table_schema,
                  k.table_name,
                  k.constraint_name,
                  k.column_name,
                  c.table_schema AS foreign_table_schema,
                  c.table_name AS foreign_table_name,
                  c.column_name AS foreign_column_name
           FROM information_schema.key_column_usage k
           JOIN information_schema.referential_constraints r
             ON r.constraint_name = k.constraint_name
            AND r.constraint_schema = k.constraint_schema
           JOIN information_schema.constraint_column_usage c
             ON c.constraint_name = r.unique_constraint_name
            AND c.constraint_schema = r.unique_constraint_schema
           WHERE k.table_schema NOT IN ('pg_catalog', 'information_schema')
           ORDER BY k.table_schema, k.table_name, k.constraint_name, k.ordinal_position`,
        );
        const byTable = new Map<
          string,
          {
            schema: string;
            name: string;
            relations: Map<
              string,
              { columns: string[]; referencedTable: string; referencedColumns: string[] }
            >;
          }
        >();
        for (const row of fkRows) {
          if (!row.table_schema || !row.table_name) continue;
          const tableId = `${row.table_schema}.${row.table_name}`;
          const entry = byTable.get(tableId) ?? {
            schema: row.table_schema,
            name: row.table_name,
            relations: new Map(),
          };
          const rel = entry.relations.get(row.constraint_name) ?? {
            columns: [],
            referencedTable: `${row.foreign_table_schema}.${row.foreign_table_name}`,
            referencedColumns: [],
          };
          rel.columns.push(row.column_name);
          rel.referencedColumns.push(row.foreign_column_name);
          entry.relations.set(row.constraint_name, rel);
          byTable.set(tableId, entry);
        }
        foreignKeysForAnalysis = [...byTable.entries()].map(([id, item]) => ({
          id,
          schema: item.schema,
          name: item.name,
          relations: [...item.relations.entries()].map(([name, rel]) => ({ name, ...rel })),
        }));
      } catch {
        degradedMetrics.push("foreign_key_analysis");
      }

      const recommendations = analyzeDatabaseMaintenance({
        tables: foreignKeysForAnalysis,
        tableMaintenance,
        indexUsage,
      });

      const backup = await fetchSupabaseBackupMetadata(options?.credentials, options?.httpClient);

      return {
        provider: "supabase",
        capturedAt: new Date().toISOString(),
        connections,
        longRunningActivities,
        locks,
        tableMaintenance,
        indexUsage,
        recommendations,
        backup,
        degradedMetrics,
      };
    },
  };
}

export class SupabaseProvider implements BackendProvider {
  readonly name = "supabase" as const;
  readonly services: ProviderServices;
  private capabilities = emptyCapabilities();
  private databaseAvailable = false;

  constructor(
    private readonly credentials: SupabaseCredentials,
    private readonly client: SupabaseHttpClient = defaultHttpClient(),
    private readonly databaseClient: SupabaseDatabaseClient | undefined = credentials.databaseUrl
      ? defaultDatabaseClient(credentials.databaseUrl)
      : undefined,
  ) {
    const auth: AuthProvider = {
      listUsers: (cursor) => this.listUsers(cursor),
    };
    const storage: StorageProvider = {
      listFiles: (bucket, cursor) => this.listFiles(bucket, cursor),
    };
    const database: DatabaseProvider | undefined = this.databaseClient
      ? createDatabaseProvider(credentials.databaseUrl as string, this.databaseClient, {
          credentials: this.credentials,
          httpClient: this.client,
        })
      : undefined;
    this.services = {
      auth,
      storage,
      ...(database ? { database } : {}),
    };
  }

  async connect(): Promise<ProviderConnectionResult> {
    const [auth, storage, metadata, database] = await Promise.all([
      probe(
        this.client,
        `${this.credentials.projectUrl}/auth/v1/health`,
        projectHeaders(this.credentials),
        "check Supabase auth health",
      ),
      probe(
        this.client,
        `${this.credentials.projectUrl}/storage/v1/bucket`,
        projectHeaders(this.credentials),
        "check Supabase storage access",
      ),
      this.credentials.managementApiToken
        ? probe(
            this.client,
            `${SUPABASE_MANAGEMENT_API}/v1/projects/${projectReference(this.credentials.projectUrl)}`,
            managementHeaders(this.credentials),
            "check Supabase project metadata access",
          )
        : Promise.resolve({ ok: false, permissionMissing: false }),
      this.databaseClient
        ? this.databaseClient
            .query("SELECT 1 AS ok")
            .then(() => ({ ok: true, permissionMissing: false }))
            .catch(() => ({ ok: false, permissionMissing: false }))
        : Promise.resolve({ ok: false, permissionMissing: false }),
    ]);

    this.databaseAvailable = database.ok;

    this.capabilities = {
      ...emptyCapabilities(),
      projectMetadata: metadata.ok,
      relationalDatabase: database.ok,
      sql: database.ok,
      auth: auth.ok,
      storage: storage.ok,
    };

    const probes = [
      auth,
      storage,
      ...(this.credentials.managementApiToken ? [metadata] : []),
      ...(this.databaseClient ? [database] : []),
    ];
    const successfulProbes = probes.filter((probeResult) => probeResult.ok).length;
    const checkedAt = new Date().toISOString();
    if (successfulProbes === 0) {
      return {
        state: "disconnected",
        checkedAt,
        reason:
          auth.permissionMissing || storage.permissionMissing
            ? "permission_missing"
            : "unavailable",
      };
    }
    const healthy = successfulProbes === probes.length;
    return {
      state: healthy ? "healthy" : "degraded",
      checkedAt,
      ...(healthy ? {} : { reason: "partial_capabilities" }),
    };
  }

  async disconnect(): Promise<void> {
    await this.databaseClient?.end();
  }

  async testConnection(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await this.connect();
    return result.state === "healthy" || result.state === "degraded"
      ? { ok: true }
      : { ok: false, reason: result.reason ?? "connection_failed" };
  }

  async getProjectMetadata(): Promise<ProviderProjectMetadata> {
    const reference = projectReference(this.credentials.projectUrl);
    if (!this.credentials.managementApiToken) {
      return { id: reference, name: reference, provider: "supabase", environment: "production" };
    }

    const response = await this.client.request(
      `${SUPABASE_MANAGEMENT_API}/v1/projects/${reference}`,
      { method: "GET", headers: managementHeaders(this.credentials) },
    );
    if (response.status < 200 || response.status >= 300) {
      throw normalizeHttpError(response.status, "supabase", "read Supabase project metadata");
    }
    const body = (await response.json()) as Record<string, unknown>;
    const region = asString(body.region);
    return {
      id: reference,
      name: asString(body.name) ?? reference,
      provider: "supabase",
      ...(region ? { region } : {}),
      environment: "production",
    };
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    if (
      !this.capabilities.auth &&
      !this.capabilities.storage &&
      !this.capabilities.projectMetadata
    ) {
      await this.connect();
    }
    if (this.databaseClient && !this.databaseAvailable) {
      this.capabilities.relationalDatabase = false;
      this.capabilities.sql = false;
    }
    return this.capabilities;
  }

  private async listUsers(cursor?: string): Promise<ProviderPage<NormalizedUser>> {
    const url = new URL(`${this.credentials.projectUrl}/auth/v1/admin/users`);
    url.searchParams.set("page", cursor ?? "1");
    const response = await this.client.request(url.toString(), {
      method: "GET",
      headers: projectHeaders(this.credentials),
    });
    if (response.status < 200 || response.status >= 300) {
      throw normalizeHttpError(response.status, "supabase", "list Supabase auth users");
    }

    const body = (await response.json()) as Record<string, unknown>;
    const users = asRecords(body.users ?? body);
    return {
      items: users.map((user) => {
        const metadata =
          user.user_metadata && typeof user.user_metadata === "object"
            ? (user.user_metadata as Record<string, unknown>)
            : undefined;
        const name = asString(metadata?.name);
        const createdAt = asString(user.created_at);
        const updatedAt = asString(user.updated_at);
        return {
          id: asString(user.id) ?? "unknown",
          email: asString(user.email) ?? "unknown",
          ...(name ? { name } : {}),
          status: user.banned_until ? "disabled" : "active",
          ...(createdAt ? { createdAt } : {}),
          ...(updatedAt ? { updatedAt } : {}),
        };
      }),
    };
  }

  private async listFiles(
    bucket?: string,
    _cursor?: string,
  ): Promise<ProviderPage<NormalizedFile>> {
    const endpoint = bucket
      ? `${this.credentials.projectUrl}/storage/v1/object/list/${encodeURIComponent(bucket)}`
      : `${this.credentials.projectUrl}/storage/v1/bucket`;
    const response = await this.client.request(endpoint, {
      method: bucket ? "POST" : "GET",
      headers: { ...projectHeaders(this.credentials), "Content-Type": "application/json" },
    });
    if (response.status < 200 || response.status >= 300) {
      throw normalizeHttpError(response.status, "supabase", "list Supabase storage files");
    }

    const items = asRecords(await response.json()).map((file) => {
      const id = asString(file.id) ?? asString(file.name) ?? "unknown";
      const name = asString(file.name) ?? "unknown";
      const updatedAt = asString(file.updated_at);
      const metadata =
        file.metadata && typeof file.metadata === "object"
          ? (file.metadata as Record<string, unknown>)
          : undefined;
      const contentType = asString(metadata?.mimetype);
      return {
        id,
        name,
        bucket: bucket ?? "default",
        ...(contentType ? { contentType } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      };
    });
    return { items };
  }
}

export class SupabaseProviderFactory implements BackendProviderFactory {
  readonly name = "supabase" as const;

  constructor(private readonly clientFactory: () => SupabaseHttpClient = defaultHttpClient) {}

  async create(context: {
    readonly connectionId: string;
    readonly projectId: string;
    readonly credentials: Readonly<Record<string, string>>;
  }): Promise<BackendProvider> {
    void context.connectionId;
    void context.projectId;
    return new SupabaseProvider(
      parseSupabaseCredentials(context.credentials),
      this.clientFactory(),
    );
  }
}

export function createSupabaseProvider(
  credentials: Readonly<Record<string, string>>,
  client?: SupabaseHttpClient,
): SupabaseProvider {
  return new SupabaseProvider(parseSupabaseCredentials(credentials), client);
}
