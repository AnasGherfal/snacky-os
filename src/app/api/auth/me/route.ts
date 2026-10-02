import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";

export async function GET() {
  const profile = await getCurrentProfile();

  if (!profile) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  if (profile.active_status !== "active") {
    return NextResponse.json({ error: "Inactive user" }, { status: 403 });
  }

  return NextResponse.json({ profile });
}
