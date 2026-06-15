import type { UserProfile } from "@/lib/auth";
import type { AuthUserContext } from "@/lib/authz";
import type { getSupabaseServerClient } from "@/lib/supabase-server";

type RouteAccessSupabase = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

function uniqueIds(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

export async function loadAccessibleOperatorIds(
  supabase: RouteAccessSupabase | null | undefined,
  profile: UserProfile | null | undefined,
) {
  const fallbackIds = uniqueIds([profile?.team_member_id]);
  if (!supabase || !profile?.id) return fallbackIds;

  const { data, error } = await supabase
    .from("team_members")
    .select("id")
    .eq("auth_user_id", profile.id);

  if (error) {
    console.warn("[operator-route-access] Could not load linked operator identities", {
      auth_user_id: profile.id,
      team_member_id: profile.team_member_id ?? null,
      error,
    });
    return fallbackIds;
  }

  return uniqueIds([
    ...fallbackIds,
    ...((data ?? []).map((row: { id?: unknown }) => String(row.id ?? "").trim())),
  ]);
}

export async function buildOperatorRouteAccessContext(
  supabase: RouteAccessSupabase | null | undefined,
  profile: UserProfile | null | undefined,
): Promise<AuthUserContext | null> {
  if (!profile) return null;

  const linkedTeamMemberIds = await loadAccessibleOperatorIds(supabase, profile);
  return {
    id: profile.id,
    role: profile.role,
    roles: profile.roles,
    canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id,
    linkedTeamMemberIds,
    activeStatus: profile.active_status,
  };
}

export function preferredOperatorViewerId(
  profile: UserProfile | null | undefined,
  linkedTeamMemberIds: string[],
) {
  return profile?.team_member_id ?? linkedTeamMemberIds[0] ?? null;
}
