import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

type AvailabilityRow = {
  storage_location_id: string;
  storage_name: string;
  on_hand_qty: number;
  reserved_qty: number;
  available_qty: number;
};

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getOperatorPurchaseAvailability(productId: string): Promise<AvailabilityRow[]> {
  const admin = getSupabaseAdminClient();
  if (!admin) throw new Error("Server inventory access is not configured.");

  const [locationsResult, inventoryResult, reservedResult] = await Promise.all([
    admin
      .from("storage_locations")
      .select("id, name, active, location_type")
      .eq("active", true)
      .in("location_type", ["main_storage", "vehicle", "temporary", "other"])
      .order("name"),
    admin
      .from("current_inventory_by_location")
      .select("location_id, quantity_on_hand")
      .eq("location_type", "storage")
      .eq("product_id", productId),
    admin.rpc("operator_money_reserved_qty", { p_product_id: productId }),
  ]);

  if (locationsResult.error) throw locationsResult.error;
  if (inventoryResult.error) throw inventoryResult.error;
  if (reservedResult.error) throw reservedResult.error;

  const quantityByLocation = new Map<string, number>();
  for (const row of inventoryResult.data ?? []) {
    quantityByLocation.set(String(row.location_id), numberValue(row.quantity_on_hand));
  }

  let remainingReserved = Math.max(0, numberValue(reservedResult.data));
  const locations = (locationsResult.data ?? [])
    .map((location) => ({
      storage_location_id: String(location.id),
      storage_name: String(location.name ?? "Storage"),
      on_hand_qty: Math.max(0, quantityByLocation.get(String(location.id)) ?? 0),
    }))
    .sort((a, b) => b.on_hand_qty - a.on_hand_qty || a.storage_name.localeCompare(b.storage_name));

  return locations.map((location) => {
    const reservedQty = Math.min(location.on_hand_qty, remainingReserved);
    remainingReserved = Math.max(0, remainingReserved - reservedQty);
    return {
      ...location,
      reserved_qty: reservedQty,
      available_qty: Math.max(0, location.on_hand_qty - reservedQty),
    };
  });
}
