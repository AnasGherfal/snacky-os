import {unstable_rethrow} from 'next/navigation';
import Link from 'next/link';
import {buyingWorkspace} from '@/lib/buying-server';
import {getServerI18n} from '@/lib/i18n/server';
import {buyingError} from '@/lib/buying-lists';
import styles from '@/components/BuyingLists.module.css';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}){
 const params=await searchParams,{locale}=await getServerI18n(),ar=locale==='ar',filters:Record<string,string>={scope:params.scope==='all'?'all':'mine',status:params.status??'open',offset:params.offset??'0'};
 let view;try{view=await buyingWorkspace(null,filters);}catch(error){unstable_rethrow(error);return <section className={styles.workspace} dir={ar?'rtl':'ltr'}><h1>{ar?'قوائم الشراء غير متاحة':'Buying lists unavailable'}</h1><p role="alert">{buyingError('unavailable',ar)}</p><a href="/buying-lists" className={styles.primary}>{ar?'إعادة التحميل':'Reload'}</a></section>;}
 const {data}=view;const link=(changes:Record<string,string>)=>'/buying-lists?'+new URLSearchParams({...filters,offset:'0',...changes});
 return <section className={styles.workspace} dir={ar?'rtl':'ltr'} id="buying-lists">
 <header className={styles.header}><div><h1>{ar?'قوائم الشراء المشتركة':'Shared buying lists'}</h1><p>{ar?'القوائم المسندة إليك محفوظة في النظام. حدّث نتائج الشراء من أي جهاز بحسابك.':'Your assigned lists are saved in Snacky OS. Update buying progress from any device using your account.'}</p></div>{data.planner?<Link href="/restock-priority/shopping-list" className={styles.primary}>{ar?'تجهيز قائمة وإسنادها':'Prepare & assign a list'}</Link>:null}</header>
 <nav className={styles.tabs} aria-label={ar?'عرض القوائم':'List view'}><Link href={link({scope:'mine'})} aria-current={filters.scope==='mine'?'page':undefined}>{ar?'المسندة إليّ':'Assigned to me'}</Link>{data.planner?<Link href={link({scope:'all'})} aria-current={filters.scope==='all'?'page':undefined}>{ar?'قوائم الفريق':'Team lists'}</Link>:null}</nav>
 <nav className={styles.tabs} aria-label={ar?'حالة القائمة':'List status'}>{[['open','In progress','قيد التنفيذ'],['completed','Completed','مكتملة'],['cancelled','Cancelled','ملغاة']].map(([value,en,arabic])=><Link href={link({status:value})} key={value} aria-current={filters.status===value?'page':undefined}>{ar?arabic:en}</Link>)}</nav>
 <div className={styles.listGrid}>{data.rows.map(l=><Link href={`/buying-lists/${l.id}`} key={l.id} className={styles.listCard}><h2>{l.title}</h2><p>{ar?'المشتري:':'Buyer:'} {l.buyer_name}</p><p>{ar?'الموعد:':'Due:'} <bdi>{l.due_on}</bdi>{l.due_on<data.today&&l.status==='open'?` · ${ar?'متأخرة':'Overdue'}`:''}</p><span className={styles.status}>{l.checked_count}/{l.item_count} {ar?'منتج تمت مراجعته':'products checked'}</span></Link>)}</div>
 {!data.total?<div className={styles.notice}>{ar?'لا توجد قوائم تطابق هذا العرض. إنشاء حساب لا يسند قوائم تلقائياً.':'No lists match this view. Creating an account does not automatically assign buying lists.'}</div>:null}
 <nav className={styles.actions} aria-label={ar?'صفحات القوائم':'List pages'}>{data.offset>0?<Link className={styles.secondary} href={link({offset:String(Math.max(0,data.offset-30))})}>{ar?'السابق':'Previous'}</Link>:null}{data.offset+30<data.total?<Link className={styles.secondary} href={link({offset:String(data.offset+30)})}>{ar?'التالي':'Next'}</Link>:null}</nav>
 <p className={styles.hint}>{ar?'«تم الشراء» نتيجة متابعة فقط؛ الاستلام والدفع يُسجّلان عبر إجراءات المشتريات الحالية.':'“Bought” is checklist progress only. Receiving and payment use the existing purchase workflow.'}</p>
 </section>;
}
