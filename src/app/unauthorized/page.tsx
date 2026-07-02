import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { accessTokenCookie, getAuthenticatedSupabaseServerClient, getCurrentProfile, refreshTokenCookie } from "@/lib/auth";
import { getDefaultPathForRole } from "@/lib/authz";
import { deactivatePushSubscriptionsForUser } from "@/lib/notification-delivery";

async function logout() {
  "use server";

  const profile = await getCurrentProfile();
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (profile && supabase) {
    const result = await deactivatePushSubscriptionsForUser(supabase, profile.id, "manual_logout");
    if (!result.updated) {
      console.warn("[unauthorized] Failed to deactivate push subscriptions on logout", {
        user_id: profile.id,
        reason: result.reason,
      });
    }
  }

  const cookieStore = await cookies();
  cookieStore.delete(accessTokenCookie);
  cookieStore.delete(refreshTokenCookie);
  redirect("/login");
}
export default async function UnauthorizedPage() {
  const profile = await getCurrentProfile();
  const homeHref = getDefaultPathForRole(profile);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-lg font-semibold text-amber-800">
          !
        </div>
        <h1 className="text-2xl font-semibold text-slate-900">Access unavailable</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
          Your current role does not include this area of Snacky OS. Operators can only use assigned route execution screens, while admin areas are reserved for owner/admin roles.
        </p>
        <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          Signed in as <span className="font-medium text-slate-900">{profile?.full_name ?? "unknown user"}</span>
          {profile?.roles?.length ? <> with roles <span className="font-medium text-slate-900">{profile.roles.join(", ")}</span></> : null}.
        </div>
        <form action={logout} className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link href={homeHref} className="btn-secondary">Go to my home</Link>
          <button className="btn-primary" type="submit">Sign out</button>
        </form>
      </div>
    </main>
  );
}





