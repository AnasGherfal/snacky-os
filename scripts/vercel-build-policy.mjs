// Pure path classifier for Vercel production build skip. Fail open on unknowns.
export function skipProductionBuildForChanges(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return false;
  return changedPaths.every((path) =>
    typeof path === "string" && path.length > 0 &&
    (
      path.startsWith(".github/") ||
      path.startsWith("docs/") ||
      path.startsWith("supabase/migrations/") ||
      path.startsWith("scripts/sql/") ||
      /^scripts\/test-[^/]+\.(mjs|js)$/.test(path) ||
      path === "README.md" ||
      path === "AGENTS.md"
    )
  );
}
