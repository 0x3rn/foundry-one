# Foundry One

Foundry One is a provider-neutral backend control plane. The repository is a TypeScript workspace with a Next.js App Router application and shared packages for provider contracts, persistence, authentication, security, analytics, jobs, and UI.

## Repository layout

- `apps/web` — Next.js App Router application.
- `packages/providers/core` — provider-neutral backend contracts.
- `packages/providers/supabase` — Supabase adapter boundary.
- `packages/providers/firebase` — Firebase adapter boundary.
- `packages/database` — Foundry persistence boundary.
- `packages/auth` — account and workspace authentication boundary.
- `packages/encryption` — credential-envelope boundary.
- `packages/security` — authorization and security types.
- `packages/observability` — logging and correlation types.
- `packages/analytics` — metric snapshot types.
- `packages/jobs` — background-work contracts.
- `packages/ui` — shared presentation boundary.
- `packages/types` — shared domain types.

## Validation

```bash
npm install
npm run test:foundation
npm run typecheck
npm run lint
npm test
npm run build
```

Provider implementations must depend on `@foundry/providers-core`, never on UI code. Shared product code should consume provider-neutral contracts rather than importing provider SDKs directly.
