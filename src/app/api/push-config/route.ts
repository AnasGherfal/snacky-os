import { NextResponse } from "next/server";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { ensurePushNotificationConfig } from "@/lib/notification-delivery";

export async function GET() {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ configured: false, error: "Not authenticated." }, { status: 401 });

  const supabase = await getAuthenticatedSupabaseServerClient();
  const result = await ensurePushNotificationConfig(supabase);
  if (!result.configured) {
    return NextResponse.json(
      {
        configured: false,
        error: result.reason === "migration_required"
          ? "Push notification setup requires the notification activation migration."
          : "Push notification keys could not be prepared.",
        reason: result.reason,
      },
      { status: result.reason === "migration_required" ? 503 : 500 },
    );
  }

  return NextResponse.json({
    configured: true,
    publicKey: result.publicKey,
    source: result.source,
  });
}
