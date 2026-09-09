import type { BackendProvider } from "@foundry/providers-core";

export type SupabaseProvider = BackendProvider & { readonly name: "supabase" };
