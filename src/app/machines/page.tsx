import { revalidatePath } from "next/cache";
import { AppShell } from "@/components/AppShell";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function save(formData: FormData) {
  "use server";

  const supabase = getSupabaseServerClient();
  if (!supabase) return;

  const id = String(formData.get("id") || "");
  const payload = {
    machine_code: String(formData.get("machine_code") || "").trim(),
    vms_machine_id: String(formData.get("vms_machine_id") || "") || null,
    name: String(formData.get("name") || "").trim(),
    machine_type: String(formData.get("machine_type") || "lift"),
    location_id: String(formData.get("location_id") || "") || null,
    rent_amount: Number(formData.get("rent_amount") || 0),
    status: String(formData.get("status") || "planned"),
    target_nsm: Number(formData.get("target_nsm") || 2800),
    target_uptime_percent: Number(formData.get("target_uptime_percent") || 98),
  };

  if (!payload.machine_code || !payload.name) return;

  if (id) {
    await supabase.from("machines").update(payload).eq("id", id);
  } else {
    await supabase.from("machines").insert(payload);
  }

  revalidatePath("/machines");
}

export default async function MachinesPage() {
  const supabase = getSupabaseServerClient();
  const { data: machines } = supabase
    ? await supabase
        .from("machines")
        .select("id,machine_code,vms_machine_id,name,status,machine_type,rent_amount,target_nsm,target_uptime_percent,location_id,locations(name)")
        .order("name")
    : { data: [] };
  const { data: locations } = supabase ? await supabase.from("locations").select("id,name").order("name") : { data: [] };

  return (
    <AppShell>
      <h1 className="page-title">Machines</h1>
      <p className="page-subtitle">Manage machine master records and operating targets.</p>

      <div className="mt-6 space-y-3">
        <form action={save} className="surface-card grid gap-2 md:grid-cols-4">
          <input required name="machine_code" placeholder="SNK-009" className="field-input" />
          <input name="vms_machine_id" placeholder="VMS ID" className="field-input" />
          <input required name="name" placeholder="Machine name" className="field-input" />
          <input name="machine_type" placeholder="lift/non_lift" className="field-input" />
          <select name="location_id" className="field-input">
            <option value="">Location</option>
            {locations?.map((location: any) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
          <input type="number" step="0.01" name="rent_amount" placeholder="Rent" className="field-input" />
          <input type="number" step="0.01" name="target_nsm" placeholder="Target NSM" className="field-input" />
          <input type="number" step="0.01" name="target_uptime_percent" placeholder="Target uptime %" className="field-input" />
          <input name="status" placeholder="Status" className="field-input" />
          <button className="btn-primary md:col-span-4">Add machine</button>
        </form>

        {machines?.map((machine: any) => (
          <form key={machine.id} action={save} className="surface-card grid gap-2 md:grid-cols-5">
            <input type="hidden" name="id" defaultValue={machine.id} />
            <input required name="machine_code" defaultValue={machine.machine_code} className="field-input" />
            <input name="vms_machine_id" defaultValue={machine.vms_machine_id || ""} className="field-input" />
            <input required name="name" defaultValue={machine.name} className="field-input" />
            <input name="machine_type" defaultValue={machine.machine_type} className="field-input" />
            <select name="location_id" defaultValue={machine.location_id || ""} className="field-input">
              <option value="">Location</option>
              {locations?.map((location: any) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
            <input type="number" step="0.01" name="rent_amount" defaultValue={machine.rent_amount} className="field-input" />
            <input type="number" step="0.01" name="target_nsm" defaultValue={machine.target_nsm} className="field-input" />
            <input
              type="number"
              step="0.01"
              name="target_uptime_percent"
              defaultValue={machine.target_uptime_percent}
              className="field-input"
            />
            <input name="status" defaultValue={machine.status} className="field-input" />
            <button className="btn-primary md:col-span-5">Update</button>
          </form>
        ))}
      </div>
    </AppShell>
  );
}
