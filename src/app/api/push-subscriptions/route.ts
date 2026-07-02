import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { savePushSubscription } from "@/lib/notification-delivery";

type PushSubscriptionBody = {
  subscription?: {
    endpoint?: string;
    keys?: {
      p256dh?: string;
      auth?: string;
    };
  };
  deviceLabel?: string | null;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return jsonError("Not authenticated.", 401);

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return jsonError("Supabase is not configured.", 500);

  let body: PushSubscriptionBody;
  try {
    body = (await request.json()) as PushSubscriptionBody;
  } catch {
    return jsonError("Invalid subscription payload.");
  }

  const result = await savePushSubscription(
    supabase,
    profile.id,
    body.subscription ?? {},
    {
      deviceLabel: body.deviceLabel ?? null,
      userAgent: request.headers.get("user-agent"),
    },
  );

  if (!result.saved) {
    console.error("[push-subscriptions] Failed to save subscription", {
      user_id: profile.id,
      reason: result.reason,
    });
    return jsonError("Could not save push subscription.", 500);
  }

  return NextResponse.json({ saved: true });
}
