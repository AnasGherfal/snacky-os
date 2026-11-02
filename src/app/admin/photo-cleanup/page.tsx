import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { OwnerPhotoCleanup } from "@/components/OwnerPhotoCleanup";

export const dynamic = "force-dynamic";

export default async function PhotoCleanupPage() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" ||
      (profile.role !== "owner" && !profile.roles.includes("owner"))) {
    redirect("/dashboard");
  }
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">تنظيف صور الماكينات القديمة</h1>
        <p className="text-sm text-slate-500">
          Owner-only · Supabase Storage · Photos older than 30 full days
        </p>
      </div>
      <OwnerPhotoCleanup />
    </main>
  );
}
