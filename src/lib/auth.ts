import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import { AppRole, canAccessPath, getDefaultPathForRole, normalizeRoles, parseAppRole } from "@/lib/authz";

export const accessTokenCookie = "snacky-auth-access-token";
export const refreshTokenCookie = "snacky-auth-refresh-token";
const sessionRefreshThresholdMs = 5 * 60 * 1000;

export type UserProfile = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: AppRole;
  roles: AppRole[];
  can_add_products: boolean;
  active_status: "active" | "inactive";
  team_member_id: string | null;
  must_change_password: boolean;
};

type AuthLookupUser = {
  id: string;
  email?: string | null;
  user_metadata?: { full_name?: string };
};

type ProfileRow = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: string;
  roles?: string[] | null;
  can_add_products?: boolean | null;
  active_status: string | null;
  team_member_id: string | null;
  must_change_password?: boolean | null;
};

type TeamMemberRow = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: string;
  roles?: string[] | null;
  can_add_products?: boolean | null;
  active?: boolean | null;
  active_status?: string | null;
  auth_user_id?: string | null;
  must_change_password?: boolean | null;
};

type ResolvedAuthSession = {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  secondsUntilExpiry: number;
  refreshed: boolean;
};

function jwtExpiresAt(token: string | null) {
  if (!token) return null;
  try {
    const [, payload] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

function secondsUntilExpiry(expiresAt: number | null) {
  if (!expiresAt) return 0;
  return Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
}

export async function refreshAuthSession(refreshToken: string): Promise<ResolvedAuthSession | null> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session?.access_token) {
    console.warn("[auth] Failed to refresh session", error);
    return null;
  }

  const accessToken = data.session.access_token;
  const expiresAt = jwtExpiresAt(accessToken);

  return {
    accessToken,
    refreshToken: data.session.refresh_token ?? refreshToken,
    expiresAt,
    secondsUntilExpiry: secondsUntilExpiry(expiresAt),
    refreshed: true,
  };
}

export async function resolveAuthSession(options?: { forceRefresh?: boolean }): Promise<ResolvedAuthSession | null> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(accessTokenCookie)?.value ?? null;
  const refreshToken = cookieStore.get(refreshTokenCookie)?.value ?? null;
  const expiresAt = jwtExpiresAt(accessToken);
  const hasUsableAccessToken = Boolean(accessToken) && (expiresAt === null || expiresAt > Date.now());
  const shouldRefresh =
    Boolean(refreshToken) &&
    (options?.forceRefresh || !hasUsableAccessToken || !expiresAt || expiresAt - Date.now() <= sessionRefreshThresholdMs);

  if (shouldRefresh && refreshToken) {
    const refreshed = await refreshAuthSession(refreshToken);
    if (refreshed) return refreshed;
  }

  if (!hasUsableAccessToken) return null;

  return {
    accessToken,
    refreshToken,
    expiresAt,
    secondsUntilExpiry: secondsUntilExpiry(expiresAt),
    refreshed: false,
  };
}

export const getResolvedAuthSession = cache(async function getResolvedAuthSession() {
  return resolveAuthSession();
});

export async function getAuthAccessToken() {
  return (await getResolvedAuthSession())?.accessToken ?? null;
}

export async function getAuthenticatedSupabaseServerClient() {
  const session = await getResolvedAuthSession();
  return getSupabaseServerClient(session?.accessToken ?? null);
}

export const getCurrentProfile = cache(async function getCurrentProfile(): Promise<UserProfile | null> {
  const session = await getResolvedAuthSession();
  const accessToken = session?.accessToken ?? null;
  if (!accessToken) return null;

  const supabase = getSupabaseServerClient(accessToken);
  if (!supabase) return null;

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) {
    console.error("[auth] Failed to load Supabase auth user", userError);
    return null;
  }

  return loadCanonicalProfile(userData.user, accessToken);
});
function getAuthLookupClient(accessToken?: string | null) {
  return getSupabaseAdminClient() ?? getSupabaseServerClient(accessToken);
}

function normalizeActiveStatus(value: string | null | undefined): "active" | "inactive" {
  return value === "inactive" ? "inactive" : "active";
}

function teamMemberActiveStatus(teamMember: TeamMemberRow | null | undefined): "active" | "inactive" | null {
  if (!teamMember) return null;
  if (teamMember.active_status === "active" || teamMember.active_status === "inactive") {
    return teamMember.active_status;
  }
  if (teamMember.active === false) return "inactive";
  return "active";
}

async function getTeamMemberForAuthUser(supabase: SupabaseClient, authUserId: string, teamMemberId?: string | null) {
  if (teamMemberId) {
    const byId = await supabase
      .from("team_members")
      .select("id, full_name, email, phone, role, roles, can_add_products, active, active_status, auth_user_id, must_change_password")
      .eq("id", teamMemberId)
      .maybeSingle<TeamMemberRow>();

    if (byId.error) return { teamMember: null, error: byId.error };
    if (byId.data) return { teamMember: byId.data, error: null };
  }

  const byAuth = await supabase
    .from("team_members")
    .select("id, full_name, email, phone, role, roles, can_add_products, active, active_status, auth_user_id, must_change_password")
    .eq("auth_user_id", authUserId)
    .maybeSingle<TeamMemberRow>();

  return { teamMember: byAuth.data ?? null, error: byAuth.error };
}

function profileFromRows(user: AuthLookupUser, profile: ProfileRow | null, teamMember: TeamMemberRow | null): UserProfile | null {
  const role = parseAppRole(profile?.role) ?? parseAppRole(teamMember?.role);
  if (!role) return null;
  const roles = normalizeRoles(
    [
      ...(Array.isArray(profile?.roles) ? profile.roles : []),
      ...(Array.isArray(teamMember?.roles) ? teamMember.roles : []),
      profile?.role,
      teamMember?.role,
    ].filter(Boolean),
    role,
  );
  const canAddProducts = Boolean(profile?.can_add_products || teamMember?.can_add_products || false);

  if (profile) {
    return {
      id: profile.id,
      full_name: profile.full_name,
      email: profile.email,
      phone: profile.phone,
      role,
      roles,
      can_add_products: canAddProducts,
      active_status: normalizeActiveStatus(profile.active_status),
      team_member_id: profile.team_member_id ?? teamMember?.id ?? null,
      must_change_password: Boolean(profile.must_change_password ?? teamMember?.must_change_password ?? false),
    };
  }

  if (!teamMember) return null;

  return {
    id: user.id,
    full_name: teamMember.full_name,
    email: teamMember.email ?? user.email ?? null,
    phone: teamMember.phone,
    role,
    roles,
    can_add_products: canAddProducts,
    active_status: teamMemberActiveStatus(teamMember) ?? "inactive",
    team_member_id: teamMember.id,
    must_change_password: Boolean(teamMember.must_change_password ?? false),
  };
}

function logProfileLookupFailure(payload: {
  user: AuthLookupUser;
  profile: ProfileRow | null;
  teamMember: TeamMemberRow | null;
  profileError?: unknown;
  teamMemberError?: unknown;
  reason: string;
}) {
  console.warn("[auth] Profile lookup failed", {
    reason: payload.reason,
    authUserId: payload.user.id,
    email: payload.user.email ?? null,
    profileRowFound: Boolean(payload.profile),
    teamMemberRowFound: Boolean(payload.teamMember),
    role: payload.profile?.role ?? payload.teamMember?.role ?? null,
    active_status: payload.profile?.active_status ?? payload.teamMember?.active_status ?? null,
    profileError: payload.profileError ?? null,
    teamMemberError: payload.teamMemberError ?? null,
  });
}

async function loadCanonicalProfile(user: AuthLookupUser, accessToken?: string | null): Promise<UserProfile | null> {
  const supabase = getAuthLookupClient(accessToken);
  if (!supabase) return null;

  const { data: existingProfile, error: existingProfileError } = await supabase
    .from("profiles")
    .select("id, full_name, email, phone, role, roles, can_add_products, active_status, team_member_id, must_change_password")
    .eq("id", user.id)
    .maybeSingle<ProfileRow>();

  const { teamMember, error: teamMemberError } = await getTeamMemberForAuthUser(supabase, user.id, existingProfile?.team_member_id);
  const resolvedProfile = profileFromRows(user, existingProfile ?? null, teamMember);

  if (resolvedProfile) {
    if (resolvedProfile.active_status !== "active") {
      logProfileLookupFailure({
        user,
        profile: existingProfile ?? null,
        teamMember,
        profileError: existingProfileError,
        teamMemberError,
        reason: "profile_inactive",
      });
    }
    return resolvedProfile;
  }

  logProfileLookupFailure({
    user,
    profile: existingProfile ?? null,
    teamMember,
    profileError: existingProfileError,
    teamMemberError,
    reason: existingProfileError ? "profile_query_error" : teamMemberError ? "team_member_query_error" : "missing_or_invalid_profile",
  });

  return null;
}

export async function ensureProfileForAuthUser(user: AuthLookupUser, accessToken?: string | null) {
  const existingProfile = await loadCanonicalProfile(user, accessToken);
  const supabase = getAuthLookupClient(accessToken);
  if (!supabase) return null;
  if (existingProfile) {
    await supabase.from("profiles").update({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", user.id);
    return existingProfile;
  }

  const { teamMember } = await getTeamMemberForAuthUser(supabase, user.id);
  if (!teamMember) return null;

  const payload = {
    id: user.id,
    full_name: teamMember.full_name ?? user.user_metadata?.full_name ?? user.email ?? "Unassigned user",
    email: user.email ?? teamMember.email ?? null,
    phone: teamMember.phone ?? null,
    role: parseAppRole(teamMember.role) ?? "viewer",
    roles: normalizeRoles(teamMember.roles, teamMember.role),
    can_add_products: Boolean(teamMember.can_add_products ?? false),
    active_status: teamMemberActiveStatus(teamMember) ?? "inactive",
    team_member_id: teamMember.id,
    must_change_password: Boolean(teamMember.must_change_password ?? false),
    last_login_at: new Date().toISOString(),
  };

  const { data: profile, error } = await supabase
    .from("profiles")
    .insert(payload)
    .select("id, full_name, email, phone, role, roles, can_add_products, active_status, team_member_id, must_change_password")
    .single<ProfileRow>();

  if (error) {
    console.error("[auth] Failed to create profile", { userId: user.id, error });
    return null;
  }

  return profileFromRows(user, profile, teamMember);
}

export async function redirectToDefaultForRole(role: AppRole | null | undefined): Promise<never> {
  redirect(getDefaultPathForRole(role));
}

export async function requireCurrentProfileForPath(pathname: string): Promise<UserProfile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect(`/login?next=${encodeURIComponent(pathname)}`);
  if (
    profile.active_status !== "active" ||
    !canAccessPath(
      {
        id: profile.id,
        role: profile.role,
        roles: profile.roles,
        canAddProducts: profile.can_add_products,
        teamMemberId: profile.team_member_id,
        activeStatus: profile.active_status,
      },
      pathname,
    )
  ) {
    redirect("/unauthorized");
  }
  return profile;
}




