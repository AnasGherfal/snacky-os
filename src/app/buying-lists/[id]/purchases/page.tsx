import Link from 'next/link';
import {notFound,redirect,unstable_rethrow} from 'next/navigation';
import {getCurrentProfile,getAuthenticatedSupabaseServerClient} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {getServerI18n} from '@/lib/i18n/server';
import {buyingUuid} from '@/lib/buying-lists';
import {buyingPurchaseRoles,buyingReceiptError,type BuyingReceiptWorkspace} from '@/lib/buying-purchase';
import {BuyingPurchaseClient} from '@/components/BuyingPurchaseClient';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{id:string}>}){
 const {id}=await params;if(!buyingUuid.test(id))notFound();
 const profile=await getCurrentProfile();if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,buyingPurchaseRoles))redirect('/unauthorized');
 const {locale}=await getServerI18n(),ar=locale==='ar';
 let data:BuyingReceiptWorkspace|null=null;let code='unavailable';
 try{
  const db=await getAuthenticatedSupabaseServerClient();
  if(db){const result=await db.rpc('snacky_buying_purchase_workspace_v1',{p_list:id});
   if(result.error)code=result.error.code==='42501'?'denied':'unavailable';
   else if(result.data?.list_id===id&&Array.isArray(result.data.items)&&Array.isArray(result.data.receipts)&&Array.isArray(result.data.storage))data=result.data as BuyingReceiptWorkspace;
  }
 }catch(error){unstable_rethrow(error);}
 return <main className="min-w-0 space-y-5" dir={ar?'rtl':'ltr'}>
  <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm text-slate-500">{data?.title??(ar?'قائمة الشراء':'Buying list')}</p><h1 className="text-2xl font-semibold">{ar?'فواتير الشراء واستلام المخزن':'Purchase receipts and storage'}</h1></div><Link className="btn-secondary" href={`/buying-lists/${id}`}>{ar?'العودة للقائمة':'Back to checklist'}</Link></header>
  {data?<BuyingPurchaseClient data={data} userId={profile.id} ar={ar}/>:<section className="surface-card"><p role="alert">{buyingReceiptError(code,ar)}</p><p className="mt-2 text-sm text-slate-600">{ar?'لن نعرض الصفحة كأنها فارغة عندما يتعذر التحقق من البيانات.':'An unavailable workspace is not shown as an empty receipt list.'}</p></section>}
 </main>;
}
