// Vercel Ignored Build Step: exit 0 skips the build; exit 1 continues.
// Preserve all runtime code deployments. Skip routine previews and master
// commits that change only docs/CI/test/migrations (handled separately).
import { spawnSync } from "node:child_process";
import { skipProductionBuildForChanges } from "./vercel-build-policy.mjs";

const environment = String(process.env.VERCEL_ENV ?? "").trim().toLowerCase();
const branch = String(process.env.VERCEL_GIT_COMMIT_REF ?? "").trim();

if (environment === "production" && branch === "master") {
  // GitHub squash merges typically include only the changed files of a PR.
  // Use HEAD^ only; Git unavailable, missing parent, empty diff, or unexpected
  // errors ALWAYS deploy, never silently miss a production source change.
  const result = spawnSync("git", ["diff", "--name-only", "HEAD^", "HEAD", "--"], {
    encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024,
  });
  if (!result.error && result.status === 0) {
    const paths = result.stdout.split("\n").map((p) => p.trim()).filter(Boolean);
    if (skipProductionBuildForChanges(paths)) {
      console.log("[cost-gate] Skip non-runtime master commit; current production remains live.");
      process.exit(0);
    }
  }
  console.log("[cost-gate] Continue production build (runtime change or uncertain diff).");
  process.exit(1);
}

if (environment !== "preview") {
  console.log("[cost-gate] Continue: production or unknown environment.");
  process.exit(1);
}

if (!branch) {
  console.log("[cost-gate] Continue: unknown preview branch (fail open).");
  process.exit(1);
}

const previewRequested =
  branch === "staging" ||
  ["preview/", "qa/", "release/"].some((prefix) => branch.startsWith(prefix) && branch.length > prefix.length);

if (previewRequested) {
  console.log("[cost-gate] Continue: explicitly requested preview build.");
  process.exit(1);
}

console.log("[cost-gate] Skip routine preview build; GitHub CI can still run tests.");
process.exit(0);
