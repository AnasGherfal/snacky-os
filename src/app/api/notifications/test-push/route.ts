import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { sendTestPushNotification } from "@/lib/notification-delivery";

export async function POST() {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ sent: false, error: "Not authenticated." }, { status: 401 });

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return NextResponse.json({ sent: false, error: "Supabase is not configured." }, { status: 500 });

  const result = await sendTestPushNotification(supabase, profile.id);
  if (!result.sent) {
    return NextResponse.json(
      {
        sent: false,
        deliveredCount: result.deliveredCount,
        subscriptionCount: result.subscriptionCount,
        error: result.reason === "no_active_subscription"
          ? "Enable notifications on this device before sending a test."
          : "The test notification could not be delivered.",
        reason: result.reason,
      },
      { status: result.reason === "no_active_subscription" ? 409 : 500 },
    );
  }

  return NextResponse.json({
    sent: true,
    deliveredCount: result.deliveredCount,
    subscriptionCount: result.subscriptionCount,
  });
}
