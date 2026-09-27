'use client';
import Link from 'next/link';
import {useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {labelColors,collaborationMessage,validateCollaborationWorkspace,type CrmLabel,type LabelsWorkspace,type LabelColor} from '@/lib/crm-collaboration';
import {useCrmCollaborationCommand} from './useCrmCollaborationCommand';
import styles from './CrmCollaboration.module.css';
export function CrmLeadLabels({leadId=null,labels=[],ar}:{leadId?:string|null;labels?:CrmLabel[];ar:boolean}){
 const [open,setOpen]=useState(false),[data,setData]=useState<LabelsWorkspace|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),version=useRef(0);
 async function load(){const seq=++version.current;setBusy(true);setError('');try{const r=await fetch('/api/crm/collaboration?kind=labels'+(leadId?'&id='+encodeURIComponent(leadId):''),{cache:'no-store',signal:AbortSignal.timeout(12000)});const body=await r.json();if(!r.ok||body.ok!==true)throw Error(body.code??'unavailable');const value=validateCollaborationWorkspace(body.data);if(value.kind!=='labels')throw Error('unavailable');if(seq===version.current)setData(value);}catch(e){if(seq===version.current)setError(collaborationMessage(e instanceof Error?e.message:'unavailable',ar));}finally{if(seq===version.current)setBusy(false);}}
 return <div className={styles.labelTool}>
  <div className={styles.chips}>{labels.map(l=><span key={l.id} className={styles.badge} data-tone={l.color} title={l.owner_name}>{l.name}</span>)}<button className={styles.linkButton} type="button" aria-expanded={open} onClick={()=>{if(open){setOpen(false);return;}setOpen(true);void load();}}>{leadId?(ar?'تصنيفات':'Labels'):(ar?'إدارة تصنيفاتي':'Manage my labels')}</button></div>
  {open?<section className={styles.labelEditor} aria-label={ar?'تنظيم التصنيفات':'Organize labels'}>
   {busy?<p role="status">{ar?'جارٍ التحميل…':'Loading…'}</p>:null}
   {error?<p role="alert" className={styles.error}>{error} <button className={styles.secondary} type="button" onClick={()=>void load()}>{ar?'إعادة المحاولة':'Retry'}</button></p>:null}
   {!busy&&!error&&data?<LabelEditor key={data.checked_at} data={data} ar={ar} reload={load}/>:null}
   {leadId?<Link className={styles.linkButton} href={'/my-work/notes?lead='+leadId}>{ar?'إضافة ملاحظة للإدارة عن هذه الجهة':'Add a management note about this lead'}</Link>:null}
  </section>:null}
 </div>;
}
function LabelEditor({data,ar,reload}:{data:LabelsWorkspace;ar:boolean;reload:()=>Promise<void>}){
 const router=useRouter(),own=data.options.filter(x=>x.owner_id===data.me),key='snacky:lead-label-draft:'+data.me+':'+data.lead_id;
 const [selected,setSelected]=useState<string[]>(()=>{try{const raw=sessionStorage.getItem(key);if(raw){const value=JSON.parse(raw);if(Array.isArray(value)&&value.every(x=>typeof x==='string'))return value.filter(id=>own.some(l=>l.id===id));}}catch{}return data.selected.filter(l=>l.owner_id===data.me).map(l=>l.id);});
 const formKey=key+':definition';
 const [form]=useState(()=>{try{const r=JSON.parse(sessionStorage.getItem(formKey)??'null');if(r&&typeof r.name==='string'&&labelColors.includes(r.color)&&typeof r.id==='string'&&(!r.id||own.some(l=>l.id===r.id)))return r as {id:string;name:string;color:LabelColor};}catch{}return {id:'',name:'',color:'blue' as LabelColor};});
 const [editId,setEditId]=useState(form.id),[name,setName]=useState(form.name),[color,setColor]=useState<LabelColor>(form.color),[search,setSearch]=useState('');
 function remember(id:string,value:string,tone:LabelColor){try{sessionStorage.setItem(formKey,JSON.stringify({id,name:value,color:tone}));}catch{}}

 const save=useCrmCollaborationCommand(data.me,'labels:'+(data.lead_id??'library'),ar),editing=own.find(l=>l.id===editId);
 function choose(id:string){const next=selected.includes(id)?selected.filter(x=>x!==id):selected.length<10?[...selected,id]:selected;setSelected(next);try{sessionStorage.setItem(key,JSON.stringify(next));}catch{}}
 async function apply(e:FormEvent){e.preventDefault();if(!data.lead_id)return;const c=save.pending??{request_id:crypto.randomUUID(),id:data.lead_id,action:'labels.set' as const,revision:data.revision,payload:{label_ids:selected}};if(await save.send(c)){try{sessionStorage.removeItem(key);}catch{}await reload();router.refresh();}}
 async function label(e?:FormEvent,archive=false){e?.preventDefault();const c=save.pending??{request_id:crypto.randomUUID(),id:editing?.id??crypto.randomUUID(),action:editing?'label.update' as const:'label.create' as const,revision:editing?.revision??0,payload:{name,color,...(editing?{archived:archive}:{})}};if(await save.send(c)){try{sessionStorage.removeItem(formKey);}catch{}await reload();router.refresh();}}
 async function retry(){if(!save.pending)return;const action=save.pending.action;if(await save.send(save.pending)){try{sessionStorage.removeItem(action==='labels.set'?key:formKey);}catch{}await reload();router.refresh();}}
 return <div className={styles.stack}>
  <p className={styles.small}>{ar?'تصنيفاتك لتنظيم عملك، ويطلع عليها المالك والإدارة. لا تغيّر المرحلة أو تركيز الإدارة.':'Your labels organize your work and are visible to owner/admin. They do not change the lead stage or management focus.'}</p>
  {save.pending?<button type="button" className={styles.primary} disabled={save.busy} onClick={()=>void retry()}>{ar?'إعادة الطلب المحفوظ':'Retry saved request'}</button>:null}
  {save.message?<p role="status" className={styles.notice}>{save.message}</p>:null}
  {save.stale?<button className={styles.secondary} type="button" onClick={()=>void reload()}>{ar?'تحديث التصنيفات':'Reload labels'}</button>:null}
  {data.lead_id?<form onSubmit={e=>void apply(e)} className={styles.stack}>
   {own.length>8?<label className={styles.label}>{ar?'بحث في تصنيفاتي':'Search my labels'}<input value={search} onChange={e=>setSearch(e.target.value)} type="search"/></label>:null}
   <fieldset className={styles.labelChoices} disabled={save.blocked||!data.can_edit}><legend className={styles.small}>{ar?'تصنيفاتي لهذه الجهة':'My labels for this lead'}</legend>{own.filter(l=>l.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(l=><label key={l.id} className={styles.choice}><input type="checkbox" checked={selected.includes(l.id)} onChange={()=>choose(l.id)}/><span className={styles.badge} data-tone={l.color}>{l.name}</span></label>)}{!own.length?<p className={styles.small}>{ar?'أنشئ أول تصنيف أدناه.':'Create your first label below.'}</p>:null}</fieldset>
   {data.can_edit?<button className={styles.primary} disabled={save.blocked} type="submit">{ar?'حفظ تصنيفات الجهة':'Save lead labels'}</button>:<p className={styles.small}>{ar?'يمكنك عرض الجهة، لكن تنظيمها يتطلب صلاحية تعديلها.':'You can view this lead, but editing its labels requires lead-edit access.'}</p>}
  </form>:null}
  {data.manager&&data.selected.some(l=>l.owner_id!==data.me)?<div className={styles.reply}><strong>{ar?'تنظيم الموظفين':'Employee labels'}</strong>{data.selected.filter(l=>l.owner_id!==data.me).map(l=><p key={l.id} className={styles.small}><span className={styles.badge} data-tone={l.color}>{l.name}</span> · {l.owner_name}</p>)}</div>:null}
  <details className={styles.disclosure} open={!own.length||!data.lead_id}><summary>{ar?'إنشاء / تعديل تصنيفاتي':'Create / edit my labels'}</summary><form onSubmit={e=>void label(e)} className={styles.stack}>
   <label className={styles.label}>{ar?'التصنيف':'Label'}<select disabled={save.blocked} value={editId} onChange={e=>{setEditId(e.target.value);const l=own.find(x=>x.id===e.target.value);setName(l?.name??'');setColor(l?.color??'blue');remember(e.target.value,l?.name??'',l?.color??'blue');}}><option value="">{ar?'+ تصنيف جديد':'+ New label'}</option>{own.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
   <label className={styles.label}>{ar?'اسم التصنيف':'Label name'}<input maxLength={40} required disabled={save.blocked} value={name} onChange={e=>{setName(e.target.value);remember(editId,e.target.value,color);}} placeholder={ar?'هذا الأسبوع، تحتاج زيارة…':'This week, Needs a visit…'}/></label>
   <label className={styles.label}>{ar?'اللون':'Color'}<select disabled={save.blocked} value={color} onChange={e=>{setColor(e.target.value as LabelColor);remember(editId,name,e.target.value as LabelColor);}}>{labelColors.map((c,i)=><option key={c} value={c}>{ar?['أزرق','أخضر','ذهبي','وردي','بنفسجي','رمادي'][i]:c}</option>)}</select></label>
   <div className={styles.actions}><button className={styles.primary} disabled={save.blocked||!name.trim()}>{editing?(ar?'حفظ التعديل':'Save changes'):(ar?'إنشاء التصنيف':'Create label')}</button>{editing?<button type="button" className={styles.secondary} disabled={save.blocked} onClick={()=>{if(window.confirm(ar?'أرشفة هذا التصنيف؟ تبقى سجلات الجهات دون تغيير.':'Archive this label? Lead records remain unchanged.'))void label(undefined,true);}}>{ar?'أرشفة':'Archive'}</button>:null}</div>
  </form></details>
 </div>;
}
