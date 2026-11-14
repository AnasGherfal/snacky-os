import Link from "next/link";
import { redirect } from "next/navigation";
import { ErrorState, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { confirmOwnerReportedCashCounts } from "@/lib/cash-owner-reported-actions";
import { loadOwnerReportedCountRows } from "@/lib/cash-owner-reported";

export const dynamic="force-dynamic";

function dateTime(v:string) {
  return new Intl.DateTimeFormat("en-GB",{
    timeZone:"Africa/Tripoli",dateStyle:"medium",timeStyle:"short",
  }).format(new Date(v));
}
function lyd(v:number) {
  return v.toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:2})+" LYD";
}

export default async function OwnerReportedCashCountPage({
  searchParams,
}:{
  searchParams:Promise<{message?:string}>;
}) {
  const profile=await getCurrentProfile();
  if(!profile||profile.active_status!=="active"||!hasAnyRole(profile,["owner","admin"]))
    redirect("/unauthorized");
  const params=await searchParams;
  let rows;
  try {rows=await loadOwnerReportedCountRows();}
  catch(e) {return <ErrorState title="Cash count records unavailable"
    body={e instanceof Error?e.message:"Owner-reported amounts could not be loaded."}/>;}
  const pending=rows.filter(x=>x.countedAmount===null);
  const completed=rows.filter(x=>x.countedAmount!==null);
  const total=pending.reduce((sum,x)=>sum+Math.round(x.amount*100),0)/100;

  return (
    <div className="space-y-6">
      <PageHeader title="Finish Anas's reported cash counts"
        subtitle="The amounts were reported as physically counted from storage. Link each one to its EXISTING operator removal and confirm through the signed-in owner cash workflow. No re-entry or duplicate sales."
        breadcrumbs={[{label:"Cash Custody",href:"/cash-collections"},{label:"Owner-reported counts"}]}
        action={<SecondaryButton href="/cash-collections/count">Regular cash counting</SecondaryButton>} />
      {params.message?<div role="status" className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">{params.message}</div>:null}
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-sm text-slate-600">Reported counts not yet posted</div>
          <div className="mt-2 text-3xl font-bold">{pending.length}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-sm text-slate-600">Total to post once</div>
          <div className="mt-2 text-3xl font-bold">{lyd(total)}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-sm text-slate-600">Already confirmed</div>
          <div className="mt-2 text-3xl font-bold">{completed.length}</div>
        </div>
      </section>
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <strong>Important:</strong> These cash amounts came from your earlier statement, not from XY sales.
        Recording them updates each physical cash count and posts one matching Finance entry.
        No VMS reconciliation is implied. For unnumbered bags, the system preserves the identification review and does not pretend a printed seal exists.
      </div>
      {!pending.length?<div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <h2 className="font-semibold text-emerald-950">All reported counts have been recorded</h2>
        <p className="mt-2 text-sm text-emerald-900">These original cash removals no longer need a new count. The XY comparison remains a separate step.</p>
        <Link href="/cash-collections/compare" className="mt-3 inline-block font-semibold text-emerald-800 underline">Compare cash with XY VMS</Link>
      </div>:null}
      {pending.length?<form action={confirmOwnerReportedCashCounts} className="space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
          <h2 className="text-lg font-bold">Previously counted — ready for owner confirmation</h2>
          <p className="mt-1 text-sm text-slate-600">All eight values below were already provided as physically counted by Anas. They remain associated with their original operator and pickup timestamp.</p>
          <div className="mt-4 divide-y divide-slate-200">
            {pending.map((row)=>(
              <label key={row.id} className="flex cursor-pointer items-start gap-3 py-4">
                <input type="checkbox" name="collection_ids" value={row.id} defaultChecked
                  className="mt-1 h-5 w-5 accent-emerald-700" />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-slate-950">{row.machineName}</span>
                  <span className="mt-1 block text-sm text-slate-600">Removed {dateTime(row.removedAt)} (Tripoli) · {row.custodyStatus==="in_storage"?"Previously deposited in storage":"Owner reports collected from storage, but the original deposit is not recorded"}</span>
                  <span className="mt-1 block text-xs text-slate-500">{row.bag.startsWith("UNNUMBERED")?"Unnumbered physical bag — electronic reference only":row.bag}</span>
                  <Link href={"/cash-collections/"+row.id} target="_blank" className="mt-1 inline-block text-xs font-semibold text-emerald-800 underline">
                    Review original removal and photos
                  </Link>
                </span>
                <strong className="shrink-0 text-base text-slate-950">{lyd(row.amount)}</strong>
              </label>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4 sm:p-6">
          <label className="flex items-start gap-3 text-sm leading-6 text-slate-900">
            <input type="checkbox" name="owner_attestation" value="yes" required className="mt-1 h-5 w-5 accent-emerald-700"/>
            <span>I confirm that Anas physically received these exact cash collections from storage and counted the amounts listed above. I am confirming previously completed physical counts, not reporting a new cash removal. The original physical count dates were not provided.</span>
          </label>
          <button type="submit" className="btn-primary mt-4 w-full text-lg">
            Confirm selected counts and post once to Finance
          </button>
          <p className="mt-2 text-xs text-slate-600">
            If a box was already counted, it is skipped rather than posted again. If custody verification fails, it remains open and the page reports the issue. The owner-review seal warning is separate from counting cash.
          </p>
        </div>
      </form>:null}
      {completed.length?<section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="font-semibold">Already counted</h2>
        <div className="mt-2 space-y-2 text-sm">
          {completed.map(row=><p key={row.id}><Link href={"/cash-collections/"+row.id} className="font-semibold text-emerald-800 underline">{row.machineName} · {dateTime(row.removedAt)}</Link> — {lyd(Number(row.countedAmount))}</p>)}
        </div>
      </section>:null}
    </div>
  );
}
