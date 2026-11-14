import "server-only";

import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";

export const OWNER_COUNT_REPORT_SOURCE = "owner_message_2026_11_14";

type RawCashCollection = {
  id: string;
  cash_bag_id: string | null;
  collected_at: string;
  actual_cash_collected: number | string | null;
  custody_status: string;
  voided_at: string | null;
  operator_id: string | null;
  machine_links: Array<{
    machine_id: string;
    expectation_metadata: Record<string, unknown> | null;
    machine: { name: string | null; machine_code: string | null } | Array<{ name: string | null; machine_code: string | null }> | null;
  }>;
};

export type OwnerCountReport = {
  id: string;
  bag: string;
  removedAt: string;
  operatorId: string | null;
  machineId: string;
  machineName: string;
  amount: number;
  source: string;
  custodyStatus: string;
  countedAmount: number | null;
};

export async function loadOwnerReportedCountRows():Promise<OwnerCountReport[]> {
  const db = await getAuthenticatedSupabaseServerClient();
  if(!db)throw new Error("Signed-in cash ledger unavailable.");
  // This is a one-time owner-reported November 2026 correction. Keep dates
  // explicit to avoid accidentally processing future unrelated reported counts.
  const {data,error,count} = await db.from("cash_collections")
    .select("id,cash_bag_id,collected_at,actual_cash_collected,custody_status,voided_at,operator_id,machine_links:cash_collection_machines(machine_id,expectation_metadata,machine:machines(name,machine_code))",{count:"exact"})
    .gte("collected_at","2026-11-01T00:00:00+02:00")
    .lt("collected_at","2026-12-01T00:00:00+02:00")
    .is("voided_at",null)
    .order("collected_at",{ascending:true}).limit(200);
  if(error || count===null || count===undefined || count!==(data??[]).length)
    throw new Error("November cash records could not be loaded completely; do not attempt a partial count.");
  const result:OwnerCountReport[]=[];
  for(const row of (data??[]) as unknown as RawCashCollection[]) {
    if(row.machine_links.length!==1)continue;
    const line=row.machine_links[0];
    const report=line.expectation_metadata?.owner_reported_cash_count_pending_confirmation;
    if(!report || typeof report!=="object" || Array.isArray(report))continue;
    const fields=report as Record<string,unknown>;
    if(fields.source!==OWNER_COUNT_REPORT_SOURCE || fields.physical_counter_name!=="Anas" ||
       fields.owner_reports_cash_received_from_storage!==true)continue;
    const amount=Number(fields.amount_lyd);
    if(!Number.isFinite(amount) || amount<0 || amount>1000000 || Math.round(amount*100)!==amount*100)
      throw new Error("An owner-reported cash amount is invalid. Do not invent a count.");
    if(!row.cash_bag_id || !row.cash_bag_id.trim())throw new Error("Missing cashbox reference in owner report.");
    const counted=row.actual_cash_collected===null ? null:Number(row.actual_cash_collected);
    const machine = Array.isArray(line.machine) ? line.machine[0] : line.machine;
    result.push({
      id:row.id,bag:row.cash_bag_id,removedAt:row.collected_at,
      operatorId:row.operator_id,machineId:line.machine_id,
      machineName:machine?.name??machine?.machine_code??line.machine_id,
      amount,source:String(fields.source),
      custodyStatus:row.custody_status,countedAmount:counted,
    });
  }
  return result;
}
