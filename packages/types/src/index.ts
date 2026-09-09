export type ProviderName = "supabase" | "firebase";

export type WorkspaceRole = "owner" | "admin" | "developer" | "analyst" | "viewer";

export type EnvironmentName = "production" | "staging" | "development";

export type ProviderConnectionState =
  | "pending"
  | "healthy"
  | "degraded"
  | "disconnected"
  | "credentials_expired"
  | "permission_missing";

export interface ProviderCapabilities {
  projectMetadata: boolean;
  relationalDatabase: boolean;
  documentDatabase: boolean;
  realtimeDatabase: boolean;
  sql: boolean;
  auth: boolean;
  storage: boolean;
  functions: boolean;
  logs: boolean;
  metrics: boolean;
  security: boolean;
}
