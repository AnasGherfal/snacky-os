import {unstable_rethrow} from 'next/navigation';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {buyingWorkspace} from '@/lib/buying-server';
import {buyingUuid,buyingTotals} from '@/lib/buying-lists';
import {getServerI18n} from '@/lib/i18n/server';
import {BuyingPrintButton} from '@/components/BuyingListClient';
import {BuyingListTable} from '@/components/BuyingListTable';
import styles from '@/components/BuyingLists.module.css';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{id:string}>}){
 const {id}=await params;if(!buyingUuid.test(id))notFound();const {locale}=await getServerI18n(),ar=locale==='ar';
 let view;try{view=await buyingWorkspace(id);}catch(error){unstable_rethrow(error);return <p role="alert">{ar?'تعذر التحقق من القائمة. لم يتم إنشاء نسخة للطباعة.':'Could not verify this list. No printable copy was created.'}</p>;}
 const list=view.data.record;if(!list)notFound();const totals=buyingTotals(list.items);
 return <div className={styles.workspace} dir={ar?'rtl':'ltr'}>
  <div className={styles.actions}><BuyingPrintButton ar={ar}/><Link className={styles.secondary} href={`/buying-lists/${id}`}>{ar?'العودة للقائمة':'Back to checklist'}</Link><span>{ar?'في نافذة الطباعة اختر حفظ PDF.':'Choose Save as PDF in the print dialog.'}</span></div>
  <article data-buying-print className={styles.printSheet}>
   <header className={styles.printHeader}><div className={styles.wordmark}>Snacky<br/><span lang="ar">سناكي</span></div><div><h1>{ar?'قائمة شراء المنتجات':'Product buying checklist'}</h1><p>{list.title}</p><small>{id.slice(0,8).toUpperCase()} · v{list.revision} · {list.status==='cancelled'?(ar?'ملغاة — لا تشترِ منها':'CANCELLED — DO NOT BUY'):list.status==='completed'?(ar?'مراجعة مكتملة':'CHECKED'):(ar?'قيد التنفيذ':'IN PROGRESS')}</small></div></header>
   <dl className={styles.printMeta}><div><dt>{ar?'المشتري':'Buyer'}</dt><dd>{list.buyer_name}</dd></div><div><dt>{ar?'الموعد':'Due'}</dt><dd><bdi>{list.due_on}</bdi></dd></div><div><dt>{ar?'أعدّها':'Prepared by'}</dt><dd>{list.creator_name}</dd></div><div><dt>{ar?'آخر تحديث':'Updated'}</dt><dd><bdi>{list.updated_at.slice(0,10)}</bdi></dd></div></dl>
   {list.instructions?<p style={{whiteSpace:'pre-wrap'}}>{list.instructions}</p>:null}
   <BuyingListTable items={list.items} ar={ar} print/>
   <p><b>{totals.boxes} {ar?'صندوق':'boxes'} · {totals.units} {ar?'وحدة':'units'}</b> — {ar?'التكلفة التقديرية':'Estimated total'}: {totals.missing===list.items.length?'—':totals.estimate.toFixed(2)} LYD{totals.missing?` (${ar?'غير مكتملة':'incomplete'})`:''}</p>
   <p className={styles.hint}>{ar?'الموردون والأسعار إرشادية. افحص المنتج والتاريخ الفعلي للصلاحية وحجم الصندوق عند الشراء. دوّن النقص في النظام.':'Suppliers and prices are indicative. Check the product, actual expiry date and box size when buying. Record shortages in Snacky OS.'}</p>
   <footer className={styles.printFooter}>{ar?'ليست فاتورة أو إثبات دفع أو استلام مخزون. النسخة المطبوعة ثابتة؛ راجع آخر تحديث في سناكي.':'Not an invoice, payment proof or stock receipt. Printed copies are snapshots; check the latest version in Snacky OS.'}<span className={styles.printReference} dir="ltr">/buying-lists/{id}</span></footer>
  </article>
 </div>;
}
