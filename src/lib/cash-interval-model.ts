/** Pure rules for read-only XY comparisons. Not a cash settlement/posting API. */
export type PaymentTender = 'cash' | 'card' | 'unknown';
export function classifyPaymentTender(value: unknown): PaymentTender {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  const text = value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const cashless = /\bcash\s*less\b/.test(text);
  const withoutCashless = text.replace(/\bcash\s*less\b/g, '');
  const cash = /\b(cash|coins?|bank\s*notes?|notes)\b/.test(withoutCashless)
    || /^(نقد|نقدي|نقداً|كاش)$/.test(text);
  const card = cashless || /\b(card|credit|debit|visa|mastercard|master|pos|electronic|online|wallet|alipay|wechat|apple\s*pay|google\s*pay|qr|scan)\b/.test(text)
    || /^(بطاقة|إلكتروني|الكتروني)$/.test(text);
  // Mixed/contradictory tender labels are not evidence of cash in the box.
  if (cash && card) return 'unknown';
  return cash ? 'cash' : card ? 'card' : 'unknown';
}
export function xyTransactionIdentity(row: {
  id: string; machine_code?: string | null; order_number?: string | null;
  third_party_transaction_number?: string | null; duplicate_hash?: string | null;
}): string {
  const clean = (v: unknown) => typeof v === 'string' ? v.trim() : '';
  const machine = clean(row.machine_code);
  const thirdParty = clean(row.third_party_transaction_number);
  const order = clean(row.order_number);
  const hash = clean(row.duplicate_hash);
  if (thirdParty) return JSON.stringify(['third-party', machine, thirdParty]);
  if (order) return JSON.stringify(['order', machine, order]);
  if (hash) return JSON.stringify(['hash', machine, hash]);
  // A machine code alone is NOT an order identity: keep distinct sales.
  return JSON.stringify(['row', row.id]);
}
export function cashAmountCents(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d{1,6})?$/.test(value.trim())) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const cents = Math.round((amount + Number.EPSILON) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
export function withinCashInterval(time: string, start: string, end: string): boolean {
  const at = Date.parse(time), from = Date.parse(start), to = Date.parse(end);
  return [at, from, to].every(Number.isFinite) && from < to && at > from && at <= to;
}
export function tripoliHourKey(value: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:00`;
}
