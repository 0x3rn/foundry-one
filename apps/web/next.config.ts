import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import type { NextConfig } from "next";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const localEnvFile = resolve(repositoryRoot, ".env.local");

if (existsSync(localEnvFile)) {
  loadEnvFile(localEnvFile);
}

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repositoryRoot,
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
  outputFileTracingIncludes: {
    "/**": ["../../node_modules/pg-cloudflare/**/*"],
  },
  turbopack: {
    root: repositoryRoot,
  },
};

export default nextConfig;
