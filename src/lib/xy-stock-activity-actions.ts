"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { XY_MACHINE_ACTIVITY_PROFILES } from "@/lib/xy-stock-activity-alert-rules";

function maybeDate(value: unknown) {
  const text=String(value??"").trim();
  if(!text) return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text)
    || Number.isNaN(Date.parse(text+"T00:00:00Z"))
    || new Date(text+"T00:00:00Z").toISOString().slice(0,10)!==text) {
    throw new Error("Use YYYY-MM-DD for a closure or pause date.");
  }
  return text;
}

export async function saveXyActivitySiteOverridesAction(form: FormData) {
  const profile=await getCurrentProfile();
  if(!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  const db=getSupabaseAdminClient();
  if(!db) throw new Error("XY site alert configuration is unavailable.");
  const machineId=String(form.get("machine_id")??"").trim();
  if(!/^[0-9a-f-]{36}$/i.test(machineId)) throw new Error("Invalid machine ID.");

  const {data:machine,error:machineError}=await db.from("machines")
    .select("id,vms_machine_id").eq("id",machineId).maybeSingle();
  if(machineError || !machine?.vms_machine_id
    || !XY_MACHINE_ACTIVITY_PROFILES[machine.vms_machine_id]) {
    throw new Error("This machine has no supported XY activity profile.");
  }

  const dateList=String(form.get("closed_dates")??"")
    .split(/[\s,;]+/).map(item=>item.trim()).filter(Boolean);
  if(dateList.length>45) throw new Error("Maximum 45 special closure dates.");
  const excluded_dates=[...new Set(dateList.map(maybeDate).filter((value):value is string=>value!==null))];
  const pause_through=maybeDate(form.get("pause_through"));
  const hourText=String(form.get("minimum_hours")??"").trim();
  const expectedText=String(form.get("minimum_expected_units")??"").trim();
  const min_window_hours=hourText?Number(hourText):null;
  const min_expected_units=expectedText?Number(expectedText):null;
  if(min_window_hours!==null && (!Number.isInteger(min_window_hours) || min_window_hours<2 || min_window_hours>8)) {
    throw new Error("Select 2–8 operating hours.");
  }
  if(min_expected_units!==null && (!Number.isInteger(min_expected_units) || min_expected_units<1 || min_expected_units>100)) {
    throw new Error("Select 1–100 historical stock units.");
  }

  const {error}=await db.from("xy_stock_activity_site_overrides").upsert({
    machine_id:machineId,excluded_dates,pause_through,
    min_window_hours,min_expected_units,updated_at:new Date().toISOString(),
  },{onConflict:"machine_id"});
  if(error) throw new Error("Unable to save XY activity alert settings: "+error.message);
  revalidatePath("/admin/vms-api");
}
