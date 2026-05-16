"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole, parseAppRole } from "@/lib/authz";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import { tempPasswordCookie } from "@/lib/team";

function teamPayload(formData: FormData) {
  const role = parseAppRole(String(formData.get("role") || "operator")) ?? "operator";

  return {
    full_name: String(formData.get("full_name") || "").trim(),
    email: String(formData.get("email") || "").trim() || null,
    phone: String(formData.get("phone") || "").trim() || null,
    role,
    active: String(formData.get("active") || "true") === "true",
    active_status: String(formData.get("active") || "true") === "true" ? "active" : "inactive",
  };
}

async function setTemporaryPasswordBanner(payload: { fullName: string; email: string; password: string }) {
  const cookieStore = await cookies();
  cookieStore.set(tempPasswordCookie, encodeURIComponent(JSON.stringify(payload)), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/team",
    maxAge: 60 * 5,
  });
}

async function createOrResetAuthUser(teamMemberId: string, payload: ReturnType<typeof teamPayload>, password: string, existingAuthUserId?: string | null) {
  if (!payload.email) throw new Error("Email is required to create login access.");
  if (!password || password.length < 10) throw new Error("Temporary password must be at least 10 characters.");

  const admin = getSupabaseAdminClient();
  if (!admin) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to create Supabase Auth users.");

  const userResult = existingAuthUserId
    ? await admin.auth.admin.updateUserById(existingAuthUserId, {
        email: payload.email,
        password,
        email_confirm: true,
        user_metadata: { full_name: payload.full_name },
      })
    : await admin.auth.admin.createUser({
        email: payload.email,
        password,
        email_confirm: true,
        user_metadata: { full_name: payload.full_name },
      });

  if (userResult.error || !userResult.data.user) throw userResult.error ?? new Error("Could not create login access.");

  const authUserId = userResult.data.user.id;
  await admin.from("team_members").update({ auth_user_id: authUserId, must_change_password: true }).eq("id", teamMemberId);
  await admin.from("profiles").upsert({
    id: authUserId,
    full_name: payload.full_name,
    email: payload.email,
    phone: payload.phone,
    role: payload.role,
    active_status: payload.active_status,
    team_member_id: teamMemberId,
    must_change_password: true,
    updated_at: new Date().toISOString(),
  });

  await setTemporaryPasswordBanner({ fullName: payload.full_name, email: payload.email, password });
}

async function syncProfile(teamMemberId: string, payload: ReturnType<typeof teamPayload>, authUserId?: string | null) {
  const supabase = getSupabaseServerClient();
  if (!supabase) return;

  await supabase
    .from("profiles")
    .update({
      full_name: payload.full_name,
      email: payload.email,
      phone: payload.phone,
      role: payload.role,
      active_status: payload.active_status,
      team_member_id: teamMemberId,
      updated_at: new Date().toISOString(),
    })
    .or(`team_member_id.eq.${teamMemberId}${authUserId ? `,id.eq.${authUserId}` : ""}${payload.email ? `,email.eq.${payload.email}` : ""}`);
}

export async function createTeamMember(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile?.role)) redirect("/unauthorized");

  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/team/new?error=Supabase%20is%20not%20configured.");

  const payload = teamPayload(formData);
  if (!payload.full_name) redirect("/team/new?error=Full%20name%20is%20required.");

  const { data, error } = await supabase.from("team_members").insert(payload).select("id").single();
  if (error || !data?.id) {
    console.error("[team:create] Failed to create team member", error);
    redirect("/team/new?error=Could%20not%20create%20team%20member.");
  }

  try {
    if (String(formData.get("create_login_access") || "") === "yes") {
      await createOrResetAuthUser(data.id, payload, String(formData.get("temporary_password") || ""));
    } else {
      await syncProfile(data.id, payload);
    }
  } catch (error) {
    console.error("[team:create] Login access creation failed", error);
    redirect(`/team/${data.id}/edit?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not create login access.")}`);
  }

  revalidatePath("/team");
  redirect("/team");
}

export async function updateTeamMember(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile?.role)) redirect("/unauthorized");

  const supabase = getSupabaseServerClient();
  const id = String(formData.get("id") || "");
  if (!supabase) redirect(`/team/${id}/edit?error=Supabase%20is%20not%20configured.`);
  if (!id) redirect("/team?error=Missing%20team%20member.");

  const payload = teamPayload(formData);
  if (!payload.full_name) redirect(`/team/${id}/edit?error=Full%20name%20is%20required.`);

  const { data: existingMember } = await supabase.from("team_members").select("auth_user_id").eq("id", id).maybeSingle();

  const { error } = await supabase.from("team_members").update(payload).eq("id", id);
  if (error) {
    console.error("[team:update] Failed to update team member", { id, error });
    redirect(`/team/${id}/edit?error=Could%20not%20update%20team%20member.`);
  }

  try {
    if (String(formData.get("create_login_access") || "") === "yes") {
      await createOrResetAuthUser(id, payload, String(formData.get("temporary_password") || ""), existingMember?.auth_user_id ?? null);
    } else {
      await syncProfile(id, payload, existingMember?.auth_user_id ?? null);
    }
  } catch (error) {
    console.error("[team:update] Login access update failed", error);
    redirect(`/team/${id}/edit?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not update login access.")}`);
  }

  revalidatePath("/team");
  revalidatePath(`/team/${id}/edit`);
  redirect("/team");
}
