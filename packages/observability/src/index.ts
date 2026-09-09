export interface LogContext {
  readonly requestId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly provider?: string;
}
