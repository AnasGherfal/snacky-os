export function resolveCashCollectionTransactionDateTime(cash: {
  collection_datetime?: string | null;
  collected_at?: string | null;
  counted_at?: string | null;
}) {
  const raw = cash.collection_datetime ?? cash.collected_at ?? cash.counted_at ?? new Date().toISOString();
  const parsed = new Date(raw);
  const transactionDatetime = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  return {
    transactionDatetime,
    transactionDate: transactionDatetime.slice(0, 10),
  };
}
