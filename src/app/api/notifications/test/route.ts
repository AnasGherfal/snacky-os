import { after, NextResponse } from "next/server";
import { setTimeout as delay } from "node:timers/promises";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { ensurePushNotificationConfig, sendTestPushNotification } from "@/lib/notification-delivery";
import { isPushEndpoint, isSameOriginRequest } from "@/lib/push-subscription";

export const runtime = "nodejs";
export const maxDuration = 60;
const error = (message: string, status: number, code?: string) => NextResponse.json({ sent: false, error: message, ...(code ? { code } : {}) }, { status });

function deliveryError(reason: string | null, ar: boolean) {
  const message = (en: string, arabic: string) => ar ? arabic : en;
  if (["notification_save_failed", "subscription_load_failed"].includes(reason ?? "")) {
    return error(message("Server notification storage is unavailable. Ask the administrator to check the notification database setup; changing phone permissions will not fix this.", "تخزين الإشعارات غير متاح في الخادم. يجب على الإدارة التحقق من إعداد قاعدة بيانات الإشعارات؛ تغيير أذونات الهاتف لن يحل المشكلة."), 503, "notification_storage_unavailable");
  }
  if (["missing_server_notification_secret", "missing_vapid_configuration", "push_service_http_401", "push_service_http_403"].includes(reason ?? "")) {
    return error(message("The server could not authenticate with the push service. Ask the administrator to check the server push configuration.", "تعذر توثيق الخادم لدى خدمة الإشعارات. يجب على الإدارة التحقق من إعداد خدمة الإشعارات في الخادم."), 503, "push_server_configuration");
  }
  if (["no_active_subscription", "invalid_push_subscription", "push_service_http_404", "push_service_http_410"].includes(reason ?? "")) {
    return error(message("This device registration is missing or expired. Press Recheck, then Enable notifications and test again.", "تسجيل هذا الجهاز مفقود أو انتهت صلاحيته. اضغط إعادة التحقق، ثم تفعيل الإشعارات وأعد الاختبار."), 409, "push_device_expired");
  }
  if (reason === "inactive_recipient") return error(message("This account is no longer active. Sign in with an active account.", "هذا الحساب لم يعد نشطاً. سجّل الدخول بحساب نشط."), 403, "inactive_account");
  return error(message("The push service did not accept the test. Wait 30 seconds and retry. Your device registration has not been removed.", "لم تقبل خدمة الإشعارات الاختبار. انتظر 30 ثانية وأعد المحاولة. لم يتم حذف تسجيل جهازك."), 502, "push_delivery_failed");
}

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
    if (devices.error) return error(body.locale === "ar" ? "إعداد قاعدة بيانات الإشعارات غير متاح. يجب على الإدارة إكمال إعداد الخادم." : "Notification database setup is unavailable. The administrator must complete the server setup.", 503, "notification_schema_unavailable");
    if (!devices.data?.length) return error("Enable notifications on this device first.", 409);
    const reservation = await supabase.rpc("reserve_push_test_v1");
    if (reservation.error) return error(body.locale === "ar" ? "إعداد اختبار الإشعارات في الخادم غير مكتمل. يجب على الإدارة التحقق من تحديث قاعدة البيانات." : "Server notification test setup is incomplete. The administrator must check the database migration.", 503, "push_test_setup_unavailable");
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
    const startedAt = Date.now();
    const result = await send();
    if (!result.sent) {
      let reason = result.reason;
      // The sender stores sanitized provider outcomes. Read only THIS device's
      // outcome from THIS attempt; do not expose provider bodies or endpoint keys.
      if (reason === "delivery_failed" && body.endpoint) {
        const failure = await supabase.from("push_subscriptions").select("failure_reason,failed_at")
          .eq("user_id", profile.id).eq("endpoint", body.endpoint).maybeSingle();
        if (!failure.error && failure.data?.failed_at && Date.parse(failure.data.failed_at) >= startedAt) {
          reason = failure.data.failure_reason ?? reason;
        }
      }
      return deliveryError(reason, body.locale === "ar");
    }
    return NextResponse.json({ sent: true, acceptedCount: result.acceptedCount,
      deliveredCount: result.acceptedCount, subscriptionCount: result.subscriptionCount });
  } catch { return error("Notification service is unavailable.", 503); }
}
