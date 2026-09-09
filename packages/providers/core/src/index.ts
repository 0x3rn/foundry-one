import type { ProviderCapabilities, ProviderName } from "@foundry/types";

export interface BackendProvider {
  readonly name: ProviderName;
  testConnection(): Promise<{ ok: true } | { ok: false; reason: string }>;
  getCapabilities(): Promise<ProviderCapabilities>;
}
