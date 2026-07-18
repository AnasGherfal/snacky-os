import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { ensurePushConfig } from "@/lib/push-config";

export async function GET() {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({
      configured: false,
      schemaReady: false,
      activeSubscriptions: 0,
      publicKey: null,
      reason: "Supabase is not configured.",
    });
  }

  const [config, subscriptionResult] = await Promise.all([
    ensurePushConfig(supabase),
    supabase
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", profile.id)
      .eq("is_active", true),
  ]);

  return NextResponse.json({
    configured: config.configured,
    schemaReady: !subscriptionResult.error,
    activeSubscriptions: subscriptionResult.error ? 0 : subscriptionResult.count ?? 0,
    publicKey: config.configured ? config.config.publicKey : null,
    source: config.configured ? config.source : null,
    reason: subscriptionResult.error?.message ?? (config.configured ? null : config.reason),
  });
}
