import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

for (const envFile of [".env.local", ".env"]) {
  const fullPath = path.join(repositoryRoot, envFile);
  if (existsSync(fullPath)) {
    loadEnvFile(fullPath);
  }
}

if (process.platform === "win32") {
  const originalSymlinkSync = fs.symlinkSync.bind(fs);
  fs.symlinkSync = (target, linkPath, type) => {
    try {
      return originalSymlinkSync(target, linkPath, type);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
        return originalSymlinkSync(target, linkPath, "junction");
      }
      throw error;
    }
  };
  syncBuiltinESMExports();
}

const appDir = path.join(repositoryRoot, "apps", "web");
process.chdir(appDir);

const cliPath = new URL(
  "../node_modules/@opennextjs/cloudflare/dist/cli/index.js",
  import.meta.url,
);

await import(cliPath.href);
