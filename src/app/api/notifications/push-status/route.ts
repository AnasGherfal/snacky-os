import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { ensurePushNotificationConfig } from "@/lib/notification-delivery";
import { isSameOriginRequest, parseDeviceSubscription } from "@/lib/push-subscription";

export const dynamic = "force-dynamic";

async function status(request?: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  if (profile.active_status !== "active") return NextResponse.json({ error: "Account is inactive." }, { status: 403 });
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Notification service is unavailable." }, { status: 503 });
  let device = null;
  if (request) {
    if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
    try {
      const text = await request.text();
      if (text.length > 8192) throw new Error("size");
      device = parseDeviceSubscription(JSON.parse(text)?.subscription);
    } catch { /* Invalid/expired local data must never report an enabled device. */ }
    if (!device) return NextResponse.json({ error: "Invalid device subscription." }, { status: 400 });
  }
  try {
    const config = await ensurePushNotificationConfig(supabase);
    const [subscriptions, notifications] = await Promise.all([
      supabase.from("push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", profile.id).eq("is_active", true),
      supabase.from("notifications").select("id", { head: true }).eq("user_id", profile.id).limit(1),
    ]);
    const schemaReady = !subscriptions.error && !notifications.error;
    let deviceRegistered = false;
    if (schemaReady && device) {
      const current = await supabase.from("push_subscriptions").select("id")
        .eq("user_id", profile.id).eq("endpoint", device.endpoint).eq("p256dh", device.keys.p256dh)
        .eq("auth", device.keys.auth).eq("is_active", true).maybeSingle();
      if (current.error) return NextResponse.json({ error: "Could not verify this device." }, { status: 503 });
      deviceRegistered = Boolean(current.data);
    }
    const health = await supabase.rpc("snacky_notification_health_v1");
    const workAlerts = !health.error && health.data && typeof health.data === "object" ? health.data : null;
    return NextResponse.json({
      workAlerts,
      configured: config.configured, publicKey: config.configured ? config.publicKey : "",
      source: config.configured ? config.source : null, schemaReady, deviceRegistered,
      activeSubscriptions: schemaReady ? subscriptions.count ?? 0 : null,
      reason: !schemaReady ? "notification_schema_unavailable" : config.configured ? null : config.reason,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not verify notification setup." }, { status: 503 });
  }
}

export async function GET() { return status(); }
export async function POST(request: Request) { return status(request); }
