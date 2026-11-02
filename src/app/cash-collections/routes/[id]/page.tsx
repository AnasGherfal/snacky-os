import Link from "next/link";
import { redirect,notFound } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { RouteCashPanel } from "@/components/cash/RouteCashPanel";
export const dynamic="force-dynamic";
export default async function OwnerRouteCashCustodyPage({params}:{
  params:Promise<{id:string}>;
}) {
  const {id}=await params;
  const profile=await getCurrentProfile();
  if(!profile||profile.active_status!=="active"||!isOwnerAdminRole(profile))redirect("/unauthorized");
  if(!/^[0-9a-f-]{36}$/i.test(id))notFound();
  const db=getSupabaseAdminClient();
  if(!db) return <p className="p-4">تعذر الاتصال بالنقدية. أعد المحاولة.</p>;
  const result=await db.from("routes").select("id,status,route_date").eq("id",id).maybeSingle();
  if(result.error||!result.data)notFound();
  return <main className="mx-auto max-w-6xl space-y-5 p-4" dir="rtl">
    <header className="space-y-2">
      <Link href={`/routes/${id}`} className="text-sm font-semibold text-emerald-800 underline">العودة إلى جولة التعبئة</Link>
      <h1 className="text-2xl font-bold text-slate-950">ملف عهدة النقدية المستقل</h1>
      <p className="text-sm leading-6 text-slate-600">
        الإيداع والاستلام والعدّ وإقفال العهدة النقدية مراحل منفصلة عن إكمال جولة المشغّل. حتى لو لم تُعدّ النقدية، يستطيع المشغّل إنهاء جولته بعد تسجيل السحب أو الاستثناء.
      </p>
      <p className="text-xs text-slate-500">جولة <bdi>{result.data.route_date}</bdi> · حالتها التشغيلية: <bdi>{result.data.status}</bdi></p>
    </header>
    <RouteCashPanel routeId={id} routeStatus={String(result.data.status)} allowOwnerClose/>
  </main>;
}
