type DateLike = string | Date | null | undefined;

export type PurchaseFinanceDateSource = {
  payment_date?: DateLike;
  paid_at?: DateLike;
  order_date?: DateLike;
  purchase_date?: DateLike;
  received_date?: DateLike;
};

export function dateOnly(value: unknown) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }

  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const directDate = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directDate?.[1]) return directDate[1];

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function resolvePurchaseFinanceTransactionDate(purchase: PurchaseFinanceDateSource | null | undefined, fallbackDate = new Date().toISOString().slice(0, 10)) {
  const source = purchase ?? {};
  return (
    dateOnly(source.payment_date) ??
    dateOnly(source.paid_at) ??
    dateOnly(source.order_date) ??
    dateOnly(source.purchase_date) ??
    dateOnly(source.received_date) ??
    dateOnly(fallbackDate) ??
    new Date().toISOString().slice(0, 10)
  );
}
