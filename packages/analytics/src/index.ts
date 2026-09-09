export interface MetricSnapshot {
  readonly projectId: string;
  readonly capturedAt: string;
  readonly values: Readonly<Record<string, number>>;
}
