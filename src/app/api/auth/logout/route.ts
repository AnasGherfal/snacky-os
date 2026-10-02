import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile, accessTokenCookie, refreshTokenCookie } from "@/lib/auth";
import { deactivatePushSubscriptionsForUser } from "@/lib/notification-delivery";

export async function POST() {
  const profile = await getCurrentProfile();
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (profile && supabase) {
    const result = await deactivatePushSubscriptionsForUser(supabase, profile.id, "manual_logout");
    if (!result.updated) {
      console.warn("[auth:logout] Failed to deactivate push subscriptions", {
        user_id: profile.id,
        reason: result.reason,
      });
    }
  }

  const cookieStore = await cookies();
  cookieStore.delete(accessTokenCookie);
  cookieStore.delete(refreshTokenCookie);

  return NextResponse.json({ ok: true });
}
