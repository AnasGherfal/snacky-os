import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status, headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

/**
 * Real Snacky machines, real SKU names, real imported selection inventory.
 * Absolutely READ ONLY. No artificial product, storage or route DB rows and
 * no call to the XY vendor's mutable stock/product APIs.
 */
export async function GET() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !hasRole(profile, "owner")) {
    return response({ ok: false, error: "Owner-only route preview." }, 403);
  }
  const db = getSupabaseAdminClient();
  if (!db) return response({ ok: false, error: "Database unavailable." }, 503);

  const { data: machines, error: machinesError } = await db.from("machines")
    .select("id,name,machine_code,status")
    .in("machine_code", ["SNK-2509000371", "SNK-2510001719"])
    .eq("status", "active");
  if (machinesError || !machines?.length) {
    return response({ ok: false, error: "Could not load the actual machine records for route testing." }, 503);
  }

  const sorted = [...machines].sort((a, b) => (
    a.machine_code === "SNK-2509000371" ? -1 : b.machine_code === "SNK-2509000371" ? 1 : 0
  ));
  const machineIds = sorted.map((machine) => machine.id);
  const { data: stock, error: stockError } = await db.from("latest_vms_stock_by_slot")
    .select("machine_id,slot_code,product_id,current_qty,capacity,captured_at,vms_product_name")
    .in("machine_id", machineIds)
    .order("slot_code")
    .limit(250);
  if (stockError) return response({ ok: false, error: "Could not read XY selection snapshots." }, 503);
  const productIds = [...new Set((stock ?? []).map((slot) => String(slot.product_id ?? "")).filter(Boolean))];
  const { data: productRows, error: productError } = productIds.length
    ? await db.from("products")
      .select("id,name,image_url,current_selling_price_lyd,active")
      .in("id", productIds)
    : { data: [], error: null };
  if (productError) return response({ ok: false, error: "Could not read Snacky product details." }, 503);
  const byProduct = new Map((productRows ?? []).map((p) => [p.id, p]));

  const result = sorted.map((machine) => {
    const seen = new Set<string>();
    const slots = (stock ?? []).filter((slot) => slot.machine_id === machine.id)
      .filter((slot) => {
        const code = String(slot.slot_code ?? "").trim();
        if (!code || seen.has(code)) return false;
        seen.add(code);
        return true;
      }).map((slot) => {
        const product = byProduct.get(String(slot.product_id ?? ""));
        const current = Number(slot.current_qty);
        const capacity = Number(slot.capacity);
        return {
          slotCode: String(slot.slot_code),
          productId: product?.id ?? null,
          productName: product?.name ?? slot.vms_product_name ?? "Unmapped",
          imageUrl: product?.image_url ?? null,
          currentQty: Number.isSafeInteger(current) && current >= 0 ? current : null,
          capacity: Number.isSafeInteger(capacity) && capacity > 0 ? capacity : null,
          priceLyd: Math.max(0, Number(product?.current_selling_price_lyd ?? 0) || 0),
          capturedAt: slot.captured_at ?? null,
        };
      }).sort((a, b) => a.slotCode.localeCompare(b.slotCode, undefined, { numeric: true }));
    return { id: machine.id, name: machine.name, machineCode: machine.machine_code, slots };
  });

  if (result.some((machine) => machine.slots.length < 8)) {
    return response({ ok: false, error: "A real machine has no usable selection snapshot. No fake XY stock will be generated." }, 409);
  }
  return response({
    ok: true,
    source: "xy_imported_snapshot_readonly",
    capturedAt: (stock ?? []).map((row) => row.captured_at).filter(Boolean).sort().at(-1) ?? null,
    machines: result,
    disclaimer: "Real Snacky machine and product snapshots; edits are local to the browser, never production stock.",
  });
}
