<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Foundry One project workflow

- Build the roadmap sequentially from the Foundry One project and its Linear issues/milestones. Preserve the provider-neutral architecture described in Linear and the technical handbook in Notion.
- Treat each issue as a documented delivery slice. Before coding, understand its acceptance behavior and dependencies. After coding, record the implementation, code paths, design/security decisions, verification commands, failures found, and any remaining limitation in Notion.
- Keep Linear current as work progresses: update the issue status, add a natural progress comment when a meaningful slice is completed or blocked, and publish a project status update for material roadmap progress. Keep the issue open when a live dependency or acceptance check is still outstanding.
- For every completed issue, run terminal-runnable verification covering normal behavior plus invalid, boundary, permission, and failure cases that apply. Report the exact commands and outcomes in the issue and Notion record.
- Create a local Git commit for completed work and never push unless the user explicitly asks. A checkpoint commit may preserve a partially verified slice, but it must be clearly labeled as a checkpoint and must not be represented as an issue completion.
- Never log or document secret values. Local credentials belong in ignored `.env.local`; `.env.example` may contain names and safe placeholders only.
- Keep the tone of project documentation human and specific: describe what changed, why the boundary exists, how the behavior was proven, and what remains before the next issue can start.
