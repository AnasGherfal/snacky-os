"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import { logActivity } from "@/lib/activity-log";
import { accessTokenCookie, getAuthenticatedSupabaseServerClient, getCurrentProfile, refreshTokenCookie } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { deactivatePushSubscriptionsForUser } from "@/lib/notification-delivery";

function getAuthenticatedSupabaseClient(accessToken: string, refreshToken: string | null) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  return client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken ?? "" }).then(() => client);
}

export async function changeOwnPassword(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");

  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirm_password") || "");
  if (password.length < 10) redirect("/account?error=Password%20must%20be%20at%20least%2010%20characters.");
  if (password !== confirmPassword) redirect("/account?error=Passwords%20do%20not%20match.");

  const cookieStore = await cookies();
  const accessToken = cookieStore.get(accessTokenCookie)?.value;
  const refreshToken = cookieStore.get(refreshTokenCookie)?.value ?? null;
  if (!accessToken) redirect("/login");

  const client = await getAuthenticatedSupabaseClient(accessToken, refreshToken);
  if (!client) redirect("/account?error=Supabase%20is%20not%20configured.");

  const { error } = await client.auth.updateUser({ password });
  if (error) {
    console.error("[account] Password update failed", error);
    redirect("/account?error=Could%20not%20change%20password.");
  }

  const supabase = getSupabaseServerClient();
  if (supabase) {
    await supabase.from("profiles").update({ must_change_password: false, updated_at: new Date().toISOString() }).eq("id", profile.id);
    if (profile.team_member_id) {
      await supabase.from("team_members").update({ must_change_password: false }).eq("id", profile.team_member_id);
    }
  }

  revalidatePath("/account");
  redirect("/account?success=Password%20changed.");
}

export async function logoutFromAccount() {
  const profile = await getCurrentProfile();
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (profile) {
    await logActivity({
      profile,
      action: "logout",
      entityType: "team_member",
      entityId: profile.team_member_id,
      entityLabel: profile.full_name,
      summary: `${profile.full_name} logged out`,
    });
    if (supabase) {
      const result = await deactivatePushSubscriptionsForUser(supabase, profile.id, "manual_logout");
      if (!result.updated) {
        console.warn("[account] Failed to deactivate push subscriptions on logout", {
          user_id: profile.id,
          reason: result.reason,
        });
      }
    }
  }
  const cookieStore = await cookies();
  cookieStore.delete(accessTokenCookie);
  cookieStore.delete(refreshTokenCookie);
  redirect("/login");
}

