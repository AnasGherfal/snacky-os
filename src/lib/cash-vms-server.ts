import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { planCashVmsWindow, readManualCashComparison, type CashVmsPickup } from "@/lib/cash-vms-window";

type MachineLine = {
  cash_collection_id: string;
  machine_id: string;
  removal_type: string;
  compartments: string[] | null;
  counted_amount_lyd: number | string | null;
  expectation_metadata: Record<string, unknown> | null;
};
type Collection = {
  id: string;
  machine_id: string | null;
  collected_at: string;
  actual_cash_collected: string | number | null;
  custody_status: string;
  voided_at: string | null;
  notes: string | null;
  operator_id: string | null;
};
type Machine = { id: string; name: string | null; machine_code: string | null };
type Team = { id: string; full_name: string | null };

export async function loadCashVmsWindow(collectionId: string) {
  const db = getSupabaseAdminClient();
  if (!db) throw new Error("Cash database is unavailable.");
  const { data: selected, error: selectedError } = await db.from("cash_collections")
    .select("id,machine_id,collected_at,actual_cash_collected,custody_status,voided_at,notes,operator_id")
    .eq("id",collectionId).maybeSingle();
  if (selectedError || !selected || selected.voided_at)
    throw new Error("The selected cash removal could not be verified.");
  const { data: selectedLines, error: selectedLinesError } = await db.from("cash_collection_machines")
    .select("machine_id").eq("cash_collection_id",collectionId);
  if (selectedLinesError || !selectedLines?.length)
    throw new Error("The cash removal has no linked machine.");
  if (selectedLines.length !== 1)
    throw new Error("This bag includes several machines. A combined count cannot be assigned to a single machine without a separately verified split.");
  const machineId = selectedLines[0].machine_id;
  const [machineResult, linesResult] = await Promise.all([
    db.from("machines").select("id,name,machine_code").eq("id",machineId).maybeSingle(),
    db.from("cash_collection_machines")
      .select("cash_collection_id,machine_id,removal_type,compartments,counted_amount_lyd,expectation_metadata", {count:"exact"})
      .eq("machine_id",machineId).limit(1000),
  ]);
  if (machineResult.error || !machineResult.data || linesResult.error)
    throw new Error("Could not read machine history.");
  if (linesResult.count === null || linesResult.count !== (linesResult.data ?? []).length)
    throw new Error("Machine history is incomplete; a partial cash sum would be unsafe.");
  const machine = machineResult.data as Machine;
  const lines = (linesResult.data ?? []) as MachineLine[];
  const ids = lines.map((row) => row.cash_collection_id);
  const collections: Collection[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from("cash_collections")
      .select("id,machine_id,collected_at,actual_cash_collected,custody_status,voided_at,notes,operator_id")
      .in("id",ids.slice(i,i+100));
    if (error) throw new Error("Could not verify every cash removal in this period.");
    collections.push(...(data ?? []) as Collection[]);
  }
  if (collections.length !== ids.length)
    throw new Error("At least one machine cash removal is missing from the ledger.");
  const collectionMap = new Map(collections.map((row) => [row.id,row]));
  const peopleIds = [...new Set(collections.map((row) => row.operator_id).filter((id):id is string=>Boolean(id)))];
  const { data: team, error: teamError } = peopleIds.length
    ? await db.from("team_members").select("id,full_name").in("id",peopleIds)
    : {data:[] as Team[],error:null};
  if (teamError) throw new Error("The recorded operator names could not be loaded.");
  const byTeam = new Map((team ?? []).map((t) => [t.id,t.full_name]));
  const pickups: CashVmsPickup[] = [];
  for (const line of lines) {
    const collection = collectionMap.get(line.cash_collection_id);
    if (!collection || collection.voided_at) continue;
    const meta = line.expectation_metadata ?? {};
    const manual = readManualCashComparison(meta.manual_vms_group_comparison);
    const rawCount = line.counted_amount_lyd ??
      (collection.machine_id === machineId ? collection.actual_cash_collected : null);
    const count = rawCount === null ? null : Number(rawCount);
    if (count !== null && (!Number.isFinite(count) || count < 0))
      throw new Error("A physical cash count is invalid; comparison stopped.");
    const notes = String(collection.notes ?? "");
    const timeUncertain = Boolean(meta.time_proxy || meta.collected_at_is_noon_placeholder ||
      meta.removal_time_placeholder || meta.interval_end_is_date_only_placeholder ||
      meta.actual_removal_time_unknown || meta.exact_removal_time_unknown ||
      /date-only.*placeholder|noon.*placeholder|time.*proxy|exact.*time.*unknown/i.test(notes));
    const compartments = line.compartments ?? [];
    const fullClearanceUnverified = Boolean(meta.full_removal_assumed_not_verified ||
      meta.full_removal_assumed_not_independently_verified ||
      compartments.includes("legacy_unknown") ||
      !(compartments.includes("notes") && compartments.includes("coins")));
    pickups.push({
      id:collection.id,machineId,machineName:machine.name ?? machine.machine_code ?? machineId,
      machineCode:machine.machine_code,removedAt:collection.collected_at,
      removedBy:collection.operator_id ? byTeam.get(collection.operator_id) ?? null : null,
      custodyStatus:collection.custody_status,removalType:line.removal_type,
      compartments,countedAmount:count,timeUncertain,fullClearanceUnverified,comparison:manual,
    });
  }
  return planCashVmsWindow(pickups,collectionId);
}
