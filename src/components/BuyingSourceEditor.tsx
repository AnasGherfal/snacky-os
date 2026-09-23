'use client';
import { useState, type FormEvent } from 'react';
import type { BuyingItem } from '@/lib/buying-lists';
import { sourcePriceText, type BuyingSource, type BuyingSources } from '@/lib/buying-sources';
import styles from './BuyingLists.module.css';

export function BuyingSourceDetails({ source, item, ar }: { source: BuyingSource; item: BuyingItem; ar: boolean }) {
  return <div className={styles.sourceDetails}>
    <strong>{ar ? 'الشراء من: ' : 'Buy from: '}{source.primary.name}</strong>
    <p>{sourcePriceText(source.primary, item.units_per_box, ar)}</p>
    {source.primary.phone ? <p><bdi>{source.primary.phone}</bdi></p> : null}
    {source.alternative ? <><strong>{ar ? 'البديل عند عدم التوفر: ' : 'Alternative when unavailable: '}{source.alternative.name}</strong>
      <p>{sourcePriceText(source.alternative, item.units_per_box, ar)}</p></> : null}
    {source.note ? <p className={styles.sourceNote}>{source.note}</p> : null}
    <small>{ar ? 'سعر شراء سابق، وليس عرضاً حالياً. تكلفة الصندوق محسوبة من سعر الوحدة وحجم الصندوق في هذه القائمة.' : 'Previous purchase price, not a current quote. Box cost is calculated from the unit price and this list’s box size.'}</small>
  </div>;
}
export function BuyingSourceEditor({ item, source, sources, ar, disabled, save }: {
  item: BuyingItem; source?: BuyingSource; sources: BuyingSources; ar: boolean; disabled: boolean;
  save: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [primary, setPrimary] = useState(source?.primary.supplier_id ?? '');
  const [alternative, setAlternative] = useState(source?.alternative?.supplier_id ?? '');
  const [note, setNote] = useState(source?.note ?? '');
  const prices = sources.options.find(i => i.product_id === item.product_id)?.prices ?? [];
  const price = prices.find(p => p.supplier_id === primary);
  async function submit(event: FormEvent) {
    event.preventDefault();
    await save({ product_id: item.product_id, primary_supplier_id: primary, alternative_supplier_id: alternative || null, note });
  }
  return <details className={styles.sourceEditor}>
    <summary>{ar ? (source ? 'تعديل تعليمات المورد' : 'تحديد المورد والسعر المرجعي') : (source ? 'Edit store instructions' : 'Choose store & price reference')}</summary>
    <form onSubmit={submit}>
      <fieldset disabled={disabled} className={styles.fields}>
        <label>{ar ? 'المورد المطلوب' : 'Required store'}<select required value={primary} onChange={e => { setPrimary(e.target.value); if (alternative === e.target.value) setAlternative(''); }}>
          <option value="">{ar ? 'اختر المورد' : 'Choose store'}</option>
          {sources.stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>
        <label>{ar ? 'مورد بديل اختياري' : 'Alternative store (optional)'}<select value={alternative} onChange={e => setAlternative(e.target.value)}>
          <option value="">{ar ? 'بدون بديل — يرجع للإدارة' : 'No alternative — contact management'}</option>
          {sources.stores.filter(s => s.id !== primary).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>
        {primary ? <p className={`${styles.hint} ${styles.wide}`}>{sourcePriceText(price, item.units_per_box, ar)}</p> : null}
        <label className={styles.wide}>{ar ? 'المحل أو الفرع بالتحديد وتعليمات الشراء' : 'Exact shop / branch and buying instructions'}
          <textarea rows={2} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} placeholder={ar ? 'العنوان، الفرع، أو ما يجب فعله عند تغير السعر' : 'Address, branch, or what to do if the price changes'} />
        </label>
      </fieldset>
      <p className={styles.hint}>{ar ? 'يُحفظ السعر المرجعي من سجل الشراء عند التأكيد. لا تتغير تعليمات منتج تم تسجيل نتيجته.' : 'The price reference is saved from purchase history at confirmation. Instructions cannot change after an item result is recorded.'}</p>
      <button type="submit" className={styles.primary} disabled={disabled || !primary}>{ar ? 'حفظ تعليمات المورد' : 'Save store instructions'}</button>
    </form>
  </details>;
}
