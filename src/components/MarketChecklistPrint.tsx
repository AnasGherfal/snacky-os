import type {BuyingList} from '@/lib/buying-lists';
import {marketTotals} from '@/lib/market-checklist';
import {marketFlexibilityLabel, marketUnitLabel} from '@/lib/market-checklist-labels';
import styles from './BuyingLists.module.css';

export function MarketChecklistPrint({list,ar}:{list:BuyingList;ar:boolean}) {
 const items=list.checklist_items??[],totals=marketTotals(items);
 return <article data-buying-print className={styles.printSheet}>
  <header className={styles.printHeader}><div className={styles.wordmark}>Snacky<br/><span lang="ar">سناكي</span></div><div><h1>{ar?'قائمة التسوق':'Shopping checklist'}</h1><p>{list.title}</p><small>{list.id.slice(0,8).toUpperCase()} · v{list.revision} · {list.status==='cancelled'?(ar?'ملغاة — لا تشترِ منها':'CANCELLED — DO NOT BUY'):list.status==='completed'?(ar?'انتهت المراجعة':'REVIEW FINISHED'):(ar?'قيد التنفيذ':'IN PROGRESS')}</small></div></header>
  <dl className={styles.printMeta}><div><dt>{ar?'المشتري':'Buyer'}</dt><dd>{list.buyer_name}</dd></div><div><dt>{ar?'الموعد':'Due'}</dt><dd><bdi>{list.due_on}</bdi></dd></div><div><dt>{ar?'أعدّها':'Prepared by'}</dt><dd>{list.creator_name}</dd></div><div><dt>{ar?'آخر تحديث':'Updated'}</dt><dd><bdi>{list.updated_at.slice(0,10)}</bdi></dd></div></dl>
  {list.instructions?<p style={{whiteSpace:'pre-wrap'}}>{list.instructions}</p>:null}
  <p><b>{totals.remaining} {ar?'متبقٍ للشراء':'left to get'} · {totals.got}/{totals.total} {ar?'حصلت عليه':'needs acquired'}</b>{totals.unavailable?` · ${totals.unavailable} ${ar?'غير متوفر':'not found'}`:''}</p>
  <table className={styles.table}><thead><tr><th>{ar?'الحاجة للشراء':'Shopping need'}</th><th>{ar?'الكمية':'Quantity'}</th><th>{ar?'المتبقي':'Remaining'}</th><th>{ar?'النتيجة':'Result'}</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><td><strong>{item.label}</strong><small>{marketFlexibilityLabel(item.flexibility,ar)}</small>{item.note?<small style={{whiteSpace:'pre-wrap'}}>{item.note}</small>:null}</td><td>{item.acquired_quantity} / {item.quantity} {marketUnitLabel(item.unit,ar)}</td><td>{item.quantity-item.acquired_quantity} {marketUnitLabel(item.unit,ar)}</td><td>{item.acquired_quantity===item.quantity?(ar?'حصلت عليه':'Got it'):item.unavailable?(ar?'غير متوفر — ما زال مطلوباً':'Not found — still needed'):item.acquired_quantity>0?(ar?'حصلت على جزء':'Partly acquired'):(ar?'مطلوب':'Needed')}</td></tr>)}</tbody></table>
  <footer className={styles.printFooter}>{ar?'هذه قائمة حاجات للشراء وليست إيصالاً. سجّل الأصناف والنكهات والكميات والأسعار الفعلية في الإيصال. تبقى العناصر غير المتوفرة ضمن المتبقي. النسخة المطبوعة ثابتة؛ راجع آخر نسخة في سناكي.':'This records shopping needs, not a receipt. Record the actual products, flavours, quantities and prices on the receipt. Unavailable needs remain outstanding. Printed copies are snapshots; check the latest version in Snacky OS.'}<span className={styles.printReference} dir="ltr">/buying-lists/{list.id}</span></footer>
 </article>;
}
