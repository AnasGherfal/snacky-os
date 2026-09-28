import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import {
  emptyTotals, moneyValue, readAllPurchaseRows, resolvePurchasePerson,
  summarizePurchases, text, tripoliMonth, unitsValue, verifyPurchaseStock,
  type DataRow, type PurchaseHistoryRow, type PurchaseOverview, type StockProof,
} from "@/lib/operator-purchase-overview";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };
const PAGE_SIZE = 20;
const PURCHASE_COLUMNS = "id,person_id,product_id,product_name,storage_location_id,quantity,total_lyd,paid_amount_lyd,remaining_amount_lyd,purchased_at,inventory_movement_id";
// Deliberately exclude unit_cost_lyd, line_total_lyd, notes, and actor metadata.
const MOVEMENT_COLUMNS = "id,product_id,quantity,from_entity_type,from_entity_id,to_entity_type,to_entity_id,reason,created_at,reversed_movement_id,source_type,source_id";

function failure(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status, headers: HEADERS });
}

export async function GET(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return failure("Session expired.", 401);
  const url = new URL(request.url);
  const manager = isOwnerAdminRole(profile) && url.searchParams.get("selfOnly") !== "1";
  let personId: string;
  try {
    personId = resolvePurchasePerson(manager, text(profile.team_member_id), text(url.searchParams.get("personId")));
  } catch {
    return failure("You can only view your own personal purchases.", 403);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(personId)) {
    return failure("A valid team member is required.", 400);
  }
  const requestedPage = Number(url.searchParams.get("page") || 1);
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) return failure("Invalid history page.", 400);
  const supabase = getSupabaseServerClient(await getAuthAccessToken());
  if (!supabase) return failure("Money records are unavailable.", 503);

  try {
    // Operators are constrained in the query itself, in addition to RLS and the
    // route authorization above. A client flag can never grant manager access.
    const [purchases, team] = await Promise.all([
      readAllPurchaseRows<DataRow>((from, to) => {
        let query = supabase.from("operator_personal_purchase_status")
          .select(PURCHASE_COLUMNS, { count: "exact" }).order("id");
        if (!manager) query = query.eq("person_id", personId);
        return query.range(from, to);
      }),
      readAllPurchaseRows<DataRow>((from, to) => {
        let query = supabase.from("team_members")
          .select("id,full_name,active,role,roles", { count: "exact" }).order("id");
        if (!manager) query = query.eq("id", personId);
        return query.range(from, to);
      }),
    ]);
    const member = team.find((row) => text(row.id) === personId);
    if (!member) return failure("Team member not found.", 404);
    const checkedAt = new Date().toISOString();
    const month = tripoliMonth(checkedAt);
    const people = summarizePurchases(purchases, team, month);
    const selected = people.find((row) => row.personId === personId) ||
      emptyTotals(personId, text(member.full_name), member.active !== false);
    const ownPurchases = purchases.filter((row) => text(row.person_id) === personId)
      .sort((a, b) => new Date(text(b.purchased_at)).getTime() - new Date(text(a.purchased_at)).getTime() || text(a.id).localeCompare(text(b.id)));
    const pages = Math.max(1, Math.ceil(ownPurchases.length / PAGE_SIZE));
    const page = Math.min(requestedPage, pages);
    const visible = ownPurchases.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const movementIds = [...new Set(visible.map((row) => text(row.inventory_movement_id)).filter(Boolean))];
    const storageIds = [...new Set(visible.map((row) => text(row.storage_location_id)).filter(Boolean))];
    let proofAvailable = true;
    let movements: DataRow[] = [];
    let storages: DataRow[] = [];
    const reversedIds = new Set<string>();

    if (movementIds.length) {
      // Operators cannot browse warehouse movements under existing RLS. This
      // narrow server-only read uses ONLY IDs from their already-authorized
      // purchases; verifyPurchaseStock checks parent/product/location/quantity
      // and returns a sanitized proof, never unrelated movement data or costs.
      const proofClient = manager ? supabase : getSupabaseAdminClient();
      if (!proofClient) proofAvailable = false;
      else {
        try {
          const [movementRows, reversals, storageRows] = await Promise.all([
            readAllPurchaseRows<DataRow>((from, to) => proofClient.from("inventory_movements")
              .select(MOVEMENT_COLUMNS, { count: "exact" }).in("id", movementIds).order("id").range(from, to)),
            readAllPurchaseRows<DataRow>((from, to) => proofClient.from("inventory_movements")
              .select("id,reversed_movement_id", { count: "exact" }).in("reversed_movement_id", movementIds).order("id").range(from, to)),
            readAllPurchaseRows<DataRow>((from, to) => proofClient.from("storage_locations")
              .select("id,name", { count: "exact" }).in("id", storageIds).order("id").range(from, to)),
          ]);
          movements = movementRows;
          storages = storageRows;
          for (const reversal of reversals) reversedIds.add(text(reversal.reversed_movement_id));
        } catch {
          proofAvailable = false;
        }
      }
    }
    const movementMap = new Map(movements.map((row) => [text(row.id), row]));
    const storageMap = new Map(storages.map((row) => [text(row.id), text(row.name)]));
    const history: PurchaseHistoryRow[] = visible.map((purchase) => {
      const proof: StockProof = proofAvailable
        ? verifyPurchaseStock(purchase, movementMap.get(text(purchase.inventory_movement_id)), reversedIds,
            storageMap.get(text(purchase.storage_location_id)) || null)
        : { status: "unavailable", movementId: text(purchase.inventory_movement_id) || null,
            quantity: null, recordedAt: null, storageName: null };
      return { id: text(purchase.id), product: text(purchase.product_name), quantity: unitsValue(purchase.quantity),
        purchasedAt: text(purchase.purchased_at), charged: moneyValue(purchase.total_lyd),
        paid: moneyValue(purchase.paid_amount_lyd), outstanding: moneyValue(purchase.remaining_amount_lyd), proof };
    });
    const payload: PurchaseOverview = { success: true, personId, manager, month, checkedAt,
      selected, people: manager ? people : [], history, page, pages, historyCount: ownPurchases.length };
    return NextResponse.json(payload, { headers: HEADERS });
  } catch (error) {
    console.error("[operator-purchase-overview] Read failed", error);
    return failure("The full purchase balance could not be verified. Refresh to try again; no partial totals are shown.", 503);
  }
}
