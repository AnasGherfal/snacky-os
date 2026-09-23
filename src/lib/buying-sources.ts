import type { BuyingItem } from './buying-lists';

export type StorePrice = {
  supplier_id: string;
  name: string;
  phone: string | null;
  unit_cost_lyd: number | null;
  purchased_on: string | null;
  purchase_line_id: string | null;
  historical_units_per_box: number | null;
};
export type BuyingSource = {
  product_id: string;
  primary: StorePrice;
  alternative: StorePrice | null;
  note: string;
  saved_at: string;
};
export type BuyingSources = {
  list_id: string;
  revision: number;
  can_edit: boolean;
  sources: BuyingSource[];
  stores: { id: string; name: string }[];
  options: { product_id: string; prices: StorePrice[] }[];
};
export type BuyingSourceCommand = {
  request_id: string;
  list_id: string;
  product_id: string;
  revision: number;
  primary_supplier_id: string;
  alternative_supplier_id: string | null;
  note: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields = ['request_id', 'list_id', 'product_id', 'revision', 'primary_supplier_id', 'alternative_supplier_id', 'note'];
export function validateBuyingSourceCommand(value: unknown): BuyingSourceCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid');
  const c = value as Record<string, unknown>;
  if (Object.keys(c).length !== fields.length || Object.keys(c).some(k => !fields.includes(k))) throw Error('invalid');
  for (const key of ['request_id', 'list_id', 'product_id', 'primary_supplier_id']) {
    if (typeof c[key] !== 'string' || !uuid.test(c[key])) throw Error('invalid');
  }
  if (c.alternative_supplier_id !== null && (typeof c.alternative_supplier_id !== 'string' || !uuid.test(c.alternative_supplier_id))) throw Error('invalid');
  if (String(c.primary_supplier_id).toLowerCase() === String(c.alternative_supplier_id).toLowerCase()) throw Error('invalid');
  if (!Number.isSafeInteger(c.revision) || Number(c.revision) < 1 || Number(c.revision) >= 2147483647) throw Error('invalid');
  if (typeof c.note !== 'string' || c.note.length > 1000) throw Error('invalid');
  return c as BuyingSourceCommand;
}
export function sourceReceiptMatches(command: BuyingSourceCommand, response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const r = response as Record<string, unknown>;
  return r.ok === true && r.request_id === command.request_id && r.list_id === command.list_id
    && r.product_id === command.product_id && r.revision === command.revision + 1;
}
/** Once at least one store is selected, never mix another store's old product cost into the estimate. */
export function sourceAwareItems(items: BuyingItem[], sources: BuyingSources | null): BuyingItem[] {
  if (!sources?.sources.length) return items;
  const map = new Map(sources.sources.map(s => [s.product_id, s]));
  return items.map(item => {
    const source = map.get(item.product_id);
    return { ...item, supplier: source?.primary.name ?? null, unit_cost: source?.primary.unit_cost_lyd ?? null };
  });
}
export function buyingStoreGroups(items: BuyingItem[], sources: BuyingSources | null) {
  const map = new Map(sources?.sources.map(s => [s.product_id, s]) ?? []);
  const groups = new Map<string, { id: string; name: string | null; items: BuyingItem[] }>();
  for (const item of items) {
    const source = map.get(item.product_id), id = source?.primary.supplier_id ?? 'unassigned';
    if (!groups.has(id)) groups.set(id, { id, name: source?.primary.name ?? null, items: [] });
    groups.get(id)!.items.push(item);
  }
  // Stable first-appearance order preserves the owner's product sequence; unresolved stores stay visible first.
  return [...groups.values()].sort((a, b) => a.id === 'unassigned' ? -1 : b.id === 'unassigned' ? 1 : 0);
}
export function sourcePriceText(price: StorePrice | null | undefined, unitsPerBox: number, ar: boolean): string {
  if (!price || price.unit_cost_lyd === null) return ar ? 'لا يوجد سعر شراء سابق موثّق لهذا المورد' : 'No recorded previous purchase price for this store';
  const unit = Number(price.unit_cost_lyd);
  if (!Number.isFinite(unit) || unit <= 0) return ar ? 'السعر غير متوفر' : 'Price unavailable';
  return ar
    ? `${(unit * unitsPerBox).toFixed(2)} د.ل للصندوق (${unitsPerBox} وحدة) · ${unit.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} د.ل للوحدة · ${price.purchased_on ?? '—'}`
    : `${(unit * unitsPerBox).toFixed(2)} LYD / box (${unitsPerBox} units) · ${unit.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} LYD / unit · ${price.purchased_on ?? '—'}`;
}
