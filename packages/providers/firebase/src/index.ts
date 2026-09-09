import type { BackendProvider } from "@foundry/providers-core";

export type FirebaseProvider = BackendProvider & { readonly name: "firebase" };
