import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { AppRole, getDefaultPathForRole, parseAppRole } from "@/lib/authz";

export const accessTokenCookie = "snacky-auth-access-token";
export const refreshTokenCookie = "snacky-auth-refresh-token";

export type UserProfile = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: AppRole;
  active_status: "active" | "inactive";
  team_member_id: string | null;
};

export async function getAuthAccessToken() {
  const cookieStore = await cookies();
  return cookieStore.get(accessTokenCookie)?.value ?? null;
}

export async function getCurrentProfile(): Promise<UserProfile | null> {
  const accessToken = await getAuthAccessToken();
  if (!accessToken) return null;

  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) {
    console.error("[auth] Failed to load Supabase auth user", userError);
    return null;
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, full_name, email, phone, role, active_status, team_member_id")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError) {
    console.error("[auth] Failed to load profile", { userId: userData.user.id, error: profileError });
    if (profileError.message?.includes("profiles") || profileError.code === "42P01" || profileError.code === "PGRST205") {
      return getProfileFromTeamMember(userData.user.id, userData.user.email ?? null);
    }
    return null;
  }

  if (!profile) return getProfileFromTeamMember(userData.user.id, userData.user.email ?? null);

  const role = parseAppRole(profile.role);
  if (!role) return null;

  return {
    id: profile.id,
    full_name: profile.full_name,
    email: profile.email,
    phone: profile.phone,
    role,
    active_status: profile.active_status === "inactive" ? "inactive" : "active",
    team_member_id: profile.team_member_id,
  };
}

async function getProfileFromTeamMember(authUserId: string, email: string | null): Promise<UserProfile | null> {
  if (!email) return null;

  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const { data: teamMember, error } = await supabase
    .from("team_members")
    .select("id, full_name, email, phone, role, active")
    .eq("email", email)
    .maybeSingle();

  if (error || !teamMember) {
    if (error) console.error("[auth] Failed to load team member fallback profile", { email, error });
    return null;
  }

  const role = parseAppRole(teamMember.role);
  if (!role) return null;

  return {
    id: authUserId,
    full_name: teamMember.full_name,
    email: teamMember.email,
    phone: teamMember.phone,
    role,
    active_status: teamMember.active ? "active" : "inactive",
    team_member_id: teamMember.id,
  };
}

export async function ensureProfileForAuthUser(user: { id: string; email?: string | null; user_metadata?: { full_name?: string } }) {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const { data: existingProfile, error: existingProfileError } = await supabase
    .from("profiles")
    .select("id, full_name, email, phone, role, active_status, team_member_id")
    .eq("id", user.id)
    .maybeSingle();

  if (existingProfile) {
    await supabase.from("profiles").update({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", user.id);
    return existingProfile;
  }
  if (existingProfileError?.message?.includes("profiles") || existingProfileError?.code === "42P01" || existingProfileError?.code === "PGRST205") {
    return getProfileFromTeamMember(user.id, user.email ?? null);
  }

  const { data: teamMember } = user.email
    ? await supabase.from("team_members").select("id, full_name, email, phone, role, active").eq("email", user.email).maybeSingle()
    : { data: null };

  const payload = {
    id: user.id,
    full_name: teamMember?.full_name ?? user.user_metadata?.full_name ?? user.email ?? "Unassigned user",
    email: user.email ?? teamMember?.email ?? null,
    phone: teamMember?.phone ?? null,
    role: parseAppRole(teamMember?.role) ?? "viewer",
    active_status: teamMember ? (teamMember.active ? "active" : "inactive") : "inactive",
    team_member_id: teamMember?.id ?? null,
    last_login_at: new Date().toISOString(),
  };

  const { data: profile, error } = await supabase.from("profiles").insert(payload).select("id, full_name, email, phone, role, active_status, team_member_id").single();
  if (error) {
    console.error("[auth] Failed to create profile", { userId: user.id, error });
    return null;
  }

  return profile;
}

export async function redirectToDefaultForRole(role: AppRole | null | undefined): Promise<never> {
  redirect(getDefaultPathForRole(role));
}
