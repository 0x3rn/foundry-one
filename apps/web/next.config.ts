import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import type { NextConfig } from "next";

const repositoryRoot = resolve(__dirname, "../..");
const localEnvFile = resolve(repositoryRoot, ".env.local");

if (existsSync(localEnvFile)) {
  loadEnvFile(localEnvFile);
}

const nextConfig: NextConfig = {
  turbopack: {
    root: repositoryRoot,
  },
};

export default nextConfig;
