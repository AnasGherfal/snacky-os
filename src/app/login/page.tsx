import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { accessTokenCookie, ensureProfileForAuthUser, refreshTokenCookie } from "@/lib/auth";
import { getDefaultPathForRole, parseAppRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function login(formData: FormData) {
  "use server";

  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  const supabase = getSupabaseServerClient();

  if (!supabase) redirect("/login?error=Supabase%20is%20not%20configured.");
  if (!email || !password) redirect("/login?error=Email%20and%20password%20are%20required.");

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    console.error("[auth:login] Sign in failed", { email, error });
    redirect("/login?error=Invalid%20email%20or%20password.");
  }

  const profile = await ensureProfileForAuthUser(data.user);
  const role = parseAppRole(profile?.role);

  if (!profile || profile.active_status !== "active" || !role) {
    const cookieStore = await cookies();
    cookieStore.delete(accessTokenCookie);
    cookieStore.delete(refreshTokenCookie);
    redirect("/login?error=Your%20Snacky%20OS%20profile%20is%20inactive%20or%20not%20configured.");
  }

  const cookieStore = await cookies();
  cookieStore.set(accessTokenCookie, data.session.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: data.session.expires_in,
  });
  cookieStore.set(refreshTokenCookie, data.session.refresh_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  await logActivity({
    profile: {
      id: profile.id,
      full_name: profile.full_name,
      email: profile.email,
      phone: profile.phone,
      role,
      active_status: profile.active_status,
      team_member_id: profile.team_member_id,
      must_change_password: false,
    },
    action: "login",
    entityType: "team_member",
    entityId: profile.team_member_id,
    entityLabel: profile.full_name,
    summary: `${profile.full_name} logged in`,
  });

  redirect(getDefaultPathForRole(role));
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next = "" } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Sign in to Snacky OS</h1>
          <p className="mt-1 text-sm text-slate-500">Use your Supabase Auth account to access operations.</p>
        </div>
        {error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{error}</div> : null}
        <form action={login} className="space-y-4">
          <input type="hidden" name="next" value={next} />
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-800">Email</span>
            <input name="email" type="email" required className="field-input" autoComplete="email" />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-800">Password</span>
            <input name="password" type="password" required className="field-input" autoComplete="current-password" />
          </label>
          <button className="btn-primary w-full" type="submit">Sign in</button>
        </form>
      </div>
    </main>
  );
}
