'use client';
import Link from 'next/link';
import {useEffect,useRef,useState,useSyncExternalStore,type FormEvent} from 'react';
import {collaborationMessage,validateCollaborationWorkspace,type ManagementNote,type NotesWorkspace} from '@/lib/crm-collaboration';
import {useCrmCollaborationCommand} from './useCrmCollaborationCommand';
import styles from './CrmCollaboration.module.css';
const subscribe=()=>()=>{},clientSnapshot=()=>true,serverSnapshot=()=>false;
export function CrmManagementNotes(props:{userId:string;ar:boolean;leadId?:string|null}){
 const ready=useSyncExternalStore(subscribe,clientSnapshot,serverSnapshot);
 return ready?<NotesClient {...props}/>:<p role="status">{props.ar?'جارٍ تحميل الملاحظات…':'Loading notes…'}</p>;
}
function NotesClient({userId,ar,leadId=null}:{userId:string;ar:boolean;leadId?:string|null}){
 const tr=(en:string,a:string)=>ar?a:en,key='snacky:management-note-draft:'+userId+':'+(leadId??'general');
 const [draft,setDraft]=useState(()=>{try{return sessionStorage.getItem(key)??'';}catch{return '';}}),[draftError,setDraftError]=useState(false);
 const [data,setData]=useState<NotesWorkspace|null>(null),[error,setError]=useState(''),[filter,setFilter]=useState('open'),[offset,setOffset]=useState(0),[refresh,setRefresh]=useState(0),[loading,setLoading]=useState(true);
 const save=useCrmCollaborationCommand(userId,'new-note:'+(leadId??'general'),ar),epoch=useRef(0);
 useEffect(()=>{
  const controller=new AbortController(),seq=++epoch.current;
  fetch('/api/crm/collaboration?kind=notes&filter='+filter+'&offset='+offset,{cache:'no-store',signal:controller.signal}).then(async r=>{const body=await r.json();if(!r.ok||body.ok!==true)throw Error(body.code??'unavailable');const result=validateCollaborationWorkspace(body.data);if(result.kind!=='notes')throw Error('unavailable');return result;}).then(result=>{if(seq===epoch.current){setData(result);setError('');setLoading(false);}}).catch(e=>{if(!controller.signal.aborted&&seq===epoch.current){setError(collaborationMessage(e.message,ar));setLoading(false);}});
  return()=>controller.abort();
 },[filter,offset,refresh,ar]);
 const reload=()=>{setLoading(true);setRefresh(x=>x+1);};
 function edit(value:string){setDraft(value);try{sessionStorage.setItem(key,value);setDraftError(false);}catch{setDraftError(true);}}
 async function submit(e?:FormEvent){e?.preventDefault();const command=save.pending??{request_id:crypto.randomUUID(),id:crypto.randomUUID(),action:'note.create' as const,revision:0,payload:{body:draft,lead_id:leadId}};if(await save.send(command)){edit('');setOffset(0);setFilter('open');reload();}}
 return <section className={styles.workspace} dir={ar?'rtl':'ltr'}>
  <header className={styles.header}><div><p className={styles.eyebrow}>{tr('Customer Relations','علاقات العملاء')}</p><h1>{tr('Notes to management','ملاحظات للإدارة')}</h1><p>{tr('Keep decisions and replies here instead of scattered messages. Notes are visible to their author and owner/admin only.','سجّل المستجدات والقرارات والردود هنا بدلاً من الرسائل المتفرقة. يطلع على الملاحظة كاتبها والمالك والإدارة فقط.')}</p></div><Link className={styles.secondary} href="/my-work">{tr('My work','عملي اليوم')}</Link></header>
  <form className={styles.card} onSubmit={e=>void submit(e)}>
   <label className={styles.label}>{tr('New note','ملاحظة جديدة')}<textarea aria-label={tr('New note','ملاحظة جديدة')} dir="auto" value={draft} onChange={e=>edit(e.target.value)} rows={3} maxLength={4000} disabled={save.blocked} placeholder={tr('What does management need to know or decide?','ما الذي تريدين إبلاغ الإدارة به أو طلب قرار بشأنه؟')} required/></label>
   {leadId?<p className={styles.small}><Link href={'/locations-pipeline/'+leadId}>{tr('Linked to the selected lead','مرتبطة بالجهة المحددة')}</Link></p>:null}
   <div className={styles.actions}><button className={styles.primary} disabled={save.busy||save.stale||(!save.pending&&!draft.trim())}>{save.busy?tr('Saving…','جارٍ الحفظ…'):save.pending?tr('Retry saved request','إعادة الطلب المحفوظ'):tr('Send to management','إرسال للإدارة')}</button><span className={styles.small}>{draftError?tr('Draft recovery unavailable on this browser.','تعذر حفظ المسودة في هذا المتصفح.'):tr('Draft stays on this browser until sent.','تبقى المسودة في هذا المتصفح حتى إرسالها.')}</span></div>
   {save.message?<p role="status" className={styles.notice}>{save.message}</p>:null}
  </form>
  <div className={styles.actions}><nav className={styles.tabs} aria-label={tr('Note filters','تصفية الملاحظات')}>{[['open','Needs attention','تحتاج متابعة'],['done','Done','مكتملة'],['all','All','الكل']].map(([value,en,a])=><button key={value} className={filter===value?styles.activeTab:styles.tab} aria-pressed={filter===value} onClick={()=>{if(filter===value)return;setFilter(value);setOffset(0);setLoading(true);}}>{tr(en,a)}</button>)}</nav><button className={styles.secondary} disabled={loading} onClick={reload}>{tr('Refresh','تحديث')}</button></div>
  {error?<p className={styles.error} role="alert">{error} <button className={styles.secondary} onClick={reload}>{tr('Retry','إعادة المحاولة')}</button></p>:null}
  {loading?<p role="status" className={styles.small}>{tr('Loading saved notes…','جارٍ تحميل الملاحظات المحفوظة…')}</p>:null}
  {!error&&!loading&&data?.rows.length===0?<div className={styles.card}>{tr('No notes in this view.','لا توجد ملاحظات في هذا العرض.')}</div>:null}
  {!loading&&!error&&data?.rows.map(n=><article key={n.id+':'+n.revision} className={styles.card}>
   <div className={styles.noteHeader}><strong>{n.author_name}</strong><span className={styles.badge} data-tone={n.status==='done'?'green':n.status==='seen'?'blue':'amber'}>{n.status==='done'?tr('Done','مكتملة'):n.status==='seen'?tr('Seen / in review','اطّلعت الإدارة / قيد المتابعة'):tr('New','جديدة')}</span></div>
   <p className={styles.noteBody} dir="auto">{n.body}</p>
   {n.lead_id&&n.lead_name?<Link className={styles.small} href={'/locations-pipeline/'+n.lead_id}>{n.lead_name}</Link>:null}
   <p className={styles.small}><time dateTime={n.created_at}>{new Intl.DateTimeFormat(ar?'ar-LY':'en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Tripoli'}).format(new Date(n.created_at))}</time></p>
   {n.response?<div className={styles.reply}><strong>{n.reviewer_name??tr('Management','الإدارة')}</strong><p dir="auto">{n.response}</p></div>:null}
   {data.manager?<ReviewForm key={n.id+':'+n.revision} note={n} userId={userId} ar={ar} updated={reload}/>:null}
  </article>)}
  {data&&!error?<div className={styles.actions}><span className={styles.small}>{data.total} {tr('notes','ملاحظة')}</span><button className={styles.secondary} disabled={loading||offset===0} onClick={()=>{setOffset(Math.max(0,offset-10));setLoading(true);}}>{tr('Previous','السابق')}</button><button className={styles.secondary} disabled={loading||offset+10>=data.total} onClick={()=>{setOffset(offset+10);setLoading(true);}}>{tr('Next','التالي')}</button></div>:null}
 </section>;
}
function ReviewForm({note,userId,ar,updated}:{note:ManagementNote;userId:string;ar:boolean;updated:()=>void}){
 const key='snacky:note-reply:'+userId+':'+note.id;
 const [response,setResponse]=useState(()=>{try{return sessionStorage.getItem(key)??note.response;}catch{return note.response;}}),[status,setStatus]=useState(note.status),save=useCrmCollaborationCommand(userId,'review:'+note.id,ar);
 async function submit(e:FormEvent){e.preventDefault();const c=save.pending??{request_id:crypto.randomUUID(),id:note.id,action:'note.review' as const,revision:note.revision,payload:{status,response}};if(await save.send(c)){try{sessionStorage.removeItem(key);}catch{}updated();}}
 return <details className={styles.disclosure} open={Boolean(save.pending)}><summary>{ar?'رد الإدارة / تحديث الحالة':'Reply / update status'}</summary><form onSubmit={e=>void submit(e)} className={styles.stack}><label className={styles.label}>{ar?'الرد':'Reply'}<textarea aria-label={ar?'الرد':'Reply'} dir="auto" rows={2} maxLength={4000} value={response} disabled={save.blocked} onChange={e=>{setResponse(e.target.value);try{sessionStorage.setItem(key,e.target.value);}catch{}}}/></label><label className={styles.label}>{ar?'الحالة':'Status'}<select aria-label={ar?'الحالة':'Status'} value={status} disabled={save.blocked} onChange={e=>setStatus(e.target.value as ManagementNote['status'])}><option value="open">{ar?'جديدة':'New'}</option><option value="seen">{ar?'اطّلعت الإدارة / قيد المتابعة':'Seen / in review'}</option><option value="done">{ar?'مكتملة':'Done'}</option></select></label><button className={styles.primary} disabled={save.busy||save.stale}>{save.pending?(ar?'إعادة الطلب المحفوظ':'Retry saved request'):(ar?'حفظ الرد والحالة':'Save reply and status')}</button>{save.message?<p role="status">{save.message}</p>:null}{save.stale?<button type="button" className={styles.secondary} onClick={updated}>{ar?'تحديث السجل':'Reload record'}</button>:null}</form></details>;
}
