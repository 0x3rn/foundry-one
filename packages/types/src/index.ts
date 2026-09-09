export type ProviderName = "supabase" | "firebase";

export type WorkspaceRole = "owner" | "admin" | "developer" | "analyst" | "viewer";

export interface ProviderCapabilities {
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
