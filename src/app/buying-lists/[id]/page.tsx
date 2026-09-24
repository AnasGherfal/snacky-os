import {sourceAwareItems} from '@/lib/buying-sources';
import {buyingPurchaseSource} from '@/lib/buying-purchase';
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
 const list=view.data.record;if(!list)notFound();const items=sourceAwareItems(list.items,view.sources);const totals=buyingTotals(items);
 return <section className={styles.workspace} dir={ar?'rtl':'ltr'} id="buying-list-detail">
  <header className={styles.header}><div><p>{ar?'قائمة مشتركة':'Shared checklist'} · {id.slice(0,8).toUpperCase()} · v{list.revision}</p><h1>{list.title}</h1><p>{ar?'المشتري:':'Buyer:'} <b>{list.buyer_name}</b> · {ar?'الموعد:':'Due:'} <bdi>{list.due_on}</bdi></p></div><Link className={styles.secondary} href="/buying-lists">{ar?'العودة للقوائم':'Back to lists'}</Link></header>
  <div className={styles.actions}><Link className={styles.primary} href={`/buying-lists/${id}/print`}>{ar?'عرض للطباعة / PDF':'Print / PDF view'}</Link><BuyingCopyLink ar={ar}/></div>
  {list.instructions?<p className={styles.notice} style={{whiteSpace:'pre-wrap'}}>{list.instructions}</p>:null}
  <dl className={styles.metrics}><div><dt>{ar?'الصناديق المطلوبة':'Planned boxes'}</dt><dd>{totals.boxes}</dd></div><div><dt>{ar?'الوحدات داخلها':'Units inside'}</dt><dd>{totals.units}</dd></div><div><dt>{ar?'تمت مراجعتها':'Products checked'}</dt><dd>{totals.checked}/{list.items.length}</dd></div><div><dt>{ar?'التكلفة التقديرية':'Estimated total'}</dt><dd>{totals.missing===list.items.length?'—':totals.estimate.toFixed(2)} <small>LYD</small></dd></div></dl>
  {view.sourcesStatus==='unavailable'?<p className={styles.error} role="alert">{ar?'تعذر التحقق من تعليمات الموردين. حدّث الصفحة أو تأكد من الإدارة قبل الشراء.':'Store instructions could not be verified. Reload or confirm with management before buying.'}</p>:view.sourcesStatus==='not_installed'&&view.data.planner?<p className={styles.notice}>{ar?'ترقية تعليمات الموردين غير مفعلة بعد. تبقى القائمة الحالية متاحة.':'Store-guidance upgrade is not installed yet. The existing checklist remains available.'}</p>:null}
  {view.sources?.can_edit&&view.sources.sources.length<list.items.length?<p className={styles.notice}>{ar?'حدد المورد لكل منتج من تفاصيله قبل إرسال الرابط للمشتري. تظهر المنتجات غير المحددة في مجموعة منفصلة.':'Choose each product’s store in its details before sharing the link with the buyer. Unassigned products appear separately.'}</p>:null}
  <p className={styles.hint}>{view.sources?.sources.length?(ar?'التقدير من أسعار الشراء السابقة للموردين المحددين، وليس عرض سعر حالي.':'Estimate uses previous purchases from the selected stores, not current quotes.'):(ar?'الموردون والأسعار تقديرات من آخر بيانات المنتج وليست عروض أسعار.':'Suppliers and prices are estimates from the latest product records, not quotations.')} {totals.missing?(ar?'بعض التكاليف ناقصة؛ الإجمالي غير مكتمل.':'Some costs are missing; the total is incomplete.'):''}</p>
  <details className={styles.admin}><summary>{ar?'عرض جدول الكميات والتكاليف':'Show quantities and estimated costs'}</summary><div className={styles.tableWrap}><BuyingListTable items={items} sources={view.sources} ar={ar}/></div></details>
  <BuyingProgress list={list} userId={view.profile.id} planner={view.data.planner} people={view.data.people} sources={view.sources}/>
  {list.status==='completed'&&view.purchaseFlow?<section className={styles.admin}>
   <h2>{ar?'سجّل الشراء وأدخله للمخزن':'Record purchase & put in storage'}</h2>
   <p className={styles.hint}>{ar?'نفس المشتري يسجّل السعر والإيصال ثم يختار المخزن ويضغط «حفظ واستلام». كل متجر فعلي يصبح عملية شراء مستقلة.':'The same buyer records actual prices and receipt, chooses storage, then uses Save and receive. Each actual store becomes one purchase.'}</p>
   {!view.purchaseFlow.groups.length?<p>{ar?'لم يتم شراء أي منتجات من هذه القائمة، لذلك لا توجد عملية شراء لتسجيلها.':'No products were bought from this list, so there is no purchase to record.'}</p>:<div className={styles.itemCards}>{view.purchaseFlow.groups.map(group=><div className={styles.itemCard} key={group.supplier_id}>
    <div><strong>{group.store_name}</strong><p className={styles.hint}>{group.item_count} {ar?'منتج':'products'} · {group.bought_boxes} {ar?'صندوق':'boxes'}</p></div>
    {group.linked_purchase?.purchase_id?<Link className={styles.secondary} href={`/purchases/${group.linked_purchase.purchase_id}`}>{ar?'فتح عملية الشراء المسجلة':'Open recorded purchase'} · {group.linked_purchase.status}</Link>:view.purchaseFlow.can_record?<Link className={styles.primary} href={`/purchases/new?source=${encodeURIComponent(buyingPurchaseSource(id,group.supplier_id))}`}>{ar?`سجّل واستلم من ${group.store_name}`:`Record & receive from ${group.store_name}`}</Link>:<p className={styles.hint}>{ar?'يجب أن يكون المشتري المسند لديه صلاحية المشتريات والاستلام.':'The assigned buyer needs purchase and receiving access.'}</p>}
   </div>)}</div>}
  </section>:list.status==='completed'&&view.purchaseFlowStatus==='not_installed'?<p className={styles.notice}>{ar?'ربط القائمة بالمشتريات غير مفعّل بعد. القائمة نفسها محفوظة ولم تتغير.':'Buying-to-storage linking is not installed yet. The checklist remains unchanged.'}</p>:null}
  <p className={styles.hint}>{ar?'أعد تحميل الصفحة للتحقق من آخر تقدم على جهاز آخر. تبقى الكميات المطلوبة ثابتة بعد مشاركة القائمة.':'Reload to check the latest progress from another device. Requested quantities remain fixed after sharing the list.'}</p>
 </section>;
}
