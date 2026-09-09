import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import type {
  AuthProvider,
  BackendProvider,
  BackendProviderFactory,
  DatabaseProvider,
  NormalizedFile,
  NormalizedUser,
  ProviderConnectionResult,
  ProviderPage,
  ProviderProjectMetadata,
  ProviderServices,
  StorageProvider,
} from "@foundry/providers-core";
import { ProviderError } from "@foundry/providers-core";
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

export class SupabaseProvider implements BackendProvider {
  readonly name = "supabase" as const;
  readonly services: ProviderServices;
  private capabilities = emptyCapabilities();

  constructor(
    private readonly credentials: SupabaseCredentials,
    private readonly client: SupabaseHttpClient = defaultHttpClient(),
  ) {
    const auth: AuthProvider = {
      listUsers: (cursor) => this.listUsers(cursor),
    };
    const storage: StorageProvider = {
      listFiles: (bucket, cursor) => this.listFiles(bucket, cursor),
    };
    const database: DatabaseProvider | undefined = credentials.databaseUrl
      ? {
          listTables: async () => [],
          listRows: async () => ({ items: [] }),
        }
      : undefined;
    this.services = {
      auth,
      storage,
      ...(database ? { database } : {}),
    };
  }

  async connect(): Promise<ProviderConnectionResult> {
    const [auth, storage, metadata] = await Promise.all([
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
    ]);

    this.capabilities = {
      ...emptyCapabilities(),
      projectMetadata: metadata.ok,
      relationalDatabase: Boolean(this.credentials.databaseUrl),
      sql: Boolean(this.credentials.databaseUrl),
      auth: auth.ok,
      storage: storage.ok,
    };

    const successfulProbes = [auth.ok, storage.ok, metadata.ok].filter(Boolean).length;
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
    return {
      state:
        successfulProbes === 3 || (successfulProbes === 2 && !metadata.ok) ? "healthy" : "degraded",
      checkedAt,
      ...(successfulProbes < 3 ? { reason: "partial_capabilities" } : {}),
    };
  }

  async disconnect(): Promise<void> {
    // Supabase connections are request-scoped; there is no client socket to close.
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
