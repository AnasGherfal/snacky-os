import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function clean(value: unknown) { return String(value ?? "").trim(); }
function amount(value: unknown) { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0; }
function submissionId(value: unknown, prefix: string) { return clean(value) || `${prefix}:${crypto.randomUUID()}`; }
function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  const row = error as { message?: unknown; details?: unknown; hint?: unknown } | null;
  return clean(row?.message ?? row?.details ?? row?.hint) || "Operator money request failed.";
}

async function context() {
  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const supabase = getSupabaseServerClient(accessToken);
  return { profile, supabase };
}

export async function GET(request: Request) {
  const { profile, supabase } = await context();
  if (!profile || !supabase) return NextResponse.json({ success: false, error: "Session expired." }, { status: 401 });
  const manager = isOwnerAdminRole(profile);
  const url = new URL(request.url);
  const requestedPersonId = clean(url.searchParams.get("personId"));
  const personId = manager ? requestedPersonId || null : profile.team_member_id;
  if (!manager && !personId) return NextResponse.json({ success: false, error: "Operator profile is not linked." }, { status: 403 });

  const teamQuery = manager
    ? supabase.from("team_members").select("id, full_name, role, roles, active").eq("active", true).order("full_name")
    : supabase.from("team_members").select("id, full_name, role, roles, active").eq("id", personId).limit(1);
  const productsQuery = supabase.from("products").select("id, name, brand, category, selling_price, current_selling_price_lyd, active").eq("active", true).order("name");
  const balancesQuery = supabase.from("operator_money_balances").select("*").order("full_name");
  const scoped = <T extends { eq: (a: string, b: string) => T }>(query: T) => personId ? query.eq("person_id", personId) : query;

  const [team, products, balances, purchases, payments, advances, expenses, returns] = await Promise.all([
    teamQuery,
    productsQuery,
    balancesQuery,
    scoped(supabase.from("operator_personal_purchases").select("id, person_id, product_id, quantity, unit_price_lyd, total_lyd, note, purchased_at, product:products(name)").order("purchased_at", { ascending: false }).limit(200)),
    scoped(supabase.from("operator_debt_payments").select("*").order("paid_at", { ascending: false }).limit(200)),
    scoped(supabase.from("operator_advances").select("*").order("given_at", { ascending: false }).limit(200)),
    scoped(supabase.from("operator_expenses").select("*").order("spent_at", { ascending: false }).limit(200)),
    scoped(supabase.from("operator_advance_returns").select("*").order("returned_at", { ascending: false }).limit(200)),
  ]);
  const failed = [team, products, balances, purchases, payments, advances, expenses, returns].find((result) => result.error);
  if (failed?.error) return NextResponse.json({ success: false, error: errorText(failed.error) }, { status: 500 });
  return NextResponse.json({
    success: true,
    manager,
    currentPersonId: profile.team_member_id,
    selectedPersonId: personId,
    team: team.data ?? [], products: products.data ?? [], balances: balances.data ?? [], purchases: purchases.data ?? [], payments: payments.data ?? [], advances: advances.data ?? [], expenses: expenses.data ?? [], returns: returns.data ?? [],
  });
}

export async function POST(request: Request) {
  const { profile, supabase } = await context();
  if (!profile || !supabase) return NextResponse.json({ success: false, error: "Session expired." }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ success: false, error: "Invalid request." }, { status: 400 }); }
  const action = clean(body.action);
  const personId = clean(body.personId) || clean(profile.team_member_id);
  try {
    let result;
    if (action === "purchase") {
      result = await supabase.rpc("create_operator_personal_purchase", {
        p_person_id: personId, p_product_id: clean(body.productId), p_storage_location_id: clean(body.storageLocationId), p_quantity: Math.floor(amount(body.quantity)), p_unit_price_lyd: amount(body.unitPrice), p_note: clean(body.note) || null, p_client_submission_id: submissionId(body.clientSubmissionId, "operator-purchase"),
      });
    } else if (action === "advance") {
      result = await supabase.rpc("create_operator_advance", {
        p_person_id: personId, p_amount: amount(body.amount), p_given_at: clean(body.date) || new Date().toISOString(), p_purpose: clean(body.purpose), p_note: clean(body.note) || null, p_client_submission_id: submissionId(body.clientSubmissionId, "operator-advance"),
      });
    } else if (action === "expense") {
      result = await supabase.rpc("submit_operator_expense", {
        p_person_id: personId, p_advance_id: clean(body.advanceId) || null, p_amount: amount(body.amount), p_expense_type: clean(body.expenseType), p_supplier_payee: clean(body.supplierPayee), p_spent_at: clean(body.date) || new Date().toISOString(), p_receipt_url: clean(body.receiptUrl) || null, p_note: clean(body.note), p_client_submission_id: submissionId(body.clientSubmissionId, "operator-expense"),
      });
    } else if (action === "reviewExpense") {
      result = await supabase.rpc("review_operator_expense", { p_expense_id: clean(body.expenseId), p_status: clean(body.status), p_review_note: clean(body.note) || null });
    } else if (action === "debtPayment") {
      result = await supabase.rpc("record_operator_debt_payment", {
        p_person_id: personId, p_amount: amount(body.amount), p_paid_at: clean(body.date) || new Date().toISOString(), p_payment_method: clean(body.paymentMethod), p_note: clean(body.note) || null, p_client_submission_id: submissionId(body.clientSubmissionId, "operator-debt-payment"),
      });
    } else if (action === "advanceReturn") {
      result = await supabase.rpc("record_operator_advance_return", {
        p_person_id: personId, p_advance_id: clean(body.advanceId) || null, p_amount: amount(body.amount), p_returned_at: clean(body.date) || new Date().toISOString(), p_payment_method: clean(body.paymentMethod), p_note: clean(body.note) || null, p_client_submission_id: submissionId(body.clientSubmissionId, "operator-advance-return"),
      });
    } else if (action === "availability") {
      result = await supabase.rpc("operator_money_available_storage", { p_product_id: clean(body.productId) });
    } else {
      return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
    }
    if (result.error) throw result.error;
    revalidatePath("/operator-money"); revalidatePath("/inventory"); revalidatePath("/inventory/movements");
    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    const text = errorText(error);
    const status = text.toLowerCase().includes("authorized") || text.toLowerCase().includes("only owner") || text.toLowerCase().includes("only buy") ? 403 : 400;
    return NextResponse.json({ success: false, error: text }, { status });
  }
}
