import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { accessTokenCookie, refreshTokenCookie } from "@/lib/auth";

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete(accessTokenCookie);
  cookieStore.delete(refreshTokenCookie);

  return NextResponse.json({ ok: true });
}
