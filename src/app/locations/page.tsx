import { revalidatePath } from "next/cache";
import { AppShell } from "@/components/AppShell";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function save(formData: FormData) {
  "use server";

  const supabase = getSupabaseServerClient();
  if (!supabase) return;

  const id = String(formData.get("id") || "");
  const payload = {
    name: String(formData.get("name") || "").trim(),
    location_type: String(formData.get("location_type") || "other"),
    status: String(formData.get("status") || "active"),
    rent_amount: Number(formData.get("rent_amount") || 0),
  };

  if (!payload.name) return;

  if (id) {
    await supabase.from("locations").update(payload).eq("id", id);
  } else {
    await supabase.from("locations").insert(payload);
  }

  revalidatePath("/locations");
}

async function archive(formData: FormData) {
  "use server";

  const supabase = getSupabaseServerClient();
  if (!supabase) return;

  await supabase.from("locations").update({ status: "archived" }).eq("id", String(formData.get("id")));
  revalidatePath("/locations");
}

export default async function LocationsPage() {
  const supabase = getSupabaseServerClient();
  const { data } = supabase ? await supabase.from("locations").select("*").order("name") : { data: [] };

  return (
    <AppShell>
      <h1 className="page-title">Locations</h1>
      <p className="page-subtitle">Manage vending sites, location type, and rent amount.</p>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <form action={save} className="surface-card space-y-3">
          <h2 className="text-lg font-semibold">Add location</h2>
          <input name="name" required placeholder="Name" className="field-input" />
          <input name="location_type" placeholder="Type" className="field-input" />
          <input name="rent_amount" type="number" step="0.01" placeholder="Rent amount" className="field-input" />
          <button className="btn-primary">Save</button>
        </form>

        <div className="space-y-3">
          {data?.map((row: any) => (
            <form key={row.id} action={save} className="surface-card space-y-3">
              <input type="hidden" name="id" defaultValue={row.id} />
              <input name="name" required defaultValue={row.name} className="field-input" />
              <div className="grid grid-cols-2 gap-2">
                <input name="location_type" defaultValue={row.location_type} className="field-input" />
                <input name="status" defaultValue={row.status} className="field-input" />
              </div>
              <div className="flex gap-2">
                <button className="btn-primary">Update</button>
                <button formAction={archive} className="btn-secondary">Archive</button>
              </div>
            </form>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
