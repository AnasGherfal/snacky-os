import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getOperatorPurchaseAvailability } from "./availability";

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
};

type DataRow = Record<string, unknown>;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function amount(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function submissionId(value: unknown, prefix: string) {
  return clean(value) || prefix + ":" + crypto.randomUUID();
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  const row = error as ErrorLike | null;
  return clean(row?.message ?? row?.details ?? row?.hint) || "Operator money request failed.";
}

function errorCode(error: unknown) {
  return clean((error as ErrorLike | null)?.code);
}

function isMissingPeriodSchema(error: unknown) {
  const code = errorCode(error);
  const message = errorText(error).toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST200" ||
    code === "PGRST205" ||
    (message.includes("operator_money_period_summary") &&
      (message.includes("does not exist") || message.includes("schema cache") || message.includes("could not find")))
  );
}

function eventTimestamp(value: unknown) {
  const raw = clean(value);
  if (!raw) return new Date().toISOString();

  // The client sends ISO timestamps. This fallback also handles a direct
  // datetime-local request as Tripoli local time instead of silently treating it as UTC.
  const localDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
  const normalized = localDateTime.test(raw)
    ? raw + (raw.length === 16 ? ":00+02:00" : "+02:00")
    : raw;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw new Error("A valid date and time is required.");
  return parsed.toISOString();
}

async function context() {
  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const supabase = getSupabaseServerClient(accessToken);
  return { profile, supabase };
}

function syntheticLegacyPeriod(personId: string, fullName: unknown, balance: DataRow | undefined) {
  return {
    period_id: "legacy",
    person_id: personId,
    full_name: fullName ?? "",
    label: "All history",
    period_start: null,
    period_end: null,
    lifecycle_status: "open",
    closed_at: null,
    settled_at: null,
    settlement_state: "legacy",
    personal_purchases_lyd: balance?.personal_purchases_lyd ?? 0,
    debt_paid_lyd: balance?.debt_paid_lyd ?? 0,
    personal_debt_remaining_lyd: balance?.personal_debt_remaining_lyd ?? 0,
    advanced_lyd: balance?.advanced_lyd ?? 0,
    approved_expenses_lyd: balance?.approved_expenses_lyd ?? 0,
    returned_money_lyd: balance?.returned_money_lyd ?? 0,
    advance_due_to_snacky_lyd: balance?.unaccounted_advance_lyd ?? 0,
    reimbursed_lyd: balance?.reimbursed_lyd ?? 0,
    reimbursement_due_to_operator_lyd: balance?.operator_reimbursement_due_lyd ?? 0,
    pending_expense_count: 0,
  };
}

export async function GET(request: Request) {
  const { profile, supabase } = await context();
  if (!profile || !supabase) {
    return NextResponse.json({ success: false, error: "Session expired." }, { status: 401 });
  }

  const manager = isOwnerAdminRole(profile);
  const url = new URL(request.url);
  const requestedPersonId = clean(url.searchParams.get("personId"));
  const requestedPeriodId = clean(url.searchParams.get("periodId"));
  const ownPersonId = clean(profile.team_member_id);

  if (!manager && !ownPersonId) {
    return NextResponse.json(
      { success: false, error: "Operator profile is not linked." },
      { status: 403 },
    );
  }

  const teamQuery = manager
    ? supabase
        .from("team_members")
        .select("id, full_name, role, roles, active")
        .order("active", { ascending: false })
        .order("full_name")
    : supabase
        .from("team_members")
        .select("id, full_name, role, roles, active")
        .eq("id", ownPersonId)
        .limit(1);
  const productsQuery = supabase
    .from("products")
    .select("id, name, brand, category, selling_price, current_selling_price_lyd, active")
    .eq("active", true)
    .order("name");

  const [team, products] = await Promise.all([teamQuery, productsQuery]);
  const initialFailure = [team, products].find((result) => result.error);
  if (initialFailure?.error) {
    return NextResponse.json(
      { success: false, error: errorText(initialFailure.error) },
      { status: 500 },
    );
  }

  const teamRows = (team.data ?? []) as DataRow[];
  if (manager && requestedPersonId && !teamRows.some((row) => clean(row.id) === requestedPersonId)) {
    return NextResponse.json({ success: false, error: "Operator not found." }, { status: 404 });
  }

  const personId = manager
    ? requestedPersonId || ownPersonId || clean(teamRows[0]?.id)
    : ownPersonId;
  if (!personId) {
    return NextResponse.json({
      success: true,
      manager,
      currentPersonId: ownPersonId || null,
      selectedPersonId: null,
      selectedPeriodId: null,
      selectedPeriod: null,
      periodSupport: true,
      team: teamRows,
      products: products.data ?? [],
      balances: [],
      periods: [],
      purchases: [],
      payments: [],
      advances: [],
      expenses: [],
      returns: [],
      reimbursements: [],
      periodEvents: [],
    });
  }

  const [periodsResult, balancesResult] = await Promise.all([
    supabase
      .from("operator_money_period_summary")
      .select("*")
      .eq("person_id", personId)
      .order("period_start", { ascending: false }),
    supabase.from("operator_money_balances").select("*").eq("person_id", personId),
  ]);

  if (periodsResult.error && !isMissingPeriodSchema(periodsResult.error)) {
    return NextResponse.json(
      { success: false, error: errorText(periodsResult.error) },
      { status: 500 },
    );
  }

  if (!periodsResult.error) {
    if (balancesResult.error) {
      return NextResponse.json(
        { success: false, error: errorText(balancesResult.error) },
        { status: 500 },
      );
    }

    const periods = (periodsResult.data ?? []) as DataRow[];
    const requestedPeriod = requestedPeriodId
      ? periods.find((row) => clean(row.period_id) === requestedPeriodId)
      : undefined;
    if (requestedPeriodId && !requestedPeriod) {
      return NextResponse.json({ success: false, error: "Money period not found." }, { status: 404 });
    }

    const selectedPeriod =
      requestedPeriod ??
      periods.find((row) => clean(row.lifecycle_status) === "open") ??
      periods[0];
    const selectedPeriodId = clean(selectedPeriod?.period_id);

    if (!selectedPeriodId) {
      return NextResponse.json({
        success: true,
        manager,
        currentPersonId: ownPersonId || null,
        selectedPersonId: personId,
        selectedPeriodId: null,
        selectedPeriod: null,
        periodSupport: true,
        team: teamRows,
        products: products.data ?? [],
        balances: balancesResult.data ?? [],
        periods,
        purchases: [],
        payments: [],
        advances: [],
        expenses: [],
        returns: [],
        reimbursements: [],
        periodEvents: [],
      });
    }

    const [purchases, payments, advances, expenses, returns, reimbursements, periodEvents] =
      await Promise.all([
        supabase
          .from("operator_personal_purchase_status")
          .select("*")
          .eq("period_id", selectedPeriodId)
          .order("purchased_at", { ascending: false })
          .limit(500),
        supabase
          .from("operator_debt_payments")
          .select("*")
          .eq("period_id", selectedPeriodId)
          .order("paid_at", { ascending: false })
          .limit(500),
        supabase
          .from("operator_advances")
          .select("*")
          .eq("period_id", selectedPeriodId)
          .order("given_at", { ascending: false })
          .limit(500),
        supabase
          .from("operator_expenses")
          .select("*")
          .eq("period_id", selectedPeriodId)
          .order("spent_at", { ascending: false })
          .limit(500),
        supabase
          .from("operator_advance_returns")
          .select("*")
          .eq("period_id", selectedPeriodId)
          .order("returned_at", { ascending: false })
          .limit(500),
        supabase
          .from("operator_expense_reimbursements")
          .select("*")
          .eq("period_id", selectedPeriodId)
          .order("paid_at", { ascending: false })
          .limit(500),
        supabase
          .from("operator_money_period_events")
          .select("*")
          .eq("period_id", selectedPeriodId)
          .order("acted_at", { ascending: false })
          .limit(500),
      ]);

    const periodFailure = [
      purchases,
      payments,
      advances,
      expenses,
      returns,
      reimbursements,
      periodEvents,
    ].find((result) => result.error);
    if (periodFailure?.error) {
      return NextResponse.json(
        { success: false, error: errorText(periodFailure.error) },
        { status: 500 },
      );
    }

    const purchaseRows = ((purchases.data ?? []) as DataRow[]).map((row) => ({
      ...row,
      // Keep the old nested product shape while the UI moves to product_name.
      product: { name: row.product_name },
    }));

    return NextResponse.json({
      success: true,
      manager,
      currentPersonId: ownPersonId || null,
      selectedPersonId: personId,
      selectedPeriodId,
      selectedPeriod,
      periodSupport: true,
      team: teamRows,
      products: products.data ?? [],
      balances: balancesResult.data ?? [],
      periods,
      purchases: purchaseRows,
      payments: payments.data ?? [],
      advances: advances.data ?? [],
      expenses: expenses.data ?? [],
      returns: returns.data ?? [],
      reimbursements: reimbursements.data ?? [],
      periodEvents: periodEvents.data ?? [],
    });
  }

  // The preview can run before the migration is activated. Preserve the existing
  // ledger rather than turning a missing period view into an empty-money screen.
  const [balances, purchases, payments, advances, expenses, returns] = await Promise.all([
    supabase.from("operator_money_balances").select("*").eq("person_id", personId),
    supabase
      .from("operator_personal_purchases")
      .select(
        "id, person_id, product_id, quantity, unit_price_lyd, total_lyd, note, purchased_at, product:products(name)",
      )
      .eq("person_id", personId)
      .order("purchased_at", { ascending: false })
      .limit(500),
    supabase
      .from("operator_debt_payments")
      .select("*")
      .eq("person_id", personId)
      .order("paid_at", { ascending: false })
      .limit(500),
    supabase
      .from("operator_advances")
      .select("*")
      .eq("person_id", personId)
      .order("given_at", { ascending: false })
      .limit(500),
    supabase
      .from("operator_expenses")
      .select("*")
      .eq("person_id", personId)
      .order("spent_at", { ascending: false })
      .limit(500),
    supabase
      .from("operator_advance_returns")
      .select("*")
      .eq("person_id", personId)
      .order("returned_at", { ascending: false })
      .limit(500),
  ]);
  const legacyFailure = [balances, purchases, payments, advances, expenses, returns].find(
    (result) => result.error,
  );
  if (legacyFailure?.error) {
    return NextResponse.json(
      { success: false, error: errorText(legacyFailure.error) },
      { status: 500 },
    );
  }

  const balance = ((balances.data ?? []) as DataRow[])[0];
  const person = teamRows.find((row) => clean(row.id) === personId);
  const legacyPeriod = syntheticLegacyPeriod(personId, person?.full_name, balance);

  return NextResponse.json({
    success: true,
    manager,
    currentPersonId: ownPersonId || null,
    selectedPersonId: personId,
    selectedPeriodId: "legacy",
    selectedPeriod: legacyPeriod,
    periodSupport: false,
    periodWarning: "Monthly periods are not active in the database yet. Showing all history.",
    team: teamRows,
    products: products.data ?? [],
    balances: balances.data ?? [],
    periods: [legacyPeriod],
    purchases: purchases.data ?? [],
    payments: payments.data ?? [],
    advances: advances.data ?? [],
    expenses: expenses.data ?? [],
    returns: returns.data ?? [],
    reimbursements: [],
    periodEvents: [],
  });
}

export async function POST(request: Request) {
  const { profile, supabase } = await context();
  if (!profile || !supabase) {
    return NextResponse.json({ success: false, error: "Session expired." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request." }, { status: 400 });
  }

  const action = clean(body.action);
  const manager = isOwnerAdminRole(profile);
  const requestedPersonId = clean(body.personId);
  const ownPersonId = clean(profile.team_member_id);
  const personId = manager ? requestedPersonId || ownPersonId : ownPersonId;
  const periodId = clean(body.periodId);

  if (action === "availability") {
    const productId = clean(body.productId);
    if (!productId) {
      return NextResponse.json({ success: false, error: "Product is required." }, { status: 400 });
    }
    try {
      const data = await getOperatorPurchaseAvailability(productId);
      return NextResponse.json({ success: true, data });
    } catch (error) {
      return NextResponse.json({ success: false, error: errorText(error) }, { status: 400 });
    }
  }

  if (!personId) {
    return NextResponse.json(
      { success: false, error: "Operator profile is not linked." },
      { status: 403 },
    );
  }

  const managerOnlyActions = new Set([
    "advance",
    "reviewExpense",
    "debtPayment",
    "advanceReturn",
    "reimbursement",
    "closePeriod",
    "settlePeriod",
    "reopenPeriod",
  ]);
  if (managerOnlyActions.has(action) && !manager) {
    return NextResponse.json(
      { success: false, error: "Only owner/admin can perform this action." },
      { status: 403 },
    );
  }

  if (!manager && requestedPersonId && requestedPersonId !== ownPersonId) {
    return NextResponse.json(
      { success: false, error: "You can only submit records for yourself." },
      { status: 403 },
    );
  }
  if (action === "expense" && personId !== ownPersonId) {
    return NextResponse.json(
      { success: false, error: "Work expenses must be submitted by the person who paid them." },
      { status: 403 },
    );
  }

  try {
    let result;

    if (action === "purchase") {
      result = await supabase.rpc("create_operator_personal_purchase", {
        p_person_id: personId,
        p_product_id: clean(body.productId),
        p_storage_location_id: clean(body.storageLocationId),
        p_quantity: Math.floor(amount(body.quantity)),
        // The database owns the canonical selling price. Never trust a browser-supplied price.
        p_unit_price_lyd: null,
        p_note: clean(body.note) || null,
        p_client_submission_id: submissionId(body.clientSubmissionId, "operator-purchase"),
      });
    } else if (action === "advance") {
      result = await supabase.rpc("create_operator_advance", {
        p_person_id: personId,
        p_amount: amount(body.amount),
        p_given_at: eventTimestamp(body.date),
        p_purpose: clean(body.purpose),
        p_note: clean(body.note) || null,
        p_client_submission_id: submissionId(body.clientSubmissionId, "operator-advance"),
      });
    } else if (action === "expense") {
      result = await supabase.rpc("submit_operator_expense", {
        p_person_id: ownPersonId,
        p_advance_id: clean(body.advanceId) || null,
        p_amount: amount(body.amount),
        p_expense_type: clean(body.expenseType),
        p_supplier_payee: clean(body.supplierPayee),
        p_spent_at: eventTimestamp(body.date),
        p_receipt_url: clean(body.receiptUrl) || null,
        p_note: clean(body.note),
        p_client_submission_id: submissionId(body.clientSubmissionId, "operator-expense"),
      });
    } else if (action === "reviewExpense") {
      result = await supabase.rpc("review_operator_expense", {
        p_expense_id: clean(body.expenseId),
        p_status: clean(body.status),
        p_review_note: clean(body.note) || null,
      });
    } else if (action === "debtPayment") {
      const common = {
        p_person_id: personId,
        p_amount: amount(body.amount),
        p_paid_at: eventTimestamp(body.date),
        p_payment_method: clean(body.paymentMethod),
        p_note: clean(body.note) || null,
        p_client_submission_id: submissionId(body.clientSubmissionId, "operator-debt-payment"),
      };
      result =
        periodId && periodId !== "legacy"
          ? await supabase.rpc("record_operator_debt_payment_for_period", {
              ...common,
              p_period_id: periodId,
            })
          : await supabase.rpc("record_operator_debt_payment", common);
    } else if (action === "advanceReturn") {
      const common = {
        p_person_id: personId,
        p_advance_id: clean(body.advanceId) || null,
        p_amount: amount(body.amount),
        p_returned_at: eventTimestamp(body.date),
        p_payment_method: clean(body.paymentMethod),
        p_note: clean(body.note) || null,
        p_client_submission_id: submissionId(body.clientSubmissionId, "operator-advance-return"),
      };
      result =
        periodId && periodId !== "legacy"
          ? await supabase.rpc("record_operator_advance_return_for_period", {
              ...common,
              p_period_id: periodId,
            })
          : await supabase.rpc("record_operator_advance_return", common);
    } else if (action === "reimbursement") {
      if (!periodId || periodId === "legacy") {
        return NextResponse.json(
          { success: false, error: "Monthly periods must be active before recording reimbursements." },
          { status: 409 },
        );
      }
      result = await supabase.rpc("record_operator_expense_reimbursement", {
        p_person_id: personId,
        p_period_id: periodId,
        p_amount: amount(body.amount),
        p_paid_at: eventTimestamp(body.date),
        p_payment_method: clean(body.paymentMethod),
        p_note: clean(body.note) || null,
        p_client_submission_id: submissionId(body.clientSubmissionId, "operator-reimbursement"),
      });
    } else if (action === "closePeriod") {
      if (!periodId || periodId === "legacy") {
        return NextResponse.json(
          { success: false, error: "Monthly periods are not active in the database yet." },
          { status: 409 },
        );
      }
      result = await supabase.rpc("close_operator_money_period", {
        p_period_id: periodId,
        p_note: clean(body.note) || null,
      });
    } else if (action === "settlePeriod") {
      if (!periodId || periodId === "legacy") {
        return NextResponse.json(
          { success: false, error: "Monthly periods are not active in the database yet." },
          { status: 409 },
        );
      }
      result = await supabase.rpc("settle_operator_money_period", {
        p_period_id: periodId,
        p_note: clean(body.note) || null,
      });
    } else if (action === "reopenPeriod") {
      if (!periodId || periodId === "legacy") {
        return NextResponse.json(
          { success: false, error: "Monthly periods are not active in the database yet." },
          { status: 409 },
        );
      }
      result = await supabase.rpc("reopen_operator_money_period", {
        p_period_id: periodId,
        p_reason: clean(body.note),
      });
    } else {
      return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
    }

    if (result.error) throw result.error;

    revalidatePath("/operator-money");
    revalidatePath("/team/" + personId);
    revalidatePath("/team/" + personId + "/money");
    revalidatePath("/inventory");
    revalidatePath("/inventory/movements");

    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    const text = errorText(error);
    const lower = text.toLowerCase();
    const status =
      lower.includes("authorized") ||
      lower.includes("only owner") ||
      lower.includes("only buy") ||
      lower.includes("only submit") ||
      lower.includes("can only")
        ? 403
        : lower.includes("closed") || lower.includes("settled") || lower.includes("exceeds")
          ? 409
          : 400;
    return NextResponse.json({ success: false, error: text }, { status });
  }
}
