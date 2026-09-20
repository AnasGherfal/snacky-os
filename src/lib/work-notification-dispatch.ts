import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWorkNotification } from "@/lib/notification-delivery";

type Claim = { id: string; lease_id: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Database leases prevent competing webhook/cron deliveries. Each device has
 * its own receipt; a failed phone must not cause re-sends to successful phones. */
export async function dispatchWorkNotifications(db: SupabaseClient) {
  const claimed = await db.rpc("snacky_claim_notification_deliveries_v1", { p_limit: 20 });
  if (claimed.error || !Array.isArray(claimed.data)) throw new Error("notification_claim_unavailable");
  const claims = claimed.data as Claim[];
  if (claims.some((c) => !c || !uuid.test(c.id) || !uuid.test(c.lease_id))) throw new Error("invalid_notification_claim");
  let accepted = 0, failed = 0, skipped = 0;
  // Four at a time, bounded to 20 x 8-second transport timeouts (< 60 seconds).
  for (let offset = 0; offset < claims.length; offset += 4) {
    await Promise.all(claims.slice(offset, offset + 4).map(async (claim) => {
      let outcome: "accepted" | "retry" | "failed" | "skipped" = "retry";
      let reason: string | null = null;
      try {
        // Re-check active account, exact device, current assignment/audience and
        // lease immediately before sending, not just at initial queue creation.
        const loaded = await db.rpc("snacky_notification_delivery_payload_v1", { p_id: claim.id, p_lease: claim.lease_id });
        if (loaded.error) throw new Error("notification_payload_unavailable");
        if (!loaded.data) { outcome = "skipped"; reason = "no_longer_eligible"; skipped++; }
        else {
          const result = await sendWorkNotification(db, loaded.data);
          if (result.sent) { outcome = "accepted"; accepted++; }
          else {
            const status = "statusCode" in result ? result.statusCode : 0;
            outcome = [400, 404, 410, 413].includes(Number(status)) ? "failed" : "retry";
            reason = "reason" in result ? result.reason ?? "delivery_failed" : "missing_vapid_configuration";
            failed++;
          }
        }
      } catch { reason = "notification_delivery_unavailable"; failed++; }
      // An uncertain finish retains its lease and is retried after expiry; the
      // stable notificationId is also the phone notification's replacement tag.
      const saved = await db.rpc("snacky_finish_notification_delivery_v1", {
        p_id: claim.id, p_lease: claim.lease_id, p_result: outcome, p_error: reason,
      });
      if (saved.error || saved.data !== true) throw new Error("notification_receipt_unconfirmed");
    }));
  }
  return { attempted: claims.length, accepted, failed, skipped };
}
