/** Combine independent groups of alternative movement conditions into one
 * PostgREST logic expression. Multiple .or() calls overwrite each other in the
 * query builder; they must be grouped in a single top-level .or() instead.
 * Every clause is supplied by a validated or existing filter caller.
 */
export function combineMovementFilterGroups(groups: readonly (readonly string[])[]): string | null {
  const filtered = groups.filter((group) => group.length > 0);
  if (!filtered.length) return null;
  if (filtered.length === 1) return filtered[0].join(",");
  const conjunction = filtered.map((group) => group.length === 1
    ? group[0]
    : `or(${group.join(",")})`);
  return `and(${conjunction.join(",")})`;
}
