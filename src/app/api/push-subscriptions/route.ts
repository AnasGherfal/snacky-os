import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { savePushSubscription } from "@/lib/notification-delivery";
import { isPushEndpoint, isSameOriginRequest, parseDeviceSubscription } from "@/lib/push-subscription";

const error = (message: string, status = 400) => NextResponse.json({ error: message }, { status });

async function handle(request: Request, deactivate: boolean) {
  if (!isSameOriginRequest(request)) return error("Invalid origin.", 403);
  const profile = await getCurrentProfile();
  if (!profile) return error("Not authenticated.", 401);
  if (profile.active_status !== "active") return error("Account is inactive.", 403);
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return error("Notification service is unavailable.", 503);
  let body: { subscription?: unknown; endpoint?: unknown; deviceLabel?: unknown; locale?: unknown };
  try {
    const text = await request.text();
    if (text.length > 8192) return error("Subscription is too large.", 413);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return error("Invalid subscription payload.");
    body = value;
  } catch { return error("Invalid subscription payload."); }
  try {
    if (deactivate) {
      if (!isPushEndpoint(body.endpoint)) return error("Invalid push endpoint.");
      const result = await supabase.from("push_subscriptions")
        .update({ is_active: false, failure_reason: "device_disabled", updated_at: new Date().toISOString() })
        .eq("user_id", profile.id).eq("endpoint", body.endpoint);
      return result.error ? error("Could not disable this device.", 503) : NextResponse.json({ disabled: true });
    }
    const subscription = parseDeviceSubscription(body.subscription);
    if (!subscription) return error("Invalid or unsupported browser push subscription.");
    const result = await savePushSubscription(supabase, profile.id, subscription, {
      deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 160) : null,
      userAgent: request.headers.get("user-agent"),
      locale: body.locale === "en" ? "en" : "ar",
    });
    if (!result.saved) {
      // RLS deliberately prohibits moving another account's endpoint to this one.
      // The UI replaces its local subscription and retries instead.
      if (/42501|row.level security|duplicate key/i.test(result.reason ?? "")) return error("Please replace this browser subscription.", 409);
      return error("Could not save this device. Check notification setup and retry.", 503);
    }
    return NextResponse.json({ saved: true });
  } catch { return error("Notification service is unavailable.", 503); }
}
export async function POST(request: Request) { return handle(request, false); }
export async function DELETE(request: Request) { return handle(request, true); }
