import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { accessTokenCookie, refreshTokenCookie } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function jwtExpiresAt(token: string | null) {
  if (!token) return null;
  try {
    const [, payload] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return decoded.exp ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

type RefreshedSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number | null;
};

function sessionExpiresAt(session: Pick<RefreshedSession, "access_token" | "expires_at">) {
  return typeof session.expires_at === "number" && Number.isFinite(session.expires_at) ? session.expires_at * 1000 : jwtExpiresAt(session.access_token);
}

function setSessionCookies(cookieStore: Awaited<ReturnType<typeof cookies>>, session: RefreshedSession) {
  cookieStore.set(accessTokenCookie, session.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: session.expires_in,
  });
  cookieStore.set(refreshTokenCookie, session.refresh_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function GET() {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(accessTokenCookie)?.value ?? null;
  const expiresAt = jwtExpiresAt(accessToken);
  const secondsUntilExpiry = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0;

  return NextResponse.json({
    authenticated: Boolean(accessToken),
    expiresAt,
    secondsUntilExpiry,
  });
}

export async function POST() {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(refreshTokenCookie)?.value ?? null;
  if (!refreshToken) {
    return NextResponse.json({ error: "No refresh token" }, { status: 401 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    cookieStore.delete(accessTokenCookie);
    cookieStore.delete(refreshTokenCookie);
    return NextResponse.json({ error: "Session expired" }, { status: 401 });
  }

  setSessionCookies(cookieStore, data.session);
  const expiresAt = sessionExpiresAt(data.session);

  return NextResponse.json({
    ok: true,
    authenticated: true,
    expiresAt,
    secondsUntilExpiry: expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : data.session.expires_in,
  });
}
