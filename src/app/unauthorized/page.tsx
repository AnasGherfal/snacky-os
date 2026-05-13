import { cookies } from "next/headers";
import Link from "next/link";
import { accessTokenCookie, refreshTokenCookie } from "@/lib/auth";

async function logout() {
  "use server";
  const cookieStore = await cookies();
  cookieStore.delete(accessTokenCookie);
  cookieStore.delete(refreshTokenCookie);
}

export default function UnauthorizedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Unauthorized</h1>
        <p className="mt-2 text-sm text-slate-500">Your current role does not have access to this page. Contact an admin if this looks wrong.</p>
        <form action={logout} className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link href="/dashboard" className="btn-secondary">Go to dashboard</Link>
          <button className="btn-primary" type="submit">Sign out</button>
        </form>
      </div>
    </main>
  );
}
