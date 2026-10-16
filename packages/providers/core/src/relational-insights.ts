import type {
  DatabaseCatalog,
  DatabaseConstraint,
  DatabaseExtension,
  DatabaseFunction,
  DatabaseIndex,
  DatabasePolicy,
  DatabaseRelation,
  DatabaseSchema,
  NormalizedColumn,
} from "./index";

export interface DatabaseTableSnapshot {
  readonly id: string;
  readonly schema: string;
  readonly name: string;
  readonly isView: boolean;
  readonly isMaterializedView?: boolean;
  readonly columns: readonly NormalizedColumn[];
  readonly indexes: readonly DatabaseIndex[];
  readonly constraints: readonly DatabaseConstraint[];
  readonly relations: readonly DatabaseRelation[];
  readonly policies: readonly DatabasePolicy[];
  readonly triggers: readonly string[];
}

export interface DatabaseSchemaSnapshotCounts {
  readonly schemas: number;
  readonly tables: number;
  readonly views: number;
  readonly materializedViews: number;
  readonly columns: number;
  readonly indexes: number;
  readonly constraints: number;
  readonly relations: number;
  readonly policies: number;
  readonly triggers: number;
  readonly functions: number;
  readonly extensions: number;
}

export interface DatabaseSchemaSnapshot {
  readonly version: 1;
  readonly provider: "supabase" | "firebase";
  readonly capturedAt: string;
  readonly fingerprint: string;
  readonly counts: DatabaseSchemaSnapshotCounts;
  readonly schemas: readonly DatabaseSchema[];
  readonly functions: readonly DatabaseFunction[];
  readonly extensions: readonly DatabaseExtension[];
  readonly tables: readonly DatabaseTableSnapshot[];
}

export interface DatabaseErdColumnNode {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly isPrimaryKey: boolean;
  readonly isForeignKey: boolean;
  readonly referencedTable?: string;
  readonly referencedColumn?: string;
}

export interface DatabaseErdNode {
  readonly id: string;
  readonly schema: string;
  readonly name: string;
  readonly isView: boolean;
  readonly isMaterializedView?: boolean;
  readonly columns: readonly DatabaseErdColumnNode[];
  readonly primaryKeys: readonly string[];
  readonly foreignKeyColumns: readonly string[];
  readonly inboundCount: number;
  readonly outboundCount: number;
}

export interface DatabaseErdEdge {
  readonly id: string;
  readonly constraintName: string;
  readonly sourceTable: string;
  readonly sourceColumns: readonly string[];
  readonly targetTable: string;
  readonly targetColumns: readonly string[];
}

export interface DatabaseRelationshipGraph {
  readonly schemas: readonly string[];
  readonly nodes: readonly DatabaseErdNode[];
  readonly edges: readonly DatabaseErdEdge[];
  readonly isolatedTables: readonly string[];
}

export type SchemaDiffCategory =
  | "schema"
  | "extension"
  | "function"
  | "table"
  | "column"
  | "index"
  | "constraint"
  | "relation"
  | "policy"
  | "trigger";

export type SchemaDiffChangeType = "added" | "removed" | "modified";

export interface DatabaseSchemaDiffEntry {
  readonly id: string;
  readonly category: SchemaDiffCategory;
  readonly changeType: SchemaDiffChangeType;
  readonly target: string;
  readonly schema?: string;
  readonly tableId?: string;
  readonly summary: string;
  readonly before?: string;
  readonly after?: string;
}

export interface DatabaseTableSchemaDiff {
  readonly tableId: string;
  readonly schema: string;
  readonly name: string;
  readonly status: SchemaDiffChangeType;
  readonly changes: readonly DatabaseSchemaDiffEntry[];
}

export interface DatabaseSchemaDiffSummary {
  readonly totalChanges: number;
  readonly addedCount: number;
  readonly removedCount: number;
  readonly modifiedCount: number;
  readonly changedTableCount: number;
}

export interface DatabaseSchemaDiff {
  readonly identical: boolean;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly summary: DatabaseSchemaDiffSummary;
  readonly entries: readonly DatabaseSchemaDiffEntry[];
  readonly tableDiffs: readonly DatabaseTableSchemaDiff[];
}

export interface DatabaseConnectionSummary {
  readonly totalConnections: number;
  readonly activeConnections: number;
  readonly idleConnections: number;
  readonly idleInTransactionConnections: number;
  readonly waitingConnections: number;
  readonly maxConnections?: number;
  readonly utilizationPercent?: number;
}

export interface DatabaseActiveActivity {
  readonly pid: number;
  readonly user: string;
  readonly applicationName?: string;
  readonly state: string;
  readonly waitEventType?: string;
  readonly waitEvent?: string;
  readonly durationMs: number;
  readonly queryPreview: string;
  readonly isIdleInTransaction: boolean;
}

export interface DatabaseLockSummary {
  readonly pid: number;
  readonly lockType: string;
  readonly mode: string;
  readonly granted: boolean;
  readonly relation?: string;
  readonly blockedByCount: number;
  readonly state?: string;
  readonly durationMs?: number;
  readonly queryPreview?: string;
}

export interface DatabaseTableMaintenance {
  readonly tableId: string;
  readonly schema: string;
  readonly table: string;
  readonly tableBytes: number;
  readonly indexBytes: number;
  readonly totalBytes: number;
  readonly estimatedRows: number;
  readonly liveRows: number;
  readonly deadRows: number;
  readonly deadRowRatio: number;
  readonly seqScans: number;
  readonly indexScans: number;
  readonly lastVacuum?: string;
  readonly lastAutoVacuum?: string;
  readonly lastAnalyze?: string;
  readonly lastAutoAnalyze?: string;
  readonly bloatLevel: "low" | "moderate" | "high";
  readonly needsVacuum: boolean;
  readonly needsAnalyze: boolean;
}

export interface DatabaseIndexUsage {
  readonly tableId: string;
  readonly schema: string;
  readonly table: string;
  readonly indexName: string;
  readonly definition: string;
  readonly columns: readonly string[];
  readonly sizeBytes: number;
  readonly scans: number;
  readonly tuplesRead: number;
  readonly tuplesFetched: number;
  readonly isUnique: boolean;
  readonly isPrimary: boolean;
}

export type IndexRecommendationKind =
  | "missing_fk_index"
  | "duplicate_index"
  | "unused_index"
  | "high_seq_scan"
  | "vacuum_recommended"
  | "analyze_recommended";

export type IndexRecommendationSeverity = "info" | "warning" | "critical";

export interface DatabaseIndexRecommendation {
  readonly id: string;
  readonly kind: IndexRecommendationKind;
  readonly severity: IndexRecommendationSeverity;
  readonly tableId: string;
  readonly indexName?: string;
  readonly columns?: readonly string[];
  readonly title: string;
  readonly summary: string;
  readonly reason: string;
  readonly suggestedSql?: string;
  readonly advisoryOnly: true;
}

export interface DatabaseBackupMetadata {
  readonly provider: "supabase" | "firebase";
  readonly status: "available" | "unavailable" | "unsupported";
  readonly pitrEnabled?: boolean;
  readonly physicalBackupsSupported?: boolean;
  readonly walgEnabled?: boolean;
  readonly backupCount?: number;
  readonly latestBackupAt?: string;
  readonly latestBackupStatus?: string;
  readonly restoreSupported?: boolean;
  readonly note?: string;
  readonly reason?: string;
}

export interface DatabaseOperationsSnapshot {
  readonly provider: "supabase" | "firebase";
  readonly capturedAt: string;
  readonly connections: DatabaseConnectionSummary;
  readonly longRunningActivities: readonly DatabaseActiveActivity[];
  readonly locks: readonly DatabaseLockSummary[];
  readonly tableMaintenance: readonly DatabaseTableMaintenance[];
  readonly indexUsage: readonly DatabaseIndexUsage[];
  readonly recommendations: readonly DatabaseIndexRecommendation[];
  readonly backup: DatabaseBackupMetadata;
  readonly degradedMetrics: readonly string[];
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptionalExpression(value?: string | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = normalizeWhitespace(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeDataType(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function deterministicHash(payload: string): string {
  let h1 = 0xdeadbeef ^ payload.length;
  let h2 = 0x41c6ce57 ^ payload.length;
  for (let index = 0; index < payload.length; index += 1) {
    const ch = payload.charCodeAt(index);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

export function summarizeSchemaSnapshot(input: {
  readonly schemas: readonly DatabaseSchema[];
  readonly functions: readonly DatabaseFunction[];
  readonly extensions: readonly DatabaseExtension[];
  readonly tables: readonly DatabaseTableSnapshot[];
}): DatabaseSchemaSnapshotCounts {
  let tables = 0;
  let views = 0;
  let materializedViews = 0;
  let columns = 0;
  let indexes = 0;
  let constraints = 0;
  let relations = 0;
  let policies = 0;
  let triggers = 0;

  for (const table of input.tables) {
    if (table.isMaterializedView) {
      materializedViews += 1;
    } else if (table.isView) {
      views += 1;
    } else {
      tables += 1;
    }
    columns += table.columns.length;
    indexes += table.indexes.length;
    constraints += table.constraints.length;
    relations += table.relations.length;
    policies += table.policies.length;
    triggers += table.triggers.length;
  }

  return {
    schemas: input.schemas.length,
    tables,
    views,
    materializedViews,
    columns,
    indexes,
    constraints,
    relations,
    policies,
    triggers,
    functions: input.functions.length,
    extensions: input.extensions.length,
  };
}

export function computeSchemaSnapshotFingerprint(input: {
  readonly provider?: "supabase" | "firebase";
  readonly schemas: readonly DatabaseSchema[];
  readonly functions: readonly DatabaseFunction[];
  readonly extensions: readonly DatabaseExtension[];
  readonly tables: readonly DatabaseTableSnapshot[];
}): string {
  const canonicalPayload = JSON.stringify({
    provider: input.provider ?? "supabase",
    schemas: input.schemas.map((s) => s.name),
    extensions: input.extensions.map((e) => ({ name: e.name, version: e.version })),
    functions: input.functions.map((f) => ({
      schema: f.schema,
      name: f.name,
      returnType: f.returnType,
      language: f.language,
    })),
    tables: input.tables.map((t) => ({
      id: t.id,
      schema: t.schema,
      name: t.name,
      isView: t.isView,
      isMaterializedView: Boolean(t.isMaterializedView),
      columns: t.columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        nullable: c.nullable,
        defaultValue: c.defaultValue ?? null,
        isPrimaryKey: c.isPrimaryKey,
        isIdentity: c.isIdentity,
      })),
      indexes: t.indexes.map((i) => ({
        name: i.name,
        definition: i.definition,
        isUnique: i.isUnique,
        isPrimary: i.isPrimary,
      })),
      constraints: t.constraints.map((c) => ({
        name: c.name,
        type: c.type,
        definition: c.definition,
      })),
      relations: t.relations.map((r) => ({
        name: r.name,
        columns: r.columns,
        referencedTable: r.referencedTable,
        referencedColumns: r.referencedColumns,
      })),
      policies: t.policies.map((p) => ({
        name: p.name,
        command: p.command,
        roles: p.roles,
        usingExpression: p.usingExpression ?? null,
        checkExpression: p.checkExpression ?? null,
      })),
      triggers: t.triggers,
    })),
  });
  return `snap_${deterministicHash(canonicalPayload)}`;
}

export function normalizeSchemaSnapshot(input: {
  readonly provider?: "supabase" | "firebase";
  readonly capturedAt?: string;
  readonly schemas?: readonly DatabaseSchema[];
  readonly functions?: readonly DatabaseFunction[];
  readonly extensions?: readonly DatabaseExtension[];
  readonly tables?: readonly DatabaseTableSnapshot[];
}): DatabaseSchemaSnapshot {
  const provider = input.provider ?? "supabase";
  const capturedAt = input.capturedAt ?? new Date().toISOString();

  const schemas = [...(input.schemas ?? [])]
    .map((item) => ({ name: item.name.trim() }))
    .filter((item) => Boolean(item.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  const extensions = [...(input.extensions ?? [])]
    .map((item) => ({
      name: item.name.trim(),
      version: item.version.trim(),
    }))
    .filter((item) => Boolean(item.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  const functions = [...(input.functions ?? [])]
    .map((fn) => {
      const schema = fn.schema.trim();
      const name = fn.name.trim();
      const returnType = normalizeWhitespace(fn.returnType).toLowerCase();
      const language = normalizeWhitespace(fn.language).toLowerCase();
      return {
        id: `${schema}.${name}:${language}:${returnType}`,
        schema,
        name,
        returnType,
        language,
      } satisfies DatabaseFunction;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const tables = [...(input.tables ?? [])]
    .map((table) => {
      const schema = table.schema.trim() || "public";
      const name = table.name.trim();
      const id = `${schema}.${name}`;
      const isMaterializedView = Boolean(table.isMaterializedView);
      const isView = Boolean(table.isView) || isMaterializedView;

      const columns = [...(table.columns ?? [])]
        .map((column) => {
          const colName = column.name.trim();
          const defaultValue = normalizeOptionalExpression(column.defaultValue);
          return {
            id: `${id}.${colName}`,
            name: colName,
            dataType: normalizeDataType(column.dataType),
            nullable: Boolean(column.nullable),
            ...(defaultValue ? { defaultValue } : {}),
            isPrimaryKey: Boolean(column.isPrimaryKey),
            isIdentity: Boolean(column.isIdentity),
          } satisfies NormalizedColumn;
        })
        .sort((left, right) => left.name.localeCompare(right.name));

      const indexes = [...(table.indexes ?? [])]
        .map((index) => ({
          name: index.name.trim(),
          definition: normalizeWhitespace(index.definition),
          isUnique: Boolean(index.isUnique),
          isPrimary: Boolean(index.isPrimary),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      const constraints = [...(table.constraints ?? [])]
        .map((constraint) => ({
          name: constraint.name.trim(),
          type: constraint.type,
          definition: normalizeWhitespace(constraint.definition),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      const relations = [...(table.relations ?? [])]
        .map((relation) => ({
          name: relation.name.trim(),
          columns: relation.columns.map((c) => c.trim()).filter(Boolean),
          referencedTable: relation.referencedTable.trim(),
          referencedColumns: relation.referencedColumns.map((c) => c.trim()).filter(Boolean),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      const policies = [...(table.policies ?? [])]
        .map((policy) => {
          const usingExpression = normalizeOptionalExpression(policy.usingExpression);
          const checkExpression = normalizeOptionalExpression(policy.checkExpression);
          return {
            name: policy.name.trim(),
            command: normalizeWhitespace(policy.command).toUpperCase(),
            roles: [...(policy.roles ?? [])]
              .map((r) => r.trim())
              .filter(Boolean)
              .sort((a, b) => a.localeCompare(b)),
            ...(usingExpression ? { usingExpression } : {}),
            ...(checkExpression ? { checkExpression } : {}),
          } satisfies DatabasePolicy;
        })
        .sort((left, right) => left.name.localeCompare(right.name));

      const triggers = [
        ...new Set((table.triggers ?? []).map((t) => t.trim()).filter(Boolean)),
      ].sort((a, b) => a.localeCompare(b));

      return {
        id,
        schema,
        name,
        isView,
        ...(isMaterializedView ? { isMaterializedView: true } : {}),
        columns,
        indexes,
        constraints,
        relations,
        policies,
        triggers,
      } satisfies DatabaseTableSnapshot;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const counts = summarizeSchemaSnapshot({ schemas, functions, extensions, tables });
  const fingerprint = computeSchemaSnapshotFingerprint({
    provider,
    schemas,
    functions,
    extensions,
    tables,
  });

  return {
    version: 1,
    provider,
    capturedAt,
    fingerprint,
    counts,
    schemas,
    functions,
    extensions,
    tables,
  };
}

export function buildSchemaSnapshotFromParts(input: {
  readonly provider?: "supabase" | "firebase";
  readonly capturedAt?: string;
  readonly catalog: DatabaseCatalog;
  readonly tables: readonly DatabaseTableSnapshot[];
}): DatabaseSchemaSnapshot {
  return normalizeSchemaSnapshot({
    provider: input.provider ?? "supabase",
    ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
    schemas: input.catalog.schemas,
    functions: input.catalog.functions,
    extensions: input.catalog.extensions,
    tables: input.tables,
  });
}

export function buildDatabaseRelationshipGraph(
  snapshot: Pick<DatabaseSchemaSnapshot, "tables" | "schemas">,
): DatabaseRelationshipGraph {
  const normalizedTables = [...snapshot.tables].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const inboundCounts = new Map<string, number>();
  const outboundCounts = new Map<string, number>();
  const edges: DatabaseErdEdge[] = [];
  const fkTargetByTableColumn = new Map<
    string,
    { referencedTable: string; referencedColumn?: string }
  >();

  for (const table of normalizedTables) {
    for (const relation of table.relations) {
      const targetTable = relation.referencedTable.includes(".")
        ? relation.referencedTable
        : `${table.schema}.${relation.referencedTable}`;
      edges.push({
        id: `${table.id}:${relation.name}`,
        constraintName: relation.name,
        sourceTable: table.id,
        sourceColumns: relation.columns,
        targetTable,
        targetColumns: relation.referencedColumns,
      });
      outboundCounts.set(table.id, (outboundCounts.get(table.id) ?? 0) + 1);
      inboundCounts.set(targetTable, (inboundCounts.get(targetTable) ?? 0) + 1);

      relation.columns.forEach((colName, idx) => {
        fkTargetByTableColumn.set(`${table.id}.${colName}`, {
          referencedTable: targetTable,
          ...(relation.referencedColumns[idx]
            ? { referencedColumn: relation.referencedColumns[idx] }
            : {}),
        });
      });
    }
  }

  edges.sort((left, right) => left.id.localeCompare(right.id));

  const nodes: DatabaseErdNode[] = normalizedTables.map((table) => {
    const fkColumns = new Set<string>();
    for (const relation of table.relations) {
      for (const col of relation.columns) {
        fkColumns.add(col);
      }
    }
    const primaryKeys = table.columns.filter((col) => col.isPrimaryKey).map((col) => col.name);
    const foreignKeyColumns = [...fkColumns].sort((a, b) => a.localeCompare(b));

    return {
      id: table.id,
      schema: table.schema,
      name: table.name,
      isView: table.isView,
      ...(table.isMaterializedView ? { isMaterializedView: true } : {}),
      columns: table.columns.map((column) => {
        const ref = fkTargetByTableColumn.get(`${table.id}.${column.name}`);
        return {
          name: column.name,
          dataType: column.dataType,
          nullable: column.nullable,
          isPrimaryKey: column.isPrimaryKey,
          isForeignKey: fkColumns.has(column.name),
          ...(ref?.referencedTable ? { referencedTable: ref.referencedTable } : {}),
          ...(ref?.referencedColumn ? { referencedColumn: ref.referencedColumn } : {}),
        };
      }),
      primaryKeys,
      foreignKeyColumns,
      inboundCount: inboundCounts.get(table.id) ?? 0,
      outboundCount: outboundCounts.get(table.id) ?? 0,
    };
  });

  const isolatedTables = nodes
    .filter((node) => node.inboundCount === 0 && node.outboundCount === 0)
    .map((node) => node.id);

  const schemaSet = new Set<string>(snapshot.schemas.map((schema) => schema.name));
  for (const node of nodes) {
    schemaSet.add(node.schema);
  }

  return {
    schemas: [...schemaSet].sort((a, b) => a.localeCompare(b)),
    nodes,
    edges,
    isolatedTables,
  };
}

function formatTableKind(
  table: Pick<DatabaseTableSnapshot, "isView" | "isMaterializedView">,
): string {
  if (table.isMaterializedView) return "materialized view";
  if (table.isView) return "view";
  return "table";
}

function formatColumnSpec(column: NormalizedColumn): string {
  const parts = [
    column.dataType,
    column.nullable ? "NULL" : "NOT NULL",
    column.isPrimaryKey ? "PK" : "",
    column.isIdentity ? "IDENTITY" : "",
    column.defaultValue ? `DEFAULT ${column.defaultValue}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function formatPolicySpec(policy: DatabasePolicy): string {
  const parts = [
    policy.command,
    `roles(${policy.roles.join(", ") || "PUBLIC"})`,
    policy.usingExpression ? `USING (${policy.usingExpression})` : "",
    policy.checkExpression ? `WITH CHECK (${policy.checkExpression})` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function formatRelationSpec(relation: DatabaseRelation): string {
  return `(${relation.columns.join(", ")}) -> ${relation.referencedTable}(${relation.referencedColumns.join(", ")})`;
}

export function diffSchemaSnapshots(
  sourceInput: DatabaseSchemaSnapshot,
  targetInput: DatabaseSchemaSnapshot,
): DatabaseSchemaDiff {
  const source = normalizeSchemaSnapshot(sourceInput);
  const target = normalizeSchemaSnapshot(targetInput);

  if (source.fingerprint === target.fingerprint) {
    return {
      identical: true,
      sourceFingerprint: source.fingerprint,
      targetFingerprint: target.fingerprint,
      summary: {
        totalChanges: 0,
        addedCount: 0,
        removedCount: 0,
        modifiedCount: 0,
        changedTableCount: 0,
      },
      entries: [],
      tableDiffs: [],
    };
  }

  const entries: DatabaseSchemaDiffEntry[] = [];
  const tableDiffs: DatabaseTableSchemaDiff[] = [];

  // 1. Schemas
  const sourceSchemas = new Set(source.schemas.map((item) => item.name));
  const targetSchemas = new Set(target.schemas.map((item) => item.name));
  for (const name of targetSchemas) {
    if (!sourceSchemas.has(name)) {
      entries.push({
        id: `schema:added:${name}`,
        category: "schema",
        changeType: "added",
        target: name,
        schema: name,
        summary: `Added schema ${name}`,
        after: name,
      });
    }
  }
  for (const name of sourceSchemas) {
    if (!targetSchemas.has(name)) {
      entries.push({
        id: `schema:removed:${name}`,
        category: "schema",
        changeType: "removed",
        target: name,
        schema: name,
        summary: `Removed schema ${name}`,
        before: name,
      });
    }
  }

  // 2. Extensions
  const sourceExtensions = new Map(source.extensions.map((ext) => [ext.name, ext]));
  const targetExtensions = new Map(target.extensions.map((ext) => [ext.name, ext]));
  for (const [name, ext] of targetExtensions) {
    const previous = sourceExtensions.get(name);
    if (!previous) {
      entries.push({
        id: `extension:added:${name}`,
        category: "extension",
        changeType: "added",
        target: name,
        summary: `Installed extension ${name} (${ext.version})`,
        after: ext.version,
      });
    } else if (previous.version !== ext.version) {
      entries.push({
        id: `extension:modified:${name}`,
        category: "extension",
        changeType: "modified",
        target: name,
        summary: `Extension ${name} version changed from ${previous.version} to ${ext.version}`,
        before: previous.version,
        after: ext.version,
      });
    }
  }
  for (const [name, previous] of sourceExtensions) {
    if (!targetExtensions.has(name)) {
      entries.push({
        id: `extension:removed:${name}`,
        category: "extension",
        changeType: "removed",
        target: name,
        summary: `Removed extension ${name} (${previous.version})`,
        before: previous.version,
      });
    }
  }

  // 3. Functions
  const groupFunctionsByName = (fns: readonly DatabaseFunction[]) => {
    const map = new Map<string, DatabaseFunction[]>();
    for (const fn of fns) {
      const key = `${fn.schema}.${fn.name}`;
      const list = map.get(key) ?? [];
      list.push(fn);
      map.set(key, list);
    }
    return map;
  };
  const sourceFnGroups = groupFunctionsByName(source.functions);
  const targetFnGroups = groupFunctionsByName(target.functions);
  const allFnNames = new Set([...sourceFnGroups.keys(), ...targetFnGroups.keys()]);
  for (const fnName of [...allFnNames].sort((a, b) => a.localeCompare(b))) {
    const beforeList = sourceFnGroups.get(fnName) ?? [];
    const afterList = targetFnGroups.get(fnName) ?? [];
    if (beforeList.length === 0 && afterList.length > 0) {
      for (const fn of afterList) {
        const spec = `${fn.language} -> ${fn.returnType}`;
        entries.push({
          id: `function:added:${fnName}:${spec}`,
          category: "function",
          changeType: "added",
          target: fnName,
          schema: fn.schema,
          summary: `Added function ${fnName} (${spec})`,
          after: spec,
        });
      }
    } else if (beforeList.length > 0 && afterList.length === 0) {
      for (const fn of beforeList) {
        const spec = `${fn.language} -> ${fn.returnType}`;
        entries.push({
          id: `function:removed:${fnName}:${spec}`,
          category: "function",
          changeType: "removed",
          target: fnName,
          schema: fn.schema,
          summary: `Removed function ${fnName} (${spec})`,
          before: spec,
        });
      }
    } else if (beforeList.length === 1 && afterList.length === 1) {
      const beforeFn = beforeList[0] as DatabaseFunction;
      const afterFn = afterList[0] as DatabaseFunction;
      const beforeSpec = `${beforeFn.language} -> ${beforeFn.returnType}`;
      const afterSpec = `${afterFn.language} -> ${afterFn.returnType}`;
      if (beforeSpec !== afterSpec) {
        entries.push({
          id: `function:modified:${fnName}`,
          category: "function",
          changeType: "modified",
          target: fnName,
          schema: afterFn.schema,
          summary: `Changed function ${fnName} from (${beforeSpec}) to (${afterSpec})`,
          before: beforeSpec,
          after: afterSpec,
        });
      }
    } else {
      const beforeSpecs = new Set(beforeList.map((fn) => `${fn.language} -> ${fn.returnType}`));
      const afterSpecs = new Set(afterList.map((fn) => `${fn.language} -> ${fn.returnType}`));
      for (const spec of afterSpecs) {
        if (!beforeSpecs.has(spec)) {
          entries.push({
            id: `function:added:${fnName}:${spec}`,
            category: "function",
            changeType: "added",
            target: fnName,
            summary: `Added function overload ${fnName} (${spec})`,
            after: spec,
          });
        }
      }
      for (const spec of beforeSpecs) {
        if (!afterSpecs.has(spec)) {
          entries.push({
            id: `function:removed:${fnName}:${spec}`,
            category: "function",
            changeType: "removed",
            target: fnName,
            summary: `Removed function overload ${fnName} (${spec})`,
            before: spec,
          });
        }
      }
    }
  }

  // 4. Tables and table internals
  const sourceTables = new Map(source.tables.map((table) => [table.id, table]));
  const targetTables = new Map(target.tables.map((table) => [table.id, table]));
  const allTableIds = [...new Set([...sourceTables.keys(), ...targetTables.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );

  for (const tableId of allTableIds) {
    const beforeTable = sourceTables.get(tableId);
    const afterTable = targetTables.get(tableId);

    if (!beforeTable && afterTable) {
      const kindLabel = formatTableKind(afterTable);
      const entry: DatabaseSchemaDiffEntry = {
        id: `table:added:${tableId}`,
        category: "table",
        changeType: "added",
        target: tableId,
        schema: afterTable.schema,
        tableId,
        summary: `Added ${kindLabel} ${tableId} (${afterTable.columns.length} columns)`,
        after: `${kindLabel} (${afterTable.columns.map((c) => c.name).join(", ")})`,
      };
      entries.push(entry);
      tableDiffs.push({
        tableId,
        schema: afterTable.schema,
        name: afterTable.name,
        status: "added",
        changes: [entry],
      });
      continue;
    }

    if (beforeTable && !afterTable) {
      const kindLabel = formatTableKind(beforeTable);
      const entry: DatabaseSchemaDiffEntry = {
        id: `table:removed:${tableId}`,
        category: "table",
        changeType: "removed",
        target: tableId,
        schema: beforeTable.schema,
        tableId,
        summary: `Removed ${kindLabel} ${tableId}`,
        before: `${kindLabel} (${beforeTable.columns.map((c) => c.name).join(", ")})`,
      };
      entries.push(entry);
      tableDiffs.push({
        tableId,
        schema: beforeTable.schema,
        name: beforeTable.name,
        status: "removed",
        changes: [entry],
      });
      continue;
    }

    if (!beforeTable || !afterTable) continue;

    const currentTableChanges: DatabaseSchemaDiffEntry[] = [];
    const beforeKind = formatTableKind(beforeTable);
    const afterKind = formatTableKind(afterTable);

    if (beforeKind !== afterKind) {
      currentTableChanges.push({
        id: `table:modified:${tableId}:kind`,
        category: "table",
        changeType: "modified",
        target: tableId,
        schema: afterTable.schema,
        tableId,
        summary: `Relation kind changed from ${beforeKind} to ${afterKind}`,
        before: beforeKind,
        after: afterKind,
      });
    }

    // Columns
    const beforeColumns = new Map(beforeTable.columns.map((col) => [col.name, col]));
    const afterColumns = new Map(afterTable.columns.map((col) => [col.name, col]));
    for (const [colName, col] of afterColumns) {
      const prevCol = beforeColumns.get(colName);
      const afterSpec = formatColumnSpec(col);
      if (!prevCol) {
        currentTableChanges.push({
          id: `column:added:${tableId}.${colName}`,
          category: "column",
          changeType: "added",
          target: `${tableId}.${colName}`,
          schema: afterTable.schema,
          tableId,
          summary: `Added column ${colName} (${afterSpec})`,
          after: afterSpec,
        });
      } else {
        const beforeSpec = formatColumnSpec(prevCol);
        if (beforeSpec !== afterSpec) {
          currentTableChanges.push({
            id: `column:modified:${tableId}.${colName}`,
            category: "column",
            changeType: "modified",
            target: `${tableId}.${colName}`,
            schema: afterTable.schema,
            tableId,
            summary: `Changed column ${colName} from [${beforeSpec}] to [${afterSpec}]`,
            before: beforeSpec,
            after: afterSpec,
          });
        }
      }
    }
    for (const [colName, prevCol] of beforeColumns) {
      if (!afterColumns.has(colName)) {
        const beforeSpec = formatColumnSpec(prevCol);
        currentTableChanges.push({
          id: `column:removed:${tableId}.${colName}`,
          category: "column",
          changeType: "removed",
          target: `${tableId}.${colName}`,
          schema: beforeTable.schema,
          tableId,
          summary: `Removed column ${colName} (${beforeSpec})`,
          before: beforeSpec,
        });
      }
    }

    // Indexes
    const beforeIndexes = new Map(beforeTable.indexes.map((idx) => [idx.name, idx]));
    const afterIndexes = new Map(afterTable.indexes.map((idx) => [idx.name, idx]));
    for (const [idxName, idx] of afterIndexes) {
      const prevIdx = beforeIndexes.get(idxName);
      if (!prevIdx) {
        currentTableChanges.push({
          id: `index:added:${tableId}.${idxName}`,
          category: "index",
          changeType: "added",
          target: `${tableId}.${idxName}`,
          schema: afterTable.schema,
          tableId,
          summary: `Added index ${idxName}`,
          after: idx.definition,
        });
      } else if (
        prevIdx.definition !== idx.definition ||
        prevIdx.isUnique !== idx.isUnique ||
        prevIdx.isPrimary !== idx.isPrimary
      ) {
        currentTableChanges.push({
          id: `index:modified:${tableId}.${idxName}`,
          category: "index",
          changeType: "modified",
          target: `${tableId}.${idxName}`,
          schema: afterTable.schema,
          tableId,
          summary: `Modified index ${idxName}`,
          before: prevIdx.definition,
          after: idx.definition,
        });
      }
    }
    for (const [idxName, prevIdx] of beforeIndexes) {
      if (!afterIndexes.has(idxName)) {
        currentTableChanges.push({
          id: `index:removed:${tableId}.${idxName}`,
          category: "index",
          changeType: "removed",
          target: `${tableId}.${idxName}`,
          schema: beforeTable.schema,
          tableId,
          summary: `Removed index ${idxName}`,
          before: prevIdx.definition,
        });
      }
    }

    // Constraints
    const beforeConstraints = new Map(beforeTable.constraints.map((con) => [con.name, con]));
    const afterConstraints = new Map(afterTable.constraints.map((con) => [con.name, con]));
    for (const [conName, con] of afterConstraints) {
      const prevCon = beforeConstraints.get(conName);
      const afterSpec = `${con.type}: ${con.definition}`;
      if (!prevCon) {
        currentTableChanges.push({
          id: `constraint:added:${tableId}.${conName}`,
          category: "constraint",
          changeType: "added",
          target: `${tableId}.${conName}`,
          schema: afterTable.schema,
          tableId,
          summary: `Added ${con.type} constraint ${conName}`,
          after: afterSpec,
        });
      } else {
        const beforeSpec = `${prevCon.type}: ${prevCon.definition}`;
        if (beforeSpec !== afterSpec) {
          currentTableChanges.push({
            id: `constraint:modified:${tableId}.${conName}`,
            category: "constraint",
            changeType: "modified",
            target: `${tableId}.${conName}`,
            schema: afterTable.schema,
            tableId,
            summary: `Modified constraint ${conName}`,
            before: beforeSpec,
            after: afterSpec,
          });
        }
      }
    }
    for (const [conName, prevCon] of beforeConstraints) {
      if (!afterConstraints.has(conName)) {
        const beforeSpec = `${prevCon.type}: ${prevCon.definition}`;
        currentTableChanges.push({
          id: `constraint:removed:${tableId}.${conName}`,
          category: "constraint",
          changeType: "removed",
          target: `${tableId}.${conName}`,
          schema: beforeTable.schema,
          tableId,
          summary: `Removed ${prevCon.type} constraint ${conName}`,
          before: beforeSpec,
        });
      }
    }

    // Foreign-key relations
    const beforeRelations = new Map(beforeTable.relations.map((rel) => [rel.name, rel]));
    const afterRelations = new Map(afterTable.relations.map((rel) => [rel.name, rel]));
    for (const [relName, rel] of afterRelations) {
      const prevRel = beforeRelations.get(relName);
      const afterSpec = formatRelationSpec(rel);
      if (!prevRel) {
        currentTableChanges.push({
          id: `relation:added:${tableId}.${relName}`,
          category: "relation",
          changeType: "added",
          target: `${tableId}.${relName}`,
          schema: afterTable.schema,
          tableId,
          summary: `Added foreign key ${relName} ${afterSpec}`,
          after: afterSpec,
        });
      } else {
        const beforeSpec = formatRelationSpec(prevRel);
        if (beforeSpec !== afterSpec) {
          currentTableChanges.push({
            id: `relation:modified:${tableId}.${relName}`,
            category: "relation",
            changeType: "modified",
            target: `${tableId}.${relName}`,
            schema: afterTable.schema,
            tableId,
            summary: `Modified foreign key ${relName} from ${beforeSpec} to ${afterSpec}`,
            before: beforeSpec,
            after: afterSpec,
          });
        }
      }
    }
    for (const [relName, prevRel] of beforeRelations) {
      if (!afterRelations.has(relName)) {
        const beforeSpec = formatRelationSpec(prevRel);
        currentTableChanges.push({
          id: `relation:removed:${tableId}.${relName}`,
          category: "relation",
          changeType: "removed",
          target: `${tableId}.${relName}`,
          schema: beforeTable.schema,
          tableId,
          summary: `Removed foreign key ${relName} ${beforeSpec}`,
          before: beforeSpec,
        });
      }
    }

    // RLS Policies
    const beforePolicies = new Map(beforeTable.policies.map((pol) => [pol.name, pol]));
    const afterPolicies = new Map(afterTable.policies.map((pol) => [pol.name, pol]));
    for (const [polName, pol] of afterPolicies) {
      const prevPol = beforePolicies.get(polName);
      const afterSpec = formatPolicySpec(pol);
      if (!prevPol) {
        currentTableChanges.push({
          id: `policy:added:${tableId}.${polName}`,
          category: "policy",
          changeType: "added",
          target: `${tableId}.${polName}`,
          schema: afterTable.schema,
          tableId,
          summary: `Added RLS policy ${polName} (${pol.command})`,
          after: afterSpec,
        });
      } else {
        const beforeSpec = formatPolicySpec(prevPol);
        if (beforeSpec !== afterSpec) {
          currentTableChanges.push({
            id: `policy:modified:${tableId}.${polName}`,
            category: "policy",
            changeType: "modified",
            target: `${tableId}.${polName}`,
            schema: afterTable.schema,
            tableId,
            summary: `Modified RLS policy ${polName}`,
            before: beforeSpec,
            after: afterSpec,
          });
        }
      }
    }
    for (const [polName, prevPol] of beforePolicies) {
      if (!afterPolicies.has(polName)) {
        const beforeSpec = formatPolicySpec(prevPol);
        currentTableChanges.push({
          id: `policy:removed:${tableId}.${polName}`,
          category: "policy",
          changeType: "removed",
          target: `${tableId}.${polName}`,
          schema: beforeTable.schema,
          tableId,
          summary: `Removed RLS policy ${polName}`,
          before: beforeSpec,
        });
      }
    }

    // Triggers
    const beforeTriggers = new Set(beforeTable.triggers);
    const afterTriggers = new Set(afterTable.triggers);
    for (const trg of afterTriggers) {
      if (!beforeTriggers.has(trg)) {
        currentTableChanges.push({
          id: `trigger:added:${tableId}.${trg}`,
          category: "trigger",
          changeType: "added",
          target: `${tableId}.${trg}`,
          schema: afterTable.schema,
          tableId,
          summary: `Added trigger ${trg}`,
          after: trg,
        });
      }
    }
    for (const trg of beforeTriggers) {
      if (!afterTriggers.has(trg)) {
        currentTableChanges.push({
          id: `trigger:removed:${tableId}.${trg}`,
          category: "trigger",
          changeType: "removed",
          target: `${tableId}.${trg}`,
          schema: beforeTable.schema,
          tableId,
          summary: `Removed trigger ${trg}`,
          before: trg,
        });
      }
    }

    if (currentTableChanges.length > 0) {
      entries.push(...currentTableChanges);
      tableDiffs.push({
        tableId,
        schema: afterTable.schema,
        name: afterTable.name,
        status: "modified",
        changes: currentTableChanges,
      });
    }
  }

  let addedCount = 0;
  let removedCount = 0;
  let modifiedCount = 0;
  for (const entry of entries) {
    if (entry.changeType === "added") addedCount += 1;
    else if (entry.changeType === "removed") removedCount += 1;
    else modifiedCount += 1;
  }

  return {
    identical: entries.length === 0,
    sourceFingerprint: source.fingerprint,
    targetFingerprint: target.fingerprint,
    summary: {
      totalChanges: entries.length,
      addedCount,
      removedCount,
      modifiedCount,
      changedTableCount: tableDiffs.length,
    },
    entries,
    tableDiffs,
  };
}

export function extractIndexColumnsFromDefinition(definition: string): readonly string[] {
  const usingMatch = /USING\s+[A-Za-z0-9_]+\s*\((.+)\)/i.exec(definition);
  const rawColumns = usingMatch?.[1] ?? /\(([^()]+)\)\s*$/.exec(definition)?.[1];
  if (!rawColumns) return [];
  return rawColumns
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/\s+(ASC|DESC|NULLS\s+FIRST|NULLS\s+LAST)+$/i, "")
        .trim()
        .replace(/^"+|"+$/g, "")
        .trim(),
    )
    .filter(Boolean);
}

export function analyzeDatabaseMaintenance(input: {
  readonly tables: readonly {
    readonly id: string;
    readonly schema: string;
    readonly name: string;
    readonly relations: readonly DatabaseRelation[];
  }[];
  readonly tableMaintenance: readonly DatabaseTableMaintenance[];
  readonly indexUsage: readonly DatabaseIndexUsage[];
}): readonly DatabaseIndexRecommendation[] {
  const recommendations: DatabaseIndexRecommendation[] = [];

  const indexesByTable = new Map<string, DatabaseIndexUsage[]>();
  for (const idx of input.indexUsage) {
    const list = indexesByTable.get(idx.tableId) ?? [];
    list.push(idx);
    indexesByTable.set(idx.tableId, list);
  }

  // 1. Missing foreign-key indexes
  for (const table of input.tables) {
    const tableIndexes = indexesByTable.get(table.id) ?? [];
    for (const relation of table.relations) {
      if (relation.columns.length === 0) continue;
      const isCovered = tableIndexes.some((idx) => {
        if (idx.columns.length < relation.columns.length) return false;
        return relation.columns.every(
          (col, position) => idx.columns[position]?.toLowerCase() === col.toLowerCase(),
        );
      });
      if (!isCovered) {
        const indexName = `${table.name}_${relation.columns.join("_")}_idx`.slice(0, 63);
        recommendations.push({
          id: `missing_fk_index:${table.id}:${relation.name}`,
          kind: "missing_fk_index",
          severity: "warning",
          tableId: table.id,
          columns: relation.columns,
          title: `Missing index on foreign key ${relation.name}`,
          summary: `Foreign key (${relation.columns.join(", ")}) on ${table.id} referencing ${relation.referencedTable} has no covering index prefix.`,
          reason:
            "Unindexed foreign keys can cause sequential table scans during JOIN queries and parent row deletions or updates.",
          suggestedSql: `CREATE INDEX CONCURRENTLY "${indexName}" ON "${table.schema}"."${table.name}" (${relation.columns.map((c) => `"${c}"`).join(", ")});`,
          advisoryOnly: true,
        });
      }
    }
  }

  // 2. Duplicate / redundant prefix indexes
  for (const [tableId, tableIndexes] of indexesByTable.entries()) {
    for (let i = 0; i < tableIndexes.length; i += 1) {
      const candidate = tableIndexes[i]!;
      if (candidate.isPrimary || candidate.isUnique || candidate.columns.length === 0) {
        continue;
      }
      const covering = tableIndexes.find((other, j) => {
        if (i === j || other.columns.length < candidate.columns.length) return false;
        if (
          other.columns.length === candidate.columns.length &&
          !other.isPrimary &&
          !other.isUnique &&
          other.indexName.localeCompare(candidate.indexName) > 0
        ) {
          return false;
        }
        return candidate.columns.every(
          (col, pos) => other.columns[pos]?.toLowerCase() === col.toLowerCase(),
        );
      });
      if (covering) {
        recommendations.push({
          id: `duplicate_index:${tableId}:${candidate.indexName}`,
          kind: "duplicate_index",
          severity: "warning",
          tableId,
          indexName: candidate.indexName,
          columns: candidate.columns,
          title: `Redundant index ${candidate.indexName} on ${tableId}`,
          summary: `Index ${candidate.indexName} (${candidate.columns.join(", ")}) is a left-prefix duplicate of ${covering.indexName} (${covering.columns.join(", ")}).`,
          reason:
            "Redundant B-tree indexes consume storage and add write amplification on INSERT, UPDATE, and DELETE without improving read plans.",
          suggestedSql: `DROP INDEX CONCURRENTLY "${candidate.schema}"."${candidate.indexName}";`,
          advisoryOnly: true,
        });
      }
    }
  }

  // 3. Unused non-unique, non-primary indexes
  for (const idx of input.indexUsage) {
    if (idx.isPrimary || idx.isUnique) continue;
    if (idx.scans === 0) {
      recommendations.push({
        id: `unused_index:${idx.tableId}:${idx.indexName}`,
        kind: "unused_index",
        severity: "info",
        tableId: idx.tableId,
        indexName: idx.indexName,
        columns: idx.columns,
        title: `Unused index ${idx.indexName} on ${idx.tableId}`,
        summary: `Index ${idx.indexName} has 0 recorded scans in pg_stat_user_indexes.`,
        reason:
          "Confirm whether this index supports infrequent batch jobs or seasonal queries before dropping it manually.",
        suggestedSql: `DROP INDEX CONCURRENTLY "${idx.schema}"."${idx.indexName}";`,
        advisoryOnly: true,
      });
    }
  }

  // 4. Table maintenance: sequential scan pressure, vacuum bloat, and planner analyze
  for (const maint of input.tableMaintenance) {
    if (
      maint.liveRows >= 500 &&
      maint.seqScans >= 200 &&
      maint.seqScans > Math.max(1, maint.indexScans * 4)
    ) {
      recommendations.push({
        id: `high_seq_scan:${maint.tableId}`,
        kind: "high_seq_scan",
        severity: "warning",
        tableId: maint.tableId,
        title: `High sequential scan ratio on ${maint.tableId}`,
        summary: `${maint.tableId} recorded ${maint.seqScans.toLocaleString()} sequential scans vs ${maint.indexScans.toLocaleString()} index scans across ${maint.liveRows.toLocaleString()} live rows.`,
        reason:
          "Frequent sequential scans on larger tables indicate missing filter/sort indexes for common query predicates.",
        advisoryOnly: true,
      });
    }

    if (maint.needsVacuum) {
      recommendations.push({
        id: `vacuum_recommended:${maint.tableId}`,
        kind: "vacuum_recommended",
        severity: maint.bloatLevel === "high" ? "critical" : "warning",
        tableId: maint.tableId,
        title: `Dead-tuple bloat on ${maint.tableId} (${Math.round(maint.deadRowRatio * 100)}% dead rows)`,
        summary: `${maint.tableId} has ${maint.deadRows.toLocaleString()} dead tuples vs ${maint.liveRows.toLocaleString()} live tuples.`,
        reason:
          "Reclaiming dead tuples reduces table scan pages and keeps visibility maps current.",
        suggestedSql: `VACUUM (ANALYZE) "${maint.schema}"."${maint.table}";`,
        advisoryOnly: true,
      });
    }

    if (maint.needsAnalyze) {
      recommendations.push({
        id: `analyze_recommended:${maint.tableId}`,
        kind: "analyze_recommended",
        severity: "info",
        tableId: maint.tableId,
        title: `Refresh planner statistics on ${maint.tableId}`,
        summary: `${maint.tableId} has ${maint.liveRows.toLocaleString()} live rows with stale or missing planner statistics.`,
        reason:
          "Up-to-date column histograms help PostgreSQL choose accurate join and index scan plans.",
        suggestedSql: `ANALYZE "${maint.schema}"."${maint.table}";`,
        advisoryOnly: true,
      });
    }
  }

  const severityWeight: Record<IndexRecommendationSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  return recommendations.sort(
    (left, right) =>
      severityWeight[left.severity] - severityWeight[right.severity] ||
      left.id.localeCompare(right.id),
  );
}
