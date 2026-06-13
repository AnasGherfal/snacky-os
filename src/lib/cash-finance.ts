export function resolveCashCollectionTransactionDateTime(cash: {
  collection_datetime?: string | null;
  collection_date?: string | null;
  collected_at?: string | null;
  counted_at?: string | null;
}) {
  const raw = cash.collection_datetime ?? cash.collected_at ?? cash.counted_at ?? (cash.collection_date ? `${cash.collection_date}T12:00:00.000Z` : new Date().toISOString());
  const parsed = new Date(raw);
  const transactionDatetime = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  return {
    transactionDatetime,
    transactionDate: cash.collection_date ?? transactionDatetime.slice(0, 10),
  };
}

export function buildCashCollectionDescription(cash: {
  id: string;
  cash_bag_id?: string | null;
  machine_name?: string | null;
  machine_code?: string | null;
  location_name?: string | null;
  location?: string | null;
}) {
  const machine = String(cash.machine_name ?? cash.machine_code ?? "").trim();
  const location = String(cash.location_name ?? cash.location ?? "").trim();
  const place = [machine, location].filter(Boolean).join(" / ");
  const base = place ? `Cash collection from ${place}` : `Cash collection ${cash.id.slice(0, 8)}`;
  const bag = String(cash.cash_bag_id ?? "").trim();
  return bag ? `${base} - Bag ${bag}` : base;
}

export function buildCashCollectionFinanceTransactionPayload({
  cash,
  amount,
  createdBy,
}: {
  cash: {
    id: string;
    route_id?: string | null;
    machine_id?: string | null;
    operator_id?: string | null;
    actual_cash_collected?: number | string | null;
    counted_amount_lyd?: number | string | null;
    cash_bag_id?: string | null;
    collection_datetime?: string | null;
    collection_date?: string | null;
    collected_at?: string | null;
    counted_at?: string | null;
    currency?: string | null;
    account_key?: string | null;
    account_id?: string | null;
    machine_name?: string | null;
    machine_code?: string | null;
    location_name?: string | null;
    location?: string | null;
  };
  amount: number;
  createdBy?: string | null;
}) {
  const dateTime = resolveCashCollectionTransactionDateTime(cash);
  const cashId = cash.id;
  const accountKey = String(cash.account_key ?? cash.account_id ?? "snacky_lyd").trim() || "snacky_lyd";
  const currency = String(cash.currency ?? "LYD").trim().toUpperCase() === "USD" ? "USD" : "LYD";
  const description = buildCashCollectionDescription(cash);
  const location = String(cash.location_name ?? cash.location ?? cash.machine_name ?? cash.machine_code ?? "").trim() || null;

  return {
    transaction_date: dateTime.transactionDate,
    transaction_datetime: dateTime.transactionDatetime,
    direction: "money_in",
    transaction_kind: "cash_collection",
    transaction_type: "Revenue",
    category: "Revenue",
    description,
    notes: description,
    amount: Math.abs(amount),
    signed_amount: Math.abs(amount),
    currency,
    account_id: accountKey,
    account_key: accountKey,
    transaction_effect: "income",
    source_account_id: null,
    destination_account_id: null,
    bucket: "Revenue",
    final_bucket: "Revenue",
    import_status: "confirmed",
    review_status: "confirmed",
    needs_review: false,
    transaction_status: "active",
    is_void: false,
    voided_at: null,
    void_reason: null,
    payment_method: "cash",
    payer_text: "Cash customers",
    payee_text: null,
    paid_to_text: null,
    counterparty_text: "Cash customers",
    linked_cash_collection_id: cashId,
    related_cash_collection_id: cashId,
    related_route_id: cash.route_id ?? null,
    related_machine_id: cash.machine_id ?? null,
    location,
    source_type: "cash_collection",
    source_id: cashId,
    created_by: createdBy ?? cash.operator_id ?? null,
    updated_at: new Date().toISOString(),
  };
}
