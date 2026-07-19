"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { applyVisibleFinanceLedgerFilter, FINANCE_TRANSACTIONS_TABLE, loadFinanceLedgerRows } from "@/lib/finance-ledger";
import { calculateInvestorMonth, manualRouteSalesAsProfitRows, monthBounds } from "@/lib/investor-profit";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

function text(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}

function numberValue(formData: FormData, name: string, fallback = 0) {
  const parsed = Number(formData.get(name) ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(formData: FormData, name: string) {
  const value = text(formData, name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type InvestorVmsSummaryRow = {
  revenue_amount?: number | string | null;
  cogs_amount?: number | string | null;
  gross_profit_amount?: number | string | null;
  missing_cost_sales_count?: number | string | null;
};

function summaryRevenue(row: InvestorVmsSummaryRow | null | undefined) {
  const value = Number(row?.revenue_amount ?? 0);
  return Number.isFinite(value) ? value : 0;
}

async function loadInvestorVmsProfit(client: any, dateFrom: string, dateTo: string) {
  const monthly = await client.rpc("sales_dashboard_monthly_summary", {
    p_date_from: dateFrom,
    p_date_to: dateTo,
  });
  const monthlyRow = (monthly.data ?? [])[0] as InvestorVmsSummaryRow | undefined;
  if (!monthly.error && summaryRevenue(monthlyRow) > 0) {
    return { data: monthlyRow ? [{
      net_sales_amount: monthlyRow.revenue_amount,
      cogs_amount: monthlyRow.cogs_amount,
      gross_profit_amount: monthlyRow.gross_profit_amount,
      cost_missing: Number(monthlyRow.missing_cost_sales_count ?? 0) > 0,
      source: "vms",
    }] : [], error: null, source: "monthly_product_profit" };
  }

  const detailed = await client.rpc("sales_dashboard_summary", {
    p_date_from: dateFrom,
    p_date_to: dateTo,
  });
  const detailedRow = (detailed.data ?? [])[0] as InvestorVmsSummaryRow | undefined;
  if (!detailed.error && summaryRevenue(detailedRow) > 0) {
    return { data: detailedRow ? [{
      net_sales_amount: detailedRow.revenue_amount,
      cogs_amount: detailedRow.cogs_amount,
      gross_profit_amount: detailedRow.gross_profit_amount,
      cost_missing: Number(detailedRow.missing_cost_sales_count ?? 0) > 0,
      source: "vms",
    }] : [], error: null, source: "detailed_sales" };
  }
  if (!monthly.error) {
    return { data: monthlyRow ? [{
      net_sales_amount: monthlyRow.revenue_amount,
      cogs_amount: monthlyRow.cogs_amount,
      gross_profit_amount: monthlyRow.gross_profit_amount,
      cost_missing: Number(monthlyRow.missing_cost_sales_count ?? 0) > 0,
      source: "vms",
    }] : [], error: null, source: "monthly_product_profit" };
  }
  if (!detailed.error) {
    return { data: detailedRow ? [{
      net_sales_amount: detailedRow.revenue_amount,
      cogs_amount: detailedRow.cogs_amount,
      gross_profit_amount: detailedRow.gross_profit_amount,
      cost_missing: Number(detailedRow.missing_cost_sales_count ?? 0) > 0,
      source: "vms",
    }] : [], error: null, source: "detailed_sales" };
  }
  return { data: [], error: new Error(`Monthly VMS RPC: ${monthly.error?.message ?? "unknown error"}; detailed VMS RPC: ${detailed.error?.message ?? "unknown error"}`), source: null };
}

function investorsUrl(agreementId?: string | null, message?: { type: "success" | "error" | "warning"; text: string }) {
  const params = new URLSearchParams();
  if (agreementId) params.set("agreement", agreementId);
  if (message) params.set(message.type, message.text);
  const query = params.toString();
  return `/finance/investors${query ? `?${query}` : ""}`;
}

async function requireOwnerAdmin() {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect(investorsUrl(null, { type: "error", text: "Supabase is not configured." }));
  return { profile: profile!, supabase: supabase! };
}

export async function saveGrowthDecisionSettings(formData: FormData) {
  const { profile, supabase } = await requireOwnerAdmin();
  const payload = {
    singleton: true,
    machine_cost_lyd: Math.max(0, numberValue(formData, "machine_cost_lyd", 22000)),
    minimum_cash_reserve_lyd: Math.max(0, numberValue(formData, "minimum_cash_reserve_lyd", 15000)),
    restock_reserve_lyd: Math.max(0, numberValue(formData, "restock_reserve_lyd", 10000)),
    minimum_monthly_operating_profit_lyd: numberValue(formData, "minimum_monthly_operating_profit_lyd", 6000),
    target_payback_months: Math.max(1, numberValue(formData, "target_payback_months", 18)),
    minimum_history_months: Math.min(24, Math.max(1, Math.round(numberValue(formData, "minimum_history_months", 3)))),
    updated_by: profile.id,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("growth_decision_settings").upsert(payload, { onConflict: "singleton" });
  if (error) redirect(`/finance/growth-decisions?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/finance/growth-decisions");
  redirect("/finance/growth-decisions?success=Decision%20rules%20saved.");
}

export async function createInvestorAgreement(formData: FormData) {
  const { profile, supabase } = await requireOwnerAdmin();
  const investorUserId = text(formData, "investor_user_id");
  const investorName = text(formData, "investor_name");
  const startDate = text(formData, "start_date");
  if (!investorUserId || !investorName || !startDate) {
    redirect(investorsUrl(null, { type: "error", text: "Investor login, name, and start date are required." }));
  }

  const { data: investorProfile, error: investorProfileError } = await supabase
    .from("profiles")
    .select("id, role, roles, active_status")
    .eq("id", investorUserId)
    .maybeSingle();
  const profileRoles = Array.isArray(investorProfile?.roles) ? investorProfile.roles.map(String) : [];
  if (investorProfileError || !investorProfile || (String(investorProfile.role) !== "investor" && !profileRoles.includes("investor"))) {
    redirect(investorsUrl(null, { type: "error", text: "Create an active Team login with the Investor role first." }));
  }

  const endDate = text(formData, "end_date") || null;
  const { data, error } = await supabase
    .from("investor_agreements")
    .insert({
      investor_user_id: investorUserId,
      investor_name: investorName,
      investment_amount_lyd: Math.max(0, numberValue(formData, "investment_amount_lyd", 0)),
      profit_share_percent: Math.min(100, Math.max(0, numberValue(formData, "profit_share_percent", 30))),
      profit_basis: "operating_profit",
      start_date: startDate,
      end_date: endDate,
      payout_cap_lyd: optionalNumber(formData, "payout_cap_lyd"),
      status: text(formData, "status") || "active",
      notes: text(formData, "notes") || null,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error || !data?.id) redirect(investorsUrl(null, { type: "error", text: error?.message ?? "Could not create investor agreement." }));
  revalidatePath("/finance/investors");
  revalidatePath("/investor");
  redirect(investorsUrl(data.id, { type: "success", text: "Investor agreement created." }));
}

export async function generateInvestorStatement(formData: FormData) {
  const { profile, supabase } = await requireOwnerAdmin();
  const agreementId = text(formData, "agreement_id");
  const month = text(formData, "month");
  const bounds = monthBounds(month);
  if (!agreementId || !bounds) redirect(investorsUrl(agreementId, { type: "error", text: "Choose a valid agreement and month." }));

  const { data: agreement, error: agreementError } = await supabase
    .from("investor_agreements")
    .select("id, profit_share_percent, payout_cap_lyd, start_date, end_date, status")
    .eq("id", agreementId)
    .maybeSingle();
  if (agreementError || !agreement) redirect(investorsUrl(agreementId, { type: "error", text: "Investor agreement was not found." }));
  if (bounds.start < agreement.start_date || (agreement.end_date && bounds.start > agreement.end_date)) {
    redirect(investorsUrl(agreementId, { type: "error", text: "The selected month is outside the agreement period." }));
  }

  const { data: existing } = await supabase
    .from("investor_monthly_statements")
    .select("id, calculation_status")
    .eq("agreement_id", agreementId)
    .eq("month_start", bounds.start)
    .maybeSingle();
  if (existing?.calculation_status === "finalized") {
    redirect(investorsUrl(agreementId, { type: "error", text: "This month is finalized and cannot be recalculated." }));
  }

  const operationalReadClient = getSupabaseAdminClient() ?? supabase;
  const [salesResult, manualSalesResult, ledgerResult, priorStatementsResult] = await Promise.all([
    loadInvestorVmsProfit(supabase, bounds.start, bounds.end),
    operationalReadClient
      .from("route_manual_sales")
      .select("id, machine_id, total_amount_lyd, inventory_movement_id, sale_time, status")
      .eq("status", "confirmed")
      .gte("sale_time", `${bounds.start}T00:00:00.000Z`)
      .lte("sale_time", `${bounds.end}T23:59:59.999Z`),
    loadFinanceLedgerRows({
      label: `investor-statement.${bounds.start}`,
      buildQuery: (columns, level) => {
        let query = supabase
          .from(FINANCE_TRANSACTIONS_TABLE)
          .select(columns.join(","))
          .gte("transaction_date", bounds.start)
          .lte("transaction_date", bounds.end);
        query = applyVisibleFinanceLedgerFilter(query, level);
        return query;
      },
    }),
    supabase
      .from("investor_monthly_statements")
      .select("investor_share_due_lyd")
      .eq("agreement_id", agreementId)
      .neq("month_start", bounds.start)
      .eq("calculation_status", "finalized"),
  ]);

  if (salesResult.error) redirect(investorsUrl(agreementId, { type: "error", text: `VMS sales could not load: ${salesResult.error instanceof Error ? salesResult.error.message : "Unknown VMS RPC error"}` }));
  if (manualSalesResult.error) redirect(investorsUrl(agreementId, { type: "error", text: `Manual route sales could not load: ${manualSalesResult.error.message}` }));
  if (ledgerResult.error) redirect(investorsUrl(agreementId, { type: "error", text: "Finance expenses could not load for this month." }));

  const manualSales = manualSalesResult.data ?? [];
  const movementIds = Array.from(new Set(manualSales.map((sale) => String(sale.inventory_movement_id ?? "").trim()).filter(Boolean)));
  const movementResult = movementIds.length
    ? await operationalReadClient.from("inventory_movements").select("id, line_total_lyd, unit_cost_lyd").in("id", movementIds)
    : { data: [], error: null };
  if (movementResult.error) redirect(investorsUrl(agreementId, { type: "error", text: `Manual-sale product costs could not load: ${movementResult.error.message}` }));

  const manualProfitRows = manualRouteSalesAsProfitRows(manualSales, movementResult.data ?? []);
  const calculation = calculateInvestorMonth({
    salesRows: [
      ...(salesResult.data ?? []).map((row) => ({ ...row, source: "vms" })),
      ...manualProfitRows,
    ],
    ledgerRows: ledgerResult.data,
    sharePercent: Number(agreement.profit_share_percent ?? 30),
  });
  const paidOrDueBefore = (priorStatementsResult.data ?? []).reduce((sum, row) => sum + Number(row.investor_share_due_lyd ?? 0), 0);
  const cap = agreement.payout_cap_lyd === null || agreement.payout_cap_lyd === undefined ? null : Number(agreement.payout_cap_lyd);
  const remainingCap = cap === null ? null : Math.max(0, cap - paidOrDueBefore);
  const investorDue = remainingCap === null ? calculation.investorShareDueLyd : Math.min(calculation.investorShareDueLyd, remainingCap);
  const sourceNote = [
    `period ${bounds.start} to ${bounds.end}`,
    `VMS source: ${salesResult.source ?? "unavailable"}`,
    `VMS rows: ${salesResult.data?.length ?? 0}`,
    `VMS revenue: ${calculation.vmsRevenueLyd}`,
    `manual sale rows: ${manualSales.length}`,
    `manual sales revenue: ${calculation.manualSalesRevenueLyd}`,
    `manual sales COGS: ${calculation.manualSalesCogsLyd}`,
    `missing cost rows: ${calculation.missingCostRows}`,
    `complete=${calculation.complete}`,
    ledgerResult.warning ?? "finance ledger full contract",
  ].join("; ");

  const { error: saveError } = await supabase.from("investor_monthly_statements").upsert({
    id: existing?.id,
    agreement_id: agreementId,
    month_start: bounds.start,
    revenue_lyd: calculation.revenueLyd,
    cogs_lyd: calculation.cogsLyd,
    gross_profit_lyd: calculation.grossProfitLyd,
    operating_expenses_lyd: calculation.operatingExpensesLyd,
    operating_profit_lyd: calculation.operatingProfitLyd,
    share_percent: calculation.sharePercent,
    investor_share_due_lyd: investorDue,
    calculation_status: "draft",
    data_source_note: sourceNote,
    generated_by: profile.id,
    generated_at: new Date().toISOString(),
    finalized_at: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "agreement_id,month_start" });
  if (saveError) redirect(investorsUrl(agreementId, { type: "error", text: saveError.message }));

  revalidatePath("/finance/investors");
  revalidatePath("/investor");
  redirect(investorsUrl(agreementId, {
    type: calculation.complete ? "success" : "warning",
    text: calculation.complete ? "Monthly statement calculated as a draft, including confirmed manual route sales." : "Draft calculated, but missing VMS or manual-sale product costs must be fixed before finalizing.",
  }));
}

export async function finalizeInvestorStatement(formData: FormData) {
  const { supabase } = await requireOwnerAdmin();
  const agreementId = text(formData, "agreement_id");
  const statementId = text(formData, "statement_id");
  const { data: statement, error } = await supabase
    .from("investor_monthly_statements")
    .select("id, month_start, calculation_status, data_source_note")
    .eq("id", statementId)
    .eq("agreement_id", agreementId)
    .maybeSingle();
  if (error || !statement) redirect(investorsUrl(agreementId, { type: "error", text: "Statement was not found." }));
  if (statement.calculation_status === "finalized") redirect(investorsUrl(agreementId, { type: "success", text: "Statement is already finalized." }));
  if (!String(statement.data_source_note ?? "").includes("complete=true")) {
    redirect(investorsUrl(agreementId, { type: "error", text: "Fix missing product costs and regenerate the statement before finalizing." }));
  }
  const bounds = monthBounds(String(statement.month_start).slice(0, 7));
  const today = new Date().toISOString().slice(0, 10);
  if (!bounds || bounds.end >= today) redirect(investorsUrl(agreementId, { type: "error", text: "Only a completed month can be finalized." }));

  const { error: updateError } = await supabase
    .from("investor_monthly_statements")
    .update({ calculation_status: "finalized", finalized_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", statementId)
    .eq("calculation_status", "draft");
  if (updateError) redirect(investorsUrl(agreementId, { type: "error", text: updateError.message }));
  revalidatePath("/finance/investors");
  revalidatePath("/investor");
  redirect(investorsUrl(agreementId, { type: "success", text: "Monthly statement finalized and visible to the investor." }));
}

export async function recordInvestorPayment(formData: FormData) {
  const { profile, supabase } = await requireOwnerAdmin();
  const agreementId = text(formData, "agreement_id");
  const statementId = text(formData, "statement_id");
  const amount = Math.max(0, numberValue(formData, "amount_lyd", 0));
  const paymentDate = text(formData, "payment_date") || new Date().toISOString().slice(0, 10);
  if (!agreementId || !statementId || amount <= 0) redirect(investorsUrl(agreementId, { type: "error", text: "Statement and positive payment amount are required." }));

  const [{ data: statement }, { data: priorPayments }] = await Promise.all([
    supabase
      .from("investor_monthly_statements")
      .select("id, month_start, investor_share_due_lyd, calculation_status, agreement_id")
      .eq("id", statementId)
      .eq("agreement_id", agreementId)
      .maybeSingle(),
    supabase.from("investor_payments").select("amount_lyd").eq("statement_id", statementId),
  ]);
  if (!statement || statement.calculation_status !== "finalized") redirect(investorsUrl(agreementId, { type: "error", text: "Only finalized monthly statements can be paid." }));
  const alreadyPaid = (priorPayments ?? []).reduce((sum, row) => sum + Number(row.amount_lyd ?? 0), 0);
  const remaining = Math.max(0, Number(statement.investor_share_due_lyd ?? 0) - alreadyPaid);
  if (amount > remaining + 0.005) redirect(investorsUrl(agreementId, { type: "error", text: `Payment exceeds the remaining ${remaining.toFixed(2)} LYD due.` }));

  const { data: payment, error: paymentError } = await supabase
    .from("investor_payments")
    .insert({
      agreement_id: agreementId,
      statement_id: statementId,
      payment_date: paymentDate,
      amount_lyd: amount,
      payment_reference: text(formData, "payment_reference") || null,
      notes: text(formData, "notes") || null,
      finance_posting_status: "pending",
      recorded_by: profile.id,
    })
    .select("id")
    .single();
  if (paymentError || !payment?.id) redirect(investorsUrl(agreementId, { type: "error", text: paymentError?.message ?? "Could not save investor payment." }));

  const transactionPayload = {
    transaction_date: paymentDate,
    transaction_datetime: `${paymentDate}T12:00:00.000Z`,
    direction: "money_out",
    transaction_kind: "investor_distribution",
    transaction_type: "Investor Profit Share",
    description: `Investor profit share for ${String(statement.month_start).slice(0, 7)}`,
    notes: text(formData, "notes") || null,
    amount,
    signed_amount: -amount,
    currency: "LYD",
    account_id: "snacky_lyd",
    transaction_effect: "expense",
    category: "Investor Profit Share",
    final_bucket: "Investor Profit Share",
    payment_method: text(formData, "payment_method") || "cash",
    source_type: "investor_payment",
    source_id: payment.id,
    transaction_status: "active",
    import_status: "imported",
    needs_review: false,
    created_by: profile.id,
  };

  const { data: financeTransaction, error: financeError } = await supabase
    .from(FINANCE_TRANSACTIONS_TABLE)
    .insert(transactionPayload)
    .select("id")
    .single();
  await supabase
    .from("investor_payments")
    .update(financeError || !financeTransaction?.id
      ? { finance_posting_status: "needs_review", finance_posting_error: financeError?.message ?? "Finance transaction ID was not returned." }
      : { finance_posting_status: "posted", finance_transaction_id: financeTransaction.id, finance_posting_error: null })
    .eq("id", payment.id);

  revalidatePath("/finance/investors");
  revalidatePath("/finance");
  revalidatePath("/finance/operations");
  revalidatePath("/investor");
  redirect(investorsUrl(agreementId, financeError
    ? { type: "warning", text: "Payment was recorded, but its Finance ledger posting needs review." }
    : { type: "success", text: "Investor payment recorded and posted to Finance." }));
}
