import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { dispatchWorkNotifications } from "@/lib/work-notification-dispatch";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Only the private database worker can invoke delivery. No recipient, content,
 * URL, or subscription can be supplied by this HTTP request. */
export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  if (!/^Bearer [a-f0-9]{64}$/.test(header)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: "Worker unavailable" }, { status: 503 });
  try {
    const auth = await db.rpc("snacky_notification_worker_start_v1", { p_token: header.slice(7) });
    if (auth.error) return NextResponse.json({ error: "Worker setup unavailable" }, { status: 503 });
    if (auth.data?.authorized !== true) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (auth.data.enabled !== true) return NextResponse.json({ paused: true });
    return NextResponse.json(await dispatchWorkNotifications(db));
  } catch {
    console.error("[work-notifications] Dispatch incomplete; persisted jobs remain retryable.");
    return NextResponse.json({ error: "Delivery incomplete; queued for retry" }, { status: 503 });
  }
}
