// Vercel ignoreCommand: exit 0 skips a build; exit 1 continues it.
// Production and unknown environments always build. Important previews are
// explicitly opted in by using preview/, qa/, release/, or staging branches.
const environment = String(process.env.VERCEL_ENV ?? "").trim().toLowerCase();
const branch = String(process.env.VERCEL_GIT_COMMIT_REF ?? "").trim();

if (environment !== "preview") {
  console.log("[cost-gate] Continue: production or non-preview environment.");
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

console.log("[cost-gate] Skip routine preview build; GitHub CI can still run tests. Use a preview/, qa/, or release/ branch for a Vercel preview.");
process.exit(0);
