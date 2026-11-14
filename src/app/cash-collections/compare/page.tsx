import Link from "next/link";
import { redirect } from "next/navigation";
import { ErrorState, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { loadCashVmsWindow } from "@/lib/cash-vms-server";
import { saveOwnerXyCashWindow } from "@/lib/cash-vms-manual-actions";

export const dynamic="force-dynamic";

const uuid=/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i;
function when(value:string|null|undefined) {
  if(!value)return "Unknown";
  return new Intl.DateTimeFormat("en-GB",{
    timeZone:"Africa/Tripoli",dateStyle:"medium",timeStyle:"medium",
  }).format(new Date(value));
}
function lyd(value:number|null|undefined) {
  if(value===null||value===undefined)return "Not counted";
  return value.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})+" LYD";
}
type CollectionChoice = {
  id:string;
  collected_at:string;
  actual_cash_collected:string|number|null;
  machine: {name:string|null} | null;
};

export default async function CompareCashWithXyPage({
  searchParams,
}:{
  searchParams:Promise<{collection?:string;error?:string;success?:string}>;
}) {
  const profile=await getCurrentProfile();
  if(!profile || profile.active_status!=="active" ||
      !hasAnyRole(profile,["owner","admin"]))redirect("/unauthorized");
  const db=getSupabaseAdminClient();
  if(!db)return <ErrorState title="XY cash comparison unavailable" body="The cash ledger connection is unavailable." />;
  const params=await searchParams;
  const {data:recent,error:recentError}=await db.from("cash_collections")
    .select("id,collected_at,actual_cash_collected,machine:machines(name)")
    .is("voided_at",null)
    .not("actual_cash_collected","is",null)
    .order("collected_at",{ascending:false}).limit(100);
  if(recentError)return <ErrorState title="Cash records could not be read" body="No XY comparison was changed." />;
  const choices=(recent??[]) as CollectionChoice[];
  const chosenId=uuid.test(params.collection??"") ? String(params.collection) : choices[0]?.id;
  if(!chosenId)return <ErrorState title="No counted removals yet" body="Record the physical cash count before comparing XY sales." />;
  let window;
  try {window=await loadCashVmsWindow(chosenId);}
  catch(e) {return <ErrorState title="The comparison period is unavailable" body={e instanceof Error?e.message:"Could not build a reliable cash comparison."} />;}

  const baseline=window.startReason==="previous_saved_comparison";
  const noBaseline=window.startReason==="missing";
  const provisional=window.quality==="provisional";
  const {target}=window;
  const status=window.existing;
  const difference=status?.difference_lyd??null;
  const selectedTimeUncertain=target.timeUncertain;
  return (
    <div className="space-y-6">
      <PageHeader title="Compare cash with XY VMS"
        subtitle="One machine, the exact recorded pickup period, and one CASH-only VMS total. No need to upload files."
        breadcrumbs={[{label:"Cash Custody",href:"/cash-collections"},{label:"XY comparison"}]}
        action={<div className="flex flex-wrap gap-2">
          <SecondaryButton href={"/cash-collections/"+chosenId}>Original cash removal</SecondaryButton>
          <SecondaryButton href={"/cash-collections/interval-comparison?collection="+chosenId}>Advanced hourly sales</SecondaryButton>
        </div>} />
      {params.error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">{params.error}</div>:null}
      {params.success ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
        XY cash comparison saved as an owner-entered report. No physical cash count, Finance entry or official reconciliation status was changed.
      </div>:null}
      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        <aside className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-semibold">Choose a counted pickup</h2>
          <p className="mt-1 text-xs text-slate-600">The comparison is for the machine of the selected removal.</p>
          <div className="mt-3 max-h-[700px] space-y-2 overflow-y-auto">
            {choices.map((item)=>(
              <Link key={item.id}
                href={"/cash-collections/compare?collection="+item.id}
                className={"block rounded-lg border p-3 text-sm "+(item.id===chosenId?"border-emerald-500 bg-emerald-50":"border-slate-200 hover:border-emerald-300")}>
                <div className="font-semibold">{item.machine?.name??"Machine"}</div>
                <div className="mt-1 text-xs text-slate-600">{when(item.collected_at)}</div>
                <div className="mt-1 font-medium">{lyd(Number(item.actual_cash_collected))}</div>
              </Link>
            ))}
          </div>
        </aside>
        <div className="space-y-5">
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-xl font-bold">{target.machineName}</h2>
            <p className="mt-1 text-sm text-slate-600">Machine {target.machineCode??target.machineId} · Collected by {target.removedBy??"not recorded"}</p>
            <h3 className="mt-5 text-base font-bold">Exactly which XY period to select</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold text-slate-600">FROM — after this timestamp</p>
                <p className="mt-2 text-lg font-bold">{when(window.startAt)}</p>
                <p className="mt-2 text-xs text-slate-700">{baseline?
                  "This is the END of the last saved VMS comparison for this machine." :
                  noBaseline?
                  "No previous full removal or saved comparison found. A reliable start has not been established.":
                  "First VMS comparison: the previous recorded FULL cash removal. It has NOT already been reconciled to XY."}</p>
              </div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-xs font-semibold text-emerald-900">UNTIL — through this timestamp</p>
                <p className="mt-2 text-lg font-bold">{when(window.endAt)}</p>
                <p className="mt-2 text-xs text-emerald-900">This is when the selected cash was removed. Sales later than this belong to the next pickup.</p>
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
              <strong>In XY Order Management:</strong> choose this machine, include only <strong>successful CASH transactions</strong>, exclude bank cards/refunds, and use the FROM/UNTIL timestamps above in Tripoli time. Enter the total for the <strong>whole displayed period</strong>, not just one calendar day.
            </div>
            {selectedTimeUncertain ? <p className="mt-3 text-sm font-semibold text-amber-900">The selected removal timestamp was recorded as approximate, not an independently verified pickup time.</p>:null}
          </section>
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h3 className="text-base font-bold">Cash removals included in this XY period</h3>
            <p className="mt-1 text-xs text-slate-600">If several cash boxes were collected since the last saved comparison, they are added together once. Each removal remains its own physical count.</p>
            {window.included.length ? <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[500px] text-sm">
                <thead><tr className="border-b bg-slate-50"><th className="p-2 text-start">Cash removed</th><th className="p-2 text-start">Operator</th><th className="p-2 text-start">Counted cash</th></tr></thead>
                <tbody>{window.included.map((r)=><tr key={r.id} className="border-b">
                  <td className="p-2"><Link className="font-semibold text-emerald-800 underline" href={"/cash-collections/"+r.id}>{when(r.removedAt)}</Link></td>
                  <td className="p-2">{r.removedBy??"—"}</td>
                  <td className="p-2">{lyd(r.countedAmount)}</td>
                </tr>)}</tbody>
              </table>
            </div>:<p className="mt-3 text-sm text-amber-900">No complete pickup interval available.</p>}
            <div className="mt-4 border-t pt-4">
              <p className="text-sm text-slate-600">Total physical cash counted for this exact window</p>
              <strong className="mt-1 block text-2xl">{lyd(window.physicalCashTotal)}</strong>
            </div>
            {window.warnings.length ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              <h4 className="font-bold">Before accepting this comparison</h4>
              <ul className="mt-2 list-disc space-y-1 ps-5">
                {window.warnings.map((w)=><li key={w}>{w}</li>)}
              </ul>
              {provisional?<p className="mt-2 font-medium">You may save an owner-reported amount as provisional, but this is NOT proof of an exact historical opening cash balance or shortage.</p>:null}
            </div>:null}
          </section>
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h3 className="text-lg font-bold">Enter your XY VMS cash total</h3>
            <p className="mt-1 text-sm text-slate-700">The amount must cover the full period above. No file upload and no machine-level split are needed.</p>
            {status?<div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm">
              <div className="font-bold">Previously saved owner VMS comparison</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <div>XY cash: <strong>{lyd(status.vms_cash_lyd)}</strong></div>
                <div>Physical count: <strong>{lyd(status.physical_cash_lyd)}</strong></div>
                <div>Difference: <strong>{difference===null?"—":lyd(difference)}</strong></div>
              </div>
              <p className="mt-2 text-xs text-slate-600">Owner-entered on {when(status.saved_at)} · {status.quality==="provisional"?"Provisional timing/clearance":"Recorded timestamp window"}. This does not alter Finance or the formal reconciliation status.</p>
            </div>:null}
            {window.canSave ? <form action={saveOwnerXyCashWindow} className="mt-5 space-y-4">
              <input type="hidden" name="collection_id" value={target.id}/>
              <input type="hidden" name="window_fingerprint" value={window.fingerprint}/>
              <input type="hidden" name="submission_id" value={crypto.randomUUID()}/>
              <label className="block space-y-2 text-sm font-semibold">
                <span>Successful CASH sales in XY — LYD</span>
                <input name="xy_cash_lyd" type="number" step="0.01" min="0" max="999999999"
                  required defaultValue={status?.vms_cash_lyd??""}
                  placeholder="Enter the total from XY for these timestamps"
                  className="field-input text-xl font-semibold"/>
              </label>
              <label className="block space-y-2 text-sm font-semibold">
                <span>Source / report reference</span>
                <input name="report_reference" required minLength={6} maxLength={500}
                  defaultValue={status?.source_note??"XY VMS Order Management — successful cash sales"}
                  className="field-input" />
              </label>
              <label className="flex items-start gap-3 rounded-xl bg-slate-50 p-3 text-sm">
                <input type="checkbox" name="confirmed_cash_scope" value="yes" required className="mt-1"/>
                <span>I checked the <strong>cash-only</strong> successful sales from after {when(window.startAt)} through {when(window.endAt)}, excluding card payments. I understand this is an owner-entered comparison, not an automatic verified XY API sync.</span>
              </label>
              <button type="submit" className="btn-primary w-full">{provisional?"Save provisional XY comparison":"Save XY cash comparison"}</button>
              <p className="text-xs text-slate-600">Saving records an auditable XY comparison only. Physical cash is already counted separately; no new Finance entry is created.</p>
            </form> : <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              Comparison entry is unavailable because the opening boundary, all physical counts or full removals are not confirmed. Resolve the issues shown above first; do not guess sales periods.
            </div>}
          </section>
        </div>
      </div>
    </div>
  );
}
