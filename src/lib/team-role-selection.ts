import { appRoles, normalizeRoles, type AppRole } from "./authz.ts";

/** Submitted checkbox values are the whole new role set, never additions to the old role. */
export function selectedTeamRoles(values: unknown[]): AppRole[] {
  if (!values.length || values.some((value) => typeof value !== "string" || !appRoles.includes(value as AppRole))) {
    throw new Error("Select at least one valid role. Unchecked roles will be removed.");
  }
  return normalizeRoles(values);
}

export function teamProductPermission(roles: AppRole[], requested: boolean): boolean {
  if (roles.length === 1 && roles[0] === "investor") return false;
  return requested || roles.includes("owner") || roles.includes("admin");
}
