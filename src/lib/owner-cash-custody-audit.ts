/** Owner/admin read-only cash chain review.
 *
 * Historical records may predate seal, witness or photograph controls.
 * "Not recorded" is an audit coverage gap, NEVER proof of missing money,
 * misconduct or a failed physical handoff.
 */
export type CashCustodySourceRow = {
  id: string;
  cash_bag_id?: string | null;
  collected_at?: string | null;
  operator_id?: string | null;
  storage_received_at?: string | null;
  storage_received_by?: string | null;
  storage_location?: string | null;
  storage_seal_condition?: string | null;
  counted_at?: string | null;
  counted_by?: string | null;
  count_witnessed_by?: string | null;
  count_seal_condition?: string | null;
  custody_status?: string | null;
  reconciliation_status?: string | null;
  expected_source?: string | null;
  voided_at?: string | null;
};
export type CashCustodyReceiptRow = {
  cash_collection_id: string;
  removal_evidence_path?: string | null;
};
export type CashCustodyEventRow = {
  id: string;
  cash_collection_id: string;
  event_type: string;
  evidence_storage_path?: string | null;
};
export type CashCustodyNameRow = {
  id: string;
  full_name?: string | null;
};
export type CashCustodyStage = "awaiting_handoff" | "awaiting_count" | "variance_review" | "awaiting_source" | "other_review";
export type OwnerCashBagReview = {
  id: string;
  label: string;
  collectedAt: string | null;
  stage: CashCustodyStage;
  custodyStatus: string;
  reconciliationStatus: string;
  collectedBy: string;
  receivedBy: string;
  countedBy: string;
  witnessedBy: string;
  collectedByRecorded: boolean;
  receivedByRecorded: boolean;
  countedByRecorded: boolean;
  witnessRecorded: boolean;
  storageLocation: string | null;
  storageReceivedAt: string | null;
  countedAt: string | null;
  sealAtReceipt: string | null;
  sealAtCount: string | null;
  removalEvidenceRecorded: boolean;
  storageEvidenceRecorded: boolean;
  samePersonHandoff: boolean;
  flags: string[];
};
export type OwnerCashCustodyAudit = {
  verified: true;
  totalActiveBags: number;
  waitingForStorageHandoff: number;
  waitingForPhysicalCount: number;
  countedPendingSource: number;
  variancePendingReview: number;
  collectorIdentityNotRecorded: number;
  countWitnessNotRecorded: number;
  bagsWithHandoffEvidenceGap: number;
  samePersonReceiptRecorded: number;
  bagQueue: OwnerCashBagReview[];
};

const priority: Record<CashCustodyStage,number> = {
  awaiting_handoff: 0,
  awaiting_count: 1,
  variance_review: 2,
  awaiting_source: 3,
  other_review: 4,
};

function recordedText(value: string | null | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function person(value: string | null | undefined, names: Map<string,string>) {
  const id=recordedText(value);
  if (!id) return "Not recorded";
  return names.get(id) || "Recorded ID · " + id.slice(0,8);
}

/** Reconciliation is not the same as physical custody. Counted cash still
 * pending an XY source must not be called missing money.
 */
export function classifyCashCustodyStage(row: CashCustodySourceRow): CashCustodyStage {
  const custody=recordedText(row.custody_status) ?? "";
  const reconciliation=recordedText(row.reconciliation_status) ?? "";
  if (custody==="removed" && !row.storage_received_at && !row.counted_at) return "awaiting_handoff";
  if (!row.counted_at && (custody==="in_storage" || Boolean(row.storage_received_at))) return "awaiting_count";
  if (reconciliation==="variance_review") return "variance_review";
  if (row.counted_at && reconciliation==="pending") return "awaiting_source";
  return "other_review";
}

/** All input sets must have been read completely; the caller is responsible
 * for rejecting truncated/denied sources before invoking this pure helper.
 */
export function buildOwnerCashCustodyAudit({
  collections,
  receipts,
  events,
  names,
  maxVisible=12,
}: {
  collections: readonly CashCustodySourceRow[];
  receipts: readonly CashCustodyReceiptRow[];
  events: readonly CashCustodyEventRow[];
  names: readonly CashCustodyNameRow[];
  maxVisible?: number;
}): OwnerCashCustodyAudit {
  const nameMap = new Map(names.filter(n=>n.id).map(n=>[n.id,recordedText(n.full_name)||"Recorded ID · "+n.id.slice(0,8)]));
  const receiptsByCollection = new Map<string,CashCustodyReceiptRow>();
  for(const receipt of receipts) {
    if (!receipt.cash_collection_id || receiptsByCollection.has(receipt.cash_collection_id)) {
      throw new Error("Cash receipt references must be unique and valid.");
    }
    receiptsByCollection.set(receipt.cash_collection_id,receipt);
  }
  const evidenceByCollection = new Map<string,{removed:boolean;stored:boolean}>();
  const validCollections = new Set(collections.map(row=>row.id));
  if(validCollections.size!==collections.length || collections.some(row=>!row.id)) {
    throw new Error("Duplicate or missing cash collection ID in audit data.");
  }
  for(const event of events) {
    if(!event.id || !validCollections.has(event.cash_collection_id)) {
      throw new Error("Cash event belongs to collection outside verified source.");
    }
    const current=evidenceByCollection.get(event.cash_collection_id)||{removed:false,stored:false};
    if(recordedText(event.evidence_storage_path)) {
      if(event.event_type==="removed") current.removed=true;
      if(event.event_type==="stored") current.stored=true;
    }
    evidenceByCollection.set(event.cash_collection_id,current);
  }

  const bags: OwnerCashBagReview[] = collections
    .filter(row=>!row.voided_at && row.custody_status!=="voided")
    .map(row=>{
      const stage=classifyCashCustodyStage(row);
      const collector=recordedText(row.operator_id);
      const receiver=recordedText(row.storage_received_by);
      const counter=recordedText(row.counted_by);
      const witness=recordedText(row.count_witnessed_by);
      const receiptEvidence=receiptsByCollection.get(row.id);
      const eventsEvidence=evidenceByCollection.get(row.id);
      const removalEvidenceRecorded=Boolean(recordedText(receiptEvidence?.removal_evidence_path) || eventsEvidence?.removed);
      const storageEvidenceRecorded=Boolean(eventsEvidence?.stored);
      const samePersonHandoff=Boolean(collector&&receiver&&collector===receiver);
      const flags:string[]=[];
      if(row.collected_at && !collector) flags.push("collector_not_recorded");
      if(row.storage_received_at && !receiver) flags.push("receiver_not_recorded");
      if(row.storage_received_at && !storageEvidenceRecorded) flags.push("storage_evidence_not_recorded");
      if(row.collected_at && !removalEvidenceRecorded) flags.push("removal_evidence_not_recorded");
      if(row.counted_at && !counter) flags.push("counter_not_recorded");
      if(row.counted_at && !witness) flags.push("count_witness_not_recorded");
      if(samePersonHandoff) flags.push("same_person_handoff_review");
      if(row.storage_seal_condition && row.storage_seal_condition!=="intact") flags.push("seal_condition_review");
      return {
        id:row.id,label:recordedText(row.cash_bag_id)||row.id.slice(0,8).toUpperCase(),
        collectedAt:row.collected_at??null,
        stage,
        custodyStatus:row.custody_status||"unverified",
        reconciliationStatus:row.reconciliation_status||"unverified",
        collectedBy:person(row.operator_id,nameMap),
        receivedBy:person(row.storage_received_by,nameMap),
        countedBy:person(row.counted_by,nameMap),
        witnessedBy:person(row.count_witnessed_by,nameMap),
        collectedByRecorded:Boolean(collector),
        receivedByRecorded:Boolean(receiver),
        countedByRecorded:Boolean(counter),
        witnessRecorded:Boolean(witness),
        storageLocation:recordedText(row.storage_location),
        storageReceivedAt:row.storage_received_at??null,
        countedAt:row.counted_at??null,
        sealAtReceipt:recordedText(row.storage_seal_condition),
        sealAtCount:recordedText(row.count_seal_condition),
        removalEvidenceRecorded,
        storageEvidenceRecorded,
        samePersonHandoff,
        flags,
      };
    });
  const sorted=bags.map((item,index)=>({item,index})).sort((a,b)=>
    priority[a.item.stage]-priority[b.item.stage]
    || String(a.item.collectedAt||"9999").localeCompare(String(b.item.collectedAt||"9999"))
    || a.index-b.index,
  ).map(row=>row.item);
  const limit=Number.isFinite(maxVisible)?Math.max(0,Math.min(30,Math.trunc(maxVisible))):12;
  return {
    verified:true,totalActiveBags:bags.length,
    waitingForStorageHandoff:bags.filter(b=>b.stage==="awaiting_handoff").length,
    waitingForPhysicalCount:bags.filter(b=>b.stage==="awaiting_count").length,
    countedPendingSource:bags.filter(b=>b.stage==="awaiting_source").length,
    variancePendingReview:bags.filter(b=>b.stage==="variance_review").length,
    collectorIdentityNotRecorded:bags.filter(b=>b.flags.includes("collector_not_recorded")).length,
    countWitnessNotRecorded:bags.filter(b=>b.flags.includes("count_witness_not_recorded")).length,
    bagsWithHandoffEvidenceGap:bags.filter(b=>b.flags.includes("storage_evidence_not_recorded")||b.flags.includes("receiver_not_recorded")).length,
    samePersonReceiptRecorded:bags.filter(b=>b.samePersonHandoff).length,
    bagQueue:sorted.filter(row=>row.stage!=="other_review" || row.flags.length>0).slice(0,limit),
  };
}
