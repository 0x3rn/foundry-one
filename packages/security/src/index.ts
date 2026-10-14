import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type { WorkspaceRole } from "@foundry/types";
import type { AuditLogEntry, AuditLogWriter } from "@foundry/observability";

export type Permission =
  | "workspace.view"
  | "workspace.manage"
  | "member.view"
  | "member.manage"
  | "project.view"
  | "project.manage"
  | "database.read"
  | "database.write"
  | "sql.execute"
  | "auth.read"
  | "auth.manage"
  | "storage.read"
  | "storage.write"
  | "functions.read"
  | "functions.manage"
  | "credentials.manage"
  | "security.read"
  | "security.manage"
  | "analytics.read"
  | "audit.read"
  | "destructive.execute";

const allPermissions: readonly Permission[] = [
  "workspace.view",
  "workspace.manage",
  "member.view",
  "member.manage",
  "project.view",
  "project.manage",
  "database.read",
  "database.write",
  "sql.execute",
  "auth.read",
  "auth.manage",
  "storage.read",
  "storage.write",
  "functions.read",
  "functions.manage",
  "credentials.manage",
  "security.read",
  "security.manage",
  "analytics.read",
  "audit.read",
  "destructive.execute",
];

const rolePermissions: Record<WorkspaceRole, readonly Permission[]> = {
  owner: allPermissions,
  admin: allPermissions,
  developer: [
    "workspace.view",
    "project.view",
    "project.manage",
    "database.read",
    "database.write",
    "sql.execute",
    "auth.read",
    "auth.manage",
    "storage.read",
    "storage.write",
    "functions.read",
    "functions.manage",
    "security.read",
    "analytics.read",
  ],
  analyst: [
    "workspace.view",
    "project.view",
    "database.read",
    "auth.read",
    "storage.read",
    "functions.read",
    "security.read",
    "analytics.read",
    "audit.read",
  ],
  viewer: [
    "workspace.view",
    "project.view",
    "database.read",
    "auth.read",
    "storage.read",
    "functions.read",
    "security.read",
    "analytics.read",
  ],
};

export class AuthorizationError extends Error {
  readonly code = "FORBIDDEN" as const;

  constructor(
    readonly role: WorkspaceRole,
    readonly permission: Permission,
  ) {
    super(`Role ${role} does not have permission ${permission}.`);
    this.name = "AuthorizationError";
  }
}

export function permissionsForRole(role: WorkspaceRole): readonly Permission[] {
  return rolePermissions[role];
}

export function hasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return rolePermissions[role].includes(permission);
}

export function assertPermission(role: WorkspaceRole, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new AuthorizationError(role, permission);
  }
}

export function allKnownPermissions(): readonly Permission[] {
  return allPermissions;
}

export type SensitiveAction =
  | "row.delete"
  | "document.delete"
  | "table.delete"
  | "collection.delete"
  | "user.delete"
  | "bucket.delete"
  | "auth.rules.change"
  | "sql.destructive";

const confirmationActions: readonly SensitiveAction[] = [
  "row.delete",
  "document.delete",
  "table.delete",
  "collection.delete",
  "user.delete",
  "bucket.delete",
  "auth.rules.change",
  "sql.destructive",
];

export interface ConfirmationChallenge {
  readonly action: SensitiveAction;
  readonly token: string;
}

export class ConfirmationRequiredError extends Error {
  readonly code = "CONFIRMATION_REQUIRED" as const;

  constructor(readonly action: SensitiveAction) {
    super(`Explicit confirmation is required for ${action}.`);
    this.name = "ConfirmationRequiredError";
  }
}

export class InvalidConfirmationError extends Error {
  readonly code = "INVALID_CONFIRMATION" as const;

  constructor(readonly action: SensitiveAction) {
    super(`The confirmation for ${action} is invalid or expired.`);
    this.name = "InvalidConfirmationError";
  }
}

export function isDangerousAction(action: string): action is SensitiveAction {
  return confirmationActions.includes(action as SensitiveAction);
}

export type SqlStatementKind = "read_only" | "mutation" | "destructive" | "critical";

export interface SqlClassification {
  readonly kind: SqlStatementKind;
  readonly normalizedSql: string;
  readonly statementCount: number;
  readonly requiresConfirmation: boolean;
  readonly reason: string;
}

export class SqlValidationError extends Error {
  readonly code = "INVALID_SQL" as const;

  constructor(message: string) {
    super(message);
    this.name = "SqlValidationError";
  }
}

function stripSqlCommentsAndLiterals(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      output += " ";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 2;
      output += " ";
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote && sql[index + 1] === quote) {
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      output += " ";
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

function sqlTokens(sql: string): readonly string[] {
  return sql
    .replace(/[^a-zA-Z0-9_$]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.toUpperCase());
}

function countSqlStatements(sql: string): number {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean).length;
}

export function classifySql(sql: string): SqlClassification {
  if (typeof sql !== "string" || !sql.trim()) {
    throw new SqlValidationError("SQL text is required.");
  }

  const sanitized = stripSqlCommentsAndLiterals(sql);
  const normalizedSql = sanitized.replace(/\s+/g, " ").trim();
  const statementCount = countSqlStatements(sanitized);
  if (!normalizedSql || statementCount === 0) {
    throw new SqlValidationError("SQL text must contain a statement.");
  }

  const tokens = sqlTokens(sanitized);
  const first = tokens[0] ?? "";
  const hasWhere = tokens.includes("WHERE");
  const hasBroadPredicate = /\bWHERE\s+(TRUE|1\s*=\s*1)\b/i.test(sanitized);
  const hasMutatingCte = tokens.some((token) =>
    ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(token),
  );

  if (statementCount > 1) {
    return {
      kind: "critical",
      normalizedSql,
      statementCount,
      requiresConfirmation: true,
      reason: "Multiple SQL statements require explicit confirmation.",
    };
  }

  if (
    ["SELECT", "SHOW", "EXPLAIN", "VALUES"].includes(first) ||
    (first === "WITH" && !hasMutatingCte)
  ) {
    return {
      kind: "read_only",
      normalizedSql,
      statementCount,
      requiresConfirmation: false,
      reason: "Read-only SQL can run without confirmation.",
    };
  }

  if (first === "DELETE" || first === "UPDATE") {
    const broad = !hasWhere || hasBroadPredicate;
    return {
      kind: broad ? "destructive" : "mutation",
      normalizedSql,
      statementCount,
      requiresConfirmation: broad,
      reason: broad
        ? `${first} without a narrow predicate requires explicit confirmation.`
        : `${first} is scoped by a predicate and requires no destructive confirmation.`,
    };
  }

  if (
    ["DROP", "TRUNCATE", "GRANT", "REVOKE", "VACUUM"].includes(first) ||
    (first === "ALTER" && tokens.includes("DROP")) ||
    (first === "CREATE" && tokens.includes("DATABASE"))
  ) {
    return {
      kind: "critical",
      normalizedSql,
      statementCount,
      requiresConfirmation: true,
      reason:
        "This SQL can cause broad or irreversible changes and requires explicit confirmation.",
    };
  }

  if (["INSERT", "MERGE", "CREATE", "ALTER", "COMMENT", "REINDEX", "SET"].includes(first)) {
    return {
      kind: "mutation",
      normalizedSql,
      statementCount,
      requiresConfirmation: false,
      reason: "This SQL changes database state but is not classified as broadly destructive.",
    };
  }

  return {
    kind: "critical",
    normalizedSql,
    statementCount,
    requiresConfirmation: true,
    reason: "Unknown SQL is held for explicit confirmation before execution.",
  };
}

export function sqlConfirmationAction(sqlOrClassification: string | SqlClassification): string {
  const normalizedSql =
    typeof sqlOrClassification === "string"
      ? classifySql(sqlOrClassification).normalizedSql
      : sqlOrClassification.normalizedSql;
  const digest = createHash("sha256").update(normalizedSql.trim()).digest("hex").slice(0, 16);
  return `sql.destructive:${digest}`;
}

export function createConfirmationChallenge(action: SensitiveAction): ConfirmationChallenge {
  return { action, token: randomBytes(24).toString("base64url") };
}

export function assertConfirmation(
  action: string,
  expected: ConfirmationChallenge | undefined,
  provided: ConfirmationChallenge | undefined,
): void {
  if (!isDangerousAction(action)) {
    return;
  }

  if (!expected || !provided) {
    throw new ConfirmationRequiredError(action);
  }

  const expectedToken = Buffer.from(expected.token);
  const providedToken = Buffer.from(provided.token);
  if (
    expected.action !== action ||
    provided.action !== action ||
    expectedToken.length !== providedToken.length ||
    !timingSafeEqual(expectedToken, providedToken)
  ) {
    throw new InvalidConfirmationError(action);
  }
}

export class ProjectScopeError extends Error {
  readonly code = "PROJECT_SCOPE_MISMATCH" as const;

  constructor(
    readonly projectId: string,
    readonly workspaceId: string,
  ) {
    super(`Project ${projectId} is outside workspace ${workspaceId}.`);
    this.name = "ProjectScopeError";
  }
}

export class WorkspaceScopeError extends Error {
  readonly code = "WORKSPACE_SCOPE_MISMATCH" as const;

  constructor(readonly workspaceId: string) {
    super(`The authenticated principal is outside workspace ${workspaceId}.`);
    this.name = "WorkspaceScopeError";
  }
}

export interface AuthorizationPrincipal {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
}

export interface ProjectScopeResolver {
  projectBelongsToWorkspace(projectId: string, workspaceId: string): Promise<boolean>;
}

export interface ProjectActionAuthorizationInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly permission: Permission;
  readonly action: string;
  readonly expectedConfirmation?: ConfirmationChallenge;
  readonly providedConfirmation?: ConfirmationChallenge;
}

export async function authorizeProjectAction(
  principal: AuthorizationPrincipal,
  input: ProjectActionAuthorizationInput,
  scopeResolver: ProjectScopeResolver,
): Promise<void> {
  if (principal.workspaceId !== input.workspaceId) {
    throw new ProjectScopeError(input.projectId, input.workspaceId);
  }

  if (!(await scopeResolver.projectBelongsToWorkspace(input.projectId, input.workspaceId))) {
    throw new ProjectScopeError(input.projectId, input.workspaceId);
  }

  assertPermission(principal.role, input.permission);
  assertConfirmation(input.action, input.expectedConfirmation, input.providedConfirmation);
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

export class RateLimitError extends Error {
  readonly code = "RATE_LIMITED" as const;

  constructor(readonly retryAfterMs: number) {
    super("This action is temporarily rate limited. Try again later.");
    this.name = "RateLimitError";
  }
}

interface RateLimitWindow {
  count: number;
  startedAt: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, RateLimitWindow>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("Rate limiter limit and window must be positive.");
    }
  }

  consume(key: string): RateLimitDecision {
    const currentTime = this.now();
    const existing = this.windows.get(key);
    const window =
      !existing || currentTime - existing.startedAt >= this.windowMs
        ? { count: 0, startedAt: currentTime }
        : existing;

    if (window.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, this.windowMs - (currentTime - window.startedAt)),
      };
    }

    window.count += 1;
    this.windows.set(key, window);
    return {
      allowed: true,
      remaining: this.limit - window.count,
      retryAfterMs: 0,
    };
  }

  assertAllowed(key: string): void {
    const decision = this.consume(key);
    if (!decision.allowed) {
      throw new RateLimitError(decision.retryAfterMs);
    }
  }
}

export interface ExecuteProjectActionInput<T = unknown> extends ProjectActionAuthorizationInput {
  readonly principal: AuthorizationPrincipal;
  readonly provider?: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly requestId: string;
  readonly rateLimitKey?: string;
  readonly rateLimiter?: FixedWindowRateLimiter;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly resultMetadata?: (result: T) => Readonly<Record<string, unknown>>;
  readonly execute: () => Promise<T>;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNEXPECTED_ERROR";
}

function auditEntry<T>(
  input: ExecuteProjectActionInput<T>,
  result: AuditLogEntry["result"],
  error?: unknown,
  executionResult?: T,
): AuditLogEntry {
  const dynamicMetadata =
    result === "success" && input.resultMetadata && executionResult !== undefined
      ? input.resultMetadata(executionResult)
      : undefined;
  const mergedMetadata = {
    ...(input.metadata ?? {}),
    ...(dynamicMetadata ?? {}),
    ...(error ? { errorCode: errorCode(error) } : {}),
  };
  return {
    actorUserId: input.principal.userId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    provider: input.provider,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    action: input.action,
    requestId: input.requestId,
    result,
    metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
  };
}

export async function executeAuthorizedProjectAction<T>(
  input: ExecuteProjectActionInput<T>,
  scopeResolver: ProjectScopeResolver,
  audit: AuditLogWriter,
): Promise<T> {
  try {
    await authorizeProjectAction(input.principal, input, scopeResolver);
    if (input.rateLimiter && input.rateLimitKey) {
      input.rateLimiter.assertAllowed(input.rateLimitKey);
    }
  } catch (error) {
    await audit.write(auditEntry(input, "denied", error));
    throw error;
  }

  try {
    const result = await input.execute();
    await audit.write(auditEntry(input, "success", undefined, result));
    return result as T;
  } catch (error) {
    await audit.write(auditEntry(input, "failure", error));
    throw error;
  }
}

export interface ExecuteWorkspaceActionInput<T> {
  readonly principal: AuthorizationPrincipal;
  readonly workspaceId: string;
  readonly permission: Permission;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly requestId: string;
  readonly rateLimitKey?: string;
  readonly rateLimiter?: FixedWindowRateLimiter;
  readonly execute: () => Promise<T>;
}

export async function executeAuthorizedWorkspaceAction<T>(
  input: ExecuteWorkspaceActionInput<T>,
  audit: AuditLogWriter,
): Promise<T> {
  const entry = (result: AuditLogEntry["result"], error?: unknown): AuditLogEntry => ({
    actorUserId: input.principal.userId,
    workspaceId: input.workspaceId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    action: input.action,
    requestId: input.requestId,
    result,
    metadata: error ? { errorCode: errorCode(error) } : undefined,
  });

  try {
    if (input.principal.workspaceId !== input.workspaceId) {
      throw new WorkspaceScopeError(input.workspaceId);
    }
    assertPermission(input.principal.role, input.permission);
    if (input.rateLimiter && input.rateLimitKey) {
      input.rateLimiter.assertAllowed(input.rateLimitKey);
    }
  } catch (error) {
    await audit.write(entry("denied", error));
    throw error;
  }

  try {
    const result = await input.execute();
    await audit.write(entry("success"));
    return result;
  } catch (error) {
    await audit.write(entry("failure", error));
    throw error;
  }
}
