"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole, parseAppRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function teamPayload(formData: FormData) {
  const role = parseAppRole(String(formData.get("role") || "operator")) ?? "operator";

  return {
    full_name: String(formData.get("full_name") || "").trim(),
    email: String(formData.get("email") || "").trim() || null,
    phone: String(formData.get("phone") || "").trim() || null,
    role,
    active: String(formData.get("active") || "true") === "true",
  };
}

async function syncProfile(teamMemberId: string, payload: ReturnType<typeof teamPayload>) {
  const supabase = getSupabaseServerClient();
  if (!supabase) return;

  await supabase
    .from("profiles")
    .update({
      full_name: payload.full_name,
      email: payload.email,
      phone: payload.phone,
      role: payload.role,
      active_status: payload.active ? "active" : "inactive",
      team_member_id: teamMemberId,
      updated_at: new Date().toISOString(),
    })
    .or(`team_member_id.eq.${teamMemberId}${payload.email ? `,email.eq.${payload.email}` : ""}`);
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

  await syncProfile(data.id, payload);
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

  const { error } = await supabase.from("team_members").update(payload).eq("id", id);
  if (error) {
    console.error("[team:update] Failed to update team member", { id, error });
    redirect(`/team/${id}/edit?error=Could%20not%20update%20team%20member.`);
  }

  await syncProfile(id, payload);
  revalidatePath("/team");
  revalidatePath(`/team/${id}/edit`);
  redirect("/team");
}
