import { NextResponse } from "next/server";
import webpush, { type PushSubscription } from "web-push";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";

let configured = false;

function configureWebPush() {
  const subject = String(process.env.VAPID_SUBJECT ?? "").trim();
  const publicKey = String(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY ?? "").trim();
  if (!subject || !publicKey || !privateKey) return false;
  if (!configured) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = true;
  }
  return true;
}

export async function POST() {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  if (!configureWebPush()) {
    return NextResponse.json({ error: "VAPID environment values are missing." }, { status: 503 });
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured." }, { status: 500 });

  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", profile.id)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data?.length) return NextResponse.json({ error: "Enable notifications on this device first." }, { status: 409 });

  const payload = JSON.stringify({
    type: "notification_test",
    title: "Snacky OS notifications are active",
    body: "This device will receive route assignment alerts.",
    url: "/operator/routes",
  });

  const results = await Promise.allSettled(data.map((row) => webpush.sendNotification({
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  } satisfies PushSubscription, payload)));
  const delivered = results.filter((result) => result.status === "fulfilled").length;

  if (!delivered) {
    const firstFailure = results.find((result) => result.status === "rejected");
    const reason = firstFailure?.status === "rejected" && firstFailure.reason instanceof Error
      ? firstFailure.reason.message
      : "The test notification could not be delivered.";
    return NextResponse.json({ error: reason }, { status: 502 });
  }

  return NextResponse.json({ sent: true, delivered, attempted: data.length });
}
