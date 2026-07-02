import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { loadNotificationsForUser, markAllNotificationsReadForUser } from "@/lib/notification-delivery";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return jsonError("Not authenticated.", 401);

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return jsonError("Supabase is not configured.", 500);

  const url = new URL(request.url);
  const parsedLimit = Number(url.searchParams.get("limit") ?? 10);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 10;
  const result = await loadNotificationsForUser(supabase, profile.id, limit);

  if ("error" in result && result.error) {
    console.error("[notifications] Failed to load notifications", {
      user_id: profile.id,
      error: result.error,
    });
    return jsonError("Could not load notifications.", 500);
  }

  return NextResponse.json({
    notifications: result.notifications,
    unreadCount: result.unreadCount,
  });
}

export async function PATCH() {
  const profile = await getCurrentProfile();
  if (!profile) return jsonError("Not authenticated.", 401);

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return jsonError("Supabase is not configured.", 500);

  const result = await markAllNotificationsReadForUser(supabase, profile.id);
  if (!result.updated) {
    console.error("[notifications] Failed to mark notifications read", {
      user_id: profile.id,
      reason: result.reason,
    });
    return jsonError("Could not mark notifications read.", 500);
  }

  return NextResponse.json({ updated: true });
}
