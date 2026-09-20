import {unstable_rethrow} from 'next/navigation';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {buyingWorkspace} from '@/lib/buying-server';
import {buyingUuid,buyingTotals,buyingError} from '@/lib/buying-lists';
import {getServerI18n} from '@/lib/i18n/server';
import {BuyingProgress,BuyingCopyLink} from '@/components/BuyingListClient';
import {BuyingListTable} from '@/components/BuyingListTable';
import styles from '@/components/BuyingLists.module.css';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{id:string}>}){
 const {id}=await params;if(!buyingUuid.test(id))notFound();const {locale}=await getServerI18n(),ar=locale==='ar';
 let view;try{view=await buyingWorkspace(id);}catch(error){unstable_rethrow(error);return <section className={styles.workspace}><h1>{ar?'تعذر فتح القائمة':'List unavailable'}</h1><p role="alert">{buyingError('denied',ar)}</p><Link href="/buying-lists">{ar?'العودة للقوائم':'Back to lists'}</Link></section>;}
 const list=view.data.record;if(!list)notFound();const totals=buyingTotals(list.items);
 return <section className={styles.workspace} dir={ar?'rtl':'ltr'} id="buying-list-detail">
  <header className={styles.header}><div><p>{ar?'قائمة مشتركة':'Shared checklist'} · {id.slice(0,8).toUpperCase()} · v{list.revision}</p><h1>{list.title}</h1><p>{ar?'المشتري:':'Buyer:'} <b>{list.buyer_name}</b> · {ar?'الموعد:':'Due:'} <bdi>{list.due_on}</bdi></p></div><Link className={styles.secondary} href="/buying-lists">{ar?'العودة للقوائم':'Back to lists'}</Link></header>
  <div className={styles.actions}><Link className={styles.primary} href={`/buying-lists/${id}/print`}>{ar?'عرض للطباعة / PDF':'Print / PDF view'}</Link><BuyingCopyLink ar={ar}/></div>
  {list.instructions?<p className={styles.notice} style={{whiteSpace:'pre-wrap'}}>{list.instructions}</p>:null}
  <dl className={styles.metrics}><div><dt>{ar?'الصناديق المطلوبة':'Planned boxes'}</dt><dd>{totals.boxes}</dd></div><div><dt>{ar?'الوحدات داخلها':'Units inside'}</dt><dd>{totals.units}</dd></div><div><dt>{ar?'تمت مراجعتها':'Products checked'}</dt><dd>{totals.checked}/{list.items.length}</dd></div><div><dt>{ar?'التكلفة التقديرية':'Estimated total'}</dt><dd>{totals.missing===list.items.length?'—':totals.estimate.toFixed(2)} <small>LYD</small></dd></div></dl>
  <p className={styles.hint}>{ar?'الموردون والأسعار تقديرات من آخر بيانات المنتج وليست عروض أسعار.':'Suppliers and prices are estimates from the latest product records, not quotations.'} {totals.missing?(ar?'بعض التكاليف ناقصة؛ الإجمالي غير مكتمل.':'Some costs are missing; the total is incomplete.'):''}</p>
  <details className={styles.admin}><summary>{ar?'عرض جدول الكميات والتكاليف':'Show quantities and estimated costs'}</summary><div className={styles.tableWrap}><BuyingListTable items={list.items} ar={ar}/></div></details>
  <BuyingProgress list={list} userId={view.profile.id} planner={view.data.planner} people={view.data.people}/>
  <p className={styles.hint}>{ar?'أعد تحميل الصفحة للتحقق من آخر تقدم على جهاز آخر. تبقى الكميات المطلوبة ثابتة بعد مشاركة القائمة.':'Reload to check the latest progress from another device. Requested quantities remain fixed after sharing the list.'}</p>
 </section>;
}
