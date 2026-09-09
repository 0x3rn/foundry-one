import type { ProviderCapabilities, ProviderConnectionState, ProviderName } from "@foundry/types";

export type ProviderScalar = string | number | boolean | null;
export type ProviderRecord = Readonly<Record<string, ProviderScalar | ProviderScalar[]>>;

export interface ProviderProjectMetadata {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderName;
  readonly region?: string;
  readonly environment?: string;
}

export interface ProviderPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly total?: number;
}

export interface DatabaseRowQuery {
  readonly cursor?: string;
  readonly search?: string;
  readonly sortColumn?: string;
  readonly sortDirection?: "asc" | "desc";
}

export interface DatabaseIndex {
  readonly name: string;
  readonly definition: string;
  readonly isUnique: boolean;
  readonly isPrimary: boolean;
}

export interface DatabaseConstraint {
  readonly name: string;
  readonly type: "primary_key" | "foreign_key" | "unique" | "check" | "exclusion" | "other";
  readonly definition: string;
}

export interface DatabaseRelation {
  readonly name: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
}

export interface DatabaseTableDetails {
  readonly indexes: readonly DatabaseIndex[];
  readonly constraints: readonly DatabaseConstraint[];
  readonly relations: readonly DatabaseRelation[];
  readonly triggers: readonly string[];
}

export interface DatabaseFunction {
  readonly id: string;
  readonly schema: string;
  readonly name: string;
  readonly returnType: string;
  readonly language: string;
}

export interface DatabaseExtension {
  readonly name: string;
  readonly version: string;
}

export interface DatabaseCatalog {
  readonly functions: readonly DatabaseFunction[];
  readonly extensions: readonly DatabaseExtension[];
}

export interface DatabaseColumnDefinition {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly isPrimaryKey?: boolean;
  readonly defaultValue?: string;
}

export interface NormalizedUser {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  readonly status: "active" | "invited" | "disabled";
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface NormalizedTable {
  readonly id: string;
  readonly name: string;
  readonly kind: "table" | "collection" | "realtime";
  readonly schema?: string;
  readonly rowCount?: number;
  readonly isView?: boolean;
}

export interface NormalizedColumn {
  readonly id: string;
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly defaultValue?: string;
  readonly isPrimaryKey: boolean;
  readonly isIdentity: boolean;
}

export interface NormalizedRow {
  readonly id: string;
  readonly values: ProviderRecord;
  readonly identity?: {
    readonly column: string;
    readonly value: ProviderScalar;
  };
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface NormalizedFile {
  readonly id: string;
  readonly name: string;
  readonly bucket: string;
  readonly sizeBytes?: number;
  readonly contentType?: string;
  readonly updatedAt?: string;
}

export interface NormalizedFunction {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "failed" | "deploying" | "disabled";
  readonly runtime?: string;
  readonly updatedAt?: string;
}

export interface NormalizedLog {
  readonly id: string;
  readonly timestamp: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly source?: string;
}

export interface NormalizedMetric {
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
  readonly timestamp: string;
}

export interface NormalizedFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly state: "open" | "resolved" | "ignored";
  readonly description?: string;
  readonly createdAt?: string;
}

export interface DatabaseProvider {
  listTables(): Promise<readonly NormalizedTable[]>;
  listRows(table: string, query?: DatabaseRowQuery | string): Promise<ProviderPage<NormalizedRow>>;
  listColumns?(table: string): Promise<readonly NormalizedColumn[]>;
  describeTable?(table: string): Promise<DatabaseTableDetails>;
  describeCatalog?(): Promise<DatabaseCatalog>;
  createTable?(
    schema: string,
    table: string,
    columns: readonly DatabaseColumnDefinition[],
  ): Promise<NormalizedTable>;
  addColumn?(table: string, column: DatabaseColumnDefinition): Promise<NormalizedColumn>;
  insertRow?(table: string, values: ProviderRecord): Promise<NormalizedRow>;
  updateRow?(
    table: string,
    identity: { readonly column: string; readonly value: ProviderScalar },
    values: ProviderRecord,
  ): Promise<NormalizedRow>;
  deleteRow?(
    table: string,
    identity: { readonly column: string; readonly value: ProviderScalar },
  ): Promise<NormalizedRow>;
}

export interface AuthProvider {
  listUsers(cursor?: string): Promise<ProviderPage<NormalizedUser>>;
}

export interface StorageProvider {
  listFiles(bucket?: string, cursor?: string): Promise<ProviderPage<NormalizedFile>>;
}

export interface FunctionsProvider {
  listFunctions(): Promise<readonly NormalizedFunction[]>;
}

export interface LogsProvider {
  listLogs(input?: {
    readonly cursor?: string;
    readonly since?: string;
  }): Promise<ProviderPage<NormalizedLog>>;
}

export interface MetricsProvider {
  listMetrics(input?: {
    readonly names?: readonly string[];
    readonly since?: string;
  }): Promise<readonly NormalizedMetric[]>;
}

export interface SecurityProvider {
  listFindings(): Promise<readonly NormalizedFinding[]>;
}

export interface ProviderServices {
  readonly database?: DatabaseProvider;
  readonly auth?: AuthProvider;
  readonly storage?: StorageProvider;
  readonly functions?: FunctionsProvider;
  readonly logs?: LogsProvider;
  readonly metrics?: MetricsProvider;
  readonly security?: SecurityProvider;
}

export interface ProviderConnectionResult {
  readonly state: ProviderConnectionState;
  readonly checkedAt: string;
  readonly reason?: string;
}

export interface BackendProvider {
  readonly name: ProviderName;
  readonly services: ProviderServices;
  connect(): Promise<ProviderConnectionResult>;
  disconnect(): Promise<void>;
  testConnection(): Promise<{ ok: true } | { ok: false; reason: string }>;
  getProjectMetadata(): Promise<ProviderProjectMetadata>;
  getCapabilities(): Promise<ProviderCapabilities>;
}

export type ProviderErrorCode =
  | "provider_not_registered"
  | "provider_unavailable"
  | "connection_failed"
  | "invalid_configuration"
  | "permission_missing"
  | "capability_unsupported";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: ProviderName;
  readonly operation: string;
  readonly retryable: boolean;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: {
      readonly provider: ProviderName;
      readonly operation: string;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.code = code;
    this.provider = options.provider;
    this.operation = options.operation;
    this.retryable = options.retryable ?? false;
  }
}

export function requireCapability(
  capabilities: ProviderCapabilities,
  capability: keyof ProviderCapabilities,
  context: { readonly provider: ProviderName; readonly operation: string },
): void {
  if (!capabilities[capability]) {
    throw new ProviderError(
      "capability_unsupported",
      `${context.operation} is not supported by ${context.provider}.`,
      context,
    );
  }
}

export function permissionMissing(context: {
  readonly provider: ProviderName;
  readonly operation: string;
}): ProviderError {
  return new ProviderError(
    "permission_missing",
    `${context.provider} did not grant permission for ${context.operation}.`,
    context,
  );
}

export interface ProviderFactoryContext {
  readonly connectionId: string;
  readonly projectId: string;
  readonly credentials: Readonly<Record<string, string>>;
}

export interface BackendProviderFactory {
  readonly name: ProviderName;
  create(context: ProviderFactoryContext): Promise<BackendProvider>;
}

export type ProviderLifecycleState = "created" | "connected" | "closed";

export class ProviderLifecycle {
  private state: ProviderLifecycleState = "created";

  constructor(readonly provider: BackendProvider) {}

  get status(): ProviderLifecycleState {
    return this.state;
  }

  async connect(): Promise<ProviderConnectionResult> {
    if (this.state === "closed") {
      throw new ProviderError(
        "provider_unavailable",
        "A closed provider cannot be connected again.",
        {
          provider: this.provider.name,
          operation: "connect",
        },
      );
    }

    const result = await this.provider.connect();
    if (result.state === "healthy" || result.state === "degraded") {
      this.state = "connected";
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.state === "closed") {
      return;
    }

    await this.provider.disconnect();
    this.state = "closed";
  }
}

export class ProviderRegistry {
  private readonly factories = new Map<ProviderName, BackendProviderFactory>();

  register(factory: BackendProviderFactory): void {
    if (this.factories.has(factory.name)) {
      throw new ProviderError(
        "invalid_configuration",
        `A factory for ${factory.name} is already registered.`,
        {
          provider: factory.name,
          operation: "register provider factory",
        },
      );
    }
    this.factories.set(factory.name, factory);
  }

  list(): readonly ProviderName[] {
    return [...this.factories.keys()];
  }

  async create(name: ProviderName, context: ProviderFactoryContext): Promise<ProviderLifecycle> {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new ProviderError(
        "provider_not_registered",
        `No provider factory is registered for ${name}.`,
        {
          provider: name,
          operation: "create provider",
        },
      );
    }

    const provider = await factory.create(context);
    if (provider.name !== name) {
      throw new ProviderError(
        "invalid_configuration",
        `Factory ${name} returned ${provider.name}.`,
        {
          provider: name,
          operation: "create provider",
        },
      );
    }

    return new ProviderLifecycle(provider);
  }
}
