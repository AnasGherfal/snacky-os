import Link from 'next/link';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {getServerI18n} from '@/lib/i18n/server';
import {leadFocusEnabled,missingLeadFocus} from '@/lib/crm-lead-focus';
import {leadDate,type LeadWorkspaceData} from '@/lib/crm-lead-list';
import {crmHref} from '@/lib/crm-workspace';
/** Reference the original focused leads, never create duplicate tasks on a page read. */
export async function CrmLeadFocusOverview(){
 if(!leadFocusEnabled)return null;
 const profile=await getCurrentProfile();if(!profile||!hasAnyRole(profile,['owner','admin','supervisor','crm']))return null;
 const {locale}=await getServerI18n(),ar=locale==='ar',tr=(en:string,arabic:string)=>ar?arabic:en;
 const crmTeamView=hasAnyRole(profile,['crm'])&&!hasAnyRole(profile,['owner','admin','supervisor']);
 try{
  const db=await getAuthenticatedSupabaseServerClient();if(!db)throw Error('Unavailable');
  const {data,error}=await db.rpc('snacky_crm_lead_desk_v1',{p_filters:{scope:'mine',focus:'active'}});
  if(error){if(missingLeadFocus(error))return null;throw error;}
  const result=data as LeadWorkspaceData;if(!result?.focus_ready||!Array.isArray(result.rows))throw Error('Unverified focus');
  if(!result.total)return null;
  return <section className="surface-card mb-5 space-y-3" dir={ar?'rtl':'ltr'} aria-label={crmTeamView?tr('CRM team focus','تركيز فريق علاقات العملاء'):tr('Focused places','جهات التركيز')}><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">{crmTeamView?tr('CRM team focus','تركيز فريق علاقات العملاء'):tr('Focused places','جهات التركيز')}</h2><Link className="btn-secondary" href="/locations-pipeline?scope=mine&focus=active">{tr('View all','عرض الكل')} ({result.total})</Link></div><p className="text-sm text-slate-600">{crmTeamView?tr('Shared priorities for Ahed and Ariam. Focus dates are a review window, not a promised follow-up date.','أولويات مشتركة لعهد وأريام. فترة التركيز للمراجعة وليست موعد متابعة مفترضاً.'):tr('These links open the original leads, not extra tasks.','تفتح الروابط سجلات الجهات الأصلية وليست مهام إضافية.')}</p><div className="divide-y">{result.rows.slice(0,5).map(row=><Link className="block py-3" href={crmHref('lead',row.id)} key={row.id}><strong className="block">{row.title}</strong><span className="block text-sm">{row.next_action}</span><span className="text-xs text-slate-600">{tr('Focus review through','مراجعة التركيز حتى')} {leadDate(row.focus_until,ar)}</span></Link>)}</div></section>;
 }catch{return <p role="status" className="mb-4 rounded-lg border p-3 text-sm" dir={ar?'rtl':'ltr'}>{tr('Focused places could not be verified. Your normal work remains available below.','تعذر التحقق من جهات التركيز. يبقى عملك المعتاد متاحاً بالأسفل.')}</p>;}
}
