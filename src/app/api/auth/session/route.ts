import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { accessTokenCookie, refreshAuthSession, refreshTokenCookie, resolveAuthSession } from "@/lib/auth";

function setSessionCookies(cookieStore: Awaited<ReturnType<typeof cookies>>, session: { accessToken: string | null; refreshToken: string | null; expiresAt: number | null }) {
  if (!session.accessToken) return;
  const maxAge = session.expiresAt ? Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000)) : 60 * 60;
  cookieStore.set(accessTokenCookie, session.accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  });
  if (session.refreshToken) {
    cookieStore.set(refreshTokenCookie, session.refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
}

function clearSessionCookies(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  cookieStore.delete(accessTokenCookie);
  cookieStore.delete(refreshTokenCookie);
}

export async function GET() {
  const cookieStore = await cookies();
  const session = await resolveAuthSession();

  if (!session?.accessToken) {
    clearSessionCookies(cookieStore);
    return NextResponse.json({ authenticated: false, expiresAt: null, secondsUntilExpiry: 0 }, { status: 401 });
  }

  if (session.refreshed && session.refreshToken) {
    setSessionCookies(cookieStore, session);
  }

  return NextResponse.json({
    authenticated: true,
    expiresAt: session.expiresAt,
    secondsUntilExpiry: session.secondsUntilExpiry,
  });
}

export async function POST() {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(refreshTokenCookie)?.value ?? null;
  if (!refreshToken) {
    clearSessionCookies(cookieStore);
    return NextResponse.json({ error: "No refresh token" }, { status: 401 });
  }

  const session = await refreshAuthSession(refreshToken);
  if (!session?.accessToken || !session.refreshToken) {
    clearSessionCookies(cookieStore);
    return NextResponse.json({ error: "Session expired" }, { status: 401 });
  }

  setSessionCookies(cookieStore, session);

  return NextResponse.json({
    ok: true,
    authenticated: true,
    expiresAt: session.expiresAt,
    secondsUntilExpiry: session.secondsUntilExpiry,
  });
}



