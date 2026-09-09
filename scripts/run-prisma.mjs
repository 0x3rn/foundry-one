import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const envFiles = [".env.local", ".env"];

for (const envFile of envFiles) {
  if (existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

const prismaEntry = fileURLToPath(
  new URL("../node_modules/prisma/build/index.js", import.meta.url),
);
const child = spawn(
  process.execPath,
  [prismaEntry, ...process.argv.slice(2), "--schema", "prisma/schema.prisma"],
  {
    env: process.env,
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(`Unable to start Prisma: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Prisma exited after receiving ${signal}.`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 1;
});
