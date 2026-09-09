export interface LogContext {
  readonly requestId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly provider?: string;
}

export type AuditResult = "success" | "failure" | "denied";

export interface AuditLogEntry {
  readonly actorUserId?: string;
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly provider?: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly action: string;
  readonly requestId: string;
  readonly result: AuditResult;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditLogWriter {
  write(entry: AuditLogEntry): Promise<void>;
}

export interface StructuredLogEvent extends LogContext {
  readonly event: string;
  readonly result?: AuditResult;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StructuredLogSink {
  write(event: StructuredLogEvent): void;
}

const sensitiveKey =
  /(password|secret|token|credential|authorization|api[-_]?key|private[-_]?key)/i;

export function redactSensitiveMetadata(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return redactValue(value) as Readonly<Record<string, unknown>>;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redactValue(item),
    ]),
  );
}

export class SecretSafeLogger {
  constructor(private readonly sink: StructuredLogSink) {}

  write(event: StructuredLogEvent): void {
    this.sink.write({
      ...event,
      ...(event.metadata ? { metadata: redactSensitiveMetadata(event.metadata) } : {}),
    });
  }
}
