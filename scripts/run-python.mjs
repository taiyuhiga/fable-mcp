#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
for (const command of ["python3", "python"]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error?.code === "ENOENT") {
    continue;
  }
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

console.error("python3 or python is required");
process.exit(127);
