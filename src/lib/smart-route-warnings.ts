/**
 * Keep Smart Route diagnostics operator-readable. A shortage is actionable;
 * dozens of line-by-line warning cards are not. Audit persistence continues
 * to retain raw warnings for later investigation.
 */
export function summarizeSmartRouteWarnings(input: string[]) {
  const warnings = Array.from(new Set(input.map((x) => String(x ?? "").trim()).filter(Boolean)));
  const buckets: Array<{ prefix: string; title: string }> = [
    { prefix: "HARD NO-EMPTY-LANE EXCEPTION", title: "No compatible in-stock product for" },
    { prefix: "No verified in-stock compatible product", title: "No compatible storage stock for" },
    { prefix: "Skipped stale XY lane", title: "Outdated XY lane snapshots on" },
    { prefix: "Coverage exception", title: "Partial lane coverage on" },
    { prefix: "Clamped ", title: "Some planned quantities were lowered by storage limits on" },
    { prefix: "AI assortment optimization:", title: "Sales-backed assortment improvements suggested for" },
    { prefix: "Ignored invalid AI product", title: "AI suggestions were safely replaced for" },
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const bucket of buckets) {
    const matched = warnings.filter((line) => line.startsWith(bucket.prefix));
    matched.forEach((line) => seen.add(line));
    if (matched.length) result.push(`${bucket.title} ${matched.length} selection${matched.length === 1 ? "" : "s"}. ${matched[0].slice(0, 150)}`);
  }
  const other = warnings.filter((line) => !seen.has(line));
  result.push(...other.slice(0, 5));
  if (other.length > 5) result.push(`${other.length - 5} additional technical notes are available in the plan audit.`);
  return result;
}
