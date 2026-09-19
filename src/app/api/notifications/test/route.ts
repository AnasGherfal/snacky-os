import { after, NextResponse } from "next/server";
import { setTimeout as delay } from "node:timers/promises";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { ensurePushNotificationConfig, sendTestPushNotification } from "@/lib/notification-delivery";
import { isPushEndpoint, isSameOriginRequest } from "@/lib/push-subscription";

export const runtime = "nodejs";
export const maxDuration = 60;
const error = (message: string, status: number) => NextResponse.json({ sent: false, error: message }, { status });

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return error("Invalid origin.", 403);
  const profile = await getCurrentProfile();
  if (!profile) return error("Not authenticated.", 401);
  if (profile.active_status !== "active") return error("Account is inactive.", 403);
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return error("Notification service is unavailable.", 503);
  let body: { endpoint?: string; delaySeconds?: number; locale?: "ar" | "en" } = {};
  try {
    const text = await request.text();
    if (text.length > 8192) return error("Request is too large.", 413);
    const value = text ? JSON.parse(text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return error("Invalid test request.", 400);
    if (value.endpoint !== undefined && !isPushEndpoint(value.endpoint)) return error("Invalid device.", 400);
    if (value.delaySeconds !== undefined && value.delaySeconds !== 0 && value.delaySeconds !== 15) return error("Invalid test delay.", 400);
    if (value.delaySeconds === 15 && !value.endpoint) return error("Select this device before testing.", 400);
    body = { endpoint: value.endpoint, delaySeconds: value.delaySeconds ?? 0, locale: value.locale === "ar" ? "ar" : "en" };
  } catch { return error("Invalid test request.", 400); }
  try {
    const config = await ensurePushNotificationConfig(supabase);
    if (!config.configured) return error("Server notification setup is incomplete.", 503);
    let query = supabase.from("push_subscriptions").select("id").eq("user_id", profile.id).eq("is_active", true);
    if (body.endpoint) query = query.eq("endpoint", body.endpoint);
    const devices = await query.limit(1);
    if (devices.error) return error("Could not verify registered devices.", 503);
    if (!devices.data?.length) return error("Enable notifications on this device first.", 409);
    const reservation = await supabase.rpc("reserve_push_test_v1");
    if (reservation.error) return error("Notification test setup is unavailable.", 503);
    if (reservation.data !== true) return error("Please wait 30 seconds before testing again.", 429);

    const send = () => sendTestPushNotification(supabase, profile.id, { endpoint: body.endpoint, locale: body.locale });
    if (body.delaySeconds === 15) {
      // Next's after()/waitUntil keeps this server-side test alive after the
      // response and browser close. This is a diagnostic, NOT a durable scheduler.
      after(async () => {
        try {
          await delay(15000);
          const result = await send();
          if (!result.sent) console.warn("[push-test] Delayed test failed", { userId: profile.id, reason: result.reason });
        } catch { console.warn("[push-test] Delayed test failed", { userId: profile.id }); }
      });
      return NextResponse.json({ scheduled: true, sent: false, delaySeconds: 15 }, { status: 202 });
    }
    const result = await send();
    if (!result.sent) return error("The push service did not accept the test. Re-enable this device and retry.", 502);
    return NextResponse.json({ sent: true, acceptedCount: result.acceptedCount,
      deliveredCount: result.acceptedCount, subscriptionCount: result.subscriptionCount });
  } catch { return error("Notification service is unavailable.", 503); }
}
