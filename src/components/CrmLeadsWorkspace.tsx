import Link from 'next/link';
import {redirect} from 'next/navigation';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {getServerI18n} from '@/lib/i18n/server';
import {CrmRefresh} from '@/components/CrmClientTools';
import {CrmLeadTable} from '@/components/CrmLeadTable';
import {CrmLeadFocusList} from '@/components/CrmLeadFocusList';
import {CrmLeadQuickPanel} from '@/components/CrmLeadQuickPanel';
import {leadFocusEnabled,missingLeadFocus} from '@/lib/crm-lead-focus';
import {crmStatus,leadStatuses,locationTypes} from '@/lib/crm-workspace';
import {leadFilters,leadListHref,leadPageRange,usableLeadId,type LeadSearchParams,type LeadWorkspaceData} from '@/lib/crm-lead-list';
import styles from './CrmLeads.module.css';
export async function CrmLeadsWorkspace({searchParams={}}:{searchParams?:LeadSearchParams}){
 const profile=await getCurrentProfile();if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin','supervisor','crm']))redirect('/unauthorized');
 const {locale}=await getServerI18n(),ar=locale==='ar',tr=(en:string,arabic:string)=>ar?arabic:en;
 const filters=leadFilters(searchParams),useOpenDefault=leadFocusEnabled&&!filters.group&&!filters.status&&!filters.q&&!filters.focus;
 const deskFilters=useOpenDefault?{...filters,group:'active'}:filters;
 let context:LeadWorkspaceData;
 try{
  const db=await getAuthenticatedSupabaseServerClient();if(!db)throw Error('session_unavailable');
  if(!leadFocusEnabled&&(filters.focus||filters.group))throw Error('focus_disabled');
  let result=leadFocusEnabled?await db.rpc('snacky_crm_lead_desk_v1',{p_filters:deskFilters}):await db.rpc('snacky_crm_workspace_v1',{p_section:'lead',p_id:null,p_filters:filters});
  if(leadFocusEnabled&&missingLeadFocus(result.error)&&!filters.focus&&!filters.group)result=await db.rpc('snacky_crm_workspace_v1',{p_section:'lead',p_id:null,p_filters:filters});
  if(result.error)throw result.error;const data=result.data as LeadWorkspaceData|null;
  if(data?.focus_ready&&(!data.today||!Array.isArray(data.focus_assignees)))throw Error('invalid_focus_workspace');
  if(!data||!Array.isArray(data.rows)||!Array.isArray(data.directory)||!Number.isSafeInteger(data.total)||!Number.isSafeInteger(data.offset)||!Number.isSafeInteger(data.page_size)||data.page_size<1||data.page_size>100||data.total<0||data.offset<0||data.rows.some(row=>row.kind!=='lead'||!usableLeadId(row.id)||typeof row.title!=='string'))throw Error('invalid_workspace');
  context=data;if(context.focus_ready&&useOpenDefault)filters.group='active';
 }catch(error){
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):'unavailable';console.error('[crm-leads] Could not verify lead list',{code});
  return <section className={styles.workspace} dir={ar?'rtl':'ltr'} id="crm-leads"><div className={styles.error} role="alert"><h1>{tr('Leads unavailable','الجهات غير متاحة')}</h1><p>{tr('Could not verify the records or your access. This is not an empty lead list. Retry without creating duplicate records.','تعذر التحقق من السجلات أو صلاحياتك. هذا لا يعني أن قائمة الجهات فارغة. أعد المحاولة دون إنشاء سجلات مكررة.')}</p><a className={styles.primary} href={leadListHref(filters,{offset:filters.offset??'0'})}>{tr('Retry','إعادة المحاولة')}</a> <Link className={styles.secondary} href="/locations-pipeline">{tr('Standard lead list','قائمة الجهات المعتادة')}</Link></div></section>;
 }
 const currentOwner=filters.scope==='mine'?context.me:filters.assigned_to??'',knownOwner=context.directory.some(p=>p.id===currentOwner);
 const advanced=Boolean(filters.area||filters.type||filters.window&&filters.window!=='all'||filters.archived||filters.practice||filters.created_from||filters.created_to);
 const quick=[['all',tr('All permitted leads','كل الجهات المسموح بها'),{scope:'all',assigned_to:'',window:'all',focus:'',group:'all'}],['mine',tr('Assigned to me','المسند إليّ'),{scope:'mine',assigned_to:'',window:'all',focus:''}],['overdue',tr('Overdue follow-ups','المتابعات المتأخرة'),{window:'overdue',focus:''}]] as const;
 const activeQuick=filters.focus==='active'?'focus':filters.window==='overdue'?'overdue':currentOwner===context.me?'mine':!currentOwner?'all':'',summary=leadPageRange(context.total,context.offset,context.rows.length);
 return <section className={styles.workspace} dir={ar?'rtl':'ltr'} id="crm-leads">
  <CrmRefresh/>
  <header className={styles.header}><div><p className={styles.eyebrow}>{tr('Customer Relations','علاقات العملاء')}</p><h1>{tr('Leads & Visits','الجهات والزيارات')}</h1><p>{tr('See the contact, next action and assigned employee together. Open a place to work on its record.','اعرض جهة التواصل والخطوة القادمة والمسؤول معاً. افتح اسم الجهة للعمل على سجلها.')}</p></div>{context.staff?<Link className={styles.primary} href="/locations-pipeline/new">+ {tr('Add lead','إضافة جهة')}</Link>:null}</header>
  <nav className={styles.quick} aria-label={tr('Quick lead filters','مرشحات الجهات السريعة')}>{quick.map(([key,label,change])=><Link key={key} href={leadListHref(filters,{...change})} className={activeQuick===key?styles.quickActive:styles.quickLink} aria-current={activeQuick===key?'page':undefined}>{label}</Link>)}{context.focus_ready?<Link className={activeQuick==='focus'?styles.quickActive:styles.quickLink} href={leadListHref(filters,{focus:'active',group:'active',window:'all'})} aria-current={activeQuick==='focus'?'page':undefined}>{tr('Focused places','جهات التركيز')}</Link>:null}</nav>
  {context.focus_ready?<nav className={styles.groupTabs} aria-label={tr('Lead outcomes','حالة التعاون')}>{[['active','Open opportunities','فرص مفتوحة'],['agreed','Agreed — awaiting placement','متفق عليها — بانتظار التركيب'],['installed','Installed','تم التركيب'],['declined','Declined','رفضت التعاون'],['all','All records','جميع السجلات']].map(([key,en,arabic])=><Link key={key} className={(filters.group??'all')===key?styles.quickActive:styles.quickLink} href={leadListHref(filters,{group:key,status:'',focus:'',window:'all'})} aria-current={(filters.group??'all')===key?'page':undefined}>{tr(en,arabic)}</Link>)}</nav>:null}
  <form key={JSON.stringify(filters)} method="get" action="/locations-pipeline" className={styles.filters} aria-label={tr('Filter leads','تصفية الجهات')}>
   <input type="hidden" name="scope" value="all"/>{filters.group?<input type="hidden" name="group" value={filters.group}/>:null}{filters.focus?<input type="hidden" name="focus" value={filters.focus}/>:null}
   <div className={styles.toolbar}>
    <label className={styles.search}>{tr('Search','بحث')}<input name="q" type="search" defaultValue={filters.q??''} maxLength={200} placeholder={tr('Place, contact, phone or notes…','الجهة أو المسؤول أو الهاتف أو الملاحظات…')}/></label>
    <label>{tr('Stage','المرحلة')}<select name="status" defaultValue={filters.status??''}><option value="">{tr('All stages','كل المراحل')}</option>{leadStatuses.map(([value,en,arabic])=><option key={value} value={value}>{tr(en,arabic)}</option>)}{filters.status&&!leadStatuses.some(s=>s[0]===filters.status)?<option value={filters.status}>{crmStatus(filters.status,ar)}</option>:null}</select></label>
    <label>{tr('Assigned to','الموظف المسؤول')}<select name="assigned_to" defaultValue={currentOwner}><option value="">{tr('All permitted employees','كل المسؤولين المسموحين')}</option>{context.directory.map(p=><option key={p.id} value={p.id}>{p.name}{p.id===context.me?tr(' (me)',' (أنا)'):''}</option>)}{currentOwner&&!knownOwner?<option value={currentOwner}>{tr('Current selection','الاختيار الحالي')}</option>:null}</select></label>
    <div className={styles.filterActions}><button className={styles.primary} type="submit">{tr('Apply','تطبيق')}</button><Link className={styles.secondary} href="/locations-pipeline">{tr('Reset','إعادة ضبط')}</Link></div>
   </div>
   <details className={styles.advanced} open={advanced}><summary>{tr('More filters','مرشحات إضافية')}{advanced?<span> · {tr('active','مفعّلة')}</span>:null}</summary><div className={styles.advancedGrid}>
    <label>{tr('Follow-up date','موعد المتابعة')}<select name="window" defaultValue={filters.window??'all'}>{[['all','Any time','كل المواعيد'],['attention','Needs attention','يحتاج متابعة'],['today','Today','اليوم'],['overdue','Overdue','متأخر'],['week','This week','هذا الأسبوع'],['completed','Completed','مكتمل']].map(([value,en,arabic])=><option key={value} value={value}>{tr(en,arabic)}</option>)}</select></label>
    <label>{tr('Type','النوع')}<select name="type" defaultValue={filters.type??''}><option value="">{tr('All types','كل الأنواع')}</option>{locationTypes.map(([value,en,arabic])=><option key={value} value={value}>{tr(en,arabic)}</option>)}</select></label>
    <label>{tr('Area','المنطقة')}<input name="area" defaultValue={filters.area??''} maxLength={160}/></label><label>{tr('Created from','أُنشئ من')}<input name="created_from" type="date" defaultValue={filters.created_from??''}/></label><label>{tr('Created to','أُنشئ حتى')}<input name="created_to" type="date" defaultValue={filters.created_to??''}/></label>
    <div className={styles.checks}><label><input type="checkbox" name="archived" value="true" defaultChecked={filters.archived==='true'}/>{tr('Include archived','إظهار المؤرشف')}</label><label><input type="checkbox" name="practice" value="true" defaultChecked={filters.practice==='true'}/>{tr('Include practice','إظهار التدريب')}</label></div>
   </div></details>
  </form>
  <div className={styles.listSummary}><h2>{tr('Lead list','قائمة الجهات')}</h2><span aria-live="polite"><span className={styles.srOnly}>{tr('Showing','عرض')} </span><bdi dir="ltr">{summary}</bdi> {tr('leads','جهة')}</span></div>
  {context.focus_ready?<p className={styles.focusHint}>{tr('Focus first, then overdue, agreed and other open opportunities. Installed and declined records remain available below or in their tabs.','التركيز أولاً ثم المتأخر والمتفق عليه وبقية الفرص المفتوحة. تبقى الجهات المركّبة والرافضة في آخر القائمة أو في تبويباتها.')}</p>:<p className={styles.focusHint}>{tr('Showing the standard list. Focus tools are not installed or are switched off.','تُعرض القائمة المعتادة. أدوات التركيز غير مثبتة أو متوقفة.')}</p>}
  {context.focus_ready?<CrmLeadFocusList key={JSON.stringify(filters)+context.rows.map(r=>`${r.id}:${r.data?.version}:${r.focus_revision}`).join('|')} rows={context.rows} ar={ar} userId={profile.id} today={context.today!} manager={context.manager} assignees={context.focus_assignees??[]}/>:context.rows.length?<CrmLeadTable rows={context.rows} ar={ar}/>:null}
  {!context.rows.length?<div className={styles.empty}><h2>{tr('No matching leads','لا توجد جهات مطابقة')}</h2><p>{currentOwner===context.me?tr('No assigned leads match these filters. Review your assignments with your manager, or switch to all permitted leads.','لا توجد جهات مسندة إليك تطابق هذه المرشحات. راجع المهام مع المسؤول أو اعرض كل الجهات المسموح بها.'):tr('Try another search or reset the filters. Existing records have not been removed.','جرّب بحثاً آخر أو أعد ضبط المرشحات. لم تُحذف السجلات الموجودة.')}</p><Link className={styles.secondary} href="/locations-pipeline">{tr('Reset filters','إعادة ضبط المرشحات')}</Link></div>:null}
  <nav className={styles.pagination} aria-label={tr('Lead pages','صفحات الجهات')}><span>{tr('Filters apply to all permitted leads, not just this page.','تُطبّق المرشحات على جميع الجهات المسموح بها، وليس هذه الصفحة فقط.')}</span><div>{context.offset>0?<Link className={styles.secondary} rel="prev" href={leadListHref(filters,{offset:String(Math.max(0,context.offset-context.page_size))})}>{tr('Previous','السابق')}</Link>:null}{context.offset+context.page_size<context.total?<Link className={styles.secondary} rel="next" href={leadListHref(filters,{offset:String(context.offset+context.page_size)})}>{tr('Next','التالي')}</Link>:null}</div></nav>
  {usableLeadId(searchParams.quick)?<CrmLeadQuickPanel id={searchParams.quick} ar={ar} returnHref={leadListHref(filters,{offset:filters.offset??'0'})}/>:null}
 </section>;
}
