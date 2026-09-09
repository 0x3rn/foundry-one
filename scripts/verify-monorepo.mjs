import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requiredWorkspaces = [
  "@foundry/web",
  "@foundry/ui",
  "@foundry/database",
  "@foundry/auth",
  "@foundry/providers-core",
  "@foundry/providers-supabase",
  "@foundry/providers-firebase",
  "@foundry/encryption",
  "@foundry/security",
  "@foundry/observability",
  "@foundry/analytics",
  "@foundry/jobs",
  "@foundry/types",
];
const manifestPaths = [
  "apps/web/package.json",
  "packages/ui/package.json",
  "packages/database/package.json",
  "packages/auth/package.json",
  "packages/providers/core/package.json",
  "packages/providers/supabase/package.json",
  "packages/providers/firebase/package.json",
  "packages/encryption/package.json",
  "packages/security/package.json",
  "packages/observability/package.json",
  "packages/analytics/package.json",
  "packages/jobs/package.json",
  "packages/types/package.json",
];

const failures = [];
const manifests = new Map();
for (const relativePath of manifestPaths) {
  try {
    const manifest = JSON.parse(await readFile(join(root, relativePath), "utf8"));
    manifests.set(manifest.name, manifest);
  } catch (error) {
    failures.push(`Unable to read ${relativePath}: ${error.message}`);
  }
}
for (const workspaceName of requiredWorkspaces) {
  if (!manifests.has(workspaceName)) failures.push(`Missing required workspace ${workspaceName}`);
}
const web = manifests.get("@foundry/web");
if (web && !web.scripts?.typecheck) failures.push("@foundry/web is missing a typecheck script");
for (const provider of ["@foundry/providers-supabase", "@foundry/providers-firebase"]) {
  const manifest = manifests.get(provider);
  if (!manifest?.dependencies?.["@foundry/providers-core"]) {
    failures.push(`${provider} must depend on @foundry/providers-core`);
  }
  if (manifest?.dependencies?.["@foundry/ui"])
    failures.push(`${provider} must not depend on @foundry/ui`);
}
if (failures.length > 0) {
  console.error("Monorepo foundation verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Monorepo foundation verified: ${manifests.size} workspaces and provider boundaries are present.`,
  );
}
