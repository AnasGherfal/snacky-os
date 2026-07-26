import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { ensurePushNotificationConfig } from "@/lib/notification-delivery";

export async function GET() {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const supabase = await getAuthenticatedSupabaseServerClient();
  const config = await ensurePushNotificationConfig(supabase);

  if (!supabase) {
    return NextResponse.json({
      configured: config.configured,
      publicKey: config.configured ? config.publicKey : "",
      source: config.configured ? config.source : null,
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
    configured: config.configured,
    publicKey: config.configured ? config.publicKey : "",
    source: config.configured ? config.source : null,
    schemaReady: !error,
    activeSubscriptions: error ? 0 : count ?? 0,
    reason: error?.message ?? (config.configured ? null : config.reason),
  });
}
