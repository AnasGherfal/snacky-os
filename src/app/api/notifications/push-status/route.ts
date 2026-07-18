import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";

function configured() {
  return Boolean(
    String(process.env.VAPID_SUBJECT ?? "").trim()
    && String(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "").trim()
    && String(process.env.VAPID_PRIVATE_KEY ?? "").trim(),
  );
}

export async function GET() {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({
      configured: configured(),
      schemaReady: false,
      activeSubscriptions: 0,
      reason: "Supabase is not configured.",
    });
  }

  const { count, error } = await supabase
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", profile.id)
    .eq("is_active", true);

  return NextResponse.json({
    configured: configured(),
    schemaReady: !error,
    activeSubscriptions: error ? 0 : count ?? 0,
    reason: error ? error.message : null,
  });
}
