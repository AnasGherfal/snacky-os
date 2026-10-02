import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const env = { ...process.env };

if (process.platform === "win32" && !env.NEXT_PRIVATE_BUILD_WORKER) {
  env.NEXT_PRIVATE_BUILD_WORKER = "0";
}

const child = spawn(process.execPath, [nextBin, "build", "--webpack"], {
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`next build exited with signal ${signal}`);
    process.exit(1);
  }

  process.exit(code ?? 0);
});
