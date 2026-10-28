import {getAuthenticatedSupabaseServerClient} from "@/lib/auth";
import {loadAllExactOwnerRows} from "@/lib/owner-closeout-pagination";
import {
  buildOwnerCashCustodyAudit,
  type CashCustodySourceRow,
  type CashCustodyReceiptRow,
  type CashCustodyEventRow,
  type CashCustodyNameRow,
  type OwnerCashCustodyAudit,
} from "@/lib/owner-cash-custody-audit";

type DB = NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>;
const chunkSize=35;

/** Read-only owner/admin audit from signed-in RLS client, no service-role
 * fallback. All source pages require a verified exact count and stable IDs.
 * A truncated/denied source yields an Unverified view, not missing evidence.
 */
export async function readOwnerCashCustodyAudit(db:DB):
 Promise<{data:OwnerCashCustodyAudit|null;error:string|null}> {
 try {
  const collections=await loadAllExactOwnerRows<CashCustodySourceRow>(async(from,to)=>{
    const r=await db.from("cash_collections")
      .select("id,cash_bag_id,collected_at,operator_id,storage_received_at,storage_received_by,storage_location,storage_seal_condition,counted_at,counted_by,count_witnessed_by,count_seal_condition,custody_status,reconciliation_status,expected_source,voided_at",{count:"exact"})
      .is("voided_at",null)
      .order("id",{ascending:true})
      .range(from,to);
    return {data:r.data as CashCustodySourceRow[]|null,count:r.count,error:r.error};
  });

  if(!collections.length) {
    return {data:buildOwnerCashCustodyAudit({collections:[],receipts:[],events:[],names:[]}),error:null};
  }

  const ids=collections.map(row=>row.id);
  const receiptRows:CashCustodyReceiptRow[]=[];
  const eventRows:CashCustodyEventRow[]=[];
  const evidenceIds=new Set<string>();
  const eventIds=new Set<string>();
  for(let start=0;start<ids.length;start+=chunkSize) {
    const batch=ids.slice(start,start+chunkSize);
    const [receipts,events]=await Promise.all([
      loadAllExactOwnerRows<CashCustodyReceiptRow & {id:string}>(async(from,to)=>{
        const r=await db.from("cash_removal_receipts")
          .select("cash_collection_id,removal_evidence_path",{count:"exact"})
          .in("cash_collection_id",batch)
          .order("cash_collection_id",{ascending:true})
          .range(from,to);
        return {
          data:r.data?.map(row=>({...row,id:String(row.cash_collection_id??"")})) as Array<CashCustodyReceiptRow&{id:string}>|null,
          count:r.count,error:r.error,
        };
      }),
      loadAllExactOwnerRows<CashCustodyEventRow>(async(from,to)=>{
        const r=await db.from("cash_collection_events")
          .select("id,cash_collection_id,event_type,evidence_storage_path",{count:"exact"})
          .in("cash_collection_id",batch)
          .order("id",{ascending:true})
          .range(from,to);
        return {data:r.data as CashCustodyEventRow[]|null,count:r.count,error:r.error};
      }),
    ]);
    for(const receipt of receipts) {
      if(evidenceIds.has(receipt.cash_collection_id)||!batch.includes(receipt.cash_collection_id)) {
        throw new Error("Cash removal receipt identity mismatch.");
      }
      evidenceIds.add(receipt.cash_collection_id);
      receiptRows.push(receipt);
    }
    for(const event of events) {
      if(eventIds.has(event.id)||!batch.includes(event.cash_collection_id)) {
        throw new Error("Cash event identity mismatch.");
      }
      eventIds.add(event.id);
      eventRows.push(event);
    }
  }

  const teamIds=[...new Set(collections.flatMap(row=>[
    row.operator_id,row.storage_received_by,row.counted_by,row.count_witnessed_by,
  ]).filter((id):id is string=>typeof id==="string" && id.trim().length>0))];
  const names:CashCustodyNameRow[]=[];
  for(let start=0;start<teamIds.length;start+=chunkSize) {
    const batch=teamIds.slice(start,start+chunkSize);
    const members=await loadAllExactOwnerRows<CashCustodyNameRow>(async(from,to)=>{
      const r=await db.from("team_members")
        .select("id,full_name",{count:"exact"})
        .in("id",batch)
        .order("id",{ascending:true})
        .range(from,to);
      return {data:r.data as CashCustodyNameRow[]|null,count:r.count,error:r.error};
    });
    names.push(...members);
  }
  return {data:buildOwnerCashCustodyAudit({
    collections,receipts:receiptRows,events:eventRows,names,
  }),error:null};
 } catch(error) {
   console.error("[owner-cash-audit] Incomplete custody source", {
     reason:error instanceof Error?error.message:"unclassified_read_error",
   });
   return {data:null,error:"Cash custody source could not be completely verified."};
 }
}
